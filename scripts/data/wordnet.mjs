// WordNet 3.1 reader (the `wordnet-db` package ships the raw Princeton dict files).
//
// We parse the four data.* files (synsets: words, pointers, gloss), the four index.* files (which list each
// lemma's synsets in sense-frequency order) and index.sense (per-sense tag counts from the semantic concordance,
// i.e. how often that sense was seen in a tagged corpus — our best frequency signal).
//
// Keys: a synset is identified by `<filePos><offset>`, e.g. "v00614907", where filePos is n|v|a|r
// (adjective satellites, ss_type 's', live in data.adj and are referenced with pos 'a' by pointers).
// Lemmas in the index are lowercase with '_' for spaces ("ice_cream"); data files keep the original case
// ("Etna", "New_York").

import fs from 'node:fs';
import path from 'node:path';

export const FILE_POS = ['n', 'v', 'a', 'r'];
const POS_FILE_NAME = { n: 'noun', v: 'verb', a: 'adj', r: 'adv' };
const SS_TYPE_NUMBER = { 1: 'n', 2: 'v', 3: 'a', 4: 'r', 5: 'a' }; // index.sense ss_type -> file pos

/** Lexicographer file names (lex_filenum -> name). Useful to recognise people, places, taxa, … */
export const LEX_FILES = [
  'adj.all', 'adj.pert', 'adv.all', 'noun.Tops', 'noun.act', 'noun.animal', 'noun.artifact', 'noun.attribute',
  'noun.body', 'noun.cognition', 'noun.communication', 'noun.event', 'noun.feeling', 'noun.food', 'noun.group',
  'noun.location', 'noun.motive', 'noun.object', 'noun.person', 'noun.phenomenon', 'noun.plant', 'noun.possession',
  'noun.process', 'noun.quantity', 'noun.relation', 'noun.shape', 'noun.state', 'noun.substance', 'noun.time',
  'verb.body', 'verb.change', 'verb.cognition', 'verb.communication', 'verb.competition', 'verb.consumption',
  'verb.contact', 'verb.creation', 'verb.emotion', 'verb.motion', 'verb.perception', 'verb.possession',
  'verb.social', 'verb.stative', 'verb.weather', 'adj.ppl',
];

/**
 * @typedef {{ key: string, pos: string, ssType: string, offset: string, lexFile: string,
 *             words: string[], ptrs: { sym: string, key: string }[], gloss: string }} Synset
 *   words: lemmas as written in the data file (original case, '_' for spaces, adjective markers removed)
 */

/** Parse one data.* line. Exported for tests. */
export function parseDataLine(line, filePos) {
  const bar = line.indexOf(' | ');
  const head = (bar >= 0 ? line.slice(0, bar) : line).trim().split(' ');
  const gloss = bar >= 0 ? line.slice(bar + 3).trim() : '';
  let i = 0;
  const offset = head[i++];
  const lexFile = LEX_FILES[Number(head[i++])] || 'unknown';
  const ssType = head[i++];
  const wCnt = parseInt(head[i++], 16);
  const words = [];
  for (let w = 0; w < wCnt; w++) {
    // Adjectives may carry a syntactic marker: "galore(ip)", "outback(a)".
    words.push(head[i++].replace(/\((?:a|p|ip)\)$/, ''));
    i++; // lex_id
  }
  const pCnt = Number(head[i++]);
  const ptrs = [];
  for (let p = 0; p < pCnt; p++) {
    const sym = head[i++];
    const target = head[i++];
    const pos = head[i++];
    i++; // source/target word numbers
    ptrs.push({ sym, key: (pos === 's' ? 'a' : pos) + target });
  }
  return { key: filePos + offset, pos: filePos, ssType, offset, lexFile, words, ptrs, gloss };
}

export class WordNet {
  constructor() {
    /** @type {Map<string, Synset>} */
    this.synsets = new Map();
    /** lemma (lowercase, '_' spaces) -> { n?: key[], v?: key[], a?: key[], r?: key[] } in sense-frequency order */
    this.index = new Map();
    /** `${lemma}|${synsetKey}` -> tag count */
    this.tagCounts = new Map();
    /** lemma -> total tag count over all its senses */
    this.lemmaFreq = new Map();
    /** pos -> Set of lemmas that occur in lowercase in some synset of that pos (excludes "Taxus"-only genus names) */
    this.lowerLemmas = { n: new Set(), v: new Set(), a: new Set(), r: new Set() };
    this.version = '';
  }

  /** Load all files from a WordNet `dict` directory. Takes ~1 s. */
  static load(dictDir) {
    const wn = new WordNet();
    for (const pos of FILE_POS) {
      const name = POS_FILE_NAME[pos];
      for (const line of readLines(path.join(dictDir, `data.${name}`))) {
        if (!line) continue;
        if (line.startsWith(' ')) {
          // License header lines start with two spaces; pick up the version line.
          const m = !wn.version && line.match(/WordNet (\d+(?:\.\d+)*) Copyright/);
          if (m) wn.version = m[1];
          continue;
        }
        const s = parseDataLine(line, pos);
        wn.synsets.set(s.key, s);
        for (const w of s.words) if (w === w.toLowerCase()) wn.lowerLemmas[pos].add(w);
      }
      for (const line of readLines(path.join(dictDir, `index.${name}`))) {
        if (!line || line.startsWith(' ')) continue;
        // lemma pos synset_cnt p_cnt [ptr_symbol...] sense_cnt tagsense_cnt synset_offset...
        const t = line.trim().split(' ');
        const lemma = t[0];
        const synsetCnt = Number(t[2]);
        const offsets = t.slice(t.length - synsetCnt);
        let entry = wn.index.get(lemma);
        if (!entry) wn.index.set(lemma, (entry = {}));
        entry[pos] = offsets.map((o) => pos + o);
      }
    }
    const senseFile = path.join(dictDir, 'index.sense');
    if (fs.existsSync(senseFile)) {
      for (const line of readLines(senseFile)) {
        // sense_key synset_offset sense_number tag_cnt ; sense_key = lemma%ss_type:lex_filenum:lex_id:head:head_id
        const t = line.split(' ');
        if (t.length < 4) continue;
        const pct = t[0].indexOf('%');
        const lemma = t[0].slice(0, pct).toLowerCase();
        const pos = SS_TYPE_NUMBER[t[0][pct + 1]];
        const count = Number(t[3]) || 0;
        if (!count) continue;
        const k = `${lemma}|${pos}${t[1]}`;
        wn.tagCounts.set(k, (wn.tagCounts.get(k) || 0) + count);
        wn.lemmaFreq.set(lemma, (wn.lemmaFreq.get(lemma) || 0) + count);
      }
    }
    return wn;
  }

  has(lemma) {
    return this.index.has(lemma);
  }

  /** True if `lemma` is a lowercase (common, non-taxonomic) lemma of the given pos ('n'|'v'|'a'|'r'). */
  hasLower(lemma, pos) {
    return this.lowerLemmas[pos].has(lemma);
  }

  /** Synset keys of a lemma for one file pos (n|v|a|r), most frequent sense first. */
  synsetKeys(lemma, pos) {
    return this.index.get(lemma)?.[pos] || [];
  }

  /** Parts of speech a lemma has, e.g. ['n', 'v']. */
  posOf(lemma) {
    const e = this.index.get(lemma);
    return e ? FILE_POS.filter((p) => e[p]) : [];
  }

  tagCount(lemma, synsetKey) {
    return this.tagCounts.get(`${lemma}|${synsetKey}`) || 0;
  }

  freq(lemma) {
    return this.lemmaFreq.get(lemma) || 0;
  }

  /** Corpus tag count of a lemma in one part of speech (sum over its senses). */
  posFreq(lemma, pos) {
    let n = 0;
    for (const key of this.synsetKeys(lemma, pos)) n += this.tagCount(lemma, key);
    return n;
  }

  /**
   * Senses of a lemma (optionally one pos), ordered best first: by tag count (descending), then by the
   * within-POS sense rank, then noun < verb < adj < adv. Each: { synset, pos, rank, tags }.
   */
  senses(lemma, onlyPos = null) {
    const e = this.index.get(lemma);
    if (!e) return [];
    const out = [];
    for (const pos of FILE_POS) {
      if (onlyPos && pos !== onlyPos) continue;
      (e[pos] || []).forEach((key, rank) => {
        const synset = this.synsets.get(key);
        if (synset) out.push({ synset, pos, rank, tags: this.tagCount(lemma, key) });
      });
    }
    const posOrder = { n: 0, v: 1, a: 2, r: 3 };
    out.sort((x, y) => y.tags - x.tags || x.rank - y.rank || posOrder[x.pos] - posOrder[y.pos]);
    return out;
  }
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n');
}
