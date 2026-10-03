// Blank block patterns that fill: the fill estimate (engine/fillability.js), the blank pattern generator
// (randomPattern / blankPatternSteps in engine/blocks.js) and generateLayouts without theme answers.
// The full measurement (every size 5–15 × density, 20 seeds, 8 s fills) is `node scripts/bench-engine.mjs --only blank`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WordList } from '../../engine/wordlist.js';
import { fillGrid } from '../../engine/fill.js';
import { generateLayouts, randomPattern, targetBlocks } from '../../engine/layout.js';
import { blankPatternSteps, DENSITY_LEVELS } from '../../engine/blocks.js';
import { fillEstimate, fillShortfall, runBits, FILLABLE_BITS } from '../../engine/fillability.js';
import { makeRng } from '../../engine/util.js';
import { gridFromLayout, validateGrid, isSymmetric } from '../../site/shared/grid.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const big = WordList.fromText(readFileSync(path.join(ROOT, 'data/wordlist.txt'), 'utf8'));

const blocksOf = (cells) => cells.filter((c) => c === '#').length;

describe('fillEstimate', () => {
  test('ranks known patterns: open-ish minis fill, stacked long entries do not', () => {
    const est = (rows, wl = big) => fillEstimate(gridFromLayout(rows), wl);
    // The classic 8-block 7×7 (fills in milliseconds) vs blocks only in the corners (stacks of 7s: no fill in 8 s).
    const good = est(['...#...', '...#...', '.......', '##...##', '.......', '...#...', '...#...']);
    const corners = est(['##.....', '#......', '.......', '.......', '.......', '......#', '.....##']);
    assert.ok(good.bitsPerCell > 1 && fillShortfall(good) === 0);
    assert.ok(corners.bitsPerCell < FILLABLE_BITS && fillShortfall(corners) > 0);
    // Fine on average but with a hard corner (three stacked 8-letter rows over long downs): the window measure
    // catches it. (This 14×14 timed out with every fill seed tried.)
    const corner = est([
      '.....#........', '.....#........', '.....#........', '...#...#......', '....#....#....', '###...#.......',
      '.....#....#...', '...#....#.....', '.......#...###', '....#....#....', '......#...#...', '........#.....',
      '........#.....', '........#.....',
    ]);
    assert.ok(corner.bitsPerCell >= FILLABLE_BITS, 'average alone looks fine');
    assert.ok(corner.minWindowBits < 0 && fillShortfall(corner) > 0);
  });

  test('without a word list, typical statistics give a close estimate; impossible lengths give −Infinity', () => {
    for (const rows of [['.....', '.....', '.....', '.....', '.....'], ['...#...', '...#...', '.......', '##...##', '.......', '...#...', '...#...']]) {
      const g = gridFromLayout(rows);
      assert.ok(Math.abs(fillEstimate(g, big).bitsPerCell - fillEstimate(g, null).bitsPerCell) < 0.1);
    }
    const tiny = WordList.fromText('CAT;60\nDOG;60\n');
    const e = fillEstimate(gridFromLayout(['....', '....', '....', '....']), tiny);
    assert.equal(e.bitsPerCell, -Infinity);
    assert.equal(fillShortfall(e), Infinity);
    // Run freedom falls with length (fewer words, more letters to agree on).
    const bits = runBits(big);
    for (let L = 4; L <= 15; L++) assert.ok(bits[L] < bits[L - 1] + 0.5, `length ${L}`);
  });
});

describe('randomPattern / blankPatternSteps', () => {
  test('every size 5–15 and density: valid, symmetric, fillable by the estimate, deterministic', () => {
    for (let size = 5; size <= 15; size++) {
      for (const density of ['low', 'medium', 'high']) {
        for (const seed of [1, 2]) {
          const cells = randomPattern({ width: size, height: size, density, seed, wordlist: big });
          const g = { width: size, height: size, cells };
          assert.ok(cells, `${size} ${density} ${seed}`);
          assert.deepEqual(validateGrid(g, { requireChecked: true, symmetry: 'rotational' }), []);
          assert.ok(isSymmetric(g, 'rotational'));
          assert.equal(fillShortfall(fillEstimate(g, big)), 0, `${size}×${size} ${density} seed ${seed}`);
          if (seed === 1) assert.deepEqual(randomPattern({ width: size, height: size, density, seed, wordlist: big }), cells);
        }
      }
    }
  });

  test('an unfillable density maps to the nearest fillable one', () => {
    // A 'low' 7×7 targets 2 blocks (stacks of 7-letter rows); the sparsest 7×7s that fill reliably have 6.
    assert.equal(targetBlocks(7, 7, 'low'), 2);
    for (let seed = 1; seed <= 5; seed++) {
      const steps = blankPatternSteps({ width: 7, height: 7, density: 'low', rng: makeRng(seed), wordlist: big });
      let r;
      while (!(r = steps.next()).done);
      const res = r.value;
      assert.equal(res.shortfall, 0);
      assert.ok(blocksOf(res.cells) >= 6, `seed ${seed}: ${blocksOf(res.cells)} blocks`);
      assert.ok(DENSITY_LEVELS[res.level], 'reports the level used');
    }
    // A density that fills as asked keeps its block target.
    const cells = randomPattern({ width: 11, height: 11, density: 'medium', seed: 3, wordlist: big });
    assert.equal(blocksOf(cells), targetBlocks(11, 11, 'medium') + 1); // 19 → 20: blocks come in pairs plus the centre
  });

  test('mirror and no symmetry work too, and so does the typical-list fallback', () => {
    for (const symmetry of ['mirror', 'none']) {
      for (const size of [7, 10, 13]) {
        const cells = randomPattern({ width: size, height: size, symmetry, density: 'medium', seed: 5, wordlist: big });
        const g = { width: size, height: size, cells };
        assert.deepEqual(validateGrid(g, { requireChecked: true, symmetry }), [], `${symmetry} ${size}`);
        assert.equal(fillShortfall(fillEstimate(g, big)), 0);
      }
    }
    const cells = randomPattern({ width: 9, height: 9, density: 'low', seed: 1 });
    assert.equal(fillShortfall(fillEstimate({ width: 9, height: 9, cells }, null)), 0);
  });

  test('the patterns actually fill (sample; the benchmark covers all sizes)', async () => {
    const cases = [[7, 'low'], [7, 'high'], [8, 'low'], [9, 'low'], [10, 'low'], [12, 'low'], [15, 'low']];
    for (const [size, density] of cases) {
      const cells = randomPattern({ width: size, height: size, density, seed: 7, wordlist: big });
      const r = await fillGrid({ width: size, height: size, cells }, big, { seed: 7, timeLimitMs: 8000 });
      assert.equal(r.ok, true, `${size}×${size} ${density}: ${r.problem?.message}`);
    }
  });
});

describe('generateLayouts without theme answers', () => {
  test('a "low" 7×7 gives a full gallery of proven layouts, sparsest first', async () => {
    const res = await generateLayouts({ width: 7, height: 7, theme: [], wordlist: big, density: 'low', seed: 1, count: 6, timeLimitMs: 8000 });
    assert.equal(res.layouts.length, 6);
    assert.ok(res.layouts.every((l) => l.filled), 'all proven');
    const blocks = res.layouts.map((l) => l.stats.blocks);
    assert.ok(blocks[0] <= Math.min(...blocks) && blocks[0] >= 6, `blocks ${blocks}`);
    assert.ok(res.ms < 5000, `${res.ms} ms`);
  });

  test('a "low" 15×15 is proven within the budget', async () => {
    const res = await generateLayouts({ width: 15, height: 15, theme: [], wordlist: big, density: 'low', seed: 2, count: 1, timeLimitMs: 8000 });
    assert.ok(res.layouts.length >= 1 && res.layouts.every((l) => l.filled));
    assert.ok(res.layouts[0].stats.blocks <= targetBlocks(15, 15, 'medium'));
  });
});
