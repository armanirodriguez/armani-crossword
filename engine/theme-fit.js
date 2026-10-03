// Fitting extra theme words into an existing grid (used by the layout generator; see fitWords).
//
// The layout generator places theme answers while it designs the block pattern; answers that did not make it are
// only "preferred" by the fill, which uses them when they happen to suit. fitWords() is the deliberate version:
// for each leftover word (in priority order) it tries the slots of the right length, fixing the word there and
// asking the fill engine for a complete fill around it. The first slot that works is kept, and the next word is
// tried on top of it. Each try is cheap to reject: arc consistency alone rules out most slots instantly.
// Leftovers that a fill already contains (the fill engine prefers them) are fixed in place first, so a later refill
// cannot lose them.

import { computeEntries } from '../site/shared/grid.js';
import { fillGrid, checkFillable } from './fill.js';
import { makeRng, normalizeSeed, normalizeWord, now } from './util.js';

/**
 * @param {object} p
 * @param {{width:number,height:number,cells:string[]}} p.grid  blocks + fixed letters ('' = free to refill)
 * @param {string[]|null} p.filled  a known complete fill of `grid` (used to order the slots), or null
 * @param {string[]} p.words        words to try, best first
 * @param {import('./wordlist.js').WordList} p.wordlist
 * @param {number} [p.minScore=30]
 * @param {number} [p.timeLimitMs=2000]  total budget
 * @param {number} [p.tryMs=400]         budget of one fill attempt
 * @param {number} [p.maxSlots=8]        slots tried per word (after the instant consistency check)
 * @param {*} [p.seed]
 * @param {object|Map|Array} [p.penalize]  answer freshness penalties for the refills (see fillGrid)
 * @param {{aborted:boolean}} [p.signal]
 * @returns {Promise<{ cells, filled, stats, added: {answer,row,col,dir,cells}[], left: string[], tries: number, ms: number, aborted: boolean }>}
 *   cells: the fixed cells plus the added words; filled: a complete fill of `cells` (the given one if no new fill
 *   was needed; null if none was given and nothing was added); stats: fillGrid stats of the new fill, or null.
 */
export async function fitWords({
  grid, filled = null, words, wordlist, minScore = 30, timeLimitMs = 2000, tryMs = 400, maxSlots = 8, seed, penalize,
  signal,
}) {
  const t0 = now();
  const deadline = t0 + Math.max(0, timeLimitMs);
  const { width, height } = grid;
  const rng = makeRng(normalizeSeed(seed));
  let cells = grid.cells.slice();
  let fill = filled ? filled.slice() : null;
  const added = [];
  let left = [...new Set((words || []).map(normalizeWord).filter((w) => w.length >= 3))];
  let tries = 0;
  let aborted = false;
  let stats = null;
  // Entries complete in the caller's grid are theirs (kept as-is, even if unlisted). Every other entry that a placed
  // word completes must be a usable list word: fillGrid only checks entries it fills itself, so the trial fills
  // run with verifyComplete and this whitelist (plus the words added so far).
  const givenComplete = [];
  for (const e of computeEntries(grid).all) {
    const w = e.cells.map((i) => cells[i]).join('');
    if (w.length === e.length && /^[A-Z]+$/.test(w)) givenComplete.push(w);
  }

  /** Fix the leftover words that the current fill already contains (as whole entries) into `cells`. */
  const absorb = () => {
    if (!fill) return;
    for (const e of computeEntries({ width, height, cells: fill }).all) {
      const w = e.cells.map((i) => fill[i]).join('');
      if (!left.includes(w) || !e.cells.some((i) => cells[i] === '')) continue;
      e.cells.forEach((i, k) => { cells[i] = w[k]; });
      added.push({ answer: w, row: e.row, col: e.col, dir: e.dir, cells: e.cells.slice() });
      left = left.filter((x) => x !== w);
    }
  };
  absorb();

  for (const word of left.slice()) {
    if (aborted || now() >= deadline) break;
    if (!left.includes(word)) continue; // absorbed from a fill meanwhile
    const { all } = computeEntries({ width, height, cells });
    // Already in the grid as a complete entry (e.g. the fill used it): nothing to do.
    if (all.some((e) => e.cells.every((i, k) => cells[i] === word[k]))) {
      left = left.filter((w) => w !== word);
      continue;
    }
    // Slots: same length, compatible with the fixed letters, and not completely fixed already.
    const slots = [];
    for (const e of all) {
      if (e.length !== word.length) continue;
      let ok = true;
      let free = 0;
      let agree = 0;
      for (let k = 0; k < e.length && ok; k++) {
        const ch = cells[e.cells[k]];
        if (ch === '') {
          free++;
          if (fill && fill[e.cells[k]] === word[k]) agree++;
        } else if (ch !== word[k]) ok = false;
      }
      if (ok && free) slots.push({ e, key: agree + rng() });
    }
    // Slots where the current fill already agrees with more letters disturb it least: try them first.
    slots.sort((a, b) => b.key - a.key);
    const others = left.filter((w) => w !== word);
    let tested = 0;
    for (const { e } of slots) {
      if (tested >= maxSlots || now() >= deadline) break;
      if (signal && signal.aborted) { aborted = true; break; }
      const trial = cells.slice();
      e.cells.forEach((i, k) => { trial[i] = word[k]; });
      const g = { width, height, cells: trial };
      const verify = { verifyComplete: true, allowComplete: [...givenComplete, ...added.map((a) => a.answer), word] };
      if (!checkFillable(g, wordlist, { minScore, prefer: others, preferFirst: false, ...verify }).ok) continue;
      tested++;
      tries++;
      const res = await fillGrid(g, wordlist, {
        minScore, prefer: others, preferFirst: false, penalize, seed: Math.floor(rng() * 0x7fffffff), signal, ...verify,
        timeLimitMs: Math.max(1, Math.min(tryMs, deadline - now())),
      });
      if (res.reason === 'aborted') { aborted = true; break; }
      if (res.ok) {
        cells = trial;
        fill = res.cells;
        stats = res.stats;
        added.push({ answer: word, row: e.row, col: e.col, dir: e.dir, cells: e.cells.slice() });
        left = others;
        absorb();
        break;
      }
    }
  }
  return { cells, filled: fill, stats, added, left, tries, ms: Math.round(now() - t0), aborted };
}
