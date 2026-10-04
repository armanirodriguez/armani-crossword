// `build`: theme answers -> a filled, symmetric grid for one Claude puzzle, written as a draft plus a clue worksheet
// in .claude-way/ (git-ignored: plaintext answers).
//
// 1. Plan: { title, theme, note?, answers: [{ answer, clue? }] } in priority order (most important first).
// 2. generateLayouts (engine/layout.js) places as many theme answers as it can as whole entries and proves each layout
//    fillable (leftover answers are preferred words in the fill), with answer freshness (`penalize`: answers of both
//    series within ±30 days and Claude drafts of nearby days; never the theme answers). Several seeds search in
//    parallel worker threads when the machine has the cores (layout-worker.mjs).
// 3. The best layouts get final fills (fillGrid, minScore 35 by default) with a few seeds. Candidates rank by theme
//    value (count, length and priority of the placed answers) minus a choppiness penalty (too many blocks, 2×2 block
//    squares, long block runs), then fill quality (average score minus iffy entries: low scores, repeats, words echoing
//    a theme answer or each other). Nothing fillable at minScore 35 -> minScore 30 (reported).
// 4. Polish: the chosen layout is refilled avoiding its iffy entries while that improves the fill.

import { generateLayouts, themeScore } from '../../engine/layout.js';
import { fillGrid } from '../../engine/fill.js';
import { computeEntries } from '../../site/shared/grid.js';
import { isValidDateId, isValidKind, makeDraft, normalizeAnswer, normalizeClue, hash32, parsePuzzleId } from '../../site/shared/puzzle.js';
import {
  AUTHOR, CliError, DEFAULT_MIN_SCORE, DEFAULT_TIME, FALLBACK_MIN_SCORE, FILL_MS, LEVEL_GUIDES, LOW_SCORE, OBSCURE_BELOW, SERIES, SIZES,
  claudeFile, claudeId, describeUses, difficulty, draftFile, gridRows, loadBanned, loadClueBanks, loadWordList,
  penaltiesFor, readJson, recentAnswers, rel, siteToday, weekdayName, worksheetFile, writeFileAtomic, writeJsonAtomic,
} from './common.mjs';
import { stems } from './gates.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

/** Most theme answers worth asking for, per kind (more are allowed but rarely fit). */
const SUGGESTED_MAX = { mini: 2, midi: 4, daily: 5 };
/**
 * Beyond these a grid looks choppy (too many blocks, 2×2 block squares, long block runs cutting off a corner).
 * Layouts are ranked by theme value minus a choppiness penalty that grows quickly past these limits (see
 * choppyPenalty): a few blocks too many are worth a theme answer, a much choppier grid is not. --max-blocks
 * overrides the block limit.
 */
export const CHOPPY = Object.freeze({
  mini: { blocks: 6, clumps: 0, run: 2 },
  midi: { blocks: 16, clumps: 0, run: 3 },
  daily: { blocks: 44, clumps: 1, run: 3 },
});
/** Layouts that get final fills, and fresh fill seeds per layout. */
const FINAL_LAYOUTS = 3;
const FILL_SEEDS = 2;
/** Layout searches (seeds) per min score: run in parallel when there are cores for it. */
const DEFAULT_TRIES = { mini: 2, midi: 3, daily: 3 };
/** Polishing the chosen fill: total time, refill rounds, seeds per round, time per refill. */
const POLISH_MS = { mini: 2000, midi: 6000, daily: 20000 };
const POLISH_ROUNDS = 4;
const POLISH_SEEDS = 3;
const POLISH_FILL_MS = { mini: 400, midi: 1500, daily: 4000 };

const WORKER_URL = new URL('./layout-worker.mjs', import.meta.url);

/** Worker threads for parallel layout searches: cores - 1, at most 4. */
function parallelism() {
  const n = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, n - 1));
}

/** generateLayouts in a worker thread (it loads the root's word list itself and bans `avoid`). */
function layoutsInWorker(root, avoid, params) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(WORKER_URL, { workerData: { root, avoid, params } });
    worker.once('message', (msg) => {
      settled = true;
      worker.terminate();
      if (msg && msg.error) reject(new Error(msg.error));
      else resolve(msg);
    });
    worker.once('error', (err) => {
      if (!settled) reject(err);
      settled = true;
    });
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`layout worker exited (${code})`));
      settled = true;
    });
  });
}

/**
 * Validate and normalise a plan. Throws a CliError listing every problem.
 * @returns {{ title, theme, note, answers: [{ answer, clue, raw }], warnings: string[] }}
 */
export function normalizePlan(raw, kind, isBanned = () => null) {
  const size = SIZES[kind];
  const problems = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CliError('The plan must be a JSON object: { "title", "theme", "answers": [{ "answer", "clue" }] }');
  const title = normalizeClue(raw.title);
  const theme = normalizeClue(raw.theme);
  const note = typeof raw.note === 'string' ? raw.note.trim() : '';
  if (!theme) problems.push('plan.theme: name the theme topic (e.g. "Fall flavors"); it is recorded to avoid repeats');
  const list = Array.isArray(raw.answers) ? raw.answers : [];
  if (!list.length) problems.push('plan.answers: list at least one theme answer, most important first');
  const answers = [];
  const seen = new Set();
  list.forEach((item, i) => {
    const rawAnswer = typeof item === 'string' ? item : item?.answer;
    const clue = typeof item === 'object' && item ? normalizeClue(item.clue) : '';
    const answer = normalizeAnswer(rawAnswer);
    const label = `answers[${i}] "${rawAnswer ?? ''}"`;
    if (!answer) return problems.push(`${label}: no letters`);
    if (answer.length < 3) return problems.push(`${label}: ${answer} is shorter than 3 letters`);
    if (answer.length > size) {
      return problems.push(`${label}: ${answer} has ${answer.length} letters but the ${kind} grid is ${size}×${size} — use answers of at most ${size} letters`);
    }
    const banned = isBanned(answer);
    if (banned) return problems.push(`${label}: ${answer} is banned (${banned})`);
    if (seen.has(answer)) return warnings.push(`${answer} is listed twice; the duplicate was dropped`);
    seen.add(answer);
    answers.push({ answer, clue, raw: String(rawAnswer) });
  });
  if (problems.length) throw new CliError('The plan has problems:', { details: problems });
  if (answers.length > SUGGESTED_MAX[kind]) {
    warnings.push(`${answers.length} theme answers for a ${kind}: usually at most ${SUGGESTED_MAX[kind]} fit; the generator keeps the most important ones it can place`);
  }
  return { title, theme, note, answers, warnings };
}

/** Particles that make phrase compounds out of a word: AT + BAT, BONE + UP, BRING + OUT. */
const PARTICLES = new Set(['AT', 'UP', 'IN', 'ON', 'BY', 'OF', 'OUT', 'OFF', 'DOWN', 'OVER', 'AWAY', 'BACK']);

/**
 * The shorter answer when one answer is the other plus a particle or another word (BAT / ATBAT, BONE / BONEUP,
 * EGG / EGGNOG) — often the same word twice in the grid. Only a hint for review (CAR / CARPET is a coincidence),
 * so it is flagged as "repeat?" but does not lower the fill's ranking.
 */
export function compoundOf(a, b, wordlist = null) {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 3 || long.length <= short.length) return null;
  const isPart = (x) => PARTICLES.has(x) || (x.length >= 3 && !!wordlist?.has?.(x));
  if (long.startsWith(short) && isPart(long.slice(short.length))) return short;
  if (long.endsWith(short) && isPart(long.slice(0, long.length - short.length))) return short;
  return null;
}

/** Score + flags of every entry of a filled grid; quality of the fill (higher is better). */
export function evaluateFill({ width, height, cells }, { wordlist, themeSet, recent, clueBank, date = null }) {
  const { all } = computeEntries({ width, height, cells });
  const entries = all.map((e) => {
    const answer = e.cells.map((i) => cells[i]).join('');
    const score = wordlist.score(answer);
    return {
      id: e.id, num: e.num, dir: e.dir, row: e.row, col: e.col, length: e.length, cells: e.cells,
      answer, isTheme: themeSet.has(answer), score: Number.isFinite(score) ? score : null, flags: [],
    };
  });
  const themeAnswers = entries.filter((e) => e.isTheme);
  const fill = entries.filter((e) => !e.isTheme);
  const stemCache = new Map();
  const stemsOf = (w) => {
    if (!stemCache.has(w)) stemCache.set(w, stems(w));
    return stemCache.get(w);
  };
  const shareRoot = (a, b) => {
    const sb = stemsOf(b);
    for (const s of stemsOf(a)) if (sb.has(s)) return true;
    return false;
  };
  let low = 0;
  let repeats = 0;
  let echoes = 0;
  let obscure = 0;
  // Answers of the other puzzles of the same date (published or drafts): a shared root reads as a repeat.
  const sameDay = date ? [...recent].map(([w, srcs]) => [w, srcs.filter((x) => x.date === date)]).filter(([, srcs]) => srcs.length) : [];
  for (const e of fill) {
    if (e.score === null) e.flags.push('not in the word list');
    else if (e.score < LOW_SCORE) {
      e.flags.push(`low score ${e.score}`);
      low++;
    }
    const used = recent.get(e.answer);
    if (used) {
      e.flags.push(`used recently: ${describeUses(used)}`);
      repeats++;
    } else if (sameDay.length) {
      const sib = sameDay.find(([w]) => shareRoot(e.answer, w));
      if (sib) {
        e.flags.push(`shares a root with ${sib[0]} in ${describeUses(sib[1])}`);
        repeats++;
      }
    }
    // A fill word inside a theme answer, sharing its root, or making it with another word (POPS with POPUP).
    const echo = themeAnswers.find((t) => (e.answer.length >= 4 && t.answer.includes(e.answer)) || shareRoot(e.answer, t.answer)
      || [...stemsOf(e.answer)].some((st) => compoundOf(st, t.answer, wordlist) === st));
    if (echo) {
      e.flags.push(`echoes theme answer ${echo.answer}`);
      echoes++;
    }
    if (clueBank && !clueBank.has(e.answer) && (e.score ?? 0) < OBSCURE_BELOW) {
      e.flags.push('no clue-bank entry (obscure?)');
      obscure++;
    }
  }
  for (let i = 0; i < fill.length; i++) {
    for (let j = i + 1; j < fill.length; j++) {
      if (shareRoot(fill[i].answer, fill[j].answer)) {
        fill[i].flags.push(`shares a root with ${fill[j].id} ${fill[j].answer}`);
        fill[j].flags.push(`shares a root with ${fill[i].id} ${fill[i].answer}`);
        echoes++;
      } else if (compoundOf(fill[i].answer, fill[j].answer, wordlist)) {
        // Informational only (not counted in quality): the reviewer decides whether it is a real repeat.
        const note = (other) => `repeat? ${other.id} ${other.answer} contains the same letters as a word (replace if it is the same word, like EGG / EGGNOG; fine if unrelated, like CAR / CARPET)`;
        fill[i].flags.push(note(fill[j]));
        fill[j].flags.push(note(fill[i]));
      }
    }
  }
  for (const t of themeAnswers) {
    const used = recent.get(t.answer);
    if (used) t.flags.push(`theme answer used recently: ${describeUses(used)}`);
  }
  const scored = fill.filter((e) => e.score !== null);
  const avg = scored.length ? scored.reduce((s, e) => s + e.score, 0) / scored.length : 0;
  const min = scored.length ? Math.min(...scored.map((e) => e.score)) : 0;
  const quality = avg - 3 * low - 3 * obscure - 3 * repeats - 5 * echoes;
  return { entries, avg: Math.round(avg * 10) / 10, min, low, obscure, repeats, echoes, quality: Math.round(quality * 10) / 10 };
}

/** Block count, 2×2 block squares, longest run of blocks in a row or column, and average entry length. */
export function structureOf(width, height, cells) {
  const isBlock = (r, c) => cells[r * width + c] === '#';
  let blocks = 0;
  let clumps = 0;
  let run = 0;
  for (let r = 0; r < height; r++) {
    let h = 0;
    for (let c = 0; c < width; c++) {
      if (isBlock(r, c)) {
        blocks++;
        run = Math.max(run, ++h);
        if (r + 1 < height && c + 1 < width && isBlock(r, c + 1) && isBlock(r + 1, c) && isBlock(r + 1, c + 1)) clumps++;
      } else h = 0;
    }
  }
  for (let c = 0; c < width; c++) {
    let v = 0;
    for (let r = 0; r < height; r++) {
      if (isBlock(r, c)) run = Math.max(run, ++v);
      else v = 0;
    }
  }
  const { all } = computeEntries({ width, height, cells });
  const avgLength = all.length ? all.reduce((s, e) => s + e.length, 0) / all.length : 0;
  return { blocks, clumps, run, words: all.length, avgLength: Math.round(avgLength * 100) / 100 };
}

const limitsFor = (kind, maxBlocks) => ({ ...CHOPPY[kind], ...(Number.isFinite(maxBlocks) ? { blocks: maxBlocks } : {}) });

/** Why a structure looks choppy for its kind ([] = fine). */
export function choppyReasons(st, kind, maxBlocks = null) {
  const lim = limitsFor(kind, maxBlocks);
  const out = [];
  if (st.blocks > lim.blocks) out.push(`${st.blocks} blocks (tidy ≤ ${lim.blocks})`);
  if (st.clumps > lim.clumps) out.push(`${st.clumps} 2×2 block square(s)`);
  if (st.run > lim.run) out.push(`a run of ${st.run} blocks`);
  return out;
}

/**
 * Ranking penalty for a choppy structure, on the theme-value scale (one placed theme answer ≈ 450–900): 20 × (blocks
 * over the limit)^1.5 (2 over ≈ 57, 6 over ≈ 294, 12 over ≈ 831), 400 per extra 2×2 block square, 300 per extra
 * block in the longest run.
 */
export function choppyPenalty(st, kind, maxBlocks = null) {
  const lim = limitsFor(kind, maxBlocks);
  const over = Math.max(0, st.blocks - lim.blocks);
  return 20 * over ** 1.5 + 400 * Math.max(0, st.clumps - lim.clumps) + 300 * Math.max(0, st.run - lim.run);
}

/** The worksheet as JSON with one line per entry (easy to read and scan). */
export function worksheetJson(ws) {
  const { entries, ...head } = ws;
  const top = JSON.stringify(head, null, 2).replace(/\n}$/, '');
  return `${top},\n  "entries": [\n${entries.map((e) => `    ${JSON.stringify(e)}`).join(',\n')}\n  ]\n}\n`;
}

/** Theme answers (in plan order) that are entries of the filled grid. */
function placedAnswers(entries, answers) {
  const byAnswer = new Map(entries.map((e) => [e.answer, e]));
  return answers.filter((a) => byAnswer.has(a)).map((a) => ({ answer: a, id: byAnswer.get(a).id }));
}

/**
 * Build one puzzle. Returns the report (see the CLI) and writes the draft + worksheet.
 * opts: { P, date, kind, plan (raw object), seed?, timeSec?, avoid: [], minScore?, maxBlocks?, tries?, workers?, today?, log }
 */
export async function buildPuzzle(opts) {
  const { P, date, kind, log = () => {} } = opts;
  const t0 = Date.now();
  if (!isValidDateId(date)) throw new CliError(`--date must be a date YYYY-MM-DD (got "${date ?? ''}")`, { code: 2 });
  if (!isValidKind(kind)) throw new CliError(`--kind must be mini, midi or daily (got "${kind ?? ''}")`, { code: 2 });
  const size = SIZES[kind];
  const id = claudeId(date, kind);
  const banned = loadBanned(P);
  const plan = normalizePlan(opts.plan, kind, banned.isBanned);
  const warnings = [...plan.warnings];
  const answers = plan.answers.map((a) => a.answer);
  const themeSet = new Set(answers);

  const requestedMin = Number.isFinite(opts.minScore) ? Math.round(opts.minScore) : DEFAULT_MIN_SCORE;
  if (requestedMin < 1 || requestedMin > 90) throw new CliError('--min-score must be between 1 and 90', { code: 2 });
  const timeSec = Number.isFinite(opts.timeSec) && opts.timeSec > 0 ? opts.timeSec : DEFAULT_TIME[kind];
  const tries = Number.isInteger(opts.tries) && opts.tries > 0 ? Math.min(opts.tries, 8) : DEFAULT_TRIES[kind];

  const today = await siteToday(P, opts.today);
  if (date < today) warnings.push(`${date} is in the past (today is ${today} in the site's time zone)`);
  if (fs.existsSync(claudeFile(P, id))) {
    warnings.push(`${id} is already published${date <= today ? ' and released — republishing needs --force and resets solvers\' progress' : '; publishing again replaces it'}`);
  }

  log(`Loading the word list…`);
  const wordlist = loadWordList(P);
  const avoid = [];
  for (const w of opts.avoid || []) {
    const word = normalizeAnswer(w);
    if (!word) continue;
    if (themeSet.has(word)) {
      warnings.push(`--avoid ${word} ignored: it is a theme answer (drop it from the plan instead)`);
      continue;
    }
    wordlist.ban(word);
    avoid.push(word);
  }
  const recent = await recentAnswers(P, { date, excludeId: id });
  const penalize = penaltiesFor(recent, date, answers);
  for (const a of answers) {
    if (recent.has(a)) warnings.push(`Theme answer ${a} was used recently (${describeUses(recent.get(a))})`);
  }
  const clueBank = loadClueBanks(P);

  const baseSeed = Number.isInteger(opts.seed) ? opts.seed >>> 0 : hash32(`${id}|${answers.join(',')}|${avoid.join(',')}`);
  const minScores = requestedMin > FALLBACK_MIN_SCORE ? [requestedMin, FALLBACK_MIN_SCORE] : [requestedMin];
  let best = null;
  let usedMin = requestedMin;
  const attempts = [];

  const maxBlocks = Number.isFinite(opts.maxBlocks) ? Math.round(opts.maxBlocks) : null;
  // Theme value (count, length and priority of the placed answers) minus choppiness, then fill quality (with a
  // nudge for longer entries).
  const better = (a, b) => {
    if (!b) return true;
    if (Math.abs(a.value - b.value) > 1e-6) return a.value > b.value;
    return a.rank > b.rank;
  };
  const done = () => best && best.placed.length >= answers.length && !best.choppy.length;

  /** A scored candidate for a filled grid of `layout`. */
  const candidate = (cells, layout, minScore, seed) => {
    const ev = evaluateFill({ width: size, height: size, cells }, { wordlist, themeSet, recent, clueBank, date });
    const placed = placedAnswers(ev.entries, answers);
    const st = structureOf(size, size, cells);
    const value = themeScore(placed.map((p) => answers.indexOf(p.answer)), answers) - choppyPenalty(st, kind, maxBlocks);
    return { cells, layout, eval: ev, placed, minScore, seed, structure: st, choppy: choppyReasons(st, kind, maxBlocks), value, rank: ev.quality + 4 * st.avgLength };
  };

  /** Final fills of the most promising layouts of one generateLayouts run; keeps the best candidate in `best`. */
  const consider = async (gen, minScore, seed) => {
    // Most / most important theme answers minus choppiness first, proven ones before unproven.
    const layouts = gen.layouts.map((l) => {
      const idx = l.placements.map((p) => answers.indexOf(p.answer)).filter((i) => i >= 0);
      return { ...l, value: themeScore(idx, answers) - choppyPenalty(structureOf(size, size, l.cells), kind, maxBlocks) };
    }).sort((a, b) => b.value - a.value || (b.filled ? 1 : 0) - (a.filled ? 1 : 0) || b.score - a.score);
    const attempt = { minScore, seed, layouts: gen.layouts.length, proven: gen.layouts.filter((l) => l.filled).length, mostPlaced: 0, candidates: [] };
    attempts.push(attempt);
    for (const layout of layouts.slice(0, FINAL_LAYOUTS)) {
      if (!layout.placements.length && answers.length) continue; // a theme-less grid is no use
      const grid = { width: size, height: size, cells: layout.cells.map((c) => c || '') };
      const fills = layout.filled ? [layout.filled] : [];
      for (let k = 0; k < FILL_SEEDS; k++) {
        const res = await fillGrid(grid, wordlist, {
          minScore, timeLimitMs: FILL_MS[kind] * (layout.filled ? 1 : 2), seed: (seed ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0,
          prefer: layout.unplaced, penalize, randomness: 0.25,
        });
        if (res.ok) fills.push(res.cells);
      }
      for (const cells of fills) {
        const cand = candidate(cells, layout, minScore, seed);
        attempt.mostPlaced = Math.max(attempt.mostPlaced, cand.placed.length);
        const summary = `${cand.placed.length} placed, ${cand.structure.blocks} blocks${cand.choppy.length ? ` (choppy: ${cand.choppy.join(', ')})` : ''}, fill ${cand.eval.avg}`;
        if (!attempt.candidates.includes(summary)) attempt.candidates.push(summary);
        if (better(cand, best)) best = cand;
      }
    }
  };

  // Layout searches: `tries` seeds per min score, run in parallel worker threads when the machine has the cores
  // (same wall time, more chances to fit every theme answer in a tidy grid), else one after another.
  const lanes = opts.workers === false ? 1 : parallelism();
  const params = (seed, minScore) => ({
    width: size, height: size, symmetry: 'rotational', theme: answers.map((answer) => ({ answer })), count: 6,
    timeLimitMs: timeSec * 1000, density: 'medium', seed, minScore, penalize,
  });
  const inProcess = (seed, minScore) => generateLayouts({ ...params(seed, minScore), wordlist });
  for (const minScore of minScores) {
    const seeds = Array.from({ length: tries }, (_, t) => (baseSeed + t * 7919 + (minScore !== requestedMin ? 104729 : 0)) >>> 0);
    for (let i = 0; i < seeds.length && !done(); i += lanes) {
      const batch = seeds.slice(i, i + lanes);
      log(`Generating ${size}×${size} layouts (min score ${minScore}, seed${batch.length > 1 ? `s ${batch.join(', ')} in parallel` : ` ${batch[0]}`}, up to ${timeSec}s)…`);
      const runs = batch.length > 1
        ? await Promise.all(batch.map((seed) => layoutsInWorker(P.root, avoid, params(seed, minScore)).catch((err) => {
          log(`  (worker failed: ${err.message}; searching in-process)`);
          return inProcess(seed, minScore);
        })))
        : [await inProcess(batch[0], minScore)];
      for (let k = 0; k < runs.length; k++) await consider(runs[k], minScore, batch[k]);
    }
    if (best && best.placed.length > 0) {
      usedMin = best.minScore;
      break;
    }
  }

  // Polish: refill the chosen layout avoiding its iffy entries (low scores, echoes, shared roots, obscure, repeats)
  // while that improves the fill.
  if (best && best.placed.length > 0) {
    const deadline = Date.now() + POLISH_MS[kind];
    const grid = { width: size, height: size, cells: best.layout.cells.map((c) => c || '') };
    const polishAvoid = new Set();
    const iffy = (e) => !e.isTheme && e.flags.some((f) => /^(low score|echoes|shares a root|used recently|no clue-bank)/.test(f));
    let polished = 0;
    for (let round = 0; round < POLISH_ROUNDS && Date.now() < deadline; round++) {
      const add = best.eval.entries.filter(iffy).map((e) => e.answer).filter((w) => !polishAvoid.has(w));
      if (!add.length) break;
      for (const w of add) polishAvoid.add(w);
      let improved = false;
      for (let k = 0; k < POLISH_SEEDS && Date.now() < deadline; k++) {
        const seed = (best.seed ^ Math.imul(round * POLISH_SEEDS + k + 11, 0x85ebca6b)) >>> 0;
        const res = await fillGrid(grid, wordlist, {
          minScore: best.minScore, timeLimitMs: Math.min(POLISH_FILL_MS[kind], Math.max(50, deadline - Date.now())), seed,
          prefer: best.layout.unplaced, penalize, avoid: [...polishAvoid], randomness: 0.3,
        });
        if (!res.ok) continue;
        const cand = candidate(res.cells, best.layout, best.minScore, best.seed);
        if (better(cand, best)) {
          best = cand;
          improved = true;
          polished++;
        }
      }
      if (!improved) break;
    }
    if (polished) log(`Polished the fill: ${polished} better refill${polished > 1 ? 's' : ''} found (average ${best.eval.avg}).`);
  }

  if (!best || (answers.length && !best.placed.length)) {
    const longest = [...answers].sort((a, b) => b.length - a.length)[0];
    throw new CliError(`Could not build a ${kind} that holds any of the theme answers.`, {
      details: [
        `Tried ${attempts.length} layout searches (min score ${minScores.join(' then ')}).`,
        answers.length > 1 ? 'Try fewer theme answers, or shorter ones' : 'Try a shorter or more common theme answer',
        longest && longest.length >= size - 1 ? `${longest} (${longest.length}) nearly spans the grid; a shorter answer fits far more easily` : 'Answers with common letters (E, R, S, T, A…) fit more easily',
        `More time can help too: --time ${timeSec * 2}`,
      ],
      data: { attempts },
    });
  }
  if (best.choppy.length) {
    warnings.push(`The grid is a bit choppy (${best.choppy.join(', ')}); it was kept because tidier layouts held fewer theme answers. Fewer theme answers, or ones in symmetric pairs of equal length, give a cleaner grid.`);
  }
  if (usedMin !== requestedMin) {
    warnings.push(`Nothing could be filled at min score ${requestedMin}: fell back to ${usedMin} (expect a few weaker entries; check the flags)`);
  }

  return finishBuild({
    P, id, date, kind, plan, answers, best, usedMin, requestedMin, avoid, timeSec, maxBlocks, t0, clueBank, warnings, attempts, recent,
  });
}

/**
 * Write the draft, the clue worksheet and the numbered snapshot of a finished build (or refill) and return the
 * report the CLI prints. `best` = { cells, layout: { score }, eval, placed, structure, choppy, seed }.
 */
async function finishBuild({ P, id, date, kind, plan, answers, best, usedMin, requestedMin, avoid, timeSec, maxBlocks, t0, clueBank, warnings, attempts, recent, refill = null }) {
  const size = SIZES[kind];
  const { cells, layout, eval: ev, placed } = best;
  const placedSet = new Set(placed.map((p) => p.answer));
  const unplaced = answers.filter((a) => !placedSet.has(a));
  const lockedCells = new Set();
  for (const e of ev.entries) if (e.isTheme) for (const i of e.cells) lockedCells.add(i);

  // ---- draft (crossword-draft/1, series 'claude') ----
  const level = difficulty(date, kind);
  const draft = makeDraft({ id, width: size, height: size, title: plan.title, author: AUTHOR, date, kind, series: SERIES });
  const prior = await readJson(draftFile(P, id), null).catch(() => null);
  if (prior?.createdAt) draft.createdAt = prior.createdAt;
  Object.assign(draft, {
    note: plan.note,
    cells: cells.slice(),
    locked: [...lockedCells].sort((a, b) => a - b),
    theme: plan.answers.map((a) => ({ answer: a.answer, clue: a.clue, raw: a.raw, placed: placedSet.has(a.answer) })),
    clues: Object.fromEntries(plan.answers.filter((a) => a.clue && placedSet.has(a.answer)).map((a) => [a.answer, a.clue])),
    themeTopic: plan.theme,
    level,
    build: {
      seed: best.seed, minScore: usedMin, requestedMinScore: requestedMin, avoid, timeSec, maxBlocks,
      fillAvg: ev.avg, layoutScore: layout.score ?? null, ms: Date.now() - t0, builtAt: new Date().toISOString(),
      ...(refill ? { refill } : {}),
    },
  });

  // ---- clue worksheet ----
  const acrossAt = new Map();
  const downAt = new Map();
  for (const e of ev.entries) for (const i of e.cells) (e.dir === 'across' ? acrossAt : downAt).set(i, e);
  const planClue = new Map(plan.answers.map((a) => [a.answer, a.clue]));
  const worksheet = {
    format: 'claude-way-worksheet/1',
    id, date, kind, weekday: weekdayName(date), level, levelGuide: LEVEL_GUIDES[level],
    title: plan.title, theme: plan.theme, size: `${size}x${size}`,
    grid: gridRows(size, size, cells),
    howTo: 'Write every clue yourself at this level; suggestions are only reference. Save a JSON object { "ANSWER": "clue", ... } (or keyed by id, e.g. "14A") and run: node scripts/claude-way.mjs publish --id <id> --clues <file>',
    entries: ev.entries.map((e) => ({
      id: e.id,
      answer: e.answer,
      length: e.length,
      isTheme: e.isTheme,
      score: e.score,
      // One per letter: "C 1D CAIRO" = this entry's letter C is shared with 1D CAIRO.
      crossings: e.cells.map((cell) => {
        const x = (e.dir === 'across' ? downAt : acrossAt).get(cell);
        return x ? `${cells[cell]} ${x.id} ${x.answer}` : `${cells[cell]} (unchecked)`;
      }),
      suggestions: clueBank.suggest(e.answer, 3),
      clue: planClue.get(e.answer) || '',
      ...(e.flags.length ? { flags: e.flags } : {}),
    })),
  };

  // Every build is also kept as a numbered snapshot, so a later (worse) rebuild never loses a good one: `restore`
  // copies a snapshot back as the current draft + worksheet.
  const buildNo = (await listBuilds(P, id)).reduce((n, b) => Math.max(n, b.build), 0) + 1;
  draft.build.number = buildNo;
  draft.build.summary = {
    placed: placed.length, of: answers.length, blocks: best.structure.blocks, choppy: best.choppy.length > 0,
    fillAvg: ev.avg, minScore: usedMin, flagged: ev.entries.filter((e) => e.flags.length).map((e) => e.answer),
    ...(refill ? { refillOf: refill.from } : {}),
  };
  const worksheetText = worksheetJson(worksheet);
  await writeJsonAtomic(snapshotFile(P, id, buildNo, 'draft'), draft);
  await writeFileAtomic(snapshotFile(P, id, buildNo, 'clues'), worksheetText);
  await writeJsonAtomic(draftFile(P, id), draft);
  await writeFileAtomic(worksheetFile(P, id), worksheetText);

  const flags = ev.entries.filter((e) => e.flags.length).map((e) => `${e.id} ${e.answer}${e.score !== null && !e.isTheme ? ` (${e.score})` : ''}: ${e.flags.join('; ')}`);
  return {
    ok: true,
    id, date, kind, weekday: weekdayName(date), level, levelGuide: LEVEL_GUIDES[level], size,
    title: plan.title, theme: plan.theme,
    placed, unplaced,
    minScore: usedMin, requestedMinScore: requestedMin, fellBack: usedMin !== requestedMin,
    seed: best.seed, avoid,
    structure: { ...best.structure, choppy: best.choppy, limits: limitsFor(kind, maxBlocks) },
    stats: {
      words: ev.entries.length, blocks: cells.filter((c) => c === '#').length, fillAvg: ev.avg, fillMin: ev.min,
      low: ev.low, obscure: ev.obscure, repeats: ev.repeats, echoes: ev.echoes, ms: Date.now() - t0,
    },
    grid: worksheet.grid,
    entries: ev.entries.map((e) => ({ id: e.id, answer: e.answer, length: e.length, isTheme: e.isTheme, score: e.score, flags: e.flags })),
    flags,
    warnings,
    attempts,
    recentAnswers: recent.size,
    build: buildNo,
    ...(refill ? { refill } : {}),
    files: { draft: rel(P, draftFile(P, id)), worksheet: rel(P, worksheetFile(P, id)) },
  };
}

// ---------------------------------------------------------------------------
// refill: keep the grid, replace a few fill words

/** Rounds of a refill: clear the avoided entries plus their crossings, then one more ring, then all the fill. */
const REFILL_SEEDS = 4;

/**
 * `refill --id ID --avoid W1,W2 [--seed N]`: keep the current draft's block pattern and theme answers and replace
 * the listed fill words, changing as little of the rest as possible: first only the entries crossing them are
 * refilled, then one more ring of entries, then (last resort) all the fill. Seconds instead of a full rebuild.
 * Without --avoid, refills all the fill with a new seed. Saved as a new build (restore works as usual).
 */
export async function refillPuzzle({ P, id, avoid: extra = [], seed = null, log = () => {} }) {
  const t0 = Date.now();
  const parsed = parsePuzzleId(id);
  if (!parsed || parsed.series !== SERIES) throw new CliError(`--id must be a Claude puzzle id like claude-2026-10-05-mini (got "${id ?? ''}")`, { code: 2 });
  const { date, kind } = parsed;
  const size = SIZES[kind];
  const old = await readJson(draftFile(P, id), null);
  if (!old) throw new CliError(`No draft for ${id}: run "build --date ${date} --kind ${kind} --plan …" first`);
  if (old.width !== size || old.height !== size || !Array.isArray(old.cells) || old.cells.length !== size * size) {
    throw new CliError(`The draft ${rel(P, draftFile(P, id))} is not a ${size}×${size} grid: rebuild it`);
  }
  const warnings = [];
  if (old.publishedAt) warnings.push(`${id} was already published: publish it again (with clues for the new entries) or the old grid stays live`);
  const theme = Array.isArray(old.theme) ? old.theme : [];
  const plan = {
    title: old.title || '', theme: old.themeTopic || '', note: old.note || '',
    answers: theme.map((t) => ({ answer: normalizeAnswer(t.answer), clue: normalizeClue(t.clue), raw: t.raw || t.answer })).filter((a) => a.answer),
  };
  const answers = plan.answers.map((a) => a.answer);
  const themeSet = new Set(answers);
  const minScore = Number.isFinite(old.build?.minScore) ? old.build.minScore : DEFAULT_MIN_SCORE;

  const wordlist = loadWordList(P);
  const fresh = [];
  for (const w of extra) {
    const word = normalizeAnswer(w);
    if (!word) continue;
    if (themeSet.has(word)) {
      warnings.push(`--avoid ${word} ignored: it is a theme answer (change the plan and rebuild instead)`);
      continue;
    }
    fresh.push(word);
  }
  const avoid = [...new Set([...(old.build?.avoid || []), ...fresh])];
  for (const w of avoid) wordlist.ban(w);
  const recent = await recentAnswers(P, { date, excludeId: id });
  const penalize = penaltiesFor(recent, date, answers);
  const clueBank = loadClueBanks(P);

  const grid = { width: size, height: size, cells: old.cells.slice() };
  const { all } = computeEntries(grid);
  const word = (e) => e.cells.map((i) => grid.cells[i]).join('');
  const locked = new Set(Array.isArray(old.locked) ? old.locked : []);
  for (const e of all) if (themeSet.has(word(e))) for (const i of e.cells) locked.add(i);
  const targets = all.filter((e) => fresh.includes(word(e)) && !themeSet.has(word(e)));
  const missing = fresh.filter((w) => !all.some((e) => word(e) === w));
  if (missing.length) warnings.push(`Not in the grid (only avoided from now on): ${missing.join(', ')}`);

  // Rings of entries to clear: the targets and their crossings, then one more ring, then everything.
  const crossing = (set) => {
    const cells = new Set(set.flatMap((e) => e.cells));
    return all.filter((e) => e.cells.some((i) => cells.has(i)));
  };
  const rings = [];
  if (targets.length) {
    const ring1 = crossing(targets);
    rings.push({ name: 'the avoided entries and their crossings', entries: ring1 });
    rings.push({ name: 'one more ring of crossing entries', entries: crossing(ring1) });
  }
  rings.push({ name: 'all the fill', entries: all });

  const baseSeed = Number.isInteger(seed) ? seed >>> 0 : hash32(`${id}|refill|${avoid.join(',')}|${old.build?.seed ?? ''}`);
  let best = null;
  let usedRing = null;
  const attempts = [];
  for (const ring of rings) {
    const clear = new Set(ring.entries.flatMap((e) => e.cells).filter((i) => !locked.has(i)));
    const cells = grid.cells.map((c, i) => (clear.has(i) ? '' : c));
    log(`Refilling ${ring.name} (${clear.size} cells)…`);
    for (let k = 0; k < REFILL_SEEDS; k++) {
      const s = (baseSeed ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0;
      const res = await fillGrid({ width: size, height: size, cells }, wordlist, {
        minScore, timeLimitMs: FILL_MS[kind], seed: s, prefer: answers.filter((a) => !all.some((e) => word(e) === a)), penalize, randomness: 0.25,
      });
      attempts.push({ ring: ring.name, seed: s, ok: res.ok, reason: res.reason || null });
      if (!res.ok) continue;
      const ev = evaluateFill({ width: size, height: size, cells: res.cells }, { wordlist, themeSet, recent, clueBank, date });
      const cand = {
        cells: res.cells, layout: { score: old.build?.layoutScore ?? null }, eval: ev, placed: placedAnswers(ev.entries, answers),
        structure: structureOf(size, size, res.cells), seed: s,
      };
      cand.choppy = choppyReasons(cand.structure, kind, old.build?.maxBlocks ?? null);
      if (!best || cand.eval.quality > best.eval.quality) best = cand;
    }
    if (best) {
      usedRing = ring.name;
      break;
    }
  }
  if (!best) {
    throw new CliError(`Could not refill ${id} without ${fresh.join(', ') || 'its current fill'}.`, {
      details: ['Rebuild instead (build … --avoid …), or restore an earlier build (restore --id …)'],
      data: { attempts },
    });
  }
  const changed = all.filter((e) => e.cells.map((i) => best.cells[i]).join('') !== word(e)).map((e) => `${e.id} ${word(e)} → ${e.cells.map((i) => best.cells[i]).join('')}`);
  log(`Refilled ${usedRing}: ${changed.length} entr${changed.length === 1 ? 'y' : 'ies'} changed.`);
  return finishBuild({
    P, id, date, kind, plan, answers, best, usedMin: minScore, requestedMin: old.build?.requestedMinScore ?? minScore, avoid,
    timeSec: old.build?.timeSec ?? null, maxBlocks: old.build?.maxBlocks ?? null, t0, clueBank, warnings, attempts, recent,
    refill: { from: old.build?.number ?? null, cleared: usedRing, changed },
  });
}

// ---------------------------------------------------------------------------
// Build snapshots (.claude-way/builds/<id>.<n>.draft.json + .clues.json) and `restore`

/** Snapshot file of build `n` of `id` (`part`: 'draft' | 'clues'). */
export const snapshotFile = (P, id, n, part) => path.join(P.work, 'builds', `${id}.${n}.${part}.json`);

/** The saved builds of `id`, oldest first: [{ build, file, summary, seed, avoid, builtAt }]. */
export async function listBuilds(P, id) {
  let names = [];
  try {
    names = await fsp.readdir(path.join(P.work, 'builds'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    if (!name.startsWith(`${id}.`)) continue;
    const m = /^\.(\d+)\.draft\.json$/.exec(name.slice(id.length));
    if (!m) continue;
    const n = Number(m[1]);
    const draft = await readJson(snapshotFile(P, id, n, 'draft'), null).catch(() => null);
    out.push({
      build: n, file: rel(P, snapshotFile(P, id, n, 'draft')), summary: draft?.build?.summary || null,
      seed: draft?.build?.seed ?? null, avoid: draft?.build?.avoid || [], builtAt: draft?.build?.builtAt || null,
    });
  }
  return out.sort((a, b) => a.build - b.build);
}

/**
 * `restore --id ID [--build N]`: make build N (a snapshot) the current draft + worksheet again. Without N, only
 * lists the saved builds. Clues are written afterwards as usual (keys by answer keep working if the grid matches).
 */
export async function restoreBuild({ P, id, build = null }) {
  const parsed = parsePuzzleId(id);
  if (!parsed || parsed.series !== SERIES) throw new CliError(`--id must be a Claude puzzle id like claude-2026-10-05-mini (got "${id ?? ''}")`, { code: 2 });
  const builds = await listBuilds(P, id);
  if (build === null || build === undefined) return { ok: true, id, builds, restored: null };
  const found = builds.find((b) => b.build === build);
  if (!found) {
    throw new CliError(`No build ${build} of ${id}`, { details: builds.length ? [`Saved builds: ${builds.map((b) => b.build).join(', ')}`] : ['No builds saved yet: run build first'] });
  }
  const draft = await readJson(snapshotFile(P, id, build, 'draft'));
  const worksheet = await fsp.readFile(snapshotFile(P, id, build, 'clues'), 'utf8').catch(() => null);
  if (!worksheet) throw new CliError(`The worksheet of build ${build} is missing (${rel(P, snapshotFile(P, id, build, 'clues'))}): rebuild instead`);
  await writeJsonAtomic(draftFile(P, id), draft);
  await writeFileAtomic(worksheetFile(P, id), worksheet);
  return {
    ok: true, id, builds, restored: build, grid: gridRows(draft.width, draft.height, draft.cells),
    files: { draft: rel(P, draftFile(P, id)), worksheet: rel(P, worksheetFile(P, id)) },
  };
}
