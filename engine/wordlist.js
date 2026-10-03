// WordList: the scored word list used by the fill engine, layout generator and candidate ranking (SPEC §3.1).
//
// Source of truth is a map word → score grouped by length, plus a set of banned words. For matching, each length
// gets a lazily (re)built Lexicon (see lexicon.js) holding only usable words — not banned, score > 0 — sorted by
// score so a minScore cut is a prefix of the index space. Edits (add/ban/unban) only invalidate the lexicon of the
// affected length; it is rebuilt on next use (a few ms for the biggest lengths).
//
// Conventions:
//   • Words are normalised to A–Z (accents stripped, everything else dropped). Lengths 2..25 are kept.
//   • Score 0 means "never use": such words are stored (score() returns 0) but has() is false and they never match.
//   • add() also un-bans the word (adding a word means you want it).

import { Lexicon, comparePairs } from './lexicon.js';
import { normalizeWord } from './util.js';

export const MIN_WORD_LENGTH = 2;
export const MAX_WORD_LENGTH = 25;
const DEFAULT_SCORE = 50;

export class WordList {
  constructor() {
    /** @type {Map<string, number>[]} index = length */
    this._byLen = [];
    this._banned = new Set();
    this._lex = []; // Lexicon | null | undefined (undefined = needs rebuild)
    this._size = 0; // usable words (score > 0, not banned)
  }

  /** Parse wordlist.txt format (`WORD;SCORE` lines, `#` comments). */
  static fromText(text) {
    const wl = new WordList();
    wl.load(text);
    return wl;
  }

  /** Add more `WORD;SCORE` lines (later lines override earlier ones). */
  load(text) {
    const lines = String(text ?? '').split('\n');
    for (let raw of lines) {
      raw = raw.trim();
      if (!raw || raw[0] === '#') continue;
      const semi = raw.indexOf(';');
      const wordPart = semi < 0 ? raw : raw.slice(0, semi);
      const score = semi < 0 ? DEFAULT_SCORE : parseScore(raw.slice(semi + 1));
      // Fast path for already-clean words (the generated list); normalise anything else.
      const word = /^[A-Z]+$/.test(wordPart) ? wordPart : normalizeWord(wordPart);
      this._set(word, score);
    }
    return this;
  }

  /** Apply data/user-words.txt: `WORD;SCORE` adds/overrides (and un-bans), `-WORD` bans, `#` comments. */
  applyUserWords(text) {
    for (let raw of String(text ?? '').split('\n')) {
      raw = raw.trim();
      if (!raw || raw[0] === '#') continue;
      if (raw[0] === '-') {
        this.ban(raw.slice(1));
        continue;
      }
      const semi = raw.indexOf(';');
      if (semi < 0) this.add(raw);
      else this.add(raw.slice(0, semi), parseScore(raw.slice(semi + 1)));
    }
    return this;
  }

  /** Add a word or override its score. Also removes it from the banned set. Returns the normalised word or null. */
  add(word, score = DEFAULT_SCORE) {
    const w = normalizeWord(word);
    if (!this._set(w, clampScore(score))) return null;
    if (this._banned.delete(w) && this._usable(w)) this._size++;
    return w;
  }

  ban(word) {
    const w = normalizeWord(word);
    if (!w || this._banned.has(w)) return;
    const wasUsable = this._usable(w);
    this._banned.add(w);
    if (wasUsable) this._size--;
    this._invalidate(w.length);
  }

  unban(word) {
    const w = normalizeWord(word);
    if (!this._banned.delete(w)) return;
    if (this._usable(w)) this._size++;
    this._invalidate(w.length);
  }

  isBanned(word) {
    return this._banned.has(normalizeWord(word));
  }

  /** True if the word is usable: present, score > 0 and not banned. */
  has(word) {
    const w = normalizeWord(word);
    return this._usable(w);
  }

  /** Stored score (even for banned words), or undefined. */
  score(word) {
    const w = normalizeWord(word);
    return this._byLen[w.length]?.get(w);
  }

  /** Number of usable words. */
  get size() {
    return this._size;
  }

  /** Lengths that have at least one usable word. */
  lengths() {
    const out = [];
    for (let L = MIN_WORD_LENGTH; L <= MAX_WORD_LENGTH; L++) if (this.lexicon(L)?.n) out.push(L);
    return out;
  }

  /**
   * The indexed lexicon of usable words of one length (sorted by score desc, then alphabetically), or null if
   * there are none. Treat it as read-only; it is replaced (not mutated) when the list changes.
   */
  lexicon(length) {
    let lex = this._lex[length];
    if (lex === undefined) {
      const map = this._byLen[length];
      const pairs = [];
      if (map) {
        for (const [w, s] of map) if (s > 0 && !this._banned.has(w)) pairs.push([w, s]);
      }
      pairs.sort(comparePairs);
      lex = pairs.length ? new Lexicon(length, pairs) : null;
      this._lex[length] = lex;
    }
    return lex;
  }

  /**
   * Words matching a pattern ('.' = any letter; '?', '_' and ' ' also accepted), best score first then A–Z.
   * Options: minScore (default 0), limit (default Infinity), exclude (Set of words to skip).
   */
  match(pattern, { minScore = 0, limit = Infinity, exclude = null } = {}) {
    const lex = this.lexicon(String(pattern).length);
    if (!lex || limit <= 0) return [];
    const fixed = lex.constraints(String(pattern));
    if (!fixed) return [];
    const out = [];
    lex.scan(fixed, lex.prefixCount(Math.max(1, minScore)), (i) => {
      const word = lex.words[i];
      if (exclude && exclude.has(word)) return true;
      out.push({ word, score: lex.scores[i] });
      return out.length < limit;
    });
    return out;
  }

  /** Number of words matching a pattern with score >= minScore. */
  count(pattern, { minScore = 0 } = {}) {
    const lex = this.lexicon(String(pattern).length);
    if (!lex) return 0;
    const fixed = lex.constraints(String(pattern));
    if (!fixed) return 0;
    return lex.countMatches(fixed, lex.prefixCount(Math.max(1, minScore)));
  }

  // -------------------------------------------------------------------------
  // internals

  _usable(w) {
    const s = this._byLen[w.length]?.get(w);
    return s !== undefined && s > 0 && !this._banned.has(w);
  }

  /** Set a (normalised) word's score; keeps `size` in sync. Returns false for unusable lengths. */
  _set(w, score) {
    const L = w.length;
    if (L < MIN_WORD_LENGTH || L > MAX_WORD_LENGTH) return false;
    let map = this._byLen[L];
    if (!map) map = this._byLen[L] = new Map();
    const before = this._usable(w);
    map.set(w, score);
    const after = this._usable(w);
    this._size += (after ? 1 : 0) - (before ? 1 : 0);
    this._invalidate(L);
    return true;
  }

  _invalidate(length) {
    this._lex[length] = undefined;
  }
}

function clampScore(s) {
  const n = Math.round(Number(s));
  if (!Number.isFinite(n)) return DEFAULT_SCORE;
  return n < 0 ? 0 : n > 100 ? 100 : n;
}

function parseScore(text) {
  const n = parseInt(text, 10);
  return Number.isFinite(n) ? clampScore(n) : DEFAULT_SCORE;
}
