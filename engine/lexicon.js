// Lexicon: an immutable, indexed set of words that all have the same length.
//
// Words are stored sorted by score (descending) then alphabetically, so "all words with score >= minScore" is
// always a prefix [0, prefixCount(minScore)) of the index space. For every (position, letter) pair there is a
// bitset over word indices (Uint32Array words), so the words matching a pattern are the AND of a few bitsets and
// counting them is a popcount. A 15-letter pattern over ~1–20k words is a few hundred 32-bit ANDs: microseconds.
//
// Layout of `bits`: bits[(pos * 26 + letter) * stride + w] where stride = ceil(n / 32).

import { popcount32, lowBit } from './util.js';

export class Lexicon {
  /**
   * @param {number} length word length
   * @param {Array<[string, number]>} sorted [word, score] pairs already sorted by score desc, then word asc.
   *        Words must be A–Z of exactly `length` letters and unique.
   */
  constructor(length, sorted) {
    const n = sorted.length;
    this.length = length;
    this.n = n;
    this.stride = (n + 31) >>> 5;
    this.words = new Array(n);
    this.scores = new Uint8Array(n);
    this.codes = new Uint8Array(n * length);
    this.bits = new Uint32Array(length * 26 * this.stride);
    this._indexOf = null;
    const { codes, bits, stride } = this;
    for (let i = 0; i < n; i++) {
      const [word, score] = sorted[i];
      this.words[i] = word;
      this.scores[i] = score < 0 ? 0 : score > 255 ? 255 : score;
      const w = i >>> 5;
      const b = 1 << (i & 31);
      const base = i * length;
      for (let p = 0; p < length; p++) {
        const c = word.charCodeAt(p) - 65;
        codes[base + p] = c;
        bits[(p * 26 + c) * stride + w] |= b;
      }
    }
  }

  /** Build from unsorted [word, score] pairs (sorts a copy). */
  static fromPairs(length, pairs) {
    const sorted = pairs.slice().sort(comparePairs);
    return new Lexicon(length, sorted);
  }

  /** Number of words with score >= minScore (they are the first ones). */
  prefixCount(minScore = 0) {
    const s = this.scores;
    let lo = 0;
    let hi = this.n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (s[mid] >= minScore) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Index of a word, or -1. */
  indexOf(word) {
    if (!this._indexOf) {
      this._indexOf = new Map();
      this.words.forEach((w, i) => this._indexOf.set(w, i));
    }
    const i = this._indexOf.get(word);
    return i === undefined ? -1 : i;
  }

  /**
   * Parse a pattern into fixed (position, letter) constraints. Returns null when the pattern length is wrong or a
   * character is neither a letter nor a wildcard ('.', '?', '_', ' ').
   */
  constraints(pattern) {
    if (pattern.length !== this.length) return null;
    const fixed = [];
    for (let p = 0; p < pattern.length; p++) {
      const ch = pattern.charCodeAt(p);
      if (ch >= 65 && ch <= 90) fixed.push((p * 26 + (ch - 65)) * this.stride);
      else if (ch >= 97 && ch <= 122) fixed.push((p * 26 + (ch - 97)) * this.stride);
      else if (ch !== 46 && ch !== 63 && ch !== 95 && ch !== 32) return null;
    }
    return fixed;
  }

  /**
   * Visit matching word indices in order (best score first). `visit(i)` returning false stops the scan.
   * @param {number[]} fixed from constraints()
   * @param {number} limitN only consider indices < limitN (a minScore prefix)
   */
  scan(fixed, limitN, visit) {
    const { bits } = this;
    const nw = (limitN + 31) >>> 5;
    const tail = limitN & 31;
    for (let w = 0; w < nw; w++) {
      let x = -1;
      for (let j = 0; j < fixed.length && x; j++) x &= bits[fixed[j] + w];
      if (w === nw - 1 && tail) x &= (1 << tail) - 1;
      while (x) {
        const t = x & -x;
        if (visit((w << 5) | lowBit(t)) === false) return;
        x ^= t;
      }
    }
  }

  /** Count matches among indices < limitN. */
  countMatches(fixed, limitN) {
    if (!fixed.length) return limitN;
    const { bits } = this;
    const nw = (limitN + 31) >>> 5;
    const tail = limitN & 31;
    let total = 0;
    for (let w = 0; w < nw; w++) {
      let x = bits[fixed[0] + w];
      for (let j = 1; j < fixed.length && x; j++) x &= bits[fixed[j] + w];
      if (w === nw - 1 && tail) x &= (1 << tail) - 1;
      if (x) total += popcount32(x);
    }
    return total;
  }
}

/** Sort order used everywhere: score descending, then word ascending. */
export function comparePairs(a, b) {
  return b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}
