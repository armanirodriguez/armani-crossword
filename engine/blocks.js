// Symmetric block patterns (used by the layout generator, see layout.js).
//
// completeBlocks() turns a partially decided Board (theme answers placed, their caps set) into a full, valid
// American-style block pattern: it adds symmetric block pairs that break up over-long runs, open areas and runs
// through theme letters that few or no list words fit, until a density target is reached — never creating an
// entry shorter than 3 letters and never disconnecting the white cells (so every white cell is checked both ways).

import { validateGrid } from '../site/shared/grid.js';
import { Board } from './board.js';
import { makeRng, normalizeSeed } from './util.js';
import { runBits, fillEstimate, fillShortfall } from './fillability.js';

// ---------------------------------------------------------------------------
// Size / density parameters

/**
 * Density levels, sparsest first. 'extra' is internal: when the requested density cannot hold all the theme answers,
 * the layout generator also tries one and two levels denser than requested (see generateLayouts).
 */
export const DENSITY_LEVELS = ['low', 'medium', 'high', 'extra'];

/** Index of a density name in DENSITY_LEVELS (unknown → medium). */
export function densityIndex(density) {
  const d = DENSITY_LEVELS.indexOf(density);
  return d < 0 ? 1 : d;
}

/** Target number of blocks for a grid. */
export function targetBlocks(width, height, density = 'medium') {
  const area = width * height;
  const d = densityIndex(density);
  const small = Math.min(width, height);
  if (small <= 5) return [0, 2, 4, 4][d];
  if (small <= 7) return Math.round(area * [0.04, 0.1, 0.16, 0.2][d]);
  if (small <= 9) return Math.round(area * [0.1, 0.14, 0.17, 0.2][d]);
  return Math.round(area * [0.13, 0.16, 0.185, 0.21][d]);
}

/** Longest non-theme entry allowed along a line of `len` cells. */
export function maxRunLength(len, density = 'medium') {
  const d = densityIndex(density);
  if (len <= 5) return len;
  if (len <= 7) return [len, len, len, len - 1][d];
  if (len <= 9) return [len, len, 8, 7][d];
  if (len <= 11) return [9, 8, 7, 7][d];
  if (len <= 15) return [10, 8, 7, 7][d];
  return [11, 9, 8, 8][d];
}

// ---------------------------------------------------------------------------
// Completion

/**
 * Context for block completion: limits, weights and (optionally) the word list, so that runs crossing theme
 * letters are judged by how many list words fit their pattern. `freedom` > 0 also rewards blocks by the fill
 * freedom they add (bits, see fillability.js runBits) times that weight — used for blank patterns.
 */
function makeCompletionContext({ target, maxA, maxD, weights = BLOCK_WEIGHTS, wordlist = null, minScore = 30, freedom = 0 }) {
  const cache = new Map();
  return {
    target, maxA, maxD, weights,
    freedom,
    runBits: freedom > 0 ? runBits(wordlist, { minScore }) : null,
    /** Number of list words matching a pattern ('.' = free), cached. */
    count(pattern) {
      let n = cache.get(pattern);
      if (n === undefined) {
        n = wordlist ? wordlist.count(pattern, { minScore }) : Infinity;
        cache.set(pattern, n);
      }
      return n;
    },
  };
}

/** Runs through theme letters with fewer matching words than this must be broken up (if they can be). */
const MIN_RUN_MATCHES = 3;

/** Penalty for a run whose pattern has `n` matching words. */
function hardness(n) {
  if (n === 0) return 100;
  if (n < 3) return 12;
  if (n < 10) return 5;
  if (n < 30) return 1.5;
  return 0;
}

/**
 * Score one row ('r') or column ('c') of the board, optionally pretending cells x and y are blocks.
 * Returns null if a run would be shorter than 3, else
 *   { excess, noWord, cost, threes, words, hard, free }
 *   excess  must-fix amount: over-long non-theme runs (4 + over²) and runs crossing theme letters that no list
 *           word fits (40 each) — both only when the run has a free cell, i.e. can still be broken
 *   noWord  the part of `excess` from runs through theme letters that (almost) no word fits
 *   cost    Σ run² (how open the line is)
 *   hard    Σ hardness of runs that contain theme letters
 *   free    Σ fill freedom of the runs in bits (only when ctx.freedom is set; see fillability.js runBits)
 */
function lineInfo(board, kind, a, ctx, x = -1, y = -1) {
  const { W, H } = board;
  const len = kind === 'r' ? W : H;
  const max = kind === 'r' ? ctx.maxA : ctx.maxD;
  const out = { excess: 0, noWord: 0, cost: 0, threes: 0, words: 0, hard: 0, free: 0 };
  const { runBits: bits } = ctx;
  let start = -1;
  let hasFree = false;
  let hasLetter = false;
  for (let k = 0; k <= len; k++) {
    const j = k < len ? (kind === 'r' ? a * W + k : k * W + a) : -1;
    const white = j >= 0 && !board.block[j] && j !== x && j !== y;
    if (white) {
      if (start < 0) { start = k; hasFree = false; hasLetter = false; }
      if (!board.req[j]) hasFree = true;
      if (board.letter[j]) hasLetter = true;
    } else if (start >= 0) {
      const run = k - start;
      if (run < 3) return null;
      out.words++;
      out.cost += run * run;
      if (run === 3) out.threes++;
      if (bits) out.free += bits[run];
      if (hasFree && run > max) out.excess += 4 + (run - max) * (run - max);
      if (hasLetter && hasFree) {
        let pat = '';
        for (let m = start; m < k; m++) pat += board.letter[kind === 'r' ? a * W + m : m * W + a] || '.';
        const n = ctx.count(pat);
        out.hard += hardness(n);
        const add = n === 0 ? 40 : n < MIN_RUN_MATCHES ? 8 : 0;
        out.excess += add;
        out.noWord += add;
      }
      start = -1;
    }
  }
  return out;
}

/**
 * Evaluate making cells i and p (partners) blocks. Returns null if that creates a run shorter than 3, else the
 * deltas (after − before) of lineInfo's measures summed over the affected rows and columns, plus `fixes`: the
 * lines (row r as r, column c as −1 − c) whose must-fix excess this pair reduces (null if none).
 */
function evaluateBlockPair(board, i, p, ctx, beforeInfo) {
  const { W } = board;
  const lines = [];
  const ri = (i / W) | 0;
  const rp = (p / W) | 0;
  lines.push(['r', ri], ['c', i - ri * W]);
  if (p !== i) {
    if (rp !== ri) lines.push(['r', rp]);
    if (p - rp * W !== i - ri * W) lines.push(['c', p - rp * W]);
  }
  const d = { dExcess: 0, dCost: 0, dThrees: 0, dWords: 0, dHard: 0, dFree: 0, fixes: null };
  for (const [kind, a] of lines) {
    const after = lineInfo(board, kind, a, ctx, i, p);
    if (!after) return null;
    addDeltas(d, after, beforeInfo[kind][a], lineKey(kind, a));
  }
  return d;
}

/** Add a line's measure changes (after − before) to the deltas `d`, recording the line in d.fixes if it improved. */
function addDeltas(d, after, before, key) {
  if (after.excess < before.excess) (d.fixes ||= []).push(key);
  d.dExcess += after.excess - before.excess;
  d.dCost += after.cost - before.cost;
  d.dThrees += after.threes - before.threes;
  d.dWords += after.words - before.words;
  d.dHard += after.hard - before.hard;
  d.dFree += after.free - before.free;
}

/** Score of a candidate block move from its deltas (see BLOCK_WEIGHTS; higher is better). */
function moveScore(d, ctx) {
  const w = ctx.weights;
  return -d.dExcess * w.excess - d.dCost * w.cost - d.dThrees * w.three - d.dHard * w.hard + d.dFree * ctx.freedom;
}

/** Weights of the block-placement heuristic (see completeBlocks). */
export const BLOCK_WEIGHTS = {
  excess: 10, // per unit of must-fix excess removed (over-long runs, runs no word fits)
  cost: 0.35, // per unit of Σ run² removed (breaks up open areas)
  three: 8, // per 3-letter entry created
  hard: 3, // per unit of pattern hardness (runs through theme letters with few matching words)
  cheater: 8, // block that adds no entry (15×15-style grids only)
  clump: 6, // block completing a 2×2 square of blocks
  temperature: 6, // softmax temperature for choosing among good candidates (variety)
};

/** Key of a row (r → r) or column (c → −1 − c) in the per-line bookkeeping. */
const lineKey = (kind, a) => (kind === 'r' ? a : -1 - a);

/**
 * Add symmetric block pairs until no run must be fixed (over-long non-theme runs, runs crossing theme letters
 * that no word fits) and the block target is met. Phase A (while must-fix runs exist) works "fail first": it
 * branches only on the block pairs that fix the must-fix line with the fewest options, and backtracks at once when
 * some must-fix line can never be fixed any more (see lineCanBeFixed) — e.g. a column through three theme rows
 * that earlier blocks have boxed in. Phase B adds blocks for density, never overshooting the target by one pair.
 * Candidates are scored (see BLOCK_WEIGHTS) and tried in a softmax-randomised order (best most likely first), so
 * repeated calls give varied patterns. Wherever no single pair fixes any must-fix line (every helpful block would
 * leave a 1–2 cell run, typically next to an edge), compound moves may be used: the pair plus the blocks that close
 * those short runs (see compoundCandidates) — this is what makes long theme rows near the edges workable (see
 * completeBlocksSteps for when). It is a small depth-first search: when a step has no usable candidate
 * (e.g. every way to break a long run would wall off part of the grid) it undoes the previous step and tries its
 * next candidate, within a node budget.
 * Options: target, maxA, maxD, rng, and optionally wordlist + minScore (pattern awareness), weights, branching,
 * maxNodes. Returns true on success (the board is modified in place); false if must-fix runs remain.
 */
export function completeBlocks(board, opts) {
  const steps = completeBlocksSteps(board, opts);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/**
 * completeBlocks as a generator that yields after every search node (nothing useful is yielded), so a caller can
 * spread a long completion over several event-loop turns and stop it early (steps.return()). Big grids (19×19 –
 * 21×21) can need several hundred milliseconds. Returns (as the generator's value) what completeBlocks returns.
 */
export function* completeBlocksSteps(board, opts) {
  // Around theme answers, compound moves are allowed from the start (measured: more of a five-phrase 15×15 theme
  // fits — 3.0 vs 2.2 answers on average — than when they only come after a failed plain search). A blank board
  // first gets the plain search (single block pairs only: the nicest patterns), as compound moves tend to leave
  // clumps of blocks against the edges (see compoundCandidates), and they are only allowed if that fails.
  if (board.req.some((x) => x)) return yield* searchBlocks(board, opts, true);
  const block = board.block.slice();
  const blocks = board.blocks;
  if (yield* searchBlocks(board, opts, false)) return true;
  board.block.set(block);
  board.blocks = blocks;
  return yield* searchBlocks(board, opts, true);
}

/** The depth-first search of completeBlocks (see there); `compound` enables compound moves. */
function* searchBlocks(board, opts, compound) {
  const { rng, branching = 4, maxNodes = 0 } = opts;
  const ctx = makeCompletionContext(opts);
  ctx.compound = compound;
  const budget = maxNodes || board.n * (board.n > 300 ? 12 : 2);
  const stack = []; // { cands, k, applied: [cells newly blocked] | null }
  let nodes = 0;
  const undo = (cells) => {
    for (const c of cells) board.block[c] = 0;
    board.blocks -= cells.length;
  };
  for (;;) {
    if (++nodes > budget) return false;
    yield nodes;
    const step = blockCandidates(board, ctx);
    if (step.done) return true;
    if (!step.cands.length && !step.mustFix) return true; // density target unreachable: accept as is
    stack.push({ cands: softmaxOrder(step.cands, ctx.weights.temperature, rng, branching), k: 0, applied: null });
    // Apply the next candidate of the top frame, backtracking through exhausted frames.
    for (;;) {
      const f = stack[stack.length - 1];
      if (f.applied) { undo(f.applied); f.applied = null; }
      if (f.k >= f.cands.length) {
        stack.pop();
        if (!stack.length || ++nodes > budget) return false;
        continue;
      }
      const { i, p, cells } = f.cands[f.k++];
      const added = [];
      for (const c of cells || (p === i ? [i] : [i, p])) {
        if (!board.block[c]) { board.block[c] = 1; board.blocks++; added.push(c); }
      }
      if (board.isConnected()) { f.applied = added; break; }
      undo(added);
    }
  }
}

/** Score every legal block pair for the current board (see completeBlocks). */
function blockCandidates(board, ctx) {
  const { n, W, H } = board;
  const { weights, target } = ctx;
  const mini = Math.min(W, H) <= 7;
  // Line measures of the current board, shared by all candidates of this step.
  const beforeInfo = { r: [], c: [] };
  let mustFix = false;
  for (let r = 0; r < H; r++) {
    const info = lineInfo(board, 'r', r, ctx) || { excess: Infinity, cost: 0, threes: 0, words: 0, hard: 0, free: 0 };
    beforeInfo.r.push(info);
    if (info.excess) mustFix = true;
  }
  for (let c = 0; c < W; c++) {
    const info = lineInfo(board, 'c', c, ctx) || { excess: Infinity, cost: 0, threes: 0, words: 0, hard: 0, free: 0 };
    beforeInfo.c.push(info);
    if (info.excess) mustFix = true;
  }
  if (!mustFix && board.blocks >= target) return { done: true, mustFix, cands: [] };
  const cands = [];
  for (let i = 0; i < n; i++) {
    const p = board.partner[i];
    if (p < i || board.block[i] || board.req[i] || board.req[p] || board.block[p]) continue;
    // Once only density is missing, don't overshoot the target by more than one pair.
    if (!mustFix && board.blocks + (p === i ? 1 : 2) > target + 1) continue;
    const ev = evaluateBlockPair(board, i, p, ctx, beforeInfo);
    if (!ev) continue;
    // While must-fix runs remain, only consider blocks that fix some of them.
    if (mustFix && ev.dExcess >= 0 && !ev.fixes) continue;
    let s = moveScore(ev, ctx);
    if (ev.dWords <= 0 && !mini) s -= weights.cheater;
    const r = (i / W) | 0;
    if (clump(board, r, i - r * W)) s -= weights.clump;
    cands.push({ i, p, s, fixes: ev.fixes, dExcess: ev.dExcess });
  }
  cands.sort((a, b) => b.s - a.s);
  if (!mustFix) return { done: false, mustFix, cands };
  if (!cands.length && ctx.compound) {
    // No single pair fixes anything: every block that would help leaves a 1–2 cell run behind (typically next to an
    // edge or an existing block, e.g. a column through three theme rows near the left edge). Try compound moves —
    // the pair plus the blocks that close those short runs (like "cheater" squares against the edge).
    const compound = compoundCandidates(board, ctx, beforeInfo);
    for (const c of compound) {
      const r = (c.i / W) | 0;
      let sc = moveScore(c.d, ctx);
      if (c.d.dWords <= 0 && !mini) sc -= weights.cheater;
      if (clump(board, r, c.i - r * W)) sc -= weights.clump;
      cands.push({ i: c.i, p: c.p, cells: c.cells, s: sc, fixes: c.d.fixes, dExcess: c.d.dExcess });
    }
    cands.sort((a, b) => b.s - a.s);
  }

  // Fail first: a line through theme letters that (almost) no word fits, with only a few single-step fixes, decides
  // what to branch on; otherwise every candidate that lowers the total excess is tried, best first (blocks that fix
  // several lines at once keep blank areas from getting choppy). A line that can never be fixed makes this state a
  // dead end. Lines that need two steps (e.g. the first block next to an edge must come from the crossing
  // direction) are left for later.
  const fixCount = new Map();
  for (const c of cands) if (c.fixes) for (const key of c.fixes) fixCount.set(key, (fixCount.get(key) || 0) + 1);
  let bestLine = null;
  let bestN = Infinity;
  for (const kind of ['r', 'c']) {
    const infos = beforeInfo[kind];
    for (let a = 0; a < infos.length; a++) {
      if (!infos[a].excess) continue;
      if (!lineCanBeFixed(board, kind, a, ctx)) return { done: false, mustFix, cands: [] };
      if (!infos[a].noWord) continue;
      const n = fixCount.get(lineKey(kind, a)) || 0;
      if (n > 0 && n < bestN) {
        bestN = n;
        bestLine = lineKey(kind, a);
      }
    }
  }
  if (bestLine === null || bestN > FAIL_FIRST_MAX) return { done: false, mustFix, cands: cands.filter((c) => c.dExcess < 0) };
  const fixers = cands.filter((c) => c.fixes && c.fixes.includes(bestLine));
  const reducing = fixers.filter((c) => c.dExcess < 0);
  return { done: false, mustFix, cands: reducing.length ? reducing : fixers };
}

/**
 * Most blocks a compound move may add (see compoundCandidates). Closing a short run next to the edge often cascades
 * through its symmetric partner; with 8 the classic 13/13/13 rows-3-7-11 arrangement completed 1 time in 30, with
 * 16 29 times in 30.
 */
const MAX_COMPOUND = 16;

/**
 * Compound moves: for each legal-looking cell whose pair would leave a 1–2 cell run behind, block the pair and then
 * (repeatedly) every short run it creates, as long as those runs hold no required cell and the move stays small.
 * Returns [{ i, p, cells, d }] for the moves that reduce some line's must-fix excess, where d holds the line-measure
 * deltas as in evaluateBlockPair.
 */
function compoundCandidates(board, ctx, beforeInfo, { only = null, requireFix = true } = {}) {
  const { n, W, H } = board;
  const out = [];
  const added = [];
  const lines = new Set();
  const block = (c) => {
    if (board.block[c]) return true;
    if (board.req[c]) return false;
    board.block[c] = 1;
    added.push(c);
    const r = (c / W) | 0;
    lines.add(lineKey('r', r));
    lines.add(lineKey('c', c - r * W));
    return true;
  };
  /** Block every 1–2 cell white run of the line (and partners). False if impossible. */
  const closeShortRuns = (key) => {
    const kind = key >= 0 ? 'r' : 'c';
    const a = key >= 0 ? key : -1 - key;
    const len = kind === 'r' ? W : H;
    let start = -1;
    for (let k = 0; k <= len; k++) {
      const j = k < len ? (kind === 'r' ? a * W + k : k * W + a) : -1;
      const white = j >= 0 && !board.block[j];
      if (white && start < 0) start = k;
      if (!white && start >= 0) {
        if (k - start < 3) {
          for (let m = start; m < k; m++) {
            const c = kind === 'r' ? a * W + m : m * W + a;
            if (!block(c) || !block(board.partner[c])) return false;
          }
        }
        start = -1;
      }
    }
    return true;
  };
  for (let i = 0; i < n; i++) {
    const p = board.partner[i];
    if (only ? !only.has(i) : p < i) continue;
    if (board.block[i] || board.req[i] || board.req[p] || board.block[p]) continue;
    added.length = 0;
    lines.clear();
    let ok = block(i) && block(p);
    // Close short runs to a fixpoint (lines re-scanned while new blocks keep appearing).
    for (let guard = 0; ok && guard < 4 * MAX_COMPOUND; guard++) {
      const before = added.length;
      for (const key of [...lines]) if (!(ok = closeShortRuns(key))) break;
      if (added.length > MAX_COMPOUND) ok = false;
      if (added.length === before) break;
    }
    let d = null;
    if (ok && added.length > (p === i ? 1 : 2)) {
      d = { dExcess: 0, dCost: 0, dThrees: 0, dWords: 0, dHard: 0, dFree: 0, fixes: null };
      for (const key of lines) {
        const kind = key >= 0 ? 'r' : 'c';
        const a = key >= 0 ? key : -1 - key;
        const after = lineInfo(board, kind, a, ctx);
        if (!after) { d = null; break; }
        addDeltas(d, after, beforeInfo[kind][a], key);
      }
    }
    for (const c of added) board.block[c] = 0;
    if (d && (d.fixes || !requireFix)) out.push({ i, p, cells: added.slice(), d });
  }
  return out;
}

/** A must-fix line with at most this many single-step fixes is handled first (see blockCandidates). */
const FAIL_FIRST_MAX = 4;

/**
 * Necessary condition for a must-fix line to ever be fixed by completeBlocks, which only adds blocks and never
 * creates a run shorter than 3. Blocking a free cell x of the line is "possible" unless it would leave, on this same
 * line, a 1–2 cell run containing a required (theme) cell: such a run can never be blocked away, so x stays illegal
 * forever. Then every offending run of the line needs
 *   • over-long run: a possible cell inside it;
 *   • run through theme letters that (almost) no word fits: a possible cell between its first and last theme
 *     letter (splitting it), or possible trims of its free ends that leave a pattern enough words fit.
 */
function lineCanBeFixed(board, kind, a, ctx) {
  const { W, H } = board;
  const len = kind === 'r' ? W : H;
  const max = kind === 'r' ? ctx.maxA : ctx.maxD;
  const at = (k) => (kind === 'r' ? a * W + k : k * W + a);
  const onLine = (j) => (kind === 'r' ? ((j / W) | 0) === a : j % W === a);
  const posOf = (j) => (kind === 'r' ? j - a * W : (j / W) | 0);

  const possible = (k) => {
    const x = at(k);
    const p = board.partner[x];
    if (board.block[x] || board.req[x] || board.req[p] || (board.block[p] && p !== x)) return false;
    const blocked = p !== x && onLine(p) ? [k, posOf(p)] : [k];
    for (const b of blocked) {
      for (const step of [-1, 1]) {
        let run = 0;
        let hasReq = false;
        for (let m = b + step; m >= 0 && m < len && !board.block[at(m)] && !blocked.includes(m); m += step) {
          run++;
          if (board.req[at(m)]) hasReq = true;
        }
        if (run > 0 && run < 3 && hasReq) return false;
      }
    }
    return true;
  };

  for (let start = 0; start < len;) {
    if (board.block[at(start)]) { start++; continue; }
    let end = start;
    while (end + 1 < len && !board.block[at(end + 1)]) end++;
    // The run is start..end. Theme letters span first..last.
    let first = -1;
    let last = -1;
    let free = false;
    let pat = '';
    for (let m = start; m <= end; m++) {
      const j = at(m);
      if (board.letter[j]) {
        if (first < 0) first = m;
        last = m;
      }
      if (!board.req[j]) free = true;
      pat += board.letter[j] || '.';
    }
    const noWord = first >= 0 && free && ctx.count(pat) < MIN_RUN_MATCHES;
    const tooLong = free && end - start + 1 > max;
    let ok = !noWord && !tooLong;
    if (!ok && !noWord) {
      for (let m = start; m <= end && !ok; m++) ok = possible(m);
    } else if (!ok) {
      for (let m = first + 1; m < last && !ok; m++) ok = possible(m);
      for (let s0 = start; s0 <= first && !ok; s0++) {
        if (s0 > start && !possible(s0 - 1)) continue;
        for (let e0 = end; e0 >= last && !ok; e0--) {
          if (e0 < end && !possible(e0 + 1)) continue;
          if (s0 === start && e0 === end) continue;
          if (ctx.count(pat.slice(s0 - start, e0 - start + 1)) >= MIN_RUN_MATCHES) ok = true;
        }
      }
    }
    if (!ok) return false;
    start = end + 1;
  }
  return true;
}

/**
 * Add one symmetric block pair inside the given cells (an entry the fill engine got stuck on), choosing the best
 * legal pair by the completion heuristic that keeps the white cells connected. Returns true if a pair was added.
 */
export function splitWithBlock(board, cells, opts) {
  const ctx = makeCompletionContext(opts);
  const { W, H } = board;
  const beforeInfo = { r: [], c: [] };
  const empty = { excess: 0, cost: 0, threes: 0, words: 0, hard: 0, free: 0 };
  for (let r = 0; r < H; r++) beforeInfo.r.push(lineInfo(board, 'r', r, ctx) || empty);
  for (let c = 0; c < W; c++) beforeInfo.c.push(lineInfo(board, 'c', c, ctx) || empty);
  const w = ctx.weights;
  const cands = [];
  for (const i of cells) {
    const p = board.partner[i];
    if (board.block[i] || board.req[i] || board.req[p] || board.block[p]) continue;
    const ev = evaluateBlockPair(board, i, p, ctx, beforeInfo);
    if (!ev) continue;
    let s = moveScore(ev, ctx);
    const r = (i / W) | 0;
    if (clump(board, r, i - r * W)) s -= w.clump;
    cands.push({ i, p, s });
  }
  cands.sort((a, b) => b.s - a.s);
  const tryGroup = (group) => {
    const added = [];
    for (const c of group) {
      if (!board.block[c]) { board.block[c] = 1; board.blocks++; added.push(c); }
    }
    if (board.isConnected()) return true;
    for (const c of added) board.block[c] = 0;
    board.blocks -= added.length;
    return false;
  };
  for (const { i, p } of cands) if (tryGroup(p === i ? [i] : [i, p])) return true;
  // Blocks that need company (they leave a 1–2 cell run that must be blocked too, e.g. next to the edge).
  const compound = compoundCandidates(board, ctx, beforeInfo, { only: new Set(cells), requireFix: false });
  for (const c of compound) {
    const r = (c.i / W) | 0;
    c.s = moveScore(c.d, ctx) - (clump(board, r, c.i - r * W) ? w.clump : 0) - w.cheater * (c.cells.length - (c.p === c.i ? 1 : 2));
  }
  compound.sort((a, b) => b.s - a.s);
  for (const c of compound) if (tryGroup(c.cells)) return true;
  return false;
}

/** Up to `k` items drawn without replacement with probability ∝ exp((s − best) / T) (items sorted by s desc). */
function softmaxOrder(items, T, rng, k) {
  const pool = items.slice(0, 16);
  const out = [];
  while (pool.length && out.length < k) {
    const j = softmaxPick(pool, T, rng);
    out.push(pool[j]);
    pool.splice(j, 1);
  }
  return out;
}

/** Index into `items` (sorted by .s desc) drawn with probability ∝ exp((s − best) / T). */
function softmaxPick(items, T, rng) {
  const best = items[0].s;
  let total = 0;
  const w = items.map((it) => {
    const x = Math.exp((it.s - best) / T);
    total += x;
    return x;
  });
  let u = rng() * total;
  for (let k = 0; k < w.length; k++) {
    u -= w[k];
    if (u <= 0) return k;
  }
  return w.length - 1;
}

/** Would a block at (r, c) complete a 2×2 square of blocks? */
function clump(board, r, c) {
  const B = (rr, cc) => rr >= 0 && cc >= 0 && rr < board.H && cc < board.W && board.block[rr * board.W + cc] === 1;
  for (const [dr, dc] of [[-1, -1], [-1, 0], [0, -1], [0, 0]]) {
    let k = 0;
    for (const [er, ec] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
      const rr = r + dr + er;
      const cc = c + dc + ec;
      if ((rr === r && cc === c) || B(rr, cc)) k++;
    }
    if (k === 4) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Blank patterns

/**
 * Blank patterns: weights of the fill-freedom term tried in turn (see makeCompletionContext) — the plain heuristic
 * first, which gives the nicest patterns (fewer 3-letter entries), then ever more weight on fill freedom.
 */
const BLANK_FREEDOM_STEPS = [0, 1, 2, 4];
/** Blank patterns: completions tried per (density level, freedom weight) step. */
const BLANK_TRIES = 6;

/** Most blocks a pattern for `target` may have before it counts as too choppy to offer (also used by layouts). */
export function maxBlocksFor(target) {
  return Math.max(target + 4, Math.round(target * 1.3) + 2);
}

/**
 * Blank block patterns (no theme answers) that are likely to fill: each completed pattern is judged by its fill
 * estimate (fillability.js: bits per white cell overall and in its weakest corner, against `wordlist` at `minScore`
 * or a typical list's statistics without one), and only a fillable one is accepted. Tries the requested density's
 * block target first, with the plain block heuristic and then with more and more weight on fill freedom
 * (BLANK_FREEDOM_STEPS); when no pattern is fillable, one more block pair, and so on up to the next density level's
 * target, then that level (up to the internal 'extra') — so a density that cannot be filled at some size maps to
 * the nearest one that can (e.g. a 'low' 7×7: two blocks leave stacks of 7-letter rows; the sparsest 7×7s that
 * fill reliably have six).
 * A generator that yields after every search node (see completeBlocksSteps), so callers can spread the work over
 * event-loop turns; returns { cells, level, freedom, bits, windowBits, shortfall } (level: index in DENSITY_LEVELS
 * of the run-length limits used; shortfall 0 = fillable): the first fillable pattern, else the one closest to it,
 * or null if no valid pattern could be built at all.
 */
export function* blankPatternSteps({
  width, height, symmetry = 'rotational', density = 'medium', rng, wordlist = null, minScore = 30,
}) {
  let best = null;
  for (let lv = densityIndex(density); lv < DENSITY_LEVELS.length; lv++) {
    const d = DENSITY_LEVELS[lv];
    const levelTarget = targetBlocks(width, height, d);
    const nextTarget = lv + 1 < DENSITY_LEVELS.length ? targetBlocks(width, height, DENSITY_LEVELS[lv + 1]) : levelTarget + 1;
    let built = 0;
    let relax = false;
    for (let target = levelTarget; target === levelTarget || target < nextTarget; target += 2) {
      const maxBlocks = maxBlocksFor(target);
      for (const freedom of BLANK_FREEDOM_STEPS) {
        for (let t = 0; t < BLANK_TRIES; t++) {
          // Shapes that cannot honour the run-length limits (e.g. 7 wide with mirror symmetry, whose columns 3 and
          // 5 can never hold a block) get unlimited runs once half the first tries built nothing.
          if (!built && t >= BLANK_TRIES / 2) relax = true;
          const board = new Board(width, height, symmetry);
          const ok = yield* completeBlocksSteps(board, {
            target, maxA: relax ? width : maxRunLength(width, d), maxD: relax ? height : maxRunLength(height, d),
            rng, wordlist, minScore, freedom,
          });
          if (!ok || !board.isConnected() || board.blocks > maxBlocks) continue;
          const cells = board.toCells();
          if (validateGrid({ width, height, cells }, { requireChecked: true, symmetry }).length) continue;
          built++;
          const est = fillEstimate({ width, height, cells }, wordlist, { minScore });
          const res = {
            cells, level: lv, freedom, bits: est.bitsPerCell, windowBits: est.minWindowBits, shortfall: fillShortfall(est),
          };
          if (!res.shortfall) return res;
          if (!best || res.shortfall < best.shortfall) best = res;
        }
      }
    }
  }
  return best;
}

/**
 * A random valid symmetric block pattern without theme answers that is likely to fill (see blankPatternSteps;
 * pass the word list the pattern will be filled from — without one a typical list's statistics are used).
 * Returns cells ('#' / '') or null if no valid pattern could be built.
 */
export function randomPattern({ width, height, symmetry = 'rotational', density = 'medium', seed, wordlist = null, minScore = 30 } = {}) {
  const steps = blankPatternSteps({ width, height, symmetry, density, rng: makeRng(normalizeSeed(seed)), wordlist, minScore });
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value ? r.value.cells : null;
  }
}
