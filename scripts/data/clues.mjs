// Dictionary clues derived from WordNet: for each answer, up to 3 short crossword-style clues, best first.
//
// Candidate kinds (each scored, then the best distinct ones kept):
//   synonym  other lemmas of the answer's most frequent senses ("Desert" for ABANDON), inflected to match the answer
//            ("Deserts" for ABANDONS); proper-noun epithets ("Buckeye State" for OHIO); for -LY adverbs, adverbs made
//            from the synonyms of the adjective they derive from.
//   gloss    the sense's definition, shortened ("Capital and largest city of Norway"); for inflected answers the
//            gloss is inflected too when that can be done safely ("Frankfurters served hot on a bun"). Long noun
//            definitions are fitted by trimming the tail and, if needed, leading modifiers.
//   blank    fill-in-the-blank from a WordNet phrase containing the answer ("Lake ___" for ERIE, "Hot ___" for DOG).
//   kind     "Kind of lizard" from the hypernym, for nouns with nothing better.
// Hard rules: no clue may contain the answer (letters, spaces ignored), its base lemma or a word sharing a stem with
// either (or with the parts of a phrase answer); no banned words; no offensive senses; <= 60 characters.

import { capitalize, clueLeaks, finishGlossText, glossDefinition, MAX_CLUE_LENGTH } from './gloss.mjs';
import { formPos } from './morphology.mjs';
import { isOffensiveSynset, textHasBannedWord } from './offensive.mjs';

const SENSE_WEIGHTS = [1, 0.8, 0.66, 0.54, 0.45, 0.38, 0.32, 0.27];
const MAX_SENSES = 8;
const MAX_CLUES = 3;

const NOT_HEAD_NOUNS = new Set(['one', 'any', 'some', 'each', 'either', 'neither', 'none', 'all', 'both', 'something',
  'anything', 'someone', 'anyone', 'everything', 'nothing', 'much', 'many', 'more', 'most', 'few', 'several']);
// Words that always end a noun phrase ("cap | that fits over the hub", "support | for the arm").
const NP_END = new Set(['of', 'in', 'for', 'with', 'that', 'which', 'who', 'whom', 'whose', 'where', 'from', 'on', 'by',
  'to', 'at', 'as', 'when', 'while', 'like', 'between', 'into', 'under', 'over', 'against', 'without', 'within', 'than',
  'having', 'resembling', 'consisting', 'containing', 'about', 'around', 'through', 'during', 'after', 'before',
  'along', 'across', 'behind', 'beneath', 'beyond', 'near', 'or', 'and']);
// Words that end a noun phrase only right after a noun ("lizards | typically with", "meat | formed into a ball");
// before the head they are modifiers ("usually nocturnal lizards", "widely distributed mollusk").
const NP_END_AFTER_NOUN = new Set(['especially', 'usually', 'typically', 'often', 'chiefly', 'mainly', 'mostly',
  'sometimes', 'commonly', 'native', 'found', 'used', 'made', 'formed', 'held']);
const PARTICLES = new Set(['up', 'out', 'down', 'off', 'away', 'back', 'behind', 'over', 'in', 'on', 'about',
  'around', 'along', 'aside', 'apart', 'together', 'forth', 'through', 'again']);
const KIND_HEADS = new Set(['kind', 'type', 'sort', 'form', 'variety', 'style', 'version']);
const RELATIVE = new Set(['that', 'which', 'who', 'whom', 'whose', 'where', 'when', 'while']);
const TAXONOMIC_LEX = new Set(['noun.animal', 'noun.plant']);
const TAXONOMIC_PART = /^(genus|family|order|class|phylum|subfamily|suborder|subclass|superfamily|tribe|division)$/i;
const CONNECTORS = new Set(['of', 'the', 'and', 'de', 'la', 'le', 'du', 'von', 'van', 'del', 'da', 'on', 'in', 'a']);
// "any of various small terrestrial isopods" -> "small terrestrial isopod(s)"; "either of two saclike organs".
const ANY_OF = /^(?:any|either|each) of (?:various|several|numerous|many|a number of|a group of|a variety of|the two|two|the)\s+/i;
const DETERMINERS = new Set(['a', 'an', 'the', 'other', 'another', 'some', 'any', 'its', 'their', 'his', 'her', 'one',
  'all', 'each', 'every', 'no', 'more', 'most', 'such']);
// Hypernyms too vague for a "Kind of ___" clue.
const GENERIC_HYPERNYMS = new Set(('entity physical_entity abstraction object whole thing matter substance act action ' +
  'activity event state condition attribute quality property relation group collection set unit part piece portion ' +
  'person individual someone somebody people organism being artifact artefact instrumentality device structure ' +
  'container covering area region location place point line measure amount quantity time period cognition content ' +
  'idea concept communication message statement feeling emotion process change phenomenon form shape kind sort type ' +
  'worker expert adult male female man woman member leader holder owner user consumer inhabitant native resident ' +
  'creator maker communicator intellectual professional food nutriment animal plant material medium system means ' +
  'method way practice procedure technique plan document writing text name word term expression language symbol ' +
  'sign signal number figure rate value cost sum possession assets case example instance natural_object ' +
  'causal_agent agent social_group happening psychological_feature attitude trait disposition situation status ' +
  'magnitude extent degree level grade class category division variety order arrangement national ' +
  'mortal organization institution structure facility').split(' '));

export class ClueDeriver {
  /**
   * @param {object} o
   * @param {import('./lexicon.mjs').Lexicon} o.lex
   * @param {(WORD: string) => boolean} o.isBanned
   * @param {Map<string, string>} o.phraseLemmas   WORD -> WordNet lemma for phrase / proper-noun entries
   * @param {Map<string, number>} o.phraseScores   WORD -> score of lowercase collocation entries (for blank clues)
   */
  constructor({ lex, isBanned, phraseLemmas = new Map(), phraseScores = new Map() }) {
    this.lex = lex;
    this.wn = lex.wn;
    this.isBanned = isBanned;
    this.phraseLemmas = phraseLemmas;
    this.phraseScores = phraseScores;
    this.offensiveCache = new Map();
    this.blankIndex = this._buildBlankIndex();
    // "sangfroid" -> "sang-froid", "mohawkriver" -> "mohawk_river": WordNet spellings of solid answers.
    this.joinedLemmas = new Map();
    for (const lemma of this.wn.index.keys()) {
      if (!/[_-]/.test(lemma)) continue;
      const joined = lemma.replace(/[_-]/g, '');
      if (/^[a-z]+$/.test(joined) && !this.joinedLemmas.has(joined)) this.joinedLemmas.set(joined, lemma);
    }
    // A cut gloss must not end on a verb form that needs an object ("measures for apprehending", "shrub grown").
    this.glossOpts = {
      badEnding: (w) => !lex.hasLemma(w, 'n') && lex.analyses(w).some((a) => a.pos === 'v' && a.form !== 's'),
      // A trailing coordinate may be dropped when it is a separate phrase ("or other ...", "and certify ...").
      okCoordinationCut: (next) => DETERMINERS.has(next) || (lex.hasLemma(next, 'v') && !lex.hasLemma(next, 'n')),
    };
  }

  /** The sense names a specific person/place ("Lamb, Charles Lamb"): it has no plural or verb forms. */
  _properSense(synset, lemma) {
    if (synset.ptrs.some((p) => p.sym === '@i')) return true;
    const own = synset.words.find((w) => w.toLowerCase() === lemma);
    return Boolean(own && own !== own.toLowerCase());
  }

  /** Genus names ("Paris, genus Paris": a plant genus) make no clues for PARIS. */
  _taxonomicOnly(synset, lemma) {
    if (!TAXONOMIC_LEX.has(synset.lexFile)) return false;
    const own = synset.words.find((w) => w.toLowerCase() === lemma);
    return Boolean(own && own !== own.toLowerCase());
  }

  _offensive(synset) {
    let v = this.offensiveCache.get(synset.key);
    if (v === undefined) this.offensiveCache.set(synset.key, (v = isOffensiveSynset(synset, this.isBanned)));
    return v;
  }

  /**
   * Index of WordNet phrases (2–3 parts) by lowercase part, for fill-in-the-blank clues:
   * part -> [{ parts (original case), joiner, synsetKey, proper }].
   */
  _buildBlankIndex() {
    const index = new Map();
    for (const s of this.wn.synsets.values()) {
      for (const lemma of s.words) {
        if (!/[_-]/.test(lemma)) continue;
        const joiner = lemma.includes('_') ? ' ' : '-';
        const parts = lemma.split(/[_-]/);
        if (parts.length < 2 || parts.length > 3 || !parts.every((p) => /^[A-Za-z]+$/.test(p))) continue;
        const proper = /[A-Z]/.test(lemma);
        if (proper && TAXONOMIC_LEX.has(s.lexFile)) continue; // "genus Ara", "Eschrichtius robustus"
        if (parts.some((p) => TAXONOMIC_PART.test(p))) continue;
        for (const p of new Set(parts.map((x) => x.toLowerCase()))) {
          if (p.length < 3) continue;
          if (!index.has(p)) index.set(p, []);
          index.get(p).push({ parts, joiner, synsetKey: s.key, proper });
        }
      }
    }
    return index;
  }

  /** Ways to read an answer: [{ lemma, form|null, pos|null, related: string[] }]. */
  readings(WORD) {
    const { wn, lex } = this;
    const out = [];
    const lw = WORD.toLowerCase();
    const phrase = (this.phraseLemmas.get(WORD) ?? this.joinedLemmas.get(lw))?.toLowerCase();
    if (phrase && wn.has(phrase)) out.push({ lemma: phrase, form: null, pos: null, related: phrase.split(/[_-]/) });
    if (wn.has(lw) && lw !== phrase) out.push({ lemma: lw, form: null, pos: null, related: [] });
    // Parts of speech in which the word is an ordinary (lowercase) lemma of its own; TIGERS (only "Tamil Tigers")
    // still gets read as the plural of "tiger".
    const ownPos = new Set(['n', 'v', 'a', 'r'].filter((p) => wn.hasLower(lw, p)));
    for (const a of lex.analyses(lw)) {
      // Skip the inflectional reading when the word has its own entry in that part of speech (FEED is not "fee" +
      // -ED) — except plurals of more frequent nouns (FINDINGS: "finding" + -S as well as "findings" = tools).
      const morePopularPlural = a.form === 'pl' && wn.freq(a.base) > wn.freq(lw);
      if (ownPos.has(a.pos) && !morePopularPlural) continue;
      if (ownPos.size && wn.freq(a.base) < wn.freq(lw)) continue;
      out.push({ lemma: a.base, form: a.form, pos: a.pos, related: [a.base] });
    }
    return out;
  }

  /** Up to MAX_CLUES clues for an uppercase answer, best first. */
  cluesFor(WORD) {
    const readings = this.readings(WORD);
    const related = [...new Set(readings.flatMap((r) => [r.lemma, ...r.related]))].flatMap((r) => r.split(/[_-]/));
    const candidates = [];
    const accept = (text) => text && text.length <= MAX_CLUE_LENGTH && !clueLeaks(text, WORD, related) &&
      !textHasBannedWord(text, this.isBanned);

    // Senses across readings, most frequent first.
    const senses = [];
    readings.forEach((r, ri) => {
      for (const s of this.wn.senses(r.lemma, r.form ? formPos(r.form) : null)) {
        if (this._offensive(s.synset) || this._taxonomicOnly(s.synset, r.lemma)) continue;
        if (r.form && this._properSense(s.synset, r.lemma)) continue; // LAMBS is not "English essayists"
        senses.push({ ...s, reading: r, ri });
      }
    });
    senses.sort((a, b) => b.tags - a.tags || a.ri - b.ri || a.rank - b.rank);
    const seenSynsets = new Set();
    let senseIndex = 0;
    for (const sense of senses) {
      if (senseIndex >= MAX_SENSES) break;
      if (seenSynsets.has(sense.synset.key)) continue;
      seenSynsets.add(sense.synset.key);
      const weight = SENSE_WEIGHTS[senseIndex] ?? 0.2;
      const sid = senseIndex++;
      const syns = this._synonymCandidates(sense, WORD);
      if (sense.pos === 'r' && !sense.reading.form) syns.push(...this._adverbCandidates(sense));
      syns.forEach((syn, k) => {
        if (accept(syn.text)) candidates.push({ text: syn.text, value: weight * syn.quality * 0.85 ** k, sid, kind: 'syn' });
      });
      const g = this._glossCandidate(sense);
      if (accept(g)) {
        const lenFactor = g.length <= 35 ? 1.05 : g.length > 50 ? 0.9 : 1;
        candidates.push({ text: g, value: weight * lenFactor, sid, kind: 'gloss' });
      }
      if (sid < 3 && sense.pos === 'n') {
        const k = this._kindCandidate(sense);
        if (accept(k)) candidates.push({ text: k, value: weight * 0.7, sid, kind: 'kind' });
      }
    }
    const blank = this._blankCandidate(WORD, readings);
    if (blank && accept(blank.text)) candidates.push({ text: blank.text, value: blank.value, sid: -1, kind: 'blank' });

    // Pick the best distinct clues: at most 2 per sense; no clue that merely repeats another.
    candidates.sort((a, b) => b.value - a.value);
    const picked = [];
    const perSense = new Map();
    for (const c of candidates) {
      if (picked.length >= MAX_CLUES) break;
      const key = c.text.toLowerCase();
      const letters = key.replace(/[^a-z]/g, '');
      const repeats = picked.some((p) => {
        const q = p.text.toLowerCase();
        const ql = q.replace(/[^a-z]/g, '');
        return ql === letters || q.startsWith(`${key},`) || key.startsWith(`${q},`) ||
          q.startsWith(`${key} `) || key.startsWith(`${q} `) || // "Flick-knife" = "Flick knife"
          ql.includes(letters) || letters.includes(ql); // "Of a light shade of red" / "Light shade of red"
      });
      if (repeats || (c.sid >= 0 && (perSense.get(c.sid) || 0) >= 2)) continue;
      if (c.kind === 'kind') {
        // One "Kind of X" at most, and none that repeats a word already used ("Male singers" + "Some singers").
        const head = key.split(' ').pop();
        if (picked.some((p) => p.kind === 'kind' || p.text.toLowerCase().includes(head))) continue;
      }
      perSense.set(c.sid, (perSense.get(c.sid) || 0) + 1);
      picked.push(c);
    }
    return picked.map((c) => c.text);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Synonyms

  /** Synonym clues from one sense, best first: [{ text, quality }]. */
  _synonymCandidates(sense, WORD) {
    const { lex } = this;
    const { synset, reading } = sense;
    const own = reading.lemma.replace(/[_-]/g, '');
    const out = [];
    const consider = (lemma, qualityFactor = 1) => {
      const text = lemma.replace(/_/g, ' ');
      const flat = text.toLowerCase().replace(/[ -]/g, '');
      if (flat === own || flat === WORD.toLowerCase()) return;
      if (/[^A-Za-z '-]/.test(text) || text === text.toUpperCase()) return; // digits, periods, acronyms
      const parts = text.split(/[ -]/);
      if (parts.length > 4 || text.length > 32) return;
      const isProper = /^[A-Z]/.test(text);
      if (isProper) {
        // Proper-noun epithets need at least two words ("Buckeye State"); bare alternative names are poor clues,
        // and Latin binomials ("Eschrichtius robustus") are not clues at all.
        if (parts.length < 2 || TAXONOMIC_LEX.has(synset.lexFile)) return;
        if (!parts.every((p) => /^[A-Z]/.test(p) || CONNECTORS.has(p) || (lex.level(p) ?? 99) <= 35)) return;
      } else {
        if (parts.length === 1 && text.length < 3) return; // "xl" for FORTY
        for (const p of parts) {
          if (/^[A-Z]/.test(p) || (p.length <= 2 && parts.length > 1)) continue;
          const lvl = lex.level(p);
          if (!lvl || lvl > 50) return; // obscure synonym
        }
      }
      let clue = text;
      if (reading.form) {
        if (isProper) return;
        clue = lex.inflectPhrase(text.toLowerCase(), reading.form);
        if (!clue) return;
      }
      const lvl = parts.length === 1 ? lex.level(parts[0].toLowerCase()) : null;
      let quality = parts.length > 1 ? (isProper ? 1.1 : 0.95) : lvl && lvl <= 35 ? 1.15 : 1.02;
      // Prefer synonyms the corpus actually uses in this sense.
      if (this.wn.tagCount(lemma.toLowerCase(), synset.key) > 0) quality *= 1.05;
      out.push({ text: isProper ? clue : capitalize(clue), quality: quality * qualityFactor });
    };
    // (The head adjective of a satellite's cluster is deliberately not used: it is usually far too broad —
    // "Chromatic" for AQUAMARINE, "Cardinal" for FORTY.)
    for (const w of synset.words) consider(w);
    out.sort((a, b) => b.quality - a.quality);
    return out;
  }

  /** IDEALLY -> "Perfectly": adverbs formed from synonyms of the adjective an -LY adverb derives from. */
  _adverbCandidates(sense) {
    const out = [];
    for (const p of sense.synset.ptrs) {
      if (p.sym !== '\\') continue;
      const adj = this.wn.synsets.get(p.key);
      if (!adj) continue;
      // Only true synonyms of the adjective (its similar-to cluster is too loose: "consistent" ~ "agreeable").
      for (const w of adj.words) {
        if (!/^[a-z]+$/.test(w) || (this.lex.level(w) ?? 99) > 50) continue;
        const adv = toAdverb(w).find((c) => this.wn.hasLower(c, 'r')); // WordNet must know it as an adverb
        if (adv) out.push({ text: capitalize(adv), quality: 0.95 });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Glosses

  /** Shortened (and, for inflected answers, inflected) gloss of a sense, or null. */
  _glossCandidate(sense) {
    const { synset, reading } = sense;
    const def = glossDefinition(synset.gloss);
    let { text } = def;
    const { domain } = def;
    if (!text) return null;
    // Verb definitions may end on a verb ("Move or force"); noun/adjective ones must not ("shrub grown").
    const opts = sense.pos === 'v' ? { ...this.glossOpts, badEnding: undefined } : this.glossOpts;
    const finish = (t) => (t ? finishGlossText(t, domain, opts) : null);
    if (sense.pos === 'n') {
      // Nouns glossed like "walks with regular or stately step" (MARCHER) or "accelerates a continuous beam of
      // electrons" (BETATRON) read better as "One who walks ..." / "One that accelerates ...".
      const first = text.split(' ')[0];
      if (!reading.form && this.lex.analyses(first).some((a) => a.pos === 'v' && a.form === 's') &&
          !this.lex.hasLemma(first, 'n')) {
        return finish(`${synset.lexFile === 'noun.person' ? 'one who' : 'one that'} ${text}`);
      }
      // Pluralizing needs a countable head: trust an article in the gloss ("a sculpture representing ..."), else
      // require a head that is not also a verb ("lack of respect" must not become "lacks of respect").
      const countable = /^(a|an)\s/i.test(text);
      let number = reading.form === 'pl' ? (countable ? 'plural' : 'plural?') : 'same';
      if (!reading.form && !/s$/.test(reading.lemma)) number = 'singular-if-plural'; // LARK: "North American songbirds ..." 
      if (ANY_OF.test(text)) {
        // WordNet's "any of various Xs" reads better as plain "X" (or "Xs" for a plural answer).
        text = text.replace(ANY_OF, '');
        number = reading.form === 'pl' ? 'same' : 'singular';
      }
      for (const { text: t, minCut } of this._fitNounPhrase(text.replace(/^(a|an|the)\s+/i, ''), number)) {
        const g = finishGlossText(t, domain, { ...this.glossOpts, minCut });
        if (g) return g;
      }
      return null;
    }
    if (sense.pos === 'v') text = text.replace(/^to\s+/, ''); // "to move or force" -> "move or force"
    if (!reading.form) return finish(text);
    if (reading.pos === 'v') return finish(this._inflectVerbPhrase(text, reading.form));
    return null; // comparatives/superlatives: synonyms only
  }

  _isNounToken(tok) {
    const w = tok.toLowerCase().replace(/[^a-z-]/g, '');
    if (!w) return false;
    return (this.lex.hasLemma(w, 'n') && !this.lex.hasLemma(w, 'a')) ||
      this.lex.analyses(w).some((a) => a.form === 'pl');
  }

  /** A noun, or a noun/adjective used mostly as a noun ("color averaging", but not "black flying insect"). */
  _isMostlyNoun(tok) {
    if (this._isNounToken(tok)) return true;
    const w = tok.toLowerCase();
    return this.lex.hasLemma(w, 'n') && this.wn.posFreq(w, 'n') > this.wn.posFreq(w, 'a');
  }

  /** Index of the head noun of the noun phrase that starts a definition. */
  _headIndex(toks) {
    for (let i = 1; i < toks.length; i++) {
      const prev = toks[i - 1];
      const t = toks[i].toLowerCase();
      if (/[,;:]$/.test(prev)) return i - 1;
      if (NP_END.has(t) && !(t === 'or' || t === 'and')) return i - 1;
      if ((t === 'the' || t === 'a' || t === 'an') && (this._isNounToken(prev) || this.lex.hasLemma(prev.toLowerCase(), 'n'))) {
        return i - 1; // "fly | the female of which"
      }

      const modifierLike = NP_END_AFTER_NOUN.has(t) || /(ed|ing|ly)$/.test(t) ||
        this.lex.analyses(t).some((a) => a.pos === 'v' && a.form !== 's'); // "shrubs | grown for"
      if (modifierLike && this._isMostlyNoun(prev) && !this._isNounToken(t)) return i - 1;
    }
    return toks.length - 1;
  }

  /**
   * Candidate texts ({ text, minCut }) for a noun definition, best first, with its head noun put in the wanted number
   * ('same' | 'plural' | 'singular'): the whole phrase, the noun phrase without its tail, and the noun phrase with
   * leading modifiers dropped until it fits ("widely distributed fast-moving ten-armed cephalopod mollusk" ->
   * "fast-moving ten-armed cephalopod mollusk"). Relative clauses are dropped when the number changes (agreement).
   */
  _fitNounPhrase(text, number) {
    const toks = text.split(' ').filter(Boolean);
    if (!toks.length) return [];
    const h = this._headIndex(toks);
    const headRaw = toks[h];
    const head = headRaw.replace(/[,;:]$/, '');
    const punct = headRaw.slice(head.length);
    let newHead = head;
    if (number === 'singular-if-plural') {
      // A singular answer whose definition is written in the plural: singularize a plural head that isn't a lemma
      // of its own ("songbirds" -> "songbird"; "glasses" stays).
      const base = this.lex.isLemma(head) ? null : this.lex.analyses(head).find((a) => a.form === 'pl')?.base;
      if (base) newHead = base;
      number = base ? 'singular' : 'same';
    } else if (number !== 'same') {
      if (!/^[a-z-]+$/.test(head) || NOT_HEAD_NOUNS.has(head)) return [];
      if (number === 'plural' || number === 'plural?') {
        if (!this.lex.hasLemma(head, 'n') || (number === 'plural?' && this.lex.hasLemma(head, 'v'))) return [];
        if (/ing$/.test(head)) return []; // gerunds don't pluralize ("making to seem ...")
        newHead = this.lex.inflect(head, 'pl');
      } else {
        newHead = this.lex.analyses(head).find((a) => a.form === 'pl')?.base ?? (this.lex.hasLemma(head, 'n') ? head : null);
      }
      if (!newHead) return [];
    }
    if (number !== 'same' && KIND_HEADS.has(head)) return []; // "kind of gun emplacement" has no good plural
    let rest = toks.slice(h + 1);
    if (number !== 'same' && rest.length && RELATIVE.has(rest[0].toLowerCase())) rest = [];
    const before = toks.slice(0, h);
    if (number !== 'same' && newHead !== head) {
      // Coordinated heads change together: "lay judge or civil authority" -> "lay judges or civil authorities".
      for (let j = 0; j + 1 < before.length; j++) {
        if (!/^(or|and)$/.test(before[j + 1]) || !this._isNounToken(before[j])) continue;
        const w = before[j];
        const changed = number === 'singular'
          ? this.lex.analyses(w).find((a) => a.form === 'pl')?.base
          : (this.lex.hasLemma(w, 'n') ? this.lex.inflect(w, 'pl') : null);
        if (!changed) return [];
        before[j] = changed;
      }
    }
    const np = [...before, newHead + (rest.length ? punct : '')];
    if (number.startsWith('plural') && np.length === 1 && !rest.length) return []; // a bare plural is a synonym
    // Each candidate: { text, minCut } — never cut inside the noun phrase itself.
    const npText = np.join(' ');
    const out = [{ text: [...np, ...rest].join(' '), minCut: npText.length }];
    // The bare noun phrase, when it says something on its own ("Act", "Someone" do not).
    if (rest.length && np.length >= 2 && !NOT_HEAD_NOUNS.has(head) && !GENERIC_HYPERNYMS.has(head)) {
      out.push({ text: npText, minCut: npText.length });
    }
    // Drop leading modifiers. Dropping one conjunct of "tropical and nocturnal" keeps the statement true; dropping
    // one alternative of "black or dark purple" would not, so 'or' stops the trimming.
    const mods = np.slice();
    while (mods.join(' ').length > MAX_CLUE_LENGTH && mods.length > 2) {
      if (mods[0] === 'or' || mods[1] === 'or' || /,$/.test(mods[0])) break;
      if (mods[1] === 'and') mods.splice(0, 2);
      else if (mods[0] === 'and') mods.shift();
      else mods.shift();
    }
    const short = mods.join(' ');
    if (mods.length < np.length && short.length <= MAX_CLUE_LENGTH) out.push({ text: short, minCut: short.length });
    return out;
  }

  /** "forsake, leave behind" + 's' -> "forsakes, leaves behind"; null when unsure. */
  _inflectVerbPhrase(text, form) {
    const toks = text.split(' ');
    const inflectTok = (tok) => {
      const m = tok.match(/^([a-z]+)([,;]?)$/);
      if (!m || !this.lex.hasLemma(m[1], 'v')) return null;
      if (m[1] === 'be') {
        const be = { s: 'is', ing: 'being', past: 'was', pp: 'been', ed: 'was' }[form];
        return be ? be + m[2] : null;
      }
      const inf = this.lex.inflect(m[1], form);
      return inf ? inf + m[2] : null;
    };
    const first = inflectTok(toks[0]);
    if (!first) return null;
    const out = [first];
    // Coordinated verbs share the inflection ("forsake, leave behind" -> "forsakes, leaves behind",
    // "put in order or neaten" -> "puts in order or neatens") unless they hang off an infinitive
    // ("cause to be or become" -> "causes to be or become").
    // bareVerb: the current coordinate so far is just a verb plus particles/adverbs ("forsake", "leave behind"),
    // so a following "or"/"," starts another verb; after an object ("require time | or space") it does not.
    let bareVerb = true;
    let sawTo = false;
    let skippedVerb = false; // a coordinated verb we left alone: inflecting a later one would be inconsistent
    for (let i = 1; i < toks.length; i++) {
      const prev = toks[i - 1];
      // An infinitive ("cause to be or become") — not the preposition in "from one region to another and settle".
      if (prev === 'to') {
        const t = toks[i].replace(/[,;]$/, '');
        if (this.lex.hasLemma(t, 'v') && this.wn.posFreq(t, 'v') >= this.wn.posFreq(t, 'n')) sawTo = true;
      }
      const coordinated = /,$/.test(prev) || prev === 'or' || prev === 'and';
      if (coordinated && !sawTo) {
        const bare = toks[i].replace(/[,;]$/, '');
        const { lex } = this;
        const isVerb = lex.hasLemma(bare, 'v');
        const verbOnly = isVerb && !lex.hasLemma(bare, 'n') && !lex.hasLemma(bare, 'a');
        // "... and settle there": mostly used as a verb (corpus counts), so it is the next coordinated verb;
        // "time or space": mostly a noun, so it is part of the object.
        const wn = this.wn;
        const verbDominant = isVerb && wn.posFreq(bare, 'v') > wn.posFreq(bare, 'n') + wn.posFreq(bare, 'a');
        if ((bareVerb && isVerb) || verbOnly || verbDominant) {
          if (skippedVerb) return null;
          const inf = inflectTok(toks[i]);
          if (!inf) return null;
          out.push(inf);
          bareVerb = true;
          continue;
        }
        if (isVerb) skippedVerb = true;
      }
      out.push(toks[i]);
      const t = toks[i].replace(/[,;]$/, '');
      if (!(t === 'or' || t === 'and' || PARTICLES.has(t) || /ly$/.test(t))) bareVerb = false;
    }
    return out.join(' ');
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Hypernym and fill-in-the-blank clues

  /** "Kind of lizard" (or "Some lizards" for a plural answer) from a common noun's hypernym, or null. */
  _kindCandidate(sense) {
    const { synset, reading } = sense;
    if (synset.ptrs.some((p) => p.sym === '@i')) return null; // instances (places, people): the gloss says more
    for (const p of synset.ptrs) {
      if (p.sym !== '@') continue;
      const hyper = this.wn.synsets.get(p.key);
      if (!hyper) continue;
      // A synset led by a vague word ("person, individual, someone, ..., soul") is vague as a whole.
      if (GENERIC_HYPERNYMS.has(hyper.words[0])) continue;
      for (const w of hyper.words) {
        if (/[A-Z]/.test(w) || GENERIC_HYPERNYMS.has(w)) continue;
        const parts = w.split(/[_-]/);
        if (parts.length > 2 || !parts.every((x) => (this.lex.level(x) ?? 99) <= 35)) continue;
        const phrase = w.replace(/_/g, ' ');
        if (reading.form === 'pl') {
          // Mass-noun hypernyms don't pluralize ("bark" of a magnolia): skip heads that are also verbs.
          if (this.lex.hasLemma(parts[parts.length - 1], 'v')) return null;
          const pl = this.lex.inflectPhrase(phrase, 'pl');
          // The plural must be a common word: "Some precipitations" is not English.
          return pl && (this.lex.level(pl.split(' ').pop()) ?? 99) <= 50 ? `Some ${pl}` : null;
        }
        return reading.form ? null : `Kind of ${phrase}`;
      }
    }
    return null;
  }

  /** A fill-in-the-blank clue from a WordNet phrase containing the answer as a whole word, or null. */
  _blankCandidate(WORD, readings) {
    const lw = WORD.toLowerCase();
    const entries = this.blankIndex.get(lw);
    if (!entries) return null;
    const ownSynsets = new Set(readings.filter((r) => !r.form).flatMap((r) => this.wn.senses(r.lemma).map((s) => s.synset.key)));
    let best = null;
    for (const e of entries) {
      const synset = this.wn.synsets.get(e.synsetKey);
      if (!synset || this._offensive(synset)) continue;
      const lowerParts = e.parts.map((p) => p.toLowerCase());
      if (lowerParts.join('') === lw) continue;
      const others = lowerParts.filter((p) => p !== lw);
      if (others.length !== lowerParts.length - 1) continue; // answer appears twice
      let value;
      if (ownSynsets.has(e.synsetKey) && e.proper) {
        value = 0.9; // the answer's own fuller name: "Lake ___", "Yoko ___", "Mount ___"
      } else {
        if (e.proper) continue;
        const score = this.phraseScores.get(lowerParts.join('').toUpperCase());
        if (!score || score < 40) continue; // only lively, common phrases
        if (!others.every((p) => (this.lex.level(p) ?? 99) <= 35)) continue;
        value = Math.min(0.8, 0.62 + (score - 40) / 60); // a definition stays first
      }
      const text = e.parts.map((p) => (p.toLowerCase() === lw ? '___' : p)).join(e.joiner);
      const clue = text.startsWith('___') ? text : capitalize(text);
      if (!best || value > best.value) best = { text: clue, value };
    }
    return best;
  }
}

/** Candidate -LY adverbs of an adjective: happy -> happily, gentle -> gently, tragic -> tragically, full -> fully. */
function toAdverb(adj) {
  const out = [];
  if (/[^aeiou]y$/.test(adj)) out.push(adj.slice(0, -1) + 'ily');
  if (/[^aeiou]le$/.test(adj)) out.push(adj.slice(0, -1) + 'y');
  if (/ic$/.test(adj)) out.push(adj + 'ally');
  if (/ll$/.test(adj)) out.push(adj + 'y');
  if (/ue$/.test(adj)) out.push(adj.slice(0, -1) + 'ly');
  out.push(adj + 'ly');
  return out;
}
