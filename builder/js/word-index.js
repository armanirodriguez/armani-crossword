// Main-thread word lookups for the builder UI (scores in stats, "not in word list" warnings, the Word list view).
// This is deliberately simple — the fill engine has its own fast index inside the worker.
//
// Sources: data/wordlist.txt (`WORD;SCORE`, SPEC §2.6) and data/user-words.txt (`WORD;SCORE` adds/overrides,
// `-WORD` bans, SPEC §2.7).

import { normalizeAnswer } from '../../site/shared/puzzle.js';
import { fetchStatic, api } from './api.js';

/** Parse wordlist.txt / user-words.txt text. Returns { scores: Map<word, score>, bans: Set<word> }. */
export function parseWordText(text, { allowBans = false } = {}) {
  const scores = new Map();
  const bans = new Set();
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (allowBans && line.startsWith('-')) {
      const w = normalizeAnswer(line.slice(1));
      if (w) { bans.add(w); scores.delete(w); }
      continue;
    }
    const semi = line.indexOf(';');
    const w = normalizeAnswer(semi >= 0 ? line.slice(0, semi) : line);
    if (!w) continue;
    const n = semi >= 0 ? Number(line.slice(semi + 1)) : 50;
    const score = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 50;
    scores.set(w, score);
    if (allowBans) bans.delete(w);
  }
  return { scores, bans };
}

export class WordIndex {
  constructor(baseText = '', userText = '') {
    this.base = parseWordText(baseText).scores;
    this.setUserWords(userText);
  }

  setUserWords(text) {
    this.userText = String(text || '');
    const { scores, bans } = parseWordText(this.userText, { allowBans: true });
    this.user = scores;
    this.bans = bans;
    this._sorted = null;
  }

  /** Effective score, or undefined when the word is absent, banned, or has score 0 ("never use"). */
  score(word) {
    const w = normalizeAnswer(word);
    if (this.bans.has(w)) return undefined;
    const s = this.user.has(w) ? this.user.get(w) : this.base.get(w);
    return s === undefined || s === 0 ? undefined : s;
  }

  has(word) { return this.score(word) !== undefined; }

  /** Everything known about a word, for the Word list view. */
  info(word) {
    const w = normalizeAnswer(word);
    return {
      word: w,
      base: this.base.get(w),            // score in data/wordlist.txt (undefined = not there)
      user: this.user.get(w),            // score override from user-words (undefined = none)
      banned: this.bans.has(w),
      score: this.score(w),              // effective (undefined = cannot be used)
    };
  }

  get size() { return this.base.size; }

  /**
   * Words matching a pattern ('.' or '?' = any letter). Sorted by score desc, then alphabetically.
   * Includes user-added words; excludes banned ones.
   */
  match(pattern, { limit = 200, minScore = 1 } = {}) {
    const p = String(pattern).toUpperCase().replace(/\?/g, '.').replace(/[^A-Z.]/g, '');
    if (!p) return [];
    if (!this._sorted) {
      const all = new Map(this.base);
      for (const [w, s] of this.user) all.set(w, s);
      this._sorted = [...all].filter(([w]) => !this.bans.has(w));
    }
    const re = new RegExp(`^${p}$`);
    const out = [];
    for (const [word, score] of this._sorted) {
      if (word.length === p.length && score >= minScore && re.test(word)) out.push({ word, score });
    }
    out.sort((a, b) => b.score - a.score || (a.word < b.word ? -1 : 1));
    return out.slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Shared loading: the same texts feed the main-thread index and the engine worker.

let wordDataPromise = null;
let wordData = null; // { wordlistText, userWordsText } once loaded (userWordsText kept current by setUserWordsText)

/** Load data/wordlist.txt and the user's words once. Resolves to { wordlistText, userWordsText }. */
export function loadWordData() {
  if (!wordDataPromise) {
    wordDataPromise = Promise.all([
      fetchStatic('data/wordlist.txt'),
      api.getUserWords().catch(() => ''),
    ]).then(([wordlistText, userWordsText]) => {
      wordData = { wordlistText: wordlistText || '', userWordsText: userWordsText || '' };
      return wordData;
    });
    wordDataPromise.catch(() => { wordDataPromise = null; }); // allow a retry after a failure
  }
  return wordDataPromise;
}

/** Keep the cached user-words text current (an engine restart re-reads it from here). */
export function setUserWordsText(text) {
  if (wordData) wordData.userWordsText = String(text || '');
}
