// Theme-driven grid generation (SPEC §3.3).
//
// One "attempt" builds a candidate layout in three steps:
//   1. Place theme answers — in priority order, or (half the time) longest first. Each answer goes into a full
//      entry: its letters become required white cells (plus their symmetric partners), the cells just before/after
//      it become blocks (plus partners), and runs shorter than 3 that this creates are blocked. Slots are scored to
//      favour the classic American arrangement (across, symmetric pairs or the centre row, spread out — also from
//      the partner slots of placed answers — off the edges; see slotScore) and chosen with seeded noise for variety.
//   2. Complete the block pattern (completeBlocks, run in steps that yield to the event loop): add symmetric block
//      pairs that break up over-long runs, open areas and runs through theme letters that few or no list words fit,
//      until the density target is reached — never creating entries < 3 letters and never disconnecting the white
//      cells, so every white cell is checked in both directions.
//   3. Quick feasibility check: build the fill problem and run arc consistency only (no search). Entries that the
//      theme letters complete on their own (e.g. the columns of stacked theme rows) must be real list words
//      (fillGrid's verifyComplete). When the check fails, a block pair splitting the stuck entry is tried first.
//   If step 2 or 3 fails, the attempt retries without one theme answer (preferably one crossing the dead entry).
//   Layouts without theme answers (no theme, or none of it fits) are blank patterns judged by their fill estimate
//   (blankPatternSteps in blocks.js, fillability.js): the requested density, or the nearest denser one that fills.
//   While no proven layout holds every theme answer that fits, half of the attempts use a denser block pattern than
//   requested (one or two levels): shorter entries fill far more easily around theme letters.
//
// generateLayouts() alternates small batches of attempts with proving the most promising untested candidate
// fillable — a short fillGrid call with prefer = unplaced theme answers, so leftovers can still land in the grid
// as fill. A failed proof names the entry the fill got stuck on; the candidate is then "repaired" with a block
// pair inside that entry and the repaired version queued. A successful proof is followed by fitWords (see
// theme-fit.js), which tries to put the remaining theme answers into the proven layout's own slots. Until a proven
// layout holds every theme answer that fits the grid, the search uses the whole time budget (or until it stops
// finding new structures); after that it stops once the gallery is full and either no candidate promises more theme
// answers or the best layout has not improved for a while. It returns the distinct proven layouts, best first: by
// theme value (count, length and priority of the placed answers — see themeScore), then structure and fill quality.
// Layouts that hold no theme answer, or fewer than half as many as the best one, are left out.

import { computeEntries, validateGrid, BLOCK } from '../site/shared/grid.js';
import { Board } from './board.js';
import {
  completeBlocksSteps, splitWithBlock, blankPatternSteps, targetBlocks, maxRunLength, maxBlocksFor, densityIndex, DENSITY_LEVELS,
} from './blocks.js';
import { fillGrid, checkFillable, penaltiesOption } from './fill.js';
import { fitWords } from './theme-fit.js';
import { makeRng, normalizeSeed, normalizeWord, now, yieldToEventLoop } from './util.js';

// Re-exported for the benchmark, tests and tools.
export { completeBlocks, randomPattern, targetBlocks, maxRunLength, BLOCK_WEIGHTS } from './blocks.js';

const YIELD_EVERY_MS = 30;
const PROGRESS_EVERY_MS = 200;
/** Once the gallery is full, keep trying for more theme answers while the estimated success chance is at least this. */
const MIN_CHANCE = 0.12;
/** Longer second proof for candidates whose first proof timed out. */
const RETRY_FACTOR = 4;
/** How many times a failed candidate may be repaired (block added in its bottleneck entry), per lineage. */
const MAX_REPAIRS = 3;
/** Attempts before the first fill proof, and before stopping early. */
const FIRST_BATCH = 16;
const MIN_ATTEMPTS = 40;
/** Fitting leftover theme answers into a proven layout: at most this share of the remaining time, and this many proof budgets. */
const FIT_SHARE = 0.25;
const FIT_TRIES = 4;
/** Stop early when the best proven layout has not improved for this share of the budget (and at least STALE_MIN_MS). */
const STALE_SHARE = 0.3;
const STALE_MIN_MS = 3000;
/** Early stops (grids larger than 7×7) only after this share of the budget, capped at MIN_SEARCH_MAX_MS. */
const MIN_SEARCH_SHARE = 0.25;
const MIN_SEARCH_MAX_MS = 5000;
/** With nothing proven when only this share of the budget is left, the rest goes to one long proof. */
const LAST_CHANCE_SHARE = 0.3;
/** Attempts without a single completed block pattern after which the run-length limits are dropped. */
const RELAX_AFTER = 48;
/**
 * While the proven layouts hold fewer theme answers than could be placed, this share of the attempts uses a denser
 * block pattern (shorter entries are much easier to fill around theme letters): 60% of them one level denser than
 * requested, 40% two levels (when there is such a level).
 */
const DENSER_SHARE = 0.5;
/** Score penalty per density level above the requested one (so at equal theme coverage the requested one wins). */
const DENSER_PENALTY = 25;
/** Share of attempts that place the theme answers longest first instead of in priority order. */
const LONGEST_FIRST_SHARE = 0.5;
/** Blank grids: attempts without a new pattern after which a denser level is tried as well (see the main loop). */
const BLANK_VARIETY_AFTER = 30;
/** Block pairs added to a fresh candidate whose arc-consistency check fails, before giving up on its theme set. */
const CHECK_REPAIRS = 3;

/** Time for a first proof that a candidate is fillable: feasible layouts usually fill well within this. */
function fillBudgetMs(width, height) {
  const area = width * height;
  if (area <= 25) return 200;
  if (area <= 49) return 300;
  if (area <= 81) return 400;
  if (area <= 121) return 500;
  if (area <= 169) return 600;
  return 800;
}

// ---------------------------------------------------------------------------
// Theme placement

/** Partner slot of a slot under the board's symmetry, as [r, c] start (same dir & length). */
function partnerSlot(board, r, c, dir, len) {
  const { W, H, symmetry } = board;
  if (symmetry === 'rotational') return dir === 'across' ? [H - 1 - r, W - c - len] : [H - len - r, W - 1 - c];
  if (symmetry === 'mirror') return dir === 'across' ? [r, W - c - len] : [r, W - 1 - c];
  return [r, c];
}

/**
 * Try to put `answer` at (r, c, dir). Returns a new Board or null when it does not fit.
 * The original board is not modified.
 */
function placeAnswer(board, answer, themeIndex, r, c, dir) {
  const len = answer.length;
  const { W, H } = board;
  const cells = board.slotCells(r, c, dir, len);
  const own = dir === 'across' ? board.themeA : board.themeD;
  for (let k = 0; k < len; k++) {
    const i = cells[k];
    if (board.block[i] || board.block[board.partner[i]]) return null;
    if (board.letter[i] && board.letter[i] !== answer[k]) return null;
    if (own[i] >= 0) return null; // overlaps a theme answer running the same way
  }
  const before = dir === 'across' ? (c > 0 ? r * W + c - 1 : -1) : (r > 0 ? (r - 1) * W + c : -1);
  const after = dir === 'across' ? (c + len < W ? r * W + c + len : -1) : (r + len < H ? (r + len) * W + c : -1);
  for (const cap of [before, after]) {
    if (cap >= 0 && (board.req[cap] || board.req[board.partner[cap]])) return null;
  }
  const b = board.clone();
  const bOwn = dir === 'across' ? b.themeA : b.themeD;
  for (let k = 0; k < len; k++) {
    const i = cells[k];
    if (!b.require(i)) return null;
    b.letter[i] = answer[k];
    bOwn[i] = themeIndex;
  }
  for (const cap of [before, after]) if (cap >= 0 && !b.setBlock(cap)) return null;
  if (!b.repairShortRuns()) return null;
  return b;
}

/**
 * Heuristic desirability of a slot (higher is better). Encodes the classic American layout: theme answers run
 * across, in symmetric pairs (or the centre row), spread out rather than stacked, away from the edge rows, with
 * occasional interlocks; caps that would force extra blocks against the edge are discouraged.
 */
function slotScore(board, placed, answer, r, c, dir) {
  const len = answer.length;
  const { W, H } = board;
  const across = dir === 'across';
  let score = across ? 4 : 0;
  // Crossing existing theme letters: compact and interlocking.
  const cells = board.slotCells(r, c, dir, len);
  for (let k = 0; k < len; k++) if (board.letter[cells[k]]) score += 2;
  // Symmetric partner of an already placed answer of the same length (the classic arrangement).
  const [pr, pc] = partnerSlot(board, r, c, dir, len);
  if (pr === r && pc === c) score += 6; // self-symmetric centre slot (the classic home of an odd-length answer)
  let minGap = Infinity;
  for (const p of placed) {
    if (p.dir === dir && p.answer.length === len) {
      const [qr, qc] = partnerSlot(board, p.row, p.col, p.dir, len);
      if (qr === r && qc === c) score += 8;
    }
    if (p.dir !== dir) continue;
    // Stacking against the answer and against its symmetric partner slot (a full-length entry that must stay white,
    // so it is nearly as hard to fill against). The mirror-image pairs are implied by symmetry.
    const [qr, qc] = partnerSlot(board, p.row, p.col, p.dir, p.answer.length);
    const slots = qr === p.row && qc === p.col ? [[p.row, p.col]] : [[p.row, p.col], [qr, qc]];
    for (const [sr, sc] of slots) {
      const lineGap = across ? Math.abs(sr - r) : Math.abs(sc - c);
      if (lineGap === 0) continue;
      const s0 = across ? c : r;
      const p0 = across ? sc : sr;
      const overlap = Math.min(s0 + len, p0 + p.answer.length) - Math.max(s0, p0);
      if (overlap > 0) {
        minGap = Math.min(minGap, lineGap);
        if (lineGap === 1) score -= 10 + overlap; // stacked answers: very hard to fill across both
        else if (lineGap === 2) score -= 3 + overlap * 0.3; // every crossing between them is pinned at both ends
      }
    }
  }
  if (Number.isFinite(minGap) && minGap >= 3) score += Math.min(3, minGap - 2); // spread out
  // Edge lines are unusual for theme answers.
  const line = across ? r : c;
  const lines = across ? H : W;
  if (line === 0 || line === lines - 1) score -= 3;
  else if (line === 1 || line === lines - 2) score -= 1;
  // Cells between a cap and the edge that would have to become blocks (gaps of 1–2).
  const span = across ? W : H;
  const s = across ? c : r;
  const before = s - 1;
  const after = span - (s + len) - 1;
  if (before >= 1 && before <= 2) score -= 1.5 * before;
  if (after >= 1 && after <= 2) score -= 1.5 * after;
  return score;
}

/**
 * Place the answers (in the given order) on a fresh board.
 * Returns { board, placements: [{answer, row, col, dir, index}], unplaced: [index] }.
 */
function placeThemes(board, answers, order, rng, noise) {
  const placements = [];
  const unplaced = [];
  for (const idx of order) {
    const answer = answers[idx];
    const len = answer.length;
    const options = [];
    for (const dir of ['across', 'down']) {
      const maxR = dir === 'across' ? board.H - 1 : board.H - len;
      const maxC = dir === 'across' ? board.W - len : board.W - 1;
      for (let r = 0; r <= maxR; r++) {
        for (let c = 0; c <= maxC; c++) {
          options.push({ r, c, dir, s: slotScore(board, placements, answer, r, c, dir) + noise * (rng() + rng() + rng() - 1.5) });
        }
      }
    }
    options.sort((a, b) => b.s - a.s);
    let done = false;
    for (const o of options) {
      const next = placeAnswer(board, answer, idx, o.r, o.c, o.dir);
      if (next) {
        board = next;
        placements.push({ answer, row: o.r, col: o.c, dir: o.dir, index: idx });
        done = true;
        break;
      }
    }
    if (!done) unplaced.push(idx);
  }
  return { board, placements, unplaced };
}

// ---------------------------------------------------------------------------
// Structure statistics & scoring

function structureStats(cells, width, height) {
  const grid = { width, height, cells };
  const { all } = computeEntries(grid);
  const blocks = cells.reduce((s, ch) => s + (ch === BLOCK ? 1 : 0), 0);
  const words = all.length;
  const totalLen = all.reduce((s, e) => s + e.length, 0);
  const threes = all.filter((e) => e.length === 3).length;
  let clumps = 0; // 2×2 squares of blocks
  for (let r = 0; r + 1 < height; r++) {
    for (let c = 0; c + 1 < width; c++) {
      const i = r * width + c;
      if (cells[i] === BLOCK && cells[i + 1] === BLOCK && cells[i + width] === BLOCK && cells[i + width + 1] === BLOCK) clumps++;
    }
  }
  return { blocks, words, avgLength: words ? Math.round((totalLen / words) * 100) / 100 : 0, threes, clumps };
}

const THEME_BASE = 300;
const THEME_PER_LETTER = 30;
const THEME_PRIORITY = 500;

/**
 * Value of the placed theme answers (indices into `answers`, which is in priority order). Each answer counts, plus
 * its length (more of the theme in the grid) and its priority (the builder asks for the most important answer
 * first): so the user's top, long answers outrank a few more short, low-priority ones — e.g. JACKOLANTERN +
 * TRICKORTREAT + SKELETON + GHOST beat SKELETON + WITCH + GHOST + COSTUME + PUMPKIN.
 */
export function themeScore(placedIdx, answers) {
  const n = answers.length;
  let s = 0;
  for (const idx of placedIdx) s += THEME_BASE + THEME_PER_LETTER * answers[idx].length + (THEME_PRIORITY * (n - idx)) / n;
  return s;
}

function structureScore(st, target) {
  return st.avgLength * 6 - st.threes * 0.6 - Math.abs(st.blocks - target) * 0.8 - st.clumps * 1.5;
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Generate candidate layouts for a theme. See SPEC §3.3.
 * Addition: `penalize` (see fillGrid) is applied to the fill proofs and so to every layout's `filled` grid.
 */
export async function generateLayouts(params = {}) {
  const t0 = now();
  const {
    width, height, symmetry = 'rotational', theme = [], wordlist, count = 6, timeLimitMs = 20000,
    density = 'medium', seed, minScore = 30, fillPreview = true, penalize = null, onProgress, signal,
  } = params;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 3 || width > 25 || height > 25) {
    throw new Error(`Invalid grid size ${width}x${height}`);
  }
  if (!wordlist) throw new Error('generateLayouts needs a wordlist');
  const sym = ['rotational', 'mirror', 'none'].includes(symmetry) ? symmetry : 'rotational';
  const rng = makeRng(normalizeSeed(seed));
  const deadline = t0 + Math.max(0, timeLimitMs);
  // Block-pattern variants: the requested density, then one and two levels denser for when the theme does not fit
  // (see DENSER_SHARE). Run-length limits are relaxed (see the main loop) when the grid's shape cannot honour them.
  const baseLevel = Math.min(densityIndex(density), 2);
  const makeVariant = (lv) => {
    const t = targetBlocks(width, height, DENSITY_LEVELS[lv]);
    return {
      level: lv - baseLevel, target: t, maxA: maxRunLength(width, DENSITY_LEVELS[lv]), maxD: maxRunLength(height, DENSITY_LEVELS[lv]),
      // Layouts with far more blocks than the target are too choppy to offer.
      maxBlocks: maxBlocksFor(t),
    };
  };
  const variants = [baseLevel, baseLevel + 1, baseLevel + 2].filter((lv) => lv < DENSITY_LEVELS.length).map(makeVariant);
  /** Variant for the next attempt: the requested one, unless the theme does not fit yet (see DENSER_SHARE). */
  const pickVariant = () => {
    if (bestProven >= placeable.length || variants.length === 1) return variants[0];
    const u = rng();
    if (u >= DENSER_SHARE) return variants[0];
    return variants.length > 2 && u >= DENSER_SHARE * 0.6 ? variants[2] : variants[1];
  };
  const target = variants[0].target;
  let relaxed = false;
  let blockFails = 0;

  // Normalise theme answers, dropping duplicates (keeping the first occurrence's priority).
  const answers = [];
  const seen = new Set();
  for (const t of theme || []) {
    const a = normalizeWord(typeof t === 'string' ? t : t?.answer);
    if (!a || seen.has(a)) continue;
    seen.add(a);
    answers.push(a);
  }
  const placeable = [];
  answers.forEach((a, idx) => {
    if (a.length >= 3 && a.length <= Math.max(width, height)) placeable.push(idx);
  });
  // Answer freshness (see fillGrid's `penalize`), normalised once for all the fills below. Theme answers are never
  // penalized (fillGrid already exempts the unplaced ones, which it gets as prefer words).
  const penalties = penaltiesOption(penalize);
  for (const a of answers) penalties.delete(a);

  const pool = new Map(); // key → candidate
  const proven = [];
  /** Whether any candidate holding a theme answer has been built, and whether theme-less ones are allowed anyway. */
  let themedBuilt = false;
  let blankOk = false;
  /** Most theme answers in a proven layout so far, and when that was reached. */
  let bestProven = 0;
  let bestProvenAt = t0;
  let attempts = 0;
  let attemptsSinceNew = 0;
  let lastYield = now();
  let lastProgress = t0;
  let aborted = false;

  const report = (phase) => {
    if (typeof onProgress !== 'function') return;
    const t = now();
    if (t - lastProgress < PROGRESS_EVERY_MS) return;
    lastProgress = t;
    let bestPlaced = 0;
    for (const c of pool.values()) bestPlaced = Math.max(bestPlaced, c.placed.length);
    try {
      onProgress({ phase, attempts, candidates: pool.size, found: proven.length, bestPlaced, themeCount: answers.length, ms: Math.round(t - t0) });
    } catch {
      // ignore callback errors
    }
  };

  /**
   * Build one layout from a placement order with a block-pattern variant. Returns { cand } on success, or
   * { fail, culprits } where culprits are the theme indices most likely responsible (answers crossing the entry that
   * wiped out), when known; null when stopped (abort / deadline) in the middle.
   */
  const build = async (order, variant) => {
    if (!order.length) return buildBlank();
    const noise = 1 + rng() * 4;
    const { board, placements } = placeThemes(new Board(width, height, sym), answers, order, rng, noise);
    const opts = blockOpts(variant);
    const done = await stepped(completeBlocksSteps(board, { ...opts, rng }));
    if (done === null) return null;
    if (!done || !board.isConnected()) {
      blockFails++;
      return { fail: 'blocks', placements };
    }
    let res = finalize(board, placements, variant);
    // Arc consistency failed: the open area around the stuck entry is usually the problem (e.g. stacked full-width
    // rows in a mini), so split that entry with a block pair and check again before dropping theme answers.
    for (let k = 0; k < CHECK_REPAIRS && res.fail === 'unfillable' && res.entryCells; k++) {
      if (!splitWithBlock(board, res.entryCells, opts)) break;
      res = finalize(board, placements, variant);
    }
    return res;
  };

  /** Density level blank patterns start from: the requested one, until blankPatternSteps had to go denser. */
  let blankLevel = baseLevel;

  /**
   * A layout without theme answers: a blank pattern that is likely to fill (blankPatternSteps — at the requested
   * density, or the nearest denser one that fills). Same results as build.
   */
  const buildBlank = async () => {
    const res = await stepped(blankPatternSteps({
      width, height, symmetry: sym, density: DENSITY_LEVELS[blankLevel], rng, wordlist, minScore,
    }));
    if (!res) {
      if ((signal && signal.aborted) || now() >= deadline) return null;
      blockFails++;
      return { fail: 'blocks', placements: [] };
    }
    blankLevel = res.level;
    const board = new Board(width, height, sym);
    res.cells.forEach((ch, i) => {
      if (ch === BLOCK) {
        board.block[i] = 1;
        board.blocks++;
      }
    });
    return finalize(board, [], makeVariant(res.level));
  };

  const blockOpts = (variant) => ({
    target: variant.target, maxA: relaxed ? width : variant.maxA, maxD: relaxed ? height : variant.maxD, wordlist, minScore,
  });

  /**
   * Run a block-completion generator, yielding to the event loop every ~30 ms so a worker sees 'cancel' even on
   * 21×21 grids where one completion can take a while. Returns its result, or null if aborted / out of time.
   */
  const stepped = async (steps) => {
    for (;;) {
      const r = steps.next();
      if (r.done) return r.value;
      if (now() - lastYield >= YIELD_EVERY_MS) {
        await yieldToEventLoop();
        lastYield = now();
        if ((signal && signal.aborted) || now() >= deadline) {
          steps.return();
          return null;
        }
        report('search');
      }
    }
  };

  /** Validate a completed board and turn it into a candidate (see build). */
  const finalize = (board, placementsIn, variant) => {
    if (board.blocks > variant.maxBlocks) return { fail: 'choppy', placements: placementsIn };
    const cells = board.toCells();
    const grid = { width, height, cells };
    if (validateGrid(grid, { requireChecked: true, symmetry: sym }).some((i) => i.severity === 'error' || i.type === 'asymmetric')) {
      return { fail: 'invalid', placements: placementsIn };
    }
    // Each placement must be exactly one entry.
    const { all } = computeEntries(grid);
    const entryKey = new Set(all.map((e) => `${e.dir}:${e.cells[0]}:${e.length}`));
    const placements = placementsIn.filter((p) => entryKey.has(`${p.dir}:${p.row * width + p.col}:${p.answer.length}`));
    const placedIdx = placements.map((p) => p.index).sort((a, b) => a - b);
    const placedSet = new Set(placedIdx);
    const unplaced = answers.filter((_, idx) => !placedSet.has(idx));
    const key = cells.map((c) => c || '.').join('');
    if (pool.has(key)) return { fail: 'duplicate', placements };
    // verifyComplete: entries completed by theme letters alone (e.g. the columns of stacked theme rows) are not
    // user-forced — each must be a usable list word (or another theme answer), or the layout is rejected here.
    const check = checkFillable(grid, wordlist, { minScore, prefer: unplaced, preferFirst: false, verifyComplete: true, allowComplete: placements.map((p) => p.answer) });
    if (!check.ok) {
      // Theme answers crossing the entry that has no possible word are the likely culprits.
      const entry = all.find((e) => e.id === check.problem?.entryId);
      const culprits = [];
      if (entry) {
        const cellSet = new Set(entry.cells);
        for (const p of placements) {
          const pc = board.slotCells(p.row, p.col, p.dir, p.answer.length);
          if (pc.some((c) => cellSet.has(c))) culprits.push(p.index);
        }
      }
      return { fail: 'unfillable', placements, culprits, entryCells: entry && entry.cells.some((c) => !board.req[c]) ? entry.cells : null };
    }
    if (placements.length) themedBuilt = true;
    const st = structureStats(cells, width, height);
    const prelim = themeScore(placedIdx, answers) + structureScore(st, target) - DENSER_PENALTY * variant.level;
    return {
      cand: {
        key, cells, board, placements, placed: placedIdx, unplaced, stats: st, tested: false, failed: false, prelim,
        sig: placements.map((p) => `${p.answer}@${p.row},${p.col},${p.dir}`).sort().join(' '),
        rank: prelim,
        fillSeed: Math.floor(rng() * 0x7fffffff),
        repairs: 0,
        variant,
      },
    };
  };

  /**
   * A failed proof names the entry the fill got stuck on: derive a new candidate with a block pair splitting that
   * entry (same theme arrangement), so the next proof can try it. Up to MAX_REPAIRS generations.
   */
  const repair = (cand, entryId) => {
    if (!entryId || cand.repairs >= MAX_REPAIRS) return;
    const entry = computeEntries({ width, height, cells: cand.cells }).all.find((e) => e.id === entryId);
    if (!entry) return;
    const board = cand.board.clone();
    if (!splitWithBlock(board, entry.cells, blockOpts(cand.variant))) return;
    const res = finalize(board, cand.placements, cand.variant);
    if (!res.cand || res.cand.placed.length !== cand.placed.length) return;
    res.cand.repairs = cand.repairs + 1;
    pool.set(res.cand.key, res.cand);
  };

  /**
   * One randomized construction. When the layout cannot work, retry without one of the theme answers (a culprit
   * if known, else a placed answer biased towards low priority), so subsets of the theme get explored too.
   * Returns a candidate or null.
   */
  const attempt = async () => {
    attempts++;
    // Priority order — or, half the time, longest first (long answers are the hardest to fit, and placing a short
    // one first can take the only good home of a long one, e.g. a 4 above and below a 7×7's centre row) — then
    // occasionally perturbed (swap two neighbours) for variety. Which answers are kept still follows priority.
    let order = placeable.slice();
    if (rng() < LONGEST_FIRST_SHARE) order.sort((a, b) => answers[b].length - answers[a].length || a - b);
    if (order.length > 1 && rng() < 0.3) {
      const k = Math.floor(rng() * (order.length - 1));
      [order[k], order[k + 1]] = [order[k + 1], order[k]];
    }
    // Denser blocks when the requested density has not yet shown it can hold every theme answer.
    const variant = pickVariant();
    for (let retry = 0; retry <= placeable.length; retry++) {
      // A layout without any theme answer is only worth building while no themed one could be built at all (or as
      // a last resort when no themed one could be proven: blankOk).
      if (!order.length && placeable.length && themedBuilt && !blankOk) return null;
      const res = await build(order, variant);
      if (!res) return null; // stopped
      if (res.cand) return res.cand;
      if (res.fail === 'duplicate') return null;
      let pickFrom = res.culprits?.length ? res.culprits : res.placements.map((p) => p.index);
      if (!pickFrom.length) pickFrom = order;
      if (!pickFrom.length) return null;
      // Weighted towards lower priority (higher index).
      const weights = pickFrom.map((idx) => idx + 1);
      let u = rng() * weights.reduce((a, b) => a + b, 0);
      let drop = pickFrom[pickFrom.length - 1];
      for (let k = 0; k < pickFrom.length; k++) {
        u -= weights[k];
        if (u <= 0) { drop = pickFrom[k]; break; }
      }
      order = order.filter((idx) => idx !== drop);
    }
    return null;
  };

  // ---- Scheduling of fill proofs -------------------------------------------------------------------------
  // Themed grids are much harder to fill than blank ones (only ~1 in 4 candidates of a heavily themed 15×15 turns
  // out fillable, fewer the more answers it holds), and feasible ones usually fill fast, so each candidate first
  // gets a short proof. Which candidate to prove next is a small bandit: a candidate with k theme answers has
  // priority k + log2(p̂k), where p̂k is the observed (Laplace-smoothed) success rate of proofs at k answers, minus
  // a penalty for theme arrangements that already failed (other block patterns around the same arrangement often
  // fail too). So the generator goes for many theme answers while that pays off, and settles for fewer when it
  // does not. Timeouts (as opposed to proofs of impossibility) get one longer retry when they rank highest.
  const levelStats = new Map(); // placed count → { tests, ok }
  const provenPlaced = []; // theme answers each proven layout's structure placed (before fitting leftovers)
  const sigFails = new Map(); // theme arrangement → failed proofs
  const retry = []; // candidates that timed out once
  const level = (k) => {
    if (!levelStats.has(k)) levelStats.set(k, { tests: 0, ok: 0 });
    return levelStats.get(k);
  };
  /** Estimated chance that proving c succeeds: Laplace-smoothed success rate at its number of theme answers. */
  const chance = (c) => {
    const st = level(c.placed.length);
    return (st.ok + 1) / (st.tests + 2);
  };
  // Theme-less candidates (built before any themed one existed) are proved only when nothing else is left.
  const priority = (c) => (!c.placed.length && placeable.length ? -100 : 0)
    + c.placed.length + Math.log2(chance(c)) - 0.5 * (sigFails.get(c.sig) || 0);
  const better = (a, b) => {
    const pa = priority(a);
    const pb = priority(b);
    return pa !== pb ? pa > pb : a.rank > b.rank;
  };
  const pickBest = (list) => {
    let best = null;
    for (const c of list) if (!c.tested && (!best || better(c, best))) best = c;
    return best;
  };

  /**
   * Proving can stop once `count` layouts are proven and no untested (or retryable) candidate with more theme
   * answers than the count-th best proven layout has a reasonable chance of being fillable. Counts are compared
   * before fitting (provenPlaced): any candidate may gain fitted answers too.
   */
  const enoughProven = () => {
    if (proven.length < count) return false;
    const placed = provenPlaced.slice().sort((a, b) => b - a);
    const bar = placed[count - 1];
    const promising = (c) => c.placed.length > bar && chance(c) >= MIN_CHANCE;
    for (const c of pool.values()) if (!c.tested && promising(c)) return false;
    for (const c of retry) if (!c.retried && promising(c)) return false;
    return true;
  };

  /**
   * The gallery is full and the best layout has not improved for a while (STALE_SHARE of the budget, at least
   * STALE_MIN_MS): further search rarely pays off, so return what we have.
   */
  // Beyond minis, search a little before stopping early: fitted leftovers make later candidates worth a look.
  const minSearchMs = width * height > 49 ? Math.min(timeLimitMs * MIN_SEARCH_SHARE, MIN_SEARCH_MAX_MS) : 0;
  const stale = () => proven.length >= count && now() - bestProvenAt >= Math.max(STALE_MIN_MS, timeLimitMs * STALE_SHARE);

  const prove = async (cand, budget) => {
    const res = await fillGrid({ width, height, cells: cand.cells }, wordlist, {
      minScore, timeLimitMs: budget, seed: cand.fillSeed, prefer: cand.unplaced, preferFirst: false, penalize: penalties, signal,
      verifyComplete: true, allowComplete: cand.placements.map((p) => p.answer),
      onProgress: () => report('fill'),
    });
    if (res.reason === 'aborted') return false;
    const st = level(cand.placed.length);
    st.tests++;
    if (res.ok) {
      st.ok++;
      const fitted = cand.unplaced.length ? await fitLeftovers(cand, res) : null;
      proven.push(makeLayout(fitted ? fitted.cand : cand, fitted ? fitted.res : res, answers, width, height, target));
      provenPlaced.push(cand.placed.length);
      const n = proven[proven.length - 1].placements.length;
      if (n > bestProven) {
        bestProven = n;
        bestProvenAt = now();
      }
      if (signal && signal.aborted) return false;
    } else {
      sigFails.set(cand.sig, (sigFails.get(cand.sig) || 0) + 1);
      if (res.reason === 'timeout' && !cand.retried) retry.push(cand);
      else cand.failed = true;
      repair(cand, res.problem?.entryId);
    }
    return true;
  };

  /**
   * After a successful proof: try to fit the candidate's unplaced theme answers into its own slots (fitWords), with
   * a share of the remaining time. Returns { cand, res } describing the improved layout, or null if none fit.
   */
  const fitLeftovers = async (cand, res) => {
    const short = fillBudgetMs(width, height);
    const fit = await fitWords({
      grid: { width, height, cells: cand.cells }, filled: res.cells, words: cand.unplaced, wordlist, minScore,
      timeLimitMs: Math.min((deadline - now()) * FIT_SHARE, short * FIT_TRIES), tryMs: short, seed: cand.fillSeed,
      penalize: penalties, signal,
    });
    if (!fit.added.length) return null;
    const index = new Map(answers.map((a, i) => [a, i]));
    const addedSet = new Set(fit.added.map((a) => a.answer));
    return {
      cand: {
        ...cand,
        cells: fit.cells,
        placements: cand.placements.concat(fit.added.map(({ answer, row, col, dir }) => ({ answer, row, col, dir, index: index.get(answer) }))),
        unplaced: cand.unplaced.filter((a) => !addedSet.has(a)),
      },
      res: { ...res, cells: fit.filled, stats: fit.stats || res.stats },
    };
  };

  // Early stops apply only once a proven layout holds every theme answer that fits the grid. Until then the whole
  // budget is used (the user chose it, e.g. "Try harder"): more attempts — many with denser blocks — are what gets
  // more theme answers in. A pool that stops producing new structures ends the search too (see `saturated`).
  const complete = () => bestProven >= placeable.length;
  while (!aborted) {
    if (signal && signal.aborted) { aborted = true; break; }
    if (now() >= deadline) break;
    if (fillPreview && complete() && attempts >= MIN_ATTEMPTS && now() - t0 >= minSearchMs && (enoughProven() || stale())) break;

    // A batch of cheap attempts (counted, not timed, so results depend on the seed rather than machine speed):
    // a larger first batch so the first proof tests a good candidate, more when few candidates are waiting.
    let untested = 0;
    for (const c of pool.values()) if (!c.tested) untested++;
    const batch = attempts === 0 ? FIRST_BATCH : untested < 3 ? 12 : 4;
    for (let k = 0; k < batch && now() < deadline; k++) {
      const c = await attempt();
      if (signal && signal.aborted) { aborted = true; break; }
      if (c) {
        pool.set(c.key, c);
        attemptsSinceNew = 0;
      } else attemptsSinceNew++;
      if (now() - lastYield >= YIELD_EVERY_MS) {
        await yieldToEventLoop();
        lastYield = now();
        if (signal && signal.aborted) { aborted = true; break; }
      }
    }
    report('search');
    if (aborted) break;
    // Some shapes can never satisfy the run-length limits (e.g. 7 wide with mirror symmetry: columns 3 and 5 can
    // never hold a block, so they stay 11 long in a 7×11). If nothing at all could be built, accept long runs.
    if (!relaxed && !pool.size && !proven.length && attempts >= RELAX_AFTER && blockFails >= attempts
      && variants.some((v) => v.maxA < width || v.maxD < height)) {
      relaxed = true;
      attemptsSinceNew = 0;
    }
    // Blank grids: when a density has only a few distinct fillable patterns (e.g. two 6-block 7×7s), offer denser
    // ones too rather than a nearly empty gallery (they rank lower, see DENSER_PENALTY).
    if (!placeable.length && pool.size < count && attemptsSinceNew >= BLANK_VARIETY_AFTER && blankLevel < DENSITY_LEVELS.length - 1) {
      blankLevel++;
      attemptsSinceNew = 0;
    }
    const saturated = attemptsSinceNew > 400;

    if (!fillPreview) {
      // Without fill proofs, explore for a short while then return the best structures.
      if (pool.size >= count * 4 || saturated || now() - t0 > Math.min(timeLimitMs, 1500)) break;
      continue;
    }

    const cand = pickBest(pool.values());
    const again = retry.filter((c) => !c.retried).sort((a, b) => (better(a, b) ? -1 : 1))[0];
    const remaining = deadline - now();
    const short = fillBudgetMs(width, height);
    if (!proven.length && remaining < timeLimitMs * LAST_CHANCE_SHARE && (again || cand) && remaining > short) {
      // Nothing proven yet and time is running out: spend the rest on one long proof of the candidate with the most
      // theme answers (rather than on more short proofs) — an unproven gallery is much less useful.
      let last = null;
      for (const c of [...pool.values(), ...retry]) {
        if (c.failed || (c.tested && (c.retried || !retry.includes(c)))) continue;
        if (!last || c.placed.length > last.placed.length || (c.placed.length === last.placed.length && better(c, last))) last = c;
      }
      last ||= again || cand;
      last.tested = true;
      last.retried = true;
      if (!(await prove(last, remaining - 20))) { aborted = true; break; }
      continue;
    }
    if (again && (!cand || priority(again) > priority(cand)) && remaining > short * RETRY_FACTOR) {
      again.retried = true;
      if (!(await prove(again, short * RETRY_FACTOR))) { aborted = true; break; }
    } else if (cand) {
      cand.tested = true;
      if (remaining < 50) break;
      if (!(await prove(cand, Math.min(short, remaining)))) { aborted = true; break; }
    } else if (saturated) {
      // Nothing new to try. If no themed layout could be proven at all, fall back on layouts without the theme
      // rather than returning an empty gallery (see attempt); otherwise stop.
      if (proven.length || blankOk || !placeable.length) break;
      blankOk = true;
      attemptsSinceNew = 0;
    }
    report('fill');
    if (now() - lastYield >= YIELD_EVERY_MS) {
      await yieldToEventLoop();
      lastYield = now();
    }
  }

  let layouts = proven;
  if (!fillPreview || !proven.length) {
    // Unproven structures (filled: null), best first — only ones that never failed a fill attempt.
    const rest = [...pool.values()].filter((c) => !c.failed && !c.tested).sort((a, b) => b.prelim - a.prelim);
    layouts = proven.concat(rest.slice(0, Math.max(0, count - proven.length)).map((c) => makeLayout(c, null, answers, width, height, target)));
  }
  layouts.sort((a, b) => b.score - a.score);
  // Don't pad the gallery with layouts that lost most of the theme when better ones exist: no theme-less layouts
  // once one holds a theme answer, and none with fewer than half the theme answers of the best.
  const most = Math.max(0, ...layouts.map((l) => l.placements.length));
  if (most > 0) layouts = layouts.filter((l) => l.placements.length >= Math.max(1, most / 2));
  layouts = layouts.slice(0, count);
  const out = { layouts, attempts, ms: Math.round(now() - t0) };
  if (aborted) {
    out.aborted = true;
    out.reason = 'aborted';
  }
  return out;
}

/** Final layout object (SPEC §3.3). Theme answers the fill happened to use count as placed. */
function makeLayout(cand, fillRes, answers, width, height, target) {
  const placements = cand.placements.map(({ answer, row, col, dir }) => ({ answer, row, col, dir }));
  let unplaced = cand.unplaced.slice();
  const cells = cand.cells.slice();
  const locked = new Set();
  for (const p of placements) {
    for (let k = 0; k < p.answer.length; k++) locked.add(p.dir === 'across' ? p.row * width + p.col + k : (p.row + k) * width + p.col);
  }
  let filled = null;
  let fillAvgScore = null;
  if (fillRes && fillRes.ok) {
    filled = fillRes.cells;
    fillAvgScore = fillRes.stats.avgScore;
    // Leftover theme answers that the fill placed (they were preferred words).
    if (unplaced.length) {
      const grid = { width, height, cells: filled };
      const { all } = computeEntries(grid);
      const left = new Set(unplaced);
      for (const e of all) {
        const word = e.cells.map((i) => filled[i]).join('');
        if (left.has(word)) {
          left.delete(word);
          placements.push({ answer: word, row: e.row, col: e.col, dir: e.dir });
          for (const i of e.cells) { locked.add(i); cells[i] = filled[i]; }
        }
      }
      unplaced = unplaced.filter((a) => left.has(a));
    }
  }
  const order = new Map(answers.map((a, i) => [a, i]));
  placements.sort((a, b) => order.get(a.answer) - order.get(b.answer));
  const placedIdx = placements.map((p) => order.get(p.answer));
  const st = cand.stats;
  const score = themeScore(placedIdx, answers) + structureScore(st, target) + (fillAvgScore ?? 40) * 1.5
    - DENSER_PENALTY * (cand.variant?.level || 0);
  return {
    cells,
    filled,
    placements,
    unplaced,
    locked: [...locked].sort((a, b) => a - b),
    stats: { blocks: st.blocks, words: st.words, avgLength: st.avgLength, fillAvgScore },
    score: Math.round(score * 10) / 10,
  };
}
