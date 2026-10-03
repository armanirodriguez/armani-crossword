// Unit tests for the fill engine (engine/): WordList, fillGrid, generateLayouts, rankCandidates.
// Uses the real data/wordlist.txt for realistic fills plus tiny hand-made lists for exact-logic checks.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WordList } from '../../engine/wordlist.js';
import { fillGrid, checkFillable } from '../../engine/fill.js';
import { generateLayouts, randomPattern, completeBlocks, targetBlocks, maxRunLength } from '../../engine/layout.js';
import { rankCandidates } from '../../engine/candidates.js';
import { fitWords } from '../../engine/theme-fit.js';
import { Board } from '../../engine/board.js';
import { makeRng } from '../../engine/util.js';
import {
  computeEntries, entryPattern, gridFromLayout, validateGrid, isSymmetric,
} from '../../site/shared/grid.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const big = WordList.fromText(readFileSync(path.join(ROOT, 'data/wordlist.txt'), 'utf8'));

/** Grid from rows where letters are pre-filled cells, '.' empty and '#' blocks. */
function grid(rows) {
  const layout = rows.map((r) => r.replace(/[A-Z]/g, '.'));
  return gridFromLayout(layout, rows.join(''));
}

function words(g) {
  return computeEntries(g).all.map((e) => ({ id: e.id, word: entryPattern(g, e) }));
}

/**
 * Independent verification of a fill: complete, every entry a list word (unless already complete in the input),
 * no duplicates (unless allowed), non-empty input cells untouched.
 */
function assertValidFill(input, out, wl, { allowDuplicates = false, extra = [] } = {}) {
  assert.ok(Array.isArray(out), 'result has cells');
  assert.equal(out.length, input.cells.length);
  input.cells.forEach((ch, i) => {
    if (ch !== '') assert.equal(out[i], ch, `cell ${i} must not change`);
    else assert.match(out[i], /^[A-Z]$/, `cell ${i} filled`);
  });
  const g = { ...input, cells: out };
  const inputWords = new Map(words(input).map((w) => [w.id, w.word]));
  const seen = new Set();
  for (const { id, word } of words(g)) {
    const before = inputWords.get(id);
    if (before.includes('.')) assert.ok(wl.has(word) || extra.includes(word), `${id} ${word} must be a list word`);
    if (!allowDuplicates) {
      assert.ok(!seen.has(word), `duplicate ${word}`);
      seen.add(word);
    }
  }
}

// ---------------------------------------------------------------------------
describe('WordList', () => {
  const wl = WordList.fromText([
    '# comment line',
    'CAT;70', 'COT;60', 'CUT;70', 'ACT;40', 'cab;55', 'Café;45', 'TAC;0', 'DOG', '  EEL;20  ', 'BAD;x',
    '', 'ABCDEFGHIJKLMNO;50',
  ].join('\n'));

  test('parses scores, defaults, normalisation and comments', () => {
    assert.equal(wl.score('CAT'), 70);
    assert.equal(wl.score('cab'), 55);
    assert.equal(wl.score('CAFE'), 45);
    assert.equal(wl.score('DOG'), 50, 'missing score defaults to 50');
    assert.equal(wl.score('EEL'), 20);
    assert.equal(wl.score('BAD'), 50, 'unparseable score defaults to 50');
    assert.equal(wl.score('NOPE'), undefined);
    assert.ok(wl.has('cat'));
    assert.ok(!wl.has('TAC'), 'score 0 = never use');
    assert.equal(wl.score('TAC'), 0);
    assert.equal(wl.size, 10);
  });

  test('match: pattern, order (score desc, then A–Z), minScore, limit, exclude, wildcards', () => {
    assert.deepEqual(wl.match('C.T').map((m) => m.word), ['CAT', 'CUT', 'COT']);
    assert.deepEqual(wl.match('C?T', { minScore: 65 }).map((m) => m.word), ['CAT', 'CUT']);
    assert.deepEqual(wl.match('...', { limit: 2 }).map((m) => m.word), ['CAT', 'CUT']);
    assert.deepEqual(wl.match('C.T', { exclude: new Set(['CUT']) }).map((m) => m.word), ['CAT', 'COT']);
    assert.deepEqual(wl.match('c_t').map((m) => m.word), ['CAT', 'CUT', 'COT'], 'lowercase + underscore');
    assert.deepEqual(wl.match('C.T')[0], { word: 'CAT', score: 70 });
    assert.deepEqual(wl.match('T.C'), [], 'score-0 words never match');
    assert.deepEqual(wl.match('Q..'), []);
    assert.deepEqual(wl.match('..'), []);
    assert.deepEqual(wl.match('C.T!'), [], 'bad characters → no match');
    assert.equal(wl.match('...............').length, 1);
  });

  test('count agrees with match', () => {
    for (const p of ['C.T', '...', '.A.', 'C..', '....', '.....', 'C.F.']) {
      for (const minScore of [0, 45, 60]) assert.equal(wl.count(p, { minScore }), wl.match(p, { minScore }).length, p);
    }
  });

  test('add / ban / unban / applyUserWords', () => {
    const w = WordList.fromText('CAT;70\nCOT;60\nCUT;65\n');
    w.add('cot', 90);
    assert.equal(w.match('C.T')[0].word, 'COT', 'add overrides and re-sorts');
    w.ban('COT');
    assert.ok(!w.has('COT'));
    assert.equal(w.size, 2);
    assert.deepEqual(w.match('C.T').map((m) => m.word), ['CAT', 'CUT']);
    assert.equal(w.count('C.T'), 2);
    w.unban('COT');
    assert.ok(w.has('COT'));
    assert.equal(w.size, 3);
    w.ban('CAT');
    w.add('CAT', 10);
    assert.ok(w.has('CAT'), 'add un-bans');
    w.applyUserWords('# mine\nZAP;80\n-CUT\nzip\n');
    assert.ok(w.has('ZAP') && w.has('ZIP') && !w.has('CUT'));
    assert.equal(w.score('ZIP'), 50);
    assert.equal(w.size, 4);
    w.add('AB', 50);
    assert.equal(w.count('..'), 1, 'two-letter words are accepted');
  });

  test('real list: matching a 15-letter pattern is well under 1 ms', () => {
    const pats = ['...............', 'S.............S', '.A.E.', 'C.T', '.......E', 'T..........T...'];
    for (const p of pats) big.count(p, { minScore: 30 }); // warm up (builds indexes)
    const t0 = performance.now();
    let n = 0;
    for (let i = 0; i < 300; i++) {
      for (const p of pats) {
        n += big.count(p, { minScore: 30 });
        n += big.match(p, { minScore: 30, limit: 50 }).length;
      }
    }
    const per = (performance.now() - t0) / (300 * pats.length * 2);
    assert.ok(n > 0);
    assert.ok(per < 0.2, `average ${per.toFixed(4)} ms per call`);
    assert.ok(big.size > 50000);
  });
});

// ---------------------------------------------------------------------------
describe('fillGrid', () => {
  test('fills a 5×5 mini with valid, unique list words', async () => {
    const g = grid(['#....', '.....', '.....', '.....', '....#']);
    const r = await fillGrid(g, big, { seed: 1 });
    assert.equal(r.ok, true, r.problem?.message);
    assert.equal(r.reason, null);
    assertValidFill(g, r.cells, big);
    assert.ok(r.stats.avgScore >= 30 && r.stats.minWordScore >= 30);
    assert.ok(r.stats.ms < 1000);
  });

  test('fills a 15×15 themed grid around locked letters', async () => {
    const g = grid([
      '....#.....#....', '....#.....#....', 'TRICKORTREATERS', '...#....#......', '###....#....###',
      '......#....#...', '.....#.....#...', '....#WITCH#....', '...#.....#.....', '...#....#......',
      '###....#....###', '......#....#...', 'CANDYCORNKERNEL', '....#.....#....', '....#.....#....',
    ]);
    // Theme rows need not be list words: they are complete in the input, so they are allowed as-is.
    const r = await fillGrid(g, big, { seed: 3, timeLimitMs: 20000 });
    assert.equal(r.ok, true, r.problem?.message);
    assertValidFill(g, r.cells, big);
  });

  test('entries completed only by their crossings are still list words (and no duplicates)', async () => {
    // In a fully checked 3×3 every across word is completed by the downs and vice versa.
    const wl = WordList.fromText('BIT;60\nICE;60\nTEN;60\nBAT;60\nARE;60\nTEA;60\nBAD;60\nOBI;60\nSET;60\n');
    for (let seed = 1; seed <= 10; seed++) {
      const g = grid(['...', '...', '...']);
      const r = await fillGrid(g, wl, { seed, minScore: 1 });
      if (r.ok) assertValidFill(g, r.cells, wl);
      else assert.equal(r.reason, 'impossible');
    }
  });

  test('duplicates are prevented unless allowDuplicates', async () => {
    // BIT/ICE/TEN is a symmetric word square: rows and columns repeat, so it needs duplicates.
    const wl = WordList.fromText('BIT;60\nICE;60\nTEN;60\n');
    const g = grid(['...', '...', '...']);
    const r1 = await fillGrid(g, wl, { seed: 1, minScore: 1 });
    assert.equal(r1.ok, false);
    assert.equal(r1.reason, 'impossible');
    assert.ok(r1.problem && r1.problem.entryId && r1.problem.message);
    const r2 = await fillGrid(g, wl, { seed: 1, minScore: 1, allowDuplicates: true });
    assert.equal(r2.ok, true);
    assert.equal(r2.cells.join(''), 'BITICETEN');
    assertValidFill(g, r2.cells, wl, { allowDuplicates: true });
  });

  test('pre-filled complete entries are kept even if unlisted, and count as used words', async () => {
    const wl = WordList.fromText('CAT;60\nCOT;60\nDOG;60\nDIG;60\nAAA;10\n');
    // Row 0 is user-forced "XYZ" (not in the list); row 2 must be filled, CAT is pre-used in row 1.
    const g = grid(['XYZ', '###', 'CAT', '###', 'C.T']);
    const r = await fillGrid(g, wl, { seed: 2, minScore: 1 });
    assert.equal(r.ok, true, r.problem?.message);
    assert.equal(r.cells.slice(0, 3).join(''), 'XYZ');
    assert.equal(r.cells.slice(12, 15).join(''), 'COT', 'CAT is already in the grid');
  });

  test('never changes non-empty cells; locked letters respected', async () => {
    const g = grid(['#P...', '.I...', '.Z...', '.Z...', '.A..#']);
    const r = await fillGrid(g, big, { seed: 4, minScore: 1, timeLimitMs: 5000 });
    if (r.ok) assertValidFill(g, r.cells, big);
    else assert.ok(['impossible', 'timeout'].includes(r.reason));
    const g2 = grid(['#....', 'PIZZA', '.....', '.....', '....#']);
    const r2 = await fillGrid(g2, big, { seed: 4, minScore: 30, timeLimitMs: 5000 });
    assert.equal(r2.ok, true, r2.problem?.message);
    assertValidFill(g2, r2.cells, big);
  });

  test('deterministic per seed', async () => {
    const cells = randomPattern({ width: 11, height: 11, seed: 42 });
    assert.ok(cells);
    const g = { width: 11, height: 11, cells };
    const a = await fillGrid(g, big, { seed: 7 });
    const b = await fillGrid(g, big, { seed: 7 });
    assert.equal(a.ok, true);
    assert.deepEqual(a.cells, b.cells);
    assert.equal(a.stats.nodes, b.stats.nodes);
    const c = await fillGrid(g, big, { seed: 8 });
    const d = await fillGrid(g, big, { seed: 9 });
    assert.ok(c.cells.join('') !== a.cells.join('') || d.cells.join('') !== a.cells.join(''), 'other seeds vary');
  });

  test('prefer words are used when they fit; avoid words never', async () => {
    const wl = WordList.fromText('CAT;70\nCOT;60\nCUT;65\n');
    const g = grid(['C.T']);
    let r = await fillGrid(g, wl, { seed: 1 });
    assert.equal(r.cells.join(''), 'CAT');
    r = await fillGrid(g, wl, { seed: 1, avoid: ['cat'] });
    assert.equal(r.cells.join(''), 'CUT');
    r = await fillGrid(g, wl, { seed: 1, prefer: ['COT'] });
    assert.equal(r.cells.join(''), 'COT');
    r = await fillGrid(g, wl, { seed: 1, prefer: ['CXT'] });
    assert.equal(r.cells.join(''), 'CXT', 'prefer words are added if missing');
    r = await fillGrid(g, wl, { seed: 1, avoid: ['CAT', 'COT', 'CUT'] });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'impossible');
  });

  test('impossible pattern → ok:false with the blocking entry', async () => {
    const g = grid(['QXZ..', '.....', '.....', '.....', '.....']);
    const r = await fillGrid(g, big, { seed: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'impossible');
    assert.equal(r.cells, null);
    assert.equal(r.problem.entryId, '1A');
    assert.equal(r.problem.pattern, 'QXZ..');
    assert.match(r.problem.message, /1A/);
  });

  test('two-letter entries and boxed-in squares are reported', async () => {
    const r = await fillGrid(grid(['..#', '...', '#..']), big, { seed: 1 });
    assert.equal(r.ok, false);
    assert.ok(r.problem.entryId);
    assert.match(r.problem.message, /2 letters|no words/);
    const r3 = await fillGrid(grid(['#.#', '###', '...']), big, { seed: 1 });
    assert.equal(r3.ok, false);
    assert.equal(r3.reason, 'invalid');
    const r4 = await fillGrid({ width: 2, height: 1, cells: ['a', ''] }, big);
    assert.equal(r4.reason, 'invalid');
  });

  test('a full grid is returned as-is', async () => {
    const g = grid(['CAT', 'ARE', 'TEN']);
    const r = await fillGrid(g, big);
    assert.equal(r.ok, true);
    assert.deepEqual(r.cells, g.cells);
  });

  test('time limit is honoured', async () => {
    // An open 8×8 (no blocks) is a stacked word rectangle: practically hopeless, but not provably so quickly.
    const g = { width: 8, height: 8, cells: new Array(64).fill('') };
    const t0 = performance.now();
    const r = await fillGrid(g, big, { seed: 1, timeLimitMs: 300 });
    const ms = performance.now() - t0;
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timeout');
    assert.ok(ms < 1000, `took ${ms} ms`);
    assert.ok(r.problem && r.problem.entryId, 'timeout reports a bottleneck entry');
  });

  test('abort via signal, with progress callbacks along the way', async () => {
    const g = { width: 8, height: 8, cells: new Array(64).fill('') };
    const signal = { aborted: false };
    const progress = [];
    setTimeout(() => { signal.aborted = true; }, 450);
    const t0 = performance.now();
    const r = await fillGrid(g, big, { seed: 1, timeLimitMs: 10000, signal, onProgress: (s) => progress.push(s) });
    const ms = performance.now() - t0;
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'aborted');
    assert.ok(ms < 1500, `took ${ms} ms`);
    assert.ok(progress.length >= 1, 'progress reported');
    assert.ok('nodes' in progress[0] && 'ms' in progress[0]);
  });

  test('checkFillable detects arc-consistency failures without searching', () => {
    assert.equal(checkFillable(grid(['QXZ..', '.....', '.....', '.....', '.....']), big).ok, false);
    assert.equal(checkFillable(grid(['#....', '.....', '.....', '.....', '....#']), big).ok, true);
  });
});

// ---------------------------------------------------------------------------
describe('generateLayouts', () => {
  const HALLOWEEN = ['PUMPKIN', 'WITCH', 'GHOST', 'CANDYCORN', 'HAUNTED', 'COSTUME', 'SKELETON', 'TRICKORTREAT'];

  /** Structural invariants every layout must satisfy. */
  function assertLayout(l, { width, height, symmetry = 'rotational', theme, wl = big }) {
    const g = { width, height, cells: l.cells };
    const issues = validateGrid(g, { minLength: 3, requireChecked: true, symmetry });
    assert.deepEqual(issues.map((i) => i.message), [], 'valid grid');
    assert.ok(isSymmetric(g, symmetry));
    const { all } = computeEntries(g);
    const answers = theme.map((t) => (typeof t === 'string' ? t : t.answer));
    const placedNames = l.placements.map((p) => p.answer);
    assert.deepEqual([...placedNames, ...l.unplaced].sort(), [...new Set(answers)].sort(), 'placed + unplaced = theme');
    const locked = new Set();
    for (const p of l.placements) {
      const e = all.find((x) => x.dir === p.dir && x.row === p.row && x.col === p.col);
      assert.ok(e, `${p.answer} starts an entry`);
      assert.equal(e.length, p.answer.length, `${p.answer} fills the entire entry`);
      assert.equal(entryPattern(g, e), p.answer);
      e.cells.forEach((c) => locked.add(c));
    }
    assert.deepEqual(l.locked, [...locked].sort((a, b) => a - b));
    l.cells.forEach((ch, i) => {
      if (ch !== '#' && ch !== '') assert.ok(locked.has(i), 'only theme letters are pre-filled');
    });
    if (l.filled) {
      const fg = { width, height, cells: l.filled };
      l.cells.forEach((ch, i) => {
        if (ch === '#') assert.equal(l.filled[i], '#');
        else if (ch) assert.equal(l.filled[i], ch);
        else assert.match(l.filled[i], /^[A-Z]$/);
      });
      const seen = new Set();
      for (const e of computeEntries(fg).all) {
        const w = entryPattern(fg, e);
        assert.ok(wl.has(w) || answers.includes(w), `${w} is a list word or theme answer`);
        assert.ok(!seen.has(w), `no duplicate ${w}`);
        seen.add(w);
      }
      assert.ok(Number.isFinite(l.stats.fillAvgScore));
    }
    assert.equal(l.stats.blocks, l.cells.filter((c) => c === '#').length);
    assert.equal(l.stats.words, all.length);
    assert.ok(Number.isFinite(l.score));
  }

  test('5×5 mini: proven layouts, few blocks, at least one theme answer', async () => {
    const theme = [{ answer: 'PIZZA' }, { answer: 'PASTA' }];
    const res = await generateLayouts({ width: 5, height: 5, theme, wordlist: big, seed: 1, timeLimitMs: 4000, count: 4 });
    assert.ok(res.layouts.length >= 1);
    assert.ok(res.attempts > 0 && res.ms >= 0);
    for (const l of res.layouts) {
      assertLayout(l, { width: 5, height: 5, theme });
      assert.ok(l.filled, 'proven fillable');
      assert.ok(l.stats.blocks <= 4);
      assert.ok(l.placements.length >= 1);
    }
    // Distinct layouts, best first.
    const keys = new Set(res.layouts.map((l) => l.cells.join(',')));
    assert.equal(keys.size, res.layouts.length);
    for (let i = 1; i < res.layouts.length; i++) assert.ok(res.layouts[i - 1].score >= res.layouts[i].score);
  });

  test('9×9 Halloween: several theme answers placed and proven', async () => {
    const res = await generateLayouts({ width: 9, height: 9, theme: HALLOWEEN, wordlist: big, seed: 2, timeLimitMs: 6000, count: 3 });
    assert.ok(res.layouts.length >= 1);
    for (const l of res.layouts) assertLayout(l, { width: 9, height: 9, theme: HALLOWEEN });
    assert.ok(res.layouts[0].filled);
    assert.ok(res.layouts[0].placements.length >= 2, `placed ${res.layouts[0].placements.length}`);
    // Answers longer than the grid can never be placed.
    for (const l of res.layouts) assert.ok(l.unplaced.includes('TRICKORTREAT'));
  });

  test('15×15 without fill preview is fast and structurally valid; mirror symmetry works', async () => {
    const t0 = performance.now();
    const res = await generateLayouts({ width: 15, height: 15, theme: HALLOWEEN, wordlist: big, seed: 3, timeLimitMs: 5000, fillPreview: false, count: 4 });
    assert.ok(performance.now() - t0 < 5000);
    assert.ok(res.layouts.length >= 1);
    for (const l of res.layouts) {
      assertLayout(l, { width: 15, height: 15, theme: HALLOWEEN });
      assert.equal(l.filled, null);
      assert.ok(l.stats.blocks >= 25 && l.stats.blocks <= 60, `blocks ${l.stats.blocks}`);
    }
    const m = await generateLayouts({ width: 11, height: 11, symmetry: 'mirror', theme: ['GHOST', 'WITCH'], wordlist: big, seed: 4, timeLimitMs: 4000, count: 2 });
    assert.ok(m.layouts.length >= 1);
    for (const l of m.layouts) assertLayout(l, { width: 11, height: 11, symmetry: 'mirror', theme: ['GHOST', 'WITCH'] });
  });

  test('15×15 with fill preview places theme answers and proves the fill', async () => {
    const res = await generateLayouts({ width: 15, height: 15, theme: HALLOWEEN, wordlist: big, seed: 5, timeLimitMs: 12000, count: 2 });
    assert.ok(res.layouts.length >= 1);
    for (const l of res.layouts) assertLayout(l, { width: 15, height: 15, theme: HALLOWEEN });
    assert.ok(res.layouts[0].filled);
    assert.ok(res.layouts[0].placements.length >= 3, `placed ${res.layouts[0].placements.length}`);
  });

  test('respects abort and time limit; reports progress', async () => {
    const signal = { aborted: false };
    const progress = [];
    setTimeout(() => { signal.aborted = true; }, 300);
    const t0 = performance.now();
    const res = await generateLayouts({
      width: 15, height: 15, theme: HALLOWEEN, wordlist: big, seed: 6, timeLimitMs: 20000, signal, onProgress: (p) => progress.push(p),
    });
    assert.ok(performance.now() - t0 < 1500);
    assert.equal(res.aborted, true);
    assert.equal(res.reason, 'aborted');
    assert.ok(progress.length >= 1);
    assert.ok('attempts' in progress[0] && 'found' in progress[0]);
    const t1 = performance.now();
    await generateLayouts({ width: 13, height: 13, theme: HALLOWEEN, wordlist: big, seed: 7, timeLimitMs: 800, count: 50 });
    assert.ok(performance.now() - t1 < 2500);
  });

  test('rejects invalid sizes', async () => {
    await assert.rejects(generateLayouts({ width: 2, height: 2, wordlist: big }));
    await assert.rejects(generateLayouts({ width: 5, height: 5 }));
  });

  test('block completion handles the classic 12/9/12 arrangement (columns through three theme rows)', () => {
    // JACKOLANTERN row 3 (flush left), CANDYCORN centred in row 7, TRICKORTREAT row 11 (flush right): every column
    // 3–11 crosses all three, so blocks must split them between the theme rows, and early blocks above row 3 can
    // make that impossible. Fail-first completion with dead-end detection must cope.
    const W = 15;
    const base = new Board(W, W, 'rotational');
    const put = (answer, r, c) => {
      for (let k = 0; k < answer.length; k++) {
        const i = r * W + c + k;
        assert.ok(base.require(i));
        base.letter[i] = answer[k];
      }
      if (c > 0) assert.ok(base.setBlock(r * W + c - 1));
      if (c + answer.length < W) assert.ok(base.setBlock(r * W + c + answer.length));
    };
    put('JACKOLANTERN', 3, 0);
    put('CANDYCORN', 7, 3);
    put('TRICKORTREAT', 11, 3);
    assert.ok(base.repairShortRuns());
    let ok = 0;
    let consistent = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const b = base.clone();
      const done = completeBlocks(b, {
        target: targetBlocks(W, W), maxA: maxRunLength(W), maxD: maxRunLength(W), rng: makeRng(seed), wordlist: big, minScore: 30,
      });
      if (!done) continue;
      ok++;
      const g = { width: W, height: W, cells: b.toCells() };
      assert.deepEqual(validateGrid(g, { requireChecked: true, symmetry: 'rotational' }).map((i) => i.message), []);
      if (checkFillable(g, big, { minScore: 30 }).ok) consistent++;
    }
    assert.ok(ok >= 8, `completed ${ok}/10`);
    assert.ok(consistent >= 4, `arc-consistent ${consistent}/10`);
  });

  test('leftover theme answers are fitted into proven layouts', async () => {
    // GHOST, WITCH and BATS fit easily in a 9×9; the layout should hold more than the structure placed alone.
    const theme = ['PUMPKIN', 'GHOST', 'WITCH', 'BATS'];
    const res = await generateLayouts({ width: 9, height: 9, theme, wordlist: big, seed: 3, timeLimitMs: 8000, count: 3 });
    assert.ok(res.layouts.length >= 1);
    for (const l of res.layouts) assertLayout(l, { width: 9, height: 9, theme });
    assert.ok(res.layouts[0].placements.length >= 3, `placed ${res.layouts[0].placements.length}`);
  });
});

// ---------------------------------------------------------------------------
describe('fitWords', () => {
  const pattern = randomPattern({ width: 9, height: 9, seed: 21 });

  test('puts a word into a slot of the right length and refills around it', async () => {
    const g = { width: 9, height: 9, cells: pattern.slice() };
    const base = await fillGrid(g, big, { seed: 1 });
    assert.ok(base.ok);
    const len5 = computeEntries(g).all.filter((e) => e.length === 5);
    assert.ok(len5.length, 'pattern has 5-letter slots');
    const res = await fitWords({ grid: g, filled: base.cells, words: ['GHOST', 'QZXJV'], wordlist: big, seed: 2, timeLimitMs: 5000 });
    assert.equal(res.aborted, false);
    assert.deepEqual(res.added.map((a) => a.answer), ['GHOST']);
    assert.deepEqual(res.left, ['QZXJV']);
    const a = res.added[0];
    assert.equal(a.cells.map((i) => res.cells[i]).join(''), 'GHOST', 'word fixed into cells');
    assert.equal(a.cells.map((i) => res.filled[i]).join(''), 'GHOST', 'and present in the fill');
    assertValidFill(g, res.filled, big, { extra: ['GHOST'] });
    assert.ok(res.stats && Number.isFinite(res.stats.ms));
  });

  test('keeps fixed letters, absorbs words the fill already has, honours abort', async () => {
    const g = { width: 9, height: 9, cells: pattern.slice() };
    const base = await fillGrid(g, big, { seed: 4 });
    const e = computeEntries(g).all.find((x) => x.length >= 4);
    const word = e.cells.map((i) => base.cells[i]).join('');
    // The fill already contains `word`: it is fixed in place without a new fill.
    const res = await fitWords({ grid: g, filled: base.cells, words: [word], wordlist: big, seed: 1 });
    assert.deepEqual(res.added.map((x) => x.answer), [word]);
    assert.equal(res.stats, null, 'no new fill needed');
    assert.deepEqual(res.filled, base.cells);
    // Fixed letters never change.
    const fixed = pattern.slice();
    computeEntries(g).all[0].cells.forEach((i, k) => { fixed[i] = base.cells[i]; void k; });
    const res2 = await fitWords({ grid: { width: 9, height: 9, cells: fixed }, filled: null, words: ['WITCH'], wordlist: big, seed: 5, timeLimitMs: 4000 });
    if (res2.filled) fixed.forEach((ch, i) => { if (ch) assert.equal(res2.filled[i], ch); });
    const signal = { aborted: true };
    const res3 = await fitWords({ grid: g, filled: null, words: ['GHOST'], wordlist: big, seed: 1, signal });
    assert.equal(res3.aborted, true);
    assert.deepEqual(res3.added, []);
  });
});

// ---------------------------------------------------------------------------
describe('rankCandidates', () => {
  test('matches the pattern, excludes words in the grid, computes viability', () => {
    const wl = WordList.fromText('CAT;70\nCOT;60\nCUT;65\nARE;50\nTEN;55\nAXE;40\nOAT;45\nOAK;45\nUFO;45\n');
    // 1A = C . T across; 1D/2D/3D downs. Row 1 is "A.E" (2A), row 2 open.
    const g = grid(['C.T', 'A.E', '...']);
    const res = rankCandidates(g, '1A', wl, { minScore: 0 });
    // Down through the middle: ". . ." with first letter = candidate's 2nd letter, "?.?" pattern.
    const byWord = Object.fromEntries(res.map((r) => [r.word, r]));
    assert.deepEqual(Object.keys(byWord).sort(), ['CAT', 'COT', 'CUT']);
    // Middle down is X.. for candidate C X T → count of words matching X.. (minScore 0).
    for (const r of res) {
      const expect = wl.count(`${r.word[1]}..`);
      assert.equal(r.viability, expect, r.word);
    }
    // Viable first, then by score.
    const viable = res.filter((r) => r.viability !== 0);
    for (let i = 1; i < viable.length; i++) assert.ok(viable[i - 1].score >= viable[i].score);
    const dead = res.findIndex((r) => r.viability === 0);
    if (dead >= 0) assert.ok(res.slice(dead).every((r) => r.viability === 0), 'dead ends last');

    // Words already in the grid are excluded.
    const g2 = grid(['C.T', '###', 'CAT']);
    assert.deepEqual(rankCandidates(g2, '1A', wl).map((r) => r.word), ['CUT', 'COT']);
    assert.equal(rankCandidates(g2, '1A', wl)[0].viability, null, 'no crossings');
  });

  test('filter, limit, minScore and unknown entries', () => {
    const g = grid(['.....', '#####', '.....']);
    const all = rankCandidates(g, '1A', big, { minScore: 50, limit: 1000 });
    assert.ok(all.length > 0 && all.length <= 1000);
    assert.ok(all.every((r) => r.score >= 50 && r.word.length === 5));
    const f = rankCandidates(g, '1A', big, { filter: 'ab', limit: 50 });
    assert.ok(f.length > 0 && f.every((r) => r.word.includes('AB')));
    const pre = rankCandidates(g, '1A', big, { filter: '^ab', limit: 50 });
    assert.ok(pre.length > 0 && pre.every((r) => r.word.startsWith('AB')));
    assert.equal(rankCandidates(g, '1A', big, { limit: 3 }).length, 3);
    assert.deepEqual(rankCandidates(g, '9D', big), []);
  });

  test('is fast for an empty long entry with crossings', () => {
    const cells = randomPattern({ width: 15, height: 15, seed: 11 });
    const g = { width: 15, height: 15, cells };
    const longest = computeEntries(g).all.sort((a, b) => b.length - a.length)[0];
    const t0 = performance.now();
    const res = rankCandidates(g, longest.id, big, { minScore: 0, limit: 200 });
    const ms = performance.now() - t0;
    assert.ok(res.length > 0);
    assert.ok(res.every((r) => r.viability === null || r.viability > 0 || r.viability === 0));
    assert.ok(ms < 300, `${ms} ms`);
  });
});
