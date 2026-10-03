#!/usr/bin/env node
// Fill-engine benchmark: fills on representative block patterns and theme layout generation.
//
// Usage:
//   node scripts/bench-engine.mjs                 # full run (a few minutes): fill, layouts, coverage
//   node scripts/bench-engine.mjs --quick         # fewer seeds/patterns
//   node scripts/bench-engine.mjs --seeds 10 --time 20000 --only fill|layouts|coverage --no-stress --show
//   node scripts/bench-engine.mjs --only blank [--seeds 20] [--time 8000] [--sizes 5-15|7,9] [--symmetry mirror]
//   node scripts/bench-engine.mjs --only freshness [--fills 100] [--top 200] [--points 30] [--time 8000]
//   node scripts/bench-engine.mjs --wordlist path/to/wordlist.txt
//
// Reports, per pattern group and minScore: success rate, median / p90 time, average word score of the fill;
// and for generateLayouts: time, layouts found, theme answers placed, fill quality. `--only coverage` runs just the
// theme-coverage cases (themes from builder reviews, at the builder's default settings): how many of the theme
// answers the best layout holds, and a check that every entry of every layout is a list word or a theme answer.
// `--only blank`: blank patterns (randomPattern) at every size and density, each filled once at minScore 30 —
// how often they fill within the time limit. `--only freshness`: how often the most common answers turn up in
// seeded 9×9 / 15×15 fills with and without fillGrid's `penalize` (top answers taken from separate training fills).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WordList } from '../engine/wordlist.js';
import { fillGrid } from '../engine/fill.js';
import { generateLayouts, randomPattern, targetBlocks } from '../engine/layout.js';
import { gridFromLayout, computeEntries, validateGrid } from '../site/shared/grid.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const QUICK = flag('quick');
const SEEDS = Number(opt('seeds', QUICK ? 2 : 4));
const TIME = Number(opt('time', 15000));
const ONLY = opt('only', '');
const WORDLIST = opt('wordlist', path.join(ROOT, 'data/wordlist.txt'));

// Hand-made patterns (rotationally symmetric; validated before use).
const HANDMADE = {
  '7x7 a': ['...#...', '...#...', '.......', '##...##', '.......', '...#...', '...#...'],
  '7x7 b': ['##...##', '#......', '.......', '...#...', '.......', '......#', '##...##'],
  '15x15 classic-36': [
    '....#.....#....', '....#.....#....', '...............', '...#....#......', '###....#....###',
    '......#....#...', '.....#.....#...', '....#.....#....', '...#.....#.....', '...#....#......',
    '###....#....###', '......#....#...', '...............', '....#.....#....', '....#.....#....',
  ],
  // Stress tests (characterise the limits; not typical): stacked 15s with a wide-open middle, and an open 7×7
  // with five stacked 7-letter rows.
  '15x15 open-32 (stress)': [
    '....#...#......', '....#...#......', '....#...#......', '...............', '###...#...#....',
    '.....#...#.....', '....#......#...', '...#.......#...', '...#......#....', '.....#...#.....',
    '....#...#...###', '...............', '......#...#....', '......#...#....', '......#...#....',
  ],
  '7x7 stacked (stress)': ['....###', '.......', '.......', '.......', '.......', '.......', '###....'],
};

function pct(sorted, p) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + 0.5))];
}

function fmtMs(x) {
  return Number.isFinite(x) ? `${Math.round(x)}` : '-';
}

function patternStats(cells, w, h) {
  const { all } = computeEntries({ width: w, height: h, cells });
  return { blocks: cells.filter((c) => c === '#').length, words: all.length };
}

/** Independent check of a fill result. */
function verifyFill(input, out, wl) {
  const g = { width: input.width, height: input.height, cells: out };
  const seen = new Set();
  for (const e of computeEntries(g).all) {
    const w = e.cells.map((i) => out[i]).join('');
    if (!/^[A-Z]+$/.test(w)) return `incomplete ${e.id}`;
    if (!wl.has(w)) return `${w} not in list`;
    if (seen.has(w)) return `duplicate ${w}`;
    seen.add(w);
  }
  for (let i = 0; i < input.cells.length; i++) if (input.cells[i] !== '' && input.cells[i] !== out[i]) return 'changed a cell';
  return null;
}

async function benchFill(wl) {
  const groups = [];
  const gen = (size, density, n) => {
    const pats = [];
    for (let s = 1; pats.length < n && s < 100; s++) {
      const cells = randomPattern({ width: size, height: size, density, seed: 1000 * size + s, wordlist: wl });
      if (cells) pats.push(cells);
    }
    return pats;
  };
  const hand = (name) => {
    const grid = gridFromLayout(HANDMADE[name]);
    const issues = validateGrid(grid, { requireChecked: true, symmetry: 'rotational' });
    if (issues.length) throw new Error(`handmade pattern ${name} invalid: ${issues.map((i) => i.message).join('; ')}`);
    return grid.cells;
  };
  const nPat = QUICK ? 2 : 3;
  groups.push({ name: '5x5 mini', size: 5, patterns: [gridFromLayout(['#....', '.....', '.....', '.....', '....#']).cells] });
  groups.push({ name: '5x5 open', size: 5, patterns: [new Array(25).fill('')] });
  groups.push({ name: '7x7 (hand)', size: 7, patterns: [hand('7x7 a'), hand('7x7 b')] });
  groups.push({ name: '9x9 (gen)', size: 9, patterns: gen(9, 'medium', nPat) });
  groups.push({ name: '11x11 (gen)', size: 11, patterns: gen(11, 'medium', nPat) });
  groups.push({ name: '13x13 (gen)', size: 13, patterns: gen(13, 'medium', nPat) });
  groups.push({ name: '15x15 classic-36', size: 15, patterns: [hand('15x15 classic-36')] });
  groups.push({ name: '15x15 medium (gen)', size: 15, patterns: gen(15, 'medium', QUICK ? 2 : 4) });
  groups.push({ name: '15x15 high (gen)', size: 15, patterns: gen(15, 'high', QUICK ? 1 : 2) });
  groups.push({ name: '15x15 low (gen)', size: 15, patterns: gen(15, 'low', QUICK ? 1 : 2) });
  if (!flag('no-stress')) {
    groups.push({ name: '15x15 open-32 (stress)', size: 15, patterns: [hand('15x15 open-32 (stress)')] });
    groups.push({ name: '7x7 stacked (stress)', size: 7, patterns: [hand('7x7 stacked (stress)')] });
  }

  console.log(`\n== fillGrid: ${SEEDS} seeds per pattern, time limit ${TIME} ms ==`);
  console.log('group                     | min | runs | ok    | median ms | p90 ms | max ms | avg word score | blocks/words');
  const summary = [];
  for (const minScore of [30, 40]) {
    for (const g of groups) {
      const times = [];
      let ok = 0;
      let runs = 0;
      let scoreSum = 0;
      let bad = null;
      for (const cells of g.patterns) {
        for (let seed = 1; seed <= SEEDS; seed++) {
          const grid = { width: g.size, height: g.size, cells: cells.slice() };
          const r = await fillGrid(grid, wl, { minScore, timeLimitMs: TIME, seed });
          runs++;
          times.push(r.stats.ms);
          if (r.ok) {
            ok++;
            scoreSum += r.stats.avgScore;
            bad = bad || verifyFill(grid, r.cells, wl);
          }
        }
      }
      times.sort((a, b) => a - b);
      const st = g.patterns.map((c) => patternStats(c, g.size, g.size));
      const shape = st.map((s) => `${s.blocks}/${s.words}`).join(' ');
      const row = {
        group: g.name, minScore, runs, ok, median: pct(times, 0.5), p90: pct(times, 0.9), max: times[times.length - 1],
        avgScore: ok ? scoreSum / ok : NaN,
      };
      summary.push(row);
      console.log(
        `${g.name.padEnd(25)} | ${String(minScore).padStart(3)} | ${String(runs).padStart(4)} | ${`${ok}/${runs}`.padEnd(5)} | `
        + `${fmtMs(row.median).padStart(9)} | ${fmtMs(row.p90).padStart(6)} | ${fmtMs(row.max).padStart(6)} | `
        + `${(ok ? row.avgScore.toFixed(1) : '-').padStart(14)} | ${shape}${bad ? `  !! INVALID FILL: ${bad}` : ''}`,
      );
    }
  }
  return summary;
}

async function benchLayouts(wl) {
  const halloween = ['PUMPKIN', 'WITCH', 'GHOST', 'CANDYCORN', 'HAUNTED', 'COSTUME', 'SKELETON', 'TRICKORTREAT'];
  const cases = [
    { name: 'mini 5x5 pizza/pasta', width: 5, height: 5, theme: ['PIZZA', 'PASTA'], timeLimitMs: 5000 },
    { name: '9x9 halloween', width: 9, height: 9, theme: halloween, timeLimitMs: 15000 },
    { name: '11x11 halloween', width: 11, height: 11, theme: halloween, timeLimitMs: 20000 },
    { name: '15x15 halloween', width: 15, height: 15, theme: halloween, timeLimitMs: 20000 },
  ];
  console.log('\n== generateLayouts (count 6, minScore 30) ==');
  for (const c of cases) {
    for (const seed of QUICK ? [1] : [1, 2]) {
      const res = await generateLayouts({ ...c, wordlist: wl, count: 6, seed, theme: c.theme.map((answer) => ({ answer })) });
      const ls = res.layouts;
      const placed = ls.map((l) => l.placements.length);
      const proven = ls.filter((l) => l.filled).length;
      const fillAvg = ls.filter((l) => l.stats.fillAvgScore != null).map((l) => l.stats.fillAvgScore);
      console.log(
        `${c.name.padEnd(22)} seed ${seed}: ${res.ms} ms, ${res.attempts} attempts, ${ls.length} layouts (${proven} proven), `
        + `theme placed [${placed.join(',')}] of ${c.theme.length}, fill avg [${fillAvg.map((x) => Math.round(x)).join(',')}], `
        + `blocks [${ls.map((l) => l.stats.blocks).join(',')}], words [${ls.map((l) => l.stats.words).join(',')}]`,
      );
      if (ls[0] && flag('show')) {
        const l = ls[0];
        const cells = l.filled || l.cells;
        for (let r = 0; r < c.height; r++) console.log('    ' + cells.slice(r * c.width, (r + 1) * c.width).map((x) => x || '.').join(' '));
        console.log('    placements:', l.placements.map((p) => `${p.answer}@${p.row},${p.col}${p.dir[0]}`).join(' '), 'unplaced:', l.unplaced.join(' '));
      }
    }
  }
}

/**
 * Theme coverage at the builder's defaults (medium density, minScore 30, count 6): the themes reviewers tried. Each
 * line: best layout's placed / placeable answers, the placed counts of all layouts, time, and any entry of a layout
 * that is neither a usable list word nor a theme answer (must be none).
 */
async function benchCoverage(wl) {
  const cases = [
    { name: '5x5 pizza/pasta', size: 5, ms: 10000, theme: ['PIZZA', 'PASTA'] },
    { name: '5x5 fruit stack', size: 5, ms: 10000, theme: ['APPLE', 'MANGO', 'GRAPE', 'LEMON', 'PEACH'] },
    { name: '7x7 taco/salsa/nacho', size: 7, ms: 20000, theme: ['TACO', 'SALSA', 'NACHO'] },
    { name: '9x9 armani/nachos', size: 9, ms: 20000, theme: ['ARMANI', 'NACHOS'] },
    { name: '9x9 coffee (10)', size: 9, ms: 20000, theme: ['ESPRESSO', 'LATTE', 'MOCHA', 'BARISTA', 'CREMA', 'ARABICA', 'DECAF', 'ROAST', 'JAVA', 'BREW'] },
    { name: '9x9 game night (7)', size: 9, ms: 60000, theme: ['ARMANI', 'BOWLING', 'KARAOKE', 'GAMENIGHT', 'ROADTRIP', 'PIZZA', 'NACHOS'] },
    { name: '11x11 halloween (4)', size: 11, ms: 20000, theme: ['HALLOWEEN', 'PUMPKIN', 'GHOST', 'CANDYCORN'] },
    { name: '15x15 sandwich (5)', size: 15, ms: 20000, theme: ['PEANUTBUTTER', 'JELLYBEAN', 'GRILLEDCHEESE', 'CHOCOLATECHIP', 'STRAWBERRYJAM'] },
    {
      name: '15x15 halloween (10)', size: 15, ms: 20000,
      theme: ['JACKOLANTERN', 'TRICKORTREAT', 'HAUNTEDHOUSE', 'CANDYCORN', 'SKELETON', 'WITCH', 'GHOST', 'COSTUME', 'PUMPKIN', 'CAULDRON'],
    },
  ];
  console.log('\n== theme coverage (medium density, minScore 30, count 6) ==');
  for (const c of cases) {
    const placeable = c.theme.filter((a) => a.length <= c.size).length;
    for (const seed of QUICK ? [1] : [1, 2, 3]) {
      const res = await generateLayouts({
        width: c.size, height: c.size, theme: c.theme.map((answer) => ({ answer })), wordlist: wl, count: 6, timeLimitMs: c.ms, seed,
      });
      const bad = [];
      for (const l of res.layouts) {
        for (const cells of [l.cells, l.filled].filter(Boolean)) {
          const g = { width: c.size, height: c.size, cells };
          for (const e of computeEntries(g).all) {
            const w = e.cells.map((i) => cells[i]).join('');
            if (/^[A-Z]+$/.test(w) && w.length === e.length && !c.theme.includes(w) && !(wl.has(w) && wl.score(w) >= 30)) bad.push(w);
          }
        }
      }
      const best = res.layouts[0];
      console.log(
        `${c.name.padEnd(22)} seed ${seed}: best ${best ? best.placements.length : 0}/${placeable} `
        + `[${res.layouts.map((l) => l.placements.length).join(',')}] in ${res.ms} ms`
        + `${best ? ` — ${best.placements.map((p) => p.answer).join(', ')}` : ''}${bad.length ? `  !! NOT WORDS: ${bad.join(' ')}` : ''}`,
      );
    }
  }
}

/** "5-15" or "7,9,15" → sizes. */
function parseSizes(text) {
  const out = [];
  for (const part of String(text).split(',')) {
    const [a, b] = part.split('-').map(Number);
    for (let n = a; n <= (b || a); n++) out.push(n);
  }
  return out;
}

/**
 * Blank patterns: for every size and density, `--seeds` patterns (randomPattern with the word list, seed s) each
 * filled once (fill seed s, minScore 30, `--time` limit, default 8 s). Reports fill success, fill time, the blocks
 * the patterns have (vs. the density's target) and the slowest pattern generation.
 */
async function benchBlank(wl) {
  const seeds = Number(opt('seeds', QUICK ? 5 : 20));
  const time = Number(opt('time', 8000));
  const symmetry = opt('symmetry', 'rotational');
  const sizes = parseSizes(opt('sizes', '5-15'));
  console.log(`\n== blank patterns: ${seeds} per size and density, ${symmetry} symmetry, fill at minScore 30 within ${time} ms ==`);
  console.log('size  | density | filled | median ms | max ms | blocks (target) | pattern ms (max)');
  let total = 0;
  let filled = 0;
  for (const size of sizes) {
    for (const density of ['low', 'medium', 'high']) {
      let ok = 0;
      const times = [];
      const blocks = new Set();
      let genMax = 0;
      for (let s = 1; s <= seeds; s++) {
        const g0 = performance.now();
        const cells = randomPattern({ width: size, height: size, symmetry, density, seed: s, wordlist: wl, minScore: 30 });
        genMax = Math.max(genMax, performance.now() - g0);
        if (!cells) { times.push(Infinity); continue; }
        blocks.add(cells.filter((c) => c === '#').length);
        const grid = { width: size, height: size, cells };
        const r = await fillGrid(grid, wl, { minScore: 30, timeLimitMs: time, seed: s });
        times.push(r.stats.ms);
        if (r.ok) {
          ok++;
          const bad = verifyFill(grid, r.cells, wl);
          if (bad) console.log(`  !! INVALID FILL ${size}x${size} ${density} seed ${s}: ${bad}`);
        }
      }
      total += seeds;
      filled += ok;
      times.sort((a, b) => a - b);
      const range = [...blocks].sort((a, b) => a - b);
      console.log(
        `${`${size}x${size}`.padEnd(5)} | ${density.padEnd(7)} | ${`${ok}/${seeds}`.padStart(6)} | ${fmtMs(pct(times, 0.5)).padStart(9)} | `
        + `${fmtMs(times[times.length - 1]).padStart(6)} | ${`${range[0]}–${range[range.length - 1]} (${targetBlocks(size, size, density)})`.padEnd(15)} | ${fmtMs(genMax)}`,
      );
    }
  }
  console.log(`total: ${filled}/${total} filled (${((100 * filled) / total).toFixed(1)}%)`);
}

/**
 * Answer freshness: fill `--fills` seeded blank 9×9 and 15×15 patterns (medium density) to find the `--top` most
 * common answers, then fill another `--fills` of each without and with `penalize` (`--points` per answer) and
 * compare how often those answers appear, plus fill success, time and average word score.
 */
async function benchFreshness(wl) {
  const fills = Number(opt('fills', QUICK ? 20 : 100));
  const top = Number(opt('top', 200));
  const points = Number(opt('points', 30));
  const time = Number(opt('time', 8000));
  const pattern = (size, seed) => ({ width: size, height: size, cells: randomPattern({ width: size, height: size, density: 'medium', seed, wordlist: wl }) });
  const entryWords = (g, cells) => computeEntries(g).all.map((e) => e.cells.map((i) => cells[i]).join(''));
  const run = async (firstSeed, penalize) => {
    const out = [];
    for (const size of [9, 15]) {
      for (let s = firstSeed; s < firstSeed + fills; s++) {
        const g = pattern(size, s);
        const r = await fillGrid(g, wl, { minScore: 30, timeLimitMs: time, seed: s, penalize });
        out.push({ size, ok: r.ok, ms: r.stats.ms, avg: r.stats.avgScore, words: r.ok ? entryWords(g, r.cells) : [] });
      }
    }
    return out;
  };
  console.log(`\n== answer freshness: ${fills} fills per size (9x9, 15x15 medium), top ${top} answers, penalty ${points} points ==`);
  const train = await run(1, null);
  const freq = new Map();
  for (const f of train) for (const w of new Set(f.words)) freq.set(w, (freq.get(w) || 0) + 1);
  const common = [...freq].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, top).map(([w]) => w);
  const okTrain = train.filter((f) => f.ok).length;
  console.log(`training fills: most common ${common.slice(0, 8).map((w) => `${w} ${Math.round((100 * freq.get(w)) / okTrain)}%`).join(', ')}`);
  const commonSet = new Set(common);
  const penalize = Object.fromEntries(common.map((w) => [w, points]));
  for (const [label, pen] of [['without penalize', null], [`penalize ${points}`, penalize]]) {
    const res = await run(10001, pen);
    console.log(`${label}:`);
    for (const size of [9, 15]) {
      const rs = res.filter((f) => f.size === size);
      const ok = rs.filter((f) => f.ok);
      const per = new Map();
      let entries = 0;
      let used = 0;
      for (const f of ok) {
        entries += f.words.length;
        for (const w of f.words) if (commonSet.has(w)) { used++; per.set(w, (per.get(w) || 0) + 1); }
      }
      const most = [...per].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([w, n]) => `${w} ${Math.round((100 * n) / ok.length)}%`);
      const ms = rs.map((f) => f.ms).sort((a, b) => a - b);
      console.log(
        `  ${size}x${size}: top-${top} answers ${((100 * used) / entries).toFixed(1)}% of entries (${(used / ok.length).toFixed(1)} per fill; `
        + `most used ${most.join(', ')}) · filled ${ok.length}/${rs.length} · median ${fmtMs(pct(ms, 0.5))} ms, p90 ${fmtMs(pct(ms, 0.9))} ms`
        + ` · avg word score ${(ok.reduce((a, f) => a + f.avg, 0) / ok.length).toFixed(1)}`,
      );
    }
  }
}

const t0 = performance.now();
const wl = WordList.fromText(readFileSync(WORDLIST, 'utf8'));
console.log(`word list: ${wl.size} words, loaded in ${Math.round(performance.now() - t0)} ms (${path.relative(ROOT, WORDLIST)})`);
if (!ONLY || ONLY === 'fill') await benchFill(wl);
if (!ONLY || ONLY === 'layouts') await benchLayouts(wl);
if (!ONLY || ONLY === 'coverage') await benchCoverage(wl);
if (ONLY === 'blank') await benchBlank(wl);
if (ONLY === 'freshness') await benchFreshness(wl);
console.log(`\ntotal ${(performance.now() - t0) / 1000 | 0} s`);
