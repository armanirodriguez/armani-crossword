// Fillability estimate of a block pattern: the "first moment" — the expected number of complete fills if every
// entry independently took a random word of its length from the list:
//
//   log2 E[#fills] = Σ_entries log2 N(length) + Σ_checked cells log2 P(the across and the down word agree there)
//
// where N(L) is the number of list words of length L (score ≥ minScore) and P(agree) = Σ_letters pA(l) · pD(l), with
// pA / pD the share of words of the across / down entry's length that have letter l at that cell's position.
// Divided by the number of white cells this gives "bits per cell": how much freedom each square keeps once its
// crossings must agree. Long entries cost freedom (there are fewer long words, and each has more letters to agree
// on), so it is mostly a function of the pattern's word-length mix — which makes it a yardstick for block patterns
// of any size. For blank patterns it predicts fill success sharply. Measured with data/wordlist.txt at minScore 30
// (660 patterns from the old generator, 5×5–15×15, one 8 s fill each): below 0.2 bits/cell 1 in 79 filled, 0.2–0.3
// about 2 in 3, 0.3 and up 99.7%; every 7×7 pattern with 6–10 blocks (exhaustively): ≥ 0.37 filled with 3/3 seeds,
// ≤ 0.29 mostly not. Being an average it can miss a hard spot: a 4-block 7×7 with two stacks of 7-letter rows
// (0.41) took 12 s to fill, and a 14×14 at 0.45 with three stacked 8s in a corner never filled. Hence the local
// measure (minWindowBits) and the margin in FILLABLE_BITS.

import { computeEntries } from '../site/shared/grid.js';

/**
 * A blank pattern counts as reliably fillable from FILLABLE_BITS per white cell on average, with no WINDOW × WINDOW
 * square below FILLABLE_WINDOW_BITS (see fillEstimate). Calibrated with the benchmark (scripts/bench-engine.mjs
 * --only blank): with these, 5×5–15×15 patterns at every density filled ≥ 95% within 8 s at minScore 30.
 */
export const FILLABLE_BITS = 0.45;
export const FILLABLE_WINDOW_BITS = 0;
const WINDOW = 5;

/**
 * Without a word list: log2 of the number of words per length (index = length) of a typical crossword list —
 * data/wordlist.txt at minScore 30 — and the mean log2 chance that two crossing letters agree (measured over the
 * checked squares of 180 random patterns with that list: −4.15, i.e. 1 in 18).
 */
const TYPICAL_LOG2_WORDS = [0, 0, 0, 9.45, 11.19, 12.14, 12.86, 13.35, 13.67, 13.59, 13.37, 12.94, 12.3, 11.56, 10.65, 9.64,
  8.34, 7.26, 5.78, 4.91, 3.7, 3.17];
const TYPICAL_LOG2_AGREE = -4.15;

/** Letter statistics of a lexicon's minScore prefix: WeakMap<Lexicon, Map<minScore, { n, p: Float64Array(L × 26) }>>. */
const statsCache = new WeakMap();

/** Number of words and positional letter distribution (p[k × 26 + letter]) of the lexicon's minScore prefix. */
function lexiconStats(lex, minScore) {
  let byScore = statsCache.get(lex);
  if (!byScore) statsCache.set(lex, (byScore = new Map()));
  let st = byScore.get(minScore);
  if (!st) {
    const L = lex.length;
    const n = lex.prefixCount(minScore);
    const p = new Float64Array(L * 26);
    for (let i = 0; i < n; i++) for (let k = 0; k < L; k++) p[k * 26 + lex.codes[i * L + k]]++;
    if (n) for (let j = 0; j < p.length; j++) p[j] /= n;
    st = { n, p };
    byScore.set(minScore, st);
  }
  return st;
}

/**
 * Estimated fillability of a blank pattern (letters in the grid are treated as empty squares). The estimate splits
 * into per-cell shares — each entry's log2 N spread evenly over its letters, plus the cell's agreement term — so it
 * can also be read locally: `minWindowBits` is the lowest mean over any WINDOW × WINDOW square of the grid (with
 * enough white cells), which exposes a hard corner (e.g. three stacked 7- or 8-letter entries crossing long downs)
 * that the rest of a big grid would average away.
 * @param {{width:number,height:number,cells:string[]}} grid
 * @param {import('./wordlist.js').WordList|null} wordlist  null → a typical list's statistics (TYPICAL_*)
 * @param {{minScore?:number}} [opts]
 * @returns {{ bitsPerCell:number, minWindowBits:number, log2Fills:number }} all −Infinity when some entry's length
 *   has no words
 */
export function fillEstimate(grid, wordlist, { minScore = 30 } = {}) {
  const { width: W, height: H, cells } = grid;
  const { across, down, acrossAt, downAt } = computeEntries(grid);
  const stats = new Map();
  /** { log2n, p } for a length: p = positional letter distribution (null without a word list). */
  const statsFor = (L) => {
    if (!stats.has(L)) {
      if (!wordlist) stats.set(L, { log2n: TYPICAL_LOG2_WORDS[L] || -Infinity, p: null });
      else {
        const lex = wordlist.lexicon(L);
        const st = lex ? lexiconStats(lex, minScore) : null;
        stats.set(L, st && st.n ? { log2n: Math.log2(st.n), p: st.p } : { log2n: -Infinity, p: null });
      }
    }
    return stats.get(L);
  };
  const none = { bitsPerCell: -Infinity, minWindowBits: -Infinity, log2Fills: -Infinity };
  const bits = new Float64Array(cells.length).fill(NaN);
  let log2Fills = 0;
  let white = 0;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === '#') continue;
    white++;
    let b = 0;
    const a = across[acrossAt[i]];
    const d = down[downAt[i]];
    const sa = a ? statsFor(a.length) : null;
    const sd = d ? statsFor(d.length) : null;
    if (sa) b += sa.log2n / a.length;
    if (sd) b += sd.log2n / d.length;
    if (sa && sd) {
      if (!wordlist) b += TYPICAL_LOG2_AGREE;
      else if (sa.p && sd.p) {
        const ka = (i - a.cells[0]) * 26;
        const kd = ((i - d.cells[0]) / W) * 26;
        let agree = 0;
        for (let l = 0; l < 26; l++) agree += sa.p[ka + l] * sd.p[kd + l];
        b += Math.log2(agree);
      }
    }
    if (!Number.isFinite(b)) return none;
    bits[i] = b;
    log2Fills += b;
  }
  if (!white) return none;
  // Lowest mean over the k × k windows that are at least 60% white.
  const kw = Math.min(WINDOW, W);
  const kh = Math.min(WINDOW, H);
  let minWindowBits = Infinity;
  for (let r = 0; r + kh <= H; r++) {
    for (let c = 0; c + kw <= W; c++) {
      let sum = 0;
      let n = 0;
      for (let rr = r; rr < r + kh; rr++) {
        for (let cc = c; cc < c + kw; cc++) {
          const b = bits[rr * W + cc];
          if (!Number.isNaN(b)) { sum += b; n++; }
        }
      }
      if (n >= 0.6 * kw * kh && sum / n < minWindowBits) minWindowBits = sum / n;
    }
  }
  return { bitsPerCell: log2Fills / white, minWindowBits: Number.isFinite(minWindowBits) ? minWindowBits : log2Fills / white, log2Fills };
}

/** How far a blank pattern's estimate (fillEstimate) falls short of reliably fillable, in bits; 0 = fillable. */
export function fillShortfall(est) {
  return Math.max(0, FILLABLE_BITS - est.bitsPerCell, FILLABLE_WINDOW_BITS - est.minWindowBits);
}

/**
 * Freedom of one run (entry) of each length, for building patterns line by line: log2 N(L) plus its half of the
 * typical agreement cost of its L checked letters (the crossing entries pay the other half). Summed over a
 * pattern's runs this approximates fillEstimate's log2Fills. Returns a Float64Array indexed by length (0..maxLen);
 * lengths without words get −1000.
 */
export function runBits(wordlist, { minScore = 30, maxLen = 25 } = {}) {
  const out = new Float64Array(maxLen + 1).fill(-1000);
  for (let L = 1; L <= maxLen; L++) {
    let log2n = TYPICAL_LOG2_WORDS[L] || -Infinity;
    if (wordlist) {
      const lex = wordlist.lexicon(L);
      const n = lex ? lex.prefixCount(minScore) : 0;
      log2n = n ? Math.log2(n) : -Infinity;
    }
    if (Number.isFinite(log2n)) out[L] = log2n + 0.5 * L * TYPICAL_LOG2_AGREE;
  }
  return out;
}
