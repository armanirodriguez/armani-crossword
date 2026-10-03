// Multi-word entries from WordNet collocations ("ice_cream" -> ICECREAM, "give_up" -> GIVEUP, "free-for-all").
//
// Only collocations whose parts are all common SCOWL words (level <= 40) are considered — except adverb/adjective
// phrases that the sense-tagged corpus attests ("per_se", "ad_hoc", "vice_versa"), which crosswords love.
// Taxonomic phrases ("mint_family"), letter codes ("b_vitamin") and offensive senses are skipped.
//
// Scoring needs positive evidence to reach the default fill threshold (30):
//   24 + commonness (+6 all parts level <= 10, +4 <= 20, 0 <= 35, -4 <= 40)
//      + phrasal verb with a lively particle (give up, cut off) +8 / other verb +3 / adjective or adverb phrase +5
//      + idiomatic noun +4 / compositional noun -5 (its head word names one of its own hypernyms:
//        "brown_bear" IS-A "bear", "film_company" IS-A "company"; but "glass_ceiling" IS-A "barrier")
//      + 6 if corpus-tagged, + 3 per extra sense (max +9), - 3 per part beyond two, -2 (>= 12 letters) / -4 (>= 15)
//      - 6 for plant/animal species, -10 for partial phrases ending in a function word ("out_to"),
//      - 8 for determiner phrases ("each_week")                              -> clamped to [10, 62]

import { isOffensiveSynset } from './offensive.mjs';
import { clampScore } from './scoring.mjs';

const TAXONOMIC_PART = new Set(['genus', 'family', 'order', 'class', 'phylum', 'subfamily', 'suborder', 'subclass',
  'superfamily', 'subphylum', 'tribe', 'division', 'subgenus', 'superorder', 'infraorder']);
// Single-letter parts allowed only in short hyphenated forms: X-RAY, T-SHIRT, U-TURN, E-MAIL, A-ONE.
const LETTER_PARTS = new Set(['x', 't', 'u', 'e', 'a']);
const LIVELY_PARTICLES = new Set(['up', 'out', 'down', 'off', 'away', 'back', 'over', 'through', 'around', 'along',
  'aside', 'apart', 'together', 'about', 'ahead', 'behind', 'forward']);
const LIGHT_VERBS = new Set(['be', 'do', 'go', 'get', 'have', 'make', 'take', 'put', 'set', 'let']);
const HYPERNYM_DEPTH = 6;
const FUNCTION_TAIL = new Set(['to', 'of', 'for', 'with', 'at', 'by', 'from', 'it', 'the', 'a', 'an', 'as', 'than',
  'that', 'and', 'or', 'into', 'onto', 'upon']);
const DETERMINER_HEAD = new Set(['each', 'every', 'this', 'that', 'these', 'those', 'some', 'any', 'all', 'no']);

/** Synset keys of `key` and its hypernym ancestors up to HYPERNYM_DEPTH levels. */
function ancestors(wn, key, cache) {
  let set = cache.get(key);
  if (set) return set;
  set = new Set([key]);
  let frontier = [key];
  for (let d = 0; d < HYPERNYM_DEPTH && frontier.length; d++) {
    const next = [];
    for (const k of frontier) {
      const s = wn.synsets.get(k);
      if (!s) continue;
      for (const p of s.ptrs) {
        if ((p.sym === '@' || p.sym === '@i') && !set.has(p.key)) { set.add(p.key); next.push(p.key); }
      }
    }
    frontier = next;
  }
  cache.set(key, set);
  return set;
}

/**
 * Collect collocation entries.
 * Returns Map<WORD, { score, lemma }> (lemma = WordNet spelling, e.g. "ice_cream").
 * @param {import('./lexicon.mjs').Lexicon} lex
 * @param {(WORD: string) => boolean} isBanned
 */
export function collectCollocations(lex, isBanned, { maxLevel = 40, maxLength = 21 } = {}) {
  const { wn } = lex;
  const out = new Map();
  const ancestorCache = new Map();
  for (const s of wn.synsets.values()) {
    for (const lemma of s.words) {
      if (!/[_-]/.test(lemma)) continue;
      const parts = lemma.split(/[_-]/);
      // Lowercase phrases only (proper names are handled in propernouns.mjs); "T-shirt" style capital letters are OK.
      if (!parts.every((p) => /^[a-z]+$/.test(p) || /^[A-Z]$/.test(p))) continue;
      const lower = parts.map((p) => p.toLowerCase());
      const word = lower.join('').toUpperCase();
      if (word.length < 4 || word.length > maxLength) continue;
      if (lower.some((p) => TAXONOMIC_PART.has(p))) continue;
      const lemmaKey = lemma.toLowerCase();
      const tagged = wn.freq(lemmaKey) > 0;
      let worst = 0;
      let ok = true;
      for (const p of lower) {
        if (p.length === 1) {
          if (p === 'a' || (LETTER_PARTS.has(p) && lower.length === 2 && lemma.includes('-'))) continue;
          ok = false; break;
        }
        const lvl = lex.level(p);
        if (!lvl || lvl > maxLevel) {
          // Foreign set phrases ("per se", "ad hoc") are fine when the corpus attests them.
          if ((s.pos === 'r' || s.pos === 'a') && tagged) { worst = Math.max(worst, 35); continue; }
          ok = false; break;
        }
        worst = Math.max(worst, lvl);
      }
      if (!ok || isBanned(word) || lower.some((p) => p.length >= 3 && isBanned(p.toUpperCase()))) continue;
      if (isOffensiveSynset(s, isBanned)) continue;

      let score = 24;
      score += worst <= 10 ? 6 : worst <= 20 ? 4 : worst <= 35 ? 0 : -4;
      const head = lower[lower.length - 1];
      if (s.pos === 'v') {
        score += lower.length === 2 && LIVELY_PARTICLES.has(head) ? 8 : 3;
        // "be_on", "go_in": a light verb plus a bare preposition is a partial phrase, not a lively entry.
        if (lower.length === 2 && LIGHT_VERBS.has(lower[0]) && !LIVELY_PARTICLES.has(head)) score -= 8;
      }
      else if (s.pos === 'a' || s.pos === 'r') score += 5;
      else {
        const anc = ancestors(wn, s.key, ancestorCache);
        const headSynsets = [...wn.synsetKeys(head, 'n'), ...wn.synsetKeys(head.replace(/s$/, ''), 'n')];
        score += headSynsets.some((k) => anc.has(k)) ? -5 : 4;
      }
      if (tagged) score += 6;
      const senseCount = wn.posOf(lemmaKey).reduce((n, pos) => n + wn.synsetKeys(lemmaKey, pos).length, 0);
      score += Math.min(9, 3 * (senseCount - 1));
      score -= 3 * Math.max(0, lower.length - 2);
      // Partial phrases ("out_to", "on_it") and compositional time phrases ("each_week") are weak fill.
      if (FUNCTION_TAIL.has(head) && !(s.pos === 'v' && LIVELY_PARTICLES.has(head))) score -= 10;
      if (DETERMINER_HEAD.has(lower[0])) score -= 8;
      if (word.length >= 15) score -= 4;
      else if (word.length >= 12) score -= 2;
      if (s.lexFile === 'noun.plant' || s.lexFile === 'noun.animal') score -= 6;
      if (lower.length === 2 && lower.some((p) => p.length === 1)) score += 8; // X-RAY, T-SHIRT, U-TURN: lively
      score = Math.min(62, Math.max(10, clampScore(score)));
      const prev = out.get(word);
      if (!prev || score > prev.score) out.set(word, { score, lemma: lemmaKey });
    }
  }
  return out;
}
