// `publish` (a built draft + clues -> site/puzzles/claude/<id>.json + index) and `check` (a date's full set is
// present, valid and indexed). Both run the same quality gates (gates.mjs) on every clue.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  KINDS, buildIndex, draftEntries, draftToPuzzle, isValidDateId, loadPuzzle, normalizeClue, parsePuzzleId, validatePuzzle,
} from '../../site/shared/puzzle.js';
import {
  AUTHOR, CliError, SERIES, claudeFile, claudeId, draftFile, listPublished, loadBanned, readJson,
  rebuildClaudeIndex, rel, siteToday, writeJsonAtomic,
} from './common.mjs';
import { checkClues } from './gates.mjs';

/**
 * Clues from a --clues file: { "14A": "clue", "PIE": "clue" } (by entry id or by answer, mixed is fine), or a
 * worksheet ({ entries: [{ id, clue }] }). Returns { byId: Map<id, clue>, errors }.
 */
export function resolveClues(raw, entries) {
  const errors = [];
  const byId = new Map();
  const ids = new Map(entries.map((e) => [e.id, e]));
  const byAnswer = new Map(entries.map((e) => [e.answer, e]));
  let pairs;
  if (raw && typeof raw === 'object' && Array.isArray(raw.entries)) {
    pairs = raw.entries.map((e) => [e?.id ?? e?.answer, e?.clue]);
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    pairs = Object.entries(raw);
  } else {
    return { byId, errors: ['The clues file must be a JSON object: { "ANSWER": "clue", ... } or { "14A": "clue", ... }'] };
  }
  for (const [key, value] of pairs) {
    const k = String(key ?? '').trim();
    const idKey = /^\d+\s*-?\s*(a|d|across|down)$/i.test(k) ? `${parseInt(k, 10)}${k.replace(/^[\d\s-]+/, '')[0].toUpperCase()}` : null;
    const entry = idKey ? ids.get(idKey) : byAnswer.get(k.toUpperCase().replace(/[^A-Z]/g, ''));
    if (!entry) {
      errors.push(`"${k}" is not an entry of this grid (use an entry id like 14A or an answer; did the grid change since you wrote the clues?)`);
      continue;
    }
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string') {
      errors.push(`${entry.id} ${entry.answer}: the clue must be a string`);
      continue;
    }
    if (byId.has(entry.id) && byId.get(entry.id) !== normalizeClue(value)) {
      errors.push(`${entry.id} ${entry.answer}: two different clues given (by id and by answer)`);
      continue;
    }
    byId.set(entry.id, normalizeClue(value));
  }
  return { byId, errors };
}

/**
 * Publish a built Claude puzzle. opts: { P, id, cluesFile, title?, note?, dryRun?, force?, today? }.
 * Throws a CliError listing every problem (nothing written) when a gate fails.
 */
export async function publishPuzzle(opts) {
  const { P, id } = opts;
  const parsed = parsePuzzleId(id);
  if (!parsed || parsed.series !== SERIES) {
    throw new CliError(`--id must be a Claude puzzle id like claude-2026-10-05-mini, claude-2026-10-05-midi or claude-2026-10-05 (got "${id ?? ''}")`, { code: 2 });
  }
  if (!opts.cluesFile) throw new CliError('--clues <file> is required (JSON: { "ANSWER": "clue", ... })', { code: 2 });
  const draft = await readJson(draftFile(P, id), null);
  if (!draft) throw new CliError(`No draft for ${id}: run "build --date ${parsed.date} --kind ${parsed.kind} --plan …" first`);
  const cluesRaw = await readJson(path.resolve(opts.cluesFile));

  const { all } = draftEntries(draft);
  const entries = all.map((e) => ({ id: e.id, answer: e.answer }));
  if (entries.some((e) => !e.answer)) throw new CliError(`The draft ${rel(P, draftFile(P, id))} has empty cells: rebuild it`);
  const { byId, errors } = resolveClues(cluesRaw, entries);
  // Theme clues written in the plan count unless the clues file overrides them.
  for (const e of entries) {
    if (!byId.has(e.id) && draft.clues?.[e.answer]) byId.set(e.id, normalizeClue(draft.clues[e.answer]));
  }
  const title = normalizeClue(opts.title ?? draft.title);
  const note = String(opts.note ?? draft.note ?? '').trim();
  const banned = loadBanned(P);
  const gate = checkClues({ entries: entries.map((e) => ({ ...e, clue: byId.get(e.id) || '' })), isBanned: banned.isBanned, title });
  errors.push(...gate.errors);
  const warnings = [...gate.warnings];
  if (note.length > 300) errors.push(`The note is ${note.length} characters (keep it under 300)`);
  if (title.length > 60) errors.push(`The title is ${title.length} characters (keep it under 60)`);

  let puzzle = null;
  if (!errors.length) {
    const clues = {};
    for (const e of entries) clues[e.answer] = byId.get(e.id);
    const res = draftToPuzzle({ ...draft, title, note, author: AUTHOR, series: SERIES, kind: parsed.kind, date: parsed.date, clues });
    errors.push(...res.errors);
    // A repeated answer is a hard error in a published crossword; draftToPuzzle only warns. Its "contains its
    // answer" warning (any run of letters, e.g. EAR in "hEARing") is left to the gates, which tell a real leak
    // (an error) from a coincidence inside a word (fine).
    for (const w of res.warnings) {
      if (/^The clue for \S+ contains its answer/.test(w)) continue;
      (/appears twice/.test(w) ? errors : warnings).push(w);
    }
    puzzle = res.puzzle;
    if (puzzle) {
      if (puzzle.id !== id || puzzle.series !== SERIES) errors.push(`Internal: the puzzle came out as ${puzzle.id} (series ${puzzle.series}), expected ${id}`);
      const v = validatePuzzle(puzzle);
      if (!v.ok) errors.push(...v.errors.map((e) => `validatePuzzle: ${e}`));
    }
  }

  const today = await siteToday(P, opts.today);
  const file = claudeFile(P, id);
  const existing = await readJson(file, null).catch(() => null);
  if (existing && parsed.date <= today && !opts.force) {
    errors.push(`${id} is already published and released (${parsed.date} ≤ today ${today}): republishing would reset solvers' progress. Use --force only to fix a real mistake.`);
  }
  if (errors.length) {
    throw new CliError(`Not published — fix these and run publish again:`, { details: errors, data: { warnings } });
  }

  puzzle = { ...puzzle, theme: draft.themeTopic || '', publishedAt: new Date().toISOString() };
  const review = reviewList(draft, byId);
  const result = {
    ok: true, id, date: parsed.date, kind: parsed.kind, title, theme: puzzle.theme, note,
    file: rel(P, file), replaced: !!existing, dryRun: !!opts.dryRun, warnings, clues: review,
  };
  if (opts.dryRun) return result;

  await writeJsonAtomic(file, puzzle);
  const { index } = await rebuildClaudeIndex(P);
  const entry = index.puzzles.find((e) => e.id === id);
  result.number = entry?.number ?? null;
  result.index = rel(P, P.claudeIndex);
  // Remember the published clues in the (git-ignored) draft, for reference and re-publishing.
  const clues = {};
  for (const e of entries) clues[e.answer] = byId.get(e.id);
  await writeJsonAtomic(draftFile(P, id), { ...draft, title, note, clues, publishedAt: puzzle.publishedAt, updatedAt: puzzle.publishedAt });
  return result;
}

/** "1A PIE — clue" lines, Across then Down. */
function reviewList(draft, byId) {
  const { across, down } = draftEntries(draft);
  return [...across, ...down].map((e) => ({ id: e.id, answer: e.answer, clue: byId.get(e.id) || '' }));
}

// ---------------------------------------------------------------------------
// check

/**
 * Verify the full Claude set (Mini, Midi, Daily) for each date: file present, valid, right id / series / author,
 * clues pass the gates, and the Claude index lists exactly the published files (numbering = buildIndex).
 * Returns { ok, dates: [{ date, ok, kinds: { mini: { id, ok, title, problems, warnings } … } }], index: { ok, problems }, warnings }.
 */
export async function checkSets({ P, dates, kinds = KINDS }) {
  for (const d of dates) if (!isValidDateId(d)) throw new CliError(`--date must be YYYY-MM-DD (got "${d}")`, { code: 2 });
  const banned = loadBanned(P);
  const out = { ok: true, dates: [], index: { ok: true, problems: [] }, warnings: [] };

  const files = await listPublished(P, SERIES);
  const puzzles = [];
  for (const f of files) {
    try {
      puzzles.push(JSON.parse(await fsp.readFile(f.file, 'utf8')));
    } catch (err) {
      out.index.problems.push(`${rel(P, f.file)} is not valid JSON (${err.message})`);
    }
  }

  // Index consistency.
  const index = await readJson(P.claudeIndex, null).catch((err) => {
    out.index.problems.push(err.message);
    return undefined;
  });
  if (index === null) out.index.problems.push(`${rel(P, P.claudeIndex)} is missing`);
  else if (index) {
    const expected = buildIndex(puzzles.filter((p) => p && typeof p.id === 'string'));
    const got = Array.isArray(index.puzzles) ? index.puzzles : [];
    if (index.format !== 'crossword-index/1') out.index.problems.push('index.json: format must be "crossword-index/1"');
    const key = (e) => JSON.stringify([e.id, e.date, e.kind, e.series, e.title, e.author, e.width, e.height, e.number]);
    const want = expected.puzzles.map(key);
    const have = got.map(key);
    for (const e of expected.puzzles) if (!got.some((g) => g.id === e.id)) out.index.problems.push(`index.json does not list ${e.id}`);
    for (const g of got) if (!expected.puzzles.some((e) => e.id === g.id)) out.index.problems.push(`index.json lists ${g.id}, which has no puzzle file`);
    if (!out.index.problems.length && want.join('\n') !== have.join('\n')) {
      out.index.problems.push('index.json is out of date (titles, sizes or numbering differ from the puzzle files)');
    }
    for (const g of got) if (!g.theme) out.warnings.push(`index.json: ${g.id} has no theme recorded`);
  }
  if (out.index.problems.length) {
    out.index.ok = false;
    out.ok = false;
  }

  for (const date of dates) {
    const day = { date, ok: true, kinds: {} };
    const answersByKind = new Map();
    for (const kind of kinds) {
      const id = claudeId(date, kind);
      const item = { id, ok: true, title: null, problems: [], warnings: [] };
      day.kinds[kind] = item;
      const p = puzzles.find((x) => x && x.id === id);
      if (!p) {
        item.problems.push(files.some((f) => f.id === id) ? 'unreadable puzzle file' : `missing (${rel(P, claudeFile(P, id))})`);
      } else {
        item.title = p.title;
        const v = validatePuzzle(p);
        if (!v.ok) item.problems.push(...v.errors);
        if (p.series !== SERIES) item.problems.push(`series must be "${SERIES}"`);
        if ((p.kind || 'daily') !== kind) item.problems.push(`kind must be ${kind}`);
        if (p.author !== AUTHOR) item.problems.push(`author must be "${AUTHOR}"`);
        if (!p.theme) item.warnings.push('no theme topic recorded');
        if (v.ok) {
          const loaded = loadPuzzle(p);
          const entries = loaded.all.map((e) => ({ id: e.id, answer: e.cells.map((i) => loaded.solution[i]).join(''), clue: e.clue }));
          const gate = checkClues({ entries, isBanned: banned.isBanned, title: p.title });
          item.problems.push(...gate.errors);
          item.warnings.push(...gate.warnings);
          answersByKind.set(kind, new Set(entries.map((e) => e.answer)));
        }
      }
      if (item.problems.length) {
        item.ok = false;
        day.ok = false;
        out.ok = false;
      }
    }
    // Same-day puzzles should not share answers (a warning: the fill avoids it, but theme answers may repeat).
    const ks = [...answersByKind.keys()];
    for (let i = 0; i < ks.length; i++) {
      for (let j = i + 1; j < ks.length; j++) {
        const shared = [...answersByKind.get(ks[i])].filter((a) => answersByKind.get(ks[j]).has(a));
        if (shared.length) out.warnings.push(`${date}: the ${ks[i]} and the ${ks[j]} share ${shared.join(', ')}`);
      }
    }
    out.dates.push(day);
  }

  const stray = await strayFiles(P);
  if (stray.length) out.warnings.push(`Unexpected files in site/puzzles/claude/: ${stray.join(', ')}`);
  const other = gitChangesOutside(P);
  if (other.length) out.warnings.push(`Changes outside site/puzzles/claude/ in the working tree — do NOT commit them: ${other.slice(0, 12).join(', ')}${other.length > 12 ? ', …' : ''}`);
  return out;
}

async function strayFiles(P) {
  let names = [];
  try {
    names = await fsp.readdir(P.claudeDir);
  } catch {
    return [];
  }
  return names.filter((n) => n !== 'index.json' && !(n.endsWith('.json') && parsePuzzleId(n.slice(0, -5))?.series === SERIES));
}

/** Paths changed in git outside site/puzzles/claude/ (read-only `git status`; [] when not a repository). */
function gitChangesOutside(P) {
  const res = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], {
    cwd: P.root,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CEILING_DIRECTORIES: path.dirname(P.root), GIT_TERMINAL_PROMPT: '0' },
  });
  if (res.status !== 0 || typeof res.stdout !== 'string') return [];
  const out = [];
  const parts = res.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const file = rec.slice(3);
    if (rec[0] === 'R' || rec[0] === 'C') i++; // rename: the next field is the old path
    if (!file.startsWith('site/puzzles/claude/')) out.push(file);
  }
  return out;
}

// ---------------------------------------------------------------------------
// unpublish

/**
 * Remove a Claude puzzle that should not go out (e.g. its set could not be completed) and rebuild the index.
 * A released puzzle (date ≤ today) is only removed with --force (solvers may be playing it).
 */
export async function unpublishPuzzle({ P, id, force = false, today: todayOverride = null }) {
  const parsed = parsePuzzleId(id);
  if (!parsed || parsed.series !== SERIES) throw new CliError(`--id must be a Claude puzzle id like claude-2026-10-05-mini (got "${id ?? ''}")`, { code: 2 });
  const file = claudeFile(P, id);
  const today = await siteToday(P, todayOverride);
  try {
    await fsp.access(file);
  } catch {
    throw new CliError(`Nothing is published as ${id}`);
  }
  if (parsed.date <= today && !force) {
    throw new CliError(`${id} is released (${parsed.date} ≤ today ${today}); solvers may be playing it. Use --force only if it must go.`);
  }
  await fsp.rm(file);
  const { index } = await rebuildClaudeIndex(P);
  return { ok: true, id, removed: rel(P, file), remaining: index.puzzles.length };
}
