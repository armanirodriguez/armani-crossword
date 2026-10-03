// Answer freshness: the `penalize` option of fillGrid / generateLayouts / fitWords / rankCandidates, which lowers
// recently used answers in the value ordering (never their eligibility), so the same words don't turn up in every
// daily puzzle.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WordList } from '../../engine/wordlist.js';
import { fillGrid, penaltiesOption, MAX_PENALTY } from '../../engine/fill.js';
import { generateLayouts } from '../../engine/layout.js';
import { fitWords } from '../../engine/theme-fit.js';
import { rankCandidates } from '../../engine/candidates.js';
import { computeEntries, gridFromLayout } from '../../site/shared/grid.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const big = WordList.fromText(readFileSync(path.join(ROOT, 'data/wordlist.txt'), 'utf8'));

/** Every entry's word in a complete grid. */
function entryWords(g) {
  return computeEntries(g).all.map((e) => e.cells.map((i) => g.cells[i]).join(''));
}

/** Hand-made blank patterns (fixed, so the tests don't depend on the pattern generator). */
const PATTERNS = {
  '5x5 mini': ['#....', '.....', '.....', '.....', '....#'],
  '7x7': ['...#...', '...#...', '.......', '##...##', '.......', '...#...', '...#...'],
  '9x9': ['....#....', '....#....', '.........', '...#.....', '###...###', '.....#...', '.........', '....#....', '....#....'],
  '11x11': [
    '.....#....#', '.....#.....', '.....#.....', '.......#...', '#.....#....', '###.....###',
    '....#.....#', '...#.......', '.....#.....', '.....#.....', '#....#.....',
  ],
};

describe('penaltiesOption', () => {
  test('accepts a plain object, a Map or [word, points] pairs; normalises words; drops junk', () => {
    assert.deepEqual([...penaltiesOption({ ace: 20, 'a-r-t': '15', bad: -1, nan: 'x', zero: 0 })], [['ACE', 20], ['ART', 15]]);
    assert.deepEqual([...penaltiesOption(new Map([['Star', 30]]))], [['STAR', 30]]);
    assert.deepEqual([...penaltiesOption([['ace', 5], ['ACE', 9], ['ace', 7], null, 'ERA', ['', 3]])], [['ACE', 9]], 'larger wins');
    assert.deepEqual([...penaltiesOption({ AREA: 1e9 })], [['AREA', MAX_PENALTY]], 'capped');
    for (const junk of [undefined, null, 'ACE', 42, true]) assert.equal(penaltiesOption(junk).size, 0);
  });

  test('every accepted form survives structured cloning (worker messages)', () => {
    for (const form of [{ ACE: 30 }, new Map([['ACE', 30]]), [['ACE', 30]]]) {
      assert.deepEqual([...penaltiesOption(structuredClone({ penalize: form }).penalize)], [['ACE', 30]]);
    }
  });
});

describe('fillGrid penalize', () => {
  test('a strongly penalized word that a seeded fill uses is avoided by the same seed', async () => {
    // Each word of the seeded fill in turn, including words the crossings complete (never chosen directly).
    for (const name of ['5x5 mini', '7x7', '9x9']) {
      const g = gridFromLayout(PATTERNS[name]);
      for (const seed of [1, 2]) {
        const base = await fillGrid(g, big, { seed });
        assert.equal(base.ok, true, `${name} seed ${seed}: ${base.problem?.message}`);
        for (const word of entryWords({ ...g, cells: base.cells })) {
          const r = await fillGrid(g, big, { seed, penalize: { [word]: 200 } });
          assert.equal(r.ok, true, `${name} seed ${seed} without ${word}`);
          assert.ok(!entryWords({ ...g, cells: r.cells }).includes(word), `${name} seed ${seed}: ${word} still used`);
        }
      }
    }
  });

  test('penalizing every word of a fill gives a fresh fill', async () => {
    for (const name of ['5x5 mini', '11x11']) {
      const g = gridFromLayout(PATTERNS[name]);
      const base = await fillGrid(g, big, { seed: 3 });
      const used = entryWords({ ...g, cells: base.cells });
      const penalize = new Map(used.map((w) => [w, 100]));
      const r = await fillGrid(g, big, { seed: 3, penalize });
      assert.equal(r.ok, true);
      const again = entryWords({ ...g, cells: r.cells }).filter((w) => penalize.has(w));
      assert.ok(again.length <= used.length * 0.1, `${name}: reused ${again.join(' ')}`);
    }
  });

  test('a penalized word is still used when it is the only fit', async () => {
    const wl = WordList.fromText('CAT;70\nCOT;60\nCUT;20\n');
    let r = await fillGrid(gridFromLayout(['...'], 'CA.'), wl, { seed: 1, penalize: { CAT: MAX_PENALTY } });
    assert.equal(r.cells.join(''), 'CAT');
    r = await fillGrid(gridFromLayout(['...'], 'C.T'), wl, { seed: 1, penalize: { CAT: 50 } });
    assert.equal(r.cells.join(''), 'COT', 'the alternative is preferred');
    r = await fillGrid(gridFromLayout(['...'], 'C.T'), wl, { seed: 1, penalize: { CAT: 50, COT: 50 } });
    assert.equal(r.cells.join(''), 'CAT', 'equal penalties keep the score order');
    // Eligibility is unchanged: CUT (score 20) stays out at minScore 30 however much the others are penalized.
    r = await fillGrid(gridFromLayout(['...'], 'C.T'), wl, { seed: 1, minScore: 30, penalize: { CAT: 500, COT: 500 } });
    assert.ok(['CAT', 'COT'].includes(r.cells.join('')));
    // With the real list: a pattern that only one word fits, fully penalized, still fills with it.
    const only = big.match('ZYGOT.', { minScore: 30 });
    assert.equal(only.length, 1);
    r = await fillGrid(gridFromLayout(['......'], 'ZYGOT.'), big, { seed: 1, penalize: { [only[0].word]: MAX_PENALTY } });
    assert.equal(r.cells.join(''), only[0].word);
  });

  test('prefer words are never penalized; stats report real scores', async () => {
    const wl = WordList.fromText('CAT;70\nCOT;60\nCUT;65\n');
    const r = await fillGrid(gridFromLayout(['...'], 'C.T'), wl, { seed: 1, prefer: ['cot'], penalize: { COT: MAX_PENALTY, CAT: 10 } });
    assert.equal(r.cells.join(''), 'COT');
    const s = await fillGrid(gridFromLayout(['...'], 'C.T'), wl, { seed: 1, randomness: 0, penalize: { CAT: 30 } });
    assert.equal(s.cells.join(''), 'CUT');
    assert.equal(s.stats.avgScore, 65);
  });
});

describe('penalize is threaded through the other engine entry points', () => {
  test('generateLayouts: proofs avoid penalized fill; theme answers are exempt', async () => {
    const params = { width: 5, height: 5, theme: ['PIZZA'], wordlist: big, count: 3, seed: 4, timeLimitMs: 2000 };
    const first = await generateLayouts(params);
    const used = new Set(first.layouts.filter((l) => l.filled).flatMap((l) => entryWords({ width: 5, height: 5, cells: l.filled })));
    assert.ok(used.size >= 8);
    const penalize = [...used].map((w) => [w, 200]); // includes PIZZA itself
    const second = await generateLayouts({ ...params, penalize });
    const proven = second.layouts.filter((l) => l.filled);
    assert.ok(proven.length >= 1);
    assert.ok(proven.every((l) => l.placements.some((p) => p.answer === 'PIZZA')), 'theme answer still placed');
    const words = proven.flatMap((l) => entryWords({ width: 5, height: 5, cells: l.filled })).filter((w) => w !== 'PIZZA');
    const reused = words.filter((w) => used.has(w));
    assert.ok(reused.length <= words.length * 0.25, `reused ${reused.length}/${words.length}: ${reused.join(' ')}`);
  });

  test('fitWords: refills around the fitted word avoid penalized fill', async () => {
    const grid = gridFromLayout(PATTERNS['9x9']);
    const first = await fitWords({ grid, words: ['GHOST'], wordlist: big, seed: 1 });
    assert.deepEqual(first.added.map((a) => a.answer), ['GHOST']);
    const used = entryWords({ ...grid, cells: first.filled }).filter((w) => w !== 'GHOST');
    const second = await fitWords({ grid, words: ['GHOST'], wordlist: big, seed: 1, penalize: [...used, 'GHOST'].map((w) => [w, 200]) });
    assert.deepEqual(second.added.map((a) => a.answer), ['GHOST']);
    const reused = entryWords({ ...grid, cells: second.filled }).filter((w) => used.includes(w));
    assert.ok(reused.length <= 3, `reused ${reused.join(' ')}`);
  });

  test('rankCandidates tags penalized rows without reordering', () => {
    const g = gridFromLayout(['....#', '.....', '.....', '.....', '#....']);
    const plain = rankCandidates(g, '1A', big, { minScore: 30, limit: 50 });
    const top = plain.slice(0, 3).map((c) => c.word);
    const tagged = rankCandidates(g, '1A', big, { minScore: 30, limit: 50, penalize: { [top[1].toLowerCase()]: 30 } });
    assert.deepEqual(tagged.map((c) => c.word), plain.map((c) => c.word));
    assert.deepEqual(tagged.filter((c) => c.penalized).map((c) => c.word), [top[1]]);
    assert.ok(!('penalized' in tagged[0]));
  });
});

describe('penalties never squeeze out a prefer (theme) word', () => {
  // 1A is empty; its only crossing letter comes from 4D (.ARK). Penalizing PARK used to make the filler pick HARK
  // first and then GASH, dropping the theme word GASP on ~1/3 of seeds. Entries that can still take a prefer word
  // are now filled first (fillGrid's preferFirst, on by default).
  const cells = [...'#....DELTAENTERBREAKTERM#'].map((c) => (c === '.' ? '' : c));
  const penalize = Object.fromEntries(['PARK', 'GENRE', 'ALTER', 'STEAM', 'DEBT', 'ERA', 'ARE'].map((w) => [w, 30]));

  test('GASP lands on every seed despite its crossing being penalized', async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const r = await fillGrid({ width: 5, height: 5, cells }, big, { seed, prefer: ['GASP'], penalize, minScore: 30 });
      assert.ok(r.ok, `seed ${seed}: ${r.reason}`);
      assert.equal(r.cells.slice(1, 5).join(''), 'GASP', `seed ${seed}`);
    }
  });
});
