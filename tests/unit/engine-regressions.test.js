// Regression tests for engine review findings (engine/): input hardening, verifying entries that theme letters
// complete on their own, fitWords crossings, theme coverage / ranking in generateLayouts, compound block moves,
// and responsiveness of layout generation on big grids.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WordList } from '../../engine/wordlist.js';
import { fillGrid, checkFillable } from '../../engine/fill.js';
import { generateLayouts, randomPattern, completeBlocks, targetBlocks, maxRunLength, themeScore } from '../../engine/layout.js';
import { rankCandidates } from '../../engine/candidates.js';
import { fitWords } from '../../engine/theme-fit.js';
import { Board } from '../../engine/board.js';
import { makeRng } from '../../engine/util.js';
import { computeEntries, entryPattern, gridFromLayout, validateGrid } from '../../site/shared/grid.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const big = WordList.fromText(readFileSync(path.join(ROOT, 'data/wordlist.txt'), 'utf8'));

/** Grid from rows where letters are pre-filled cells, '.' empty and '#' blocks. */
function grid(rows) {
  const layout = rows.map((r) => r.replace(/[A-Z]/g, '.'));
  return gridFromLayout(layout, rows.join(''));
}

/** Usable fill word: listed with score ≥ minScore. */
const usable = (wl, w, minScore = 30) => wl.has(w) && wl.score(w) >= minScore;

/**
 * Entries of `cells` that are complete, were not complete in `input` (null = none were) and are neither usable list
 * words nor in `allowed`.
 */
function badEntries(width, height, cells, { input = null, allowed = [], wl = big, minScore = 30 } = {}) {
  const g = { width, height, cells };
  const before = input ? computeEntries(input).all.map((e) => entryPattern(input, e)) : null;
  const bad = [];
  computeEntries(g).all.forEach((e, k) => {
    const w = entryPattern(g, e);
    if (w.includes('.')) return;
    if (before && !before[k].includes('.')) return; // the caller's own complete entry
    if (!allowed.includes(w) && !usable(wl, w, minScore)) bad.push(`${e.id}=${w}`);
  });
  return bad;
}

// ---------------------------------------------------------------------------
describe('malformed input never throws', () => {
  const tiny = WordList.fromText('CAT;60\nCOT;55\nACE;50\nTEN;50\nATE;45\nOAT;45\nTOE;40\n');
  const g3 = () => ({ width: 3, height: 3, cells: ['', '', '', '', '', '', '', '', ''] });

  test('fillGrid / checkFillable: missing or odd grid, word list and options give reason "invalid"', async () => {
    for (const bad of [null, undefined, 'grid', 42, {}, { width: 3, height: 3, cells: null }, { width: '3', height: 3, cells: [] }]) {
      const r = await fillGrid(bad, tiny);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'invalid');
      assert.ok(r.problem && typeof r.problem.message === 'string');
      assert.equal(checkFillable(bad, tiny).ok, false);
    }
    for (const wl of [null, undefined, {}, 'CAT;50']) {
      const r = await fillGrid(g3(), wl);
      assert.equal(r.reason, 'invalid', `word list ${JSON.stringify(wl)}`);
    }
  });

  test('fillGrid: null options mean defaults; prefer/avoid accept Sets and strings', async () => {
    const g = grid(['....', '....', '....']);
    const res = await fillGrid(g, big, null);
    assert.equal(res.ok, true);
    const res2 = await fillGrid(g, big, 'nonsense');
    assert.equal(res2.ok, true);
    // prefer as a Set: the preferred word is used.
    const p = await fillGrid(grid(['...', '###', '...']), WordList.fromText('CAT;60\nDOG;60\n'), { prefer: new Set(['EMU']), allowDuplicates: false, minScore: 1 });
    assert.equal(p.ok, true);
    assert.ok(p.cells.join('').includes('EMU'), p.cells.join(''));
    // avoid as a string (comma/space separated) and as a Set: those words are never used.
    for (const avoid of ['CAT', 'cat, dog', new Set(['CAT'])]) {
      const a = await fillGrid(grid(['...', '###', '...']), WordList.fromText('CAT;60\nDOG;50\nEEL;40\nEMU;35\n'), { avoid, minScore: 1 });
      assert.equal(a.ok, true);
      assert.ok(!a.cells.join('').includes('CAT'), `avoid ${String(avoid)}: ${a.cells.join('')}`);
    }
    // Anything else is ignored rather than fatal.
    const odd = await fillGrid(g, big, { prefer: 7, avoid: { a: 1 }, signal: 'x', onProgress: 'y', seed: {} });
    assert.equal(odd.ok, true);
  });

  test('rankCandidates: malformed grid, options or word list give []', () => {
    const g = grid(['C.T', 'A.E', '...']);
    for (const bad of [null, undefined, 'g', {}, { width: 3, height: 3, cells: null }, { width: 3, height: 3, cells: ['C'] },
      { width: 3, height: 3, cells: ['c', '', '', '', '', '', '', '', ''] }]) {
      assert.deepEqual(rankCandidates(bad, '1A', tiny), []);
    }
    assert.deepEqual(rankCandidates(g, '1A', null), []);
    // null options behave like {}.
    assert.deepEqual(rankCandidates(g, '1A', tiny, null), rankCandidates(g, '1A', tiny, {}));
    assert.ok(rankCandidates(g, '1A', tiny, null).length > 0);
  });
});

// ---------------------------------------------------------------------------
describe('fillGrid verifyComplete', () => {
  const wl = WordList.fromText('CAT;60\nARE;50\nTEN;50\nCAN;55\nART;45\nTEE;10\nOAT;45\n');
  // Rows CAT / ARE / TEN: a word square (the downs are CAT, ARE, TEN too).
  const square = () => grid(['CAT', 'ARE', 'TEN']);

  test('without it, complete entries are user-forced and accepted as-is (SPEC)', async () => {
    const g = grid(['CAT', 'ARE', 'TEX']); // 3A TEX and 3D TEX are not words
    const r = await fillGrid(g, wl);
    assert.equal(r.ok, true);
  });

  test('with it, every complete entry must be a usable list word unless allowed', async () => {
    assert.equal((await fillGrid(square(), wl, { verifyComplete: true, allowDuplicates: true })).ok, true);
    const g = grid(['CAT', '###', 'TEX']);
    const r = await fillGrid(g, wl, { verifyComplete: true });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'impossible');
    assert.match(r.problem.entryId, /^[0-9]+[AD]$/);
    assert.match(r.problem.message, /TEX/);
    assert.equal(checkFillable(g, wl, { verifyComplete: true }).ok, false);
    // Whitelisted (e.g. theme answers) are fine.
    assert.equal((await fillGrid(g, wl, { verifyComplete: true, allowComplete: ['TEX'] })).ok, true);
    // Prefer words count as usable too.
    assert.equal((await fillGrid(g, wl, { verifyComplete: true, prefer: ['TEX'] })).ok, true);
    // A listed word below minScore is not usable.
    const low = grid(['TEE', '###', 'CAT']);
    assert.equal((await fillGrid(low, wl, { verifyComplete: true, minScore: 30 })).ok, false);
    assert.equal((await fillGrid(low, wl, { verifyComplete: true, minScore: 5 })).ok, true);
  });

  test('with it, a complete entry may not repeat another one', async () => {
    const g = grid(['CAT', '###', 'CAT']);
    assert.equal((await fillGrid(g, wl)).ok, true, 'user-forced duplicates are kept as-is');
    const r = await fillGrid(g, wl, { verifyComplete: true });
    assert.equal(r.ok, false);
    assert.match(r.problem.message, /repeats/);
    assert.equal((await fillGrid(g, wl, { verifyComplete: true, allowDuplicates: true })).ok, true);
  });
});

// ---------------------------------------------------------------------------
describe('generateLayouts never offers entries that are only theme letters and not words', () => {
  test('5×5 with five 5-letter answers: no gibberish columns from stacked rows', async () => {
    const theme = ['APPLE', 'MANGO', 'GRAPE', 'LEMON', 'PEACH'];
    for (const seed of [1, 2]) {
      const res = await generateLayouts({ width: 5, height: 5, theme, wordlist: big, seed, timeLimitMs: 2500 });
      assert.ok(res.layouts.length >= 1);
      for (const l of res.layouts) {
        assert.deepEqual(badEntries(5, 5, l.cells, { allowed: theme }), [], 'layout cells');
        if (l.filled) assert.deepEqual(badEntries(5, 5, l.filled, { allowed: theme }), [], 'filled');
      }
    }
  });

  test('4×4 and 4×11 shapes with stacked answers', async () => {
    const four = ['BEAR', 'LION', 'WOLF', 'DEER'];
    const r1 = await generateLayouts({ width: 4, height: 4, theme: four, wordlist: big, seed: 3, timeLimitMs: 1500 });
    for (const l of r1.layouts) {
      assert.deepEqual(badEntries(4, 4, l.cells, { allowed: four }), []);
      if (l.filled) assert.deepEqual(badEntries(4, 4, l.filled, { allowed: four }), []);
    }
    const tall = ['WATERMELON', 'STRAWBERRY', 'BLACKBERRY', 'GRAPEFRUIT'];
    const r2 = await generateLayouts({ width: 4, height: 11, theme: tall, wordlist: big, seed: 4, timeLimitMs: 1500 });
    for (const l of r2.layouts) {
      assert.deepEqual(badEntries(4, 11, l.cells, { allowed: tall }), []);
      if (l.filled) assert.deepEqual(badEntries(4, 11, l.filled, { allowed: tall }), []);
    }
  });
});

// ---------------------------------------------------------------------------
describe('fitWords keeps every crossing a word', () => {
  test('a word whose crossings would become non-words is not added', async () => {
    // Rows 0 and 2 fixed; any 5-letter word in row 1 completes all five 3-letter downs.
    const g = { width: 5, height: 3, cells: [...'PASTA', '', '', '', '', '', ...'SALAD'] };
    const res = await fitWords({ grid: g, words: ['ONION', 'XYZZY'], wordlist: big, seed: 1, timeLimitMs: 2000 });
    for (const a of res.added) assert.ok(['ONION', 'XYZZY'].includes(a.answer));
    if (res.filled) assert.deepEqual(badEntries(5, 3, res.filled, { input: g, allowed: ['ONION', 'XYZZY'] }), []);
    // Plain fillGrid agrees that no list word fits row 1, so fitting ONION would be wrong unless its downs are words.
    if (res.added.length) {
      const downs = computeEntries({ width: 5, height: 3, cells: res.filled }).down.map((e) => entryPattern({ width: 5, height: 3, cells: res.filled }, e));
      for (const w of downs) assert.ok(usable(big, w), `${w} must be a word`);
    }
  });

  test('"Lock all, unlock one entry, fit a theme word": no non-word crossings', async () => {
    let cases = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const pattern = randomPattern({ width: 9, height: 9, seed: 100 + seed });
      if (!pattern) continue;
      const f = await fillGrid({ width: 9, height: 9, cells: pattern }, big, { seed, timeLimitMs: 3000 });
      if (!f.ok) continue;
      const across = computeEntries({ width: 9, height: 9, cells: f.cells }).across.filter((e) => e.length >= 5);
      const e = across[seed % across.length];
      const base = f.cells.slice();
      e.cells.forEach((i) => { base[i] = ''; });
      const used = new Set(computeEntries({ width: 9, height: 9, cells: f.cells }).all.map((x) => entryPattern({ width: 9, height: 9, cells: f.cells }, x)));
      const words = big.match('.'.repeat(e.length), { minScore: 60, limit: 200 }).map((x) => x.word).filter((w) => !used.has(w)).slice(0, 30);
      const input = { width: 9, height: 9, cells: base };
      const res = await fitWords({ grid: input, words, wordlist: big, seed, timeLimitMs: 2000, maxSlots: 8 });
      cases++;
      if (res.filled) assert.deepEqual(badEntries(9, 9, res.filled, { input, allowed: words }), [], `seed ${seed}`);
      assert.deepEqual(badEntries(9, 9, res.cells, { input, allowed: words }), [], `seed ${seed} cells`);
    }
    assert.ok(cases >= 3, `ran ${cases} cases`);
  });
});

// ---------------------------------------------------------------------------
describe('theme coverage and ranking', () => {
  const HALLOWEEN = ['JACKOLANTERN', 'TRICKORTREAT', 'HAUNTEDHOUSE', 'CANDYCORN', 'SKELETON', 'WITCH', 'GHOST', 'COSTUME', 'PUMPKIN', 'CAULDRON'];
  const idx = (...words) => words.map((w) => HALLOWEEN.indexOf(w));

  test('themeScore: the user\'s top, long answers outrank more short low-priority ones', () => {
    const topFour = themeScore(idx('JACKOLANTERN', 'TRICKORTREAT', 'SKELETON', 'GHOST'), HALLOWEEN);
    const fiveShort = themeScore(idx('SKELETON', 'WITCH', 'GHOST', 'COSTUME', 'PUMPKIN'), HALLOWEEN);
    assert.ok(topFour > fiveShort, `${topFour} > ${fiveShort}`);
    // Same length: the earlier (more important) answer is worth more.
    assert.ok(themeScore(idx('WITCH'), HALLOWEEN) > themeScore(idx('GHOST'), HALLOWEEN));
    // More answers of similar value still win.
    assert.ok(themeScore(idx('WITCH', 'GHOST'), HALLOWEEN) > themeScore(idx('SKELETON'), HALLOWEEN));
    assert.equal(themeScore([], HALLOWEEN), 0);
  });

  test('the whole budget is used while a theme answer is missing; no theme-less or far-worse layouts', async () => {
    const theme = ['ARMANI', 'BOWLING', 'KARAOKE'];
    const timeLimitMs = 6000;
    const res = await generateLayouts({ width: 9, height: 9, theme, wordlist: big, seed: 1, timeLimitMs, count: 6 });
    assert.ok(res.layouts.length >= 1);
    const most = Math.max(...res.layouts.map((l) => l.placements.length));
    assert.ok(most >= 1);
    if (most < theme.length) assert.ok(res.ms >= timeLimitMs * 0.9, `stopped after ${res.ms} ms with ${most}/${theme.length} placed`);
    for (const l of res.layouts) {
      assert.ok(l.placements.length >= 1, 'no theme-less layout');
      assert.ok(l.placements.length >= most / 2, 'no layout with less than half the best coverage');
    }
    for (let i = 1; i < res.layouts.length; i++) assert.ok(res.layouts[i - 1].score >= res.layouts[i].score);
  });

  test('a theme that fits completely still stops early', async () => {
    const res = await generateLayouts({ width: 9, height: 9, theme: ['GHOST'], wordlist: big, seed: 2, timeLimitMs: 15000, count: 3 });
    assert.ok(res.layouts.length >= 1);
    assert.equal(res.layouts[0].placements.length, 1);
    assert.ok(res.ms < 12000, `took ${res.ms} ms`);
  });

  test('"extra" density is denser than "high"', () => {
    assert.ok(targetBlocks(15, 15, 'extra') > targetBlocks(15, 15, 'high'));
    assert.ok(targetBlocks(7, 7, 'extra') > targetBlocks(7, 7, 'high'));
    assert.ok(maxRunLength(7, 'extra') < maxRunLength(7, 'high'));
    assert.equal(targetBlocks(15, 15, 'bogus'), targetBlocks(15, 15, 'medium'));
  });
});

// ---------------------------------------------------------------------------
describe('block completion with long theme rows near the edges', () => {
  test('three 13-letter rows (3, 7, 11) complete with compound moves', () => {
    // Columns 1–2 and 12–13 cross two or three theme rows next to the edge: every single block that would split
    // them leaves a 1–2 cell run behind, so the plain search alone never completed this (0 of 30 seeds).
    const W = 15;
    const base = new Board(W, W, 'rotational');
    for (const [answer, r, c] of [['GRILLEDCHEESE', 3, 0], ['CHOCOLATECHIP', 7, 1], ['STRAWBERRYJAM', 11, 2]]) {
      for (let k = 0; k < answer.length; k++) {
        const i = r * W + c + k;
        assert.ok(base.require(i));
        base.letter[i] = answer[k];
      }
      if (c > 0) assert.ok(base.setBlock(r * W + c - 1));
      if (c + answer.length < W) assert.ok(base.setBlock(r * W + c + answer.length));
    }
    assert.ok(base.repairShortRuns());
    let ok = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const b = base.clone();
      const done = completeBlocks(b, {
        target: targetBlocks(W, W), maxA: maxRunLength(W), maxD: maxRunLength(W), rng: makeRng(seed), wordlist: big, minScore: 30,
      });
      if (!done) continue;
      ok++;
      const g = { width: W, height: W, cells: b.toCells() };
      assert.deepEqual(validateGrid(g, { requireChecked: true, symmetry: 'rotational' }).map((i) => i.message), []);
    }
    assert.ok(ok >= 6, `completed ${ok}/12`);
  });

  test('blank patterns are unaffected (no clumps from compound moves)', () => {
    for (let s = 1; s <= 6; s++) {
      const cells = randomPattern({ width: 15, height: 15, seed: 15000 + s });
      assert.ok(cells);
      const blocks = cells.filter((c) => c === '#').length;
      assert.ok(blocks <= targetBlocks(15, 15) + 2, `seed ${s}: ${blocks} blocks`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('layout generation stays responsive on big grids', () => {
  test('21×21: short event-loop gaps, prompt abort and no budget overshoot', async () => {
    const theme = ['HAUNTEDHOUSE', 'TRICKORTREAT', 'JACKOLANTERN', 'CANDYCORN', 'SKELETON', 'GRAVEYARD'];
    let last = performance.now();
    let maxGap = 0;
    const iv = setInterval(() => {
      const t = performance.now();
      maxGap = Math.max(maxGap, t - last);
      last = t;
    }, 5);
    try {
      const t0 = performance.now();
      const res = await generateLayouts({ width: 21, height: 21, theme, wordlist: big, seed: 5, timeLimitMs: 2000 });
      const el = performance.now() - t0;
      assert.ok(el < 2000 + 400, `took ${Math.round(el)} ms for a 2000 ms budget`);
      assert.ok(Array.isArray(res.layouts));
      const signal = { aborted: false };
      setTimeout(() => { signal.aborted = true; }, 300);
      const t1 = performance.now();
      const ab = await generateLayouts({ width: 21, height: 21, theme, wordlist: big, seed: 6, timeLimitMs: 20000, signal });
      const abortMs = performance.now() - t1 - 300;
      assert.equal(ab.reason, 'aborted');
      assert.ok(abortMs < 300, `abort took ${Math.round(abortMs)} ms`);
    } finally {
      clearInterval(iv);
    }
    assert.ok(maxGap < 350, `event loop blocked for ${Math.round(maxGap)} ms`);
  });
});
