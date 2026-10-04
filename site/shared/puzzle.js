// Shared puzzle formats: the builder's editable *draft* and the player's published *puzzle*.
// Pure ES module (browser, worker, Node). See SPEC.md for the full field reference.

import {
  BLOCK, computeEntries, gridFromLayout, isLetter, layoutFromGrid, validateGrid,
} from './grid.js';

export const PUZZLE_FORMAT = 'crossword/1';
export const DRAFT_FORMAT = 'crossword-draft/1';
export const MAX_SIZE = 25;

// ---------------------------------------------------------------------------
// Small utilities

/** Uppercase A–Z only: "Trick or treat!" -> "TRICKORTREAT", "Café" -> "CAFE". */
export function normalizeAnswer(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
}

/** Trim and collapse whitespace in clue text. */
export function normalizeClue(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** FNV-1a 32-bit hash of a string. */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function checksum(str) {
  return hash32(str).toString(16).padStart(8, '0');
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Obfuscate a solution string (row-major, '#' for blocks, A–Z letters) so answers are not readable
 * in the page source at a glance. This is NOT security — anyone determined can decode it.
 */
export function encodeSolution(plain, salt) {
  const rnd = mulberry32(hash32(`xw:${salt}`));
  let bin = '';
  for (let i = 0; i < plain.length; i++) bin += String.fromCharCode(plain.charCodeAt(i) ^ Math.floor(rnd() * 256));
  return `x1:${btoa(bin)}`;
}

export function decodeSolution(encoded, salt) {
  if (typeof encoded !== 'string' || !encoded.startsWith('x1:')) throw new Error('Unknown solution encoding');
  const bin = atob(encoded.slice(3));
  const rnd = mulberry32(hash32(`xw:${salt}`));
  let out = '';
  for (let i = 0; i < bin.length; i++) out += String.fromCharCode(bin.charCodeAt(i) ^ Math.floor(rnd() * 256));
  return out;
}

/** True for a real calendar date written as YYYY-MM-DD. */
export function isValidDateId(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Today's date as YYYY-MM-DD in the given IANA time zone (e.g. "America/New_York"),
 * or in the device's local zone when timeZone is falsy. `now` is injectable for tests.
 */
export function todayISO(timeZone = null, now = new Date()) {
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit' };
  if (timeZone) opts.timeZone = timeZone;
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(now);
  } catch {
    delete opts.timeZone; // unknown zone: fall back to local
    parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(now);
  }
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Add `days` to a YYYY-MM-DD date. */
export function addDays(dateId, days) {
  const [y, m, d] = dateId.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** "2026-10-03" -> "Saturday, October 3, 2026" (style 'long') or "Oct 3, 2026" (style 'short'). */
export function formatDate(dateId, style = 'long') {
  if (!isValidDateId(dateId)) return String(dateId ?? '');
  const [y, m, d] = dateId.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const opts = style === 'short'
    ? { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }
    : { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' };
  return new Intl.DateTimeFormat('en-US', opts).format(dt);
}

/** 272000 -> "4:32"; 3725000 -> "1:02:05". */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// ---------------------------------------------------------------------------
// Puzzle kinds and ids (SPEC §8): a date holds up to one Mini, one Midi and one Daily.

/** Puzzle kinds in display order. */
export const KINDS = Object.freeze(['mini', 'midi', 'daily']);
export const KIND_LABELS = Object.freeze({ mini: 'Mini', midi: 'Midi', daily: 'Daily' });

/** True for one of KINDS. */
export function isValidKind(kind) {
  return typeof kind === 'string' && KINDS.includes(kind);
}

/** The kind of a puzzle, draft or index entry: `p.kind || 'daily'`. */
export function puzzleKind(p) {
  return (p && p.kind) || 'daily';
}

// ---------------------------------------------------------------------------
// Series (SPEC §9): the user's own puzzles ('main') and "Claude's way" ('claude'), made daily by a Claude session.

/** Puzzle series in display order. */
export const SERIES = Object.freeze(['main', 'claude']);
/** Display names ('' for the user's own series: the site name is used there). */
export const SERIES_LABELS = Object.freeze({ main: '', claude: "Claude's way" });

/** True for one of SERIES. */
export function isValidSeries(series) {
  return typeof series === 'string' && SERIES.includes(series);
}

/** The series of a puzzle, draft or index entry: `p.series || 'main'`. */
export function puzzleSeries(p) {
  return (p && p.series) || 'main';
}

/**
 * Published id for a date + kind (+ series): "2026-10-05" (daily, backward compatible) or "2026-10-05-mini";
 * Claude's way ids carry the series first: "claude-2026-10-05", "claude-2026-10-05-mini".
 */
export function puzzleId(date, kind = 'daily', series = 'main') {
  const k = kind || 'daily';
  const id = k === 'daily' ? String(date) : `${date}-${k}`;
  return series && series !== 'main' ? `${series}-${id}` : id;
}

const PUZZLE_ID_RE = new RegExp(`^(?:(${SERIES.filter((s) => s !== 'main').join('|')})-)?(\\d{4}-\\d{2}-\\d{2})(?:-(mini|midi))?$`);

/**
 * "2026-10-05-mini" -> { date: '2026-10-05', kind: 'mini', series: 'main' }; "2026-10-05" -> { …, kind: 'daily', … };
 * "claude-2026-10-05-midi" -> { date: '2026-10-05', kind: 'midi', series: 'claude' }; anything else -> null.
 */
export function parsePuzzleId(id) {
  if (typeof id !== 'string') return null;
  const m = PUZZLE_ID_RE.exec(id);
  if (!m || !isValidDateId(m[2])) return null;
  return { date: m[2], kind: m[3] || 'daily', series: m[1] || 'main' };
}

export function isValidPuzzleId(id) {
  return parsePuzzleId(id) !== null;
}

/** Folder of a series' files under site/puzzles/: '' for main (and anything unknown), 'claude' for Claude's way. */
export function seriesFolder(series = 'main') {
  return isValidSeries(series) && series !== 'main' ? series : '';
}

/**
 * Where a puzzle's file lives, relative to site/puzzles/ (and dist/puzzles/): "2026-10-05.json",
 * "claude/claude-2026-10-05-mini.json". Null for an invalid id.
 */
export function puzzleFilePath(id) {
  const parsed = parsePuzzleId(id);
  if (!parsed) return null;
  const folder = seriesFolder(parsed.series);
  return folder ? `${folder}/${id}.json` : `${id}.json`;
}

/** A series' index file relative to site/puzzles/: "index.json" (main) or "claude/index.json". */
export function seriesIndexPath(series = 'main') {
  const folder = seriesFolder(series);
  return folder ? `${folder}/index.json` : 'index.json';
}

/** Default kind for a grid size (the user can still choose another): ≤ 7 mini, ≤ 11 midi, else daily. */
export function suggestKind(width, height = width) {
  const size = Math.max(Number(width) || 0, Number(height) || 0);
  if (size <= 7) return 'mini';
  if (size <= 11) return 'midi';
  return 'daily';
}

// ---------------------------------------------------------------------------
// Drafts (builder)

export function isValidDraftId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

/** A new, empty draft. `series` is 'main' (the builder's) unless Claude's way makes it (SPEC §9). */
export function makeDraft({
  id, width = 9, height = width, title = '', author = '', date = '', symmetry = 'rotational', kind = 'daily', series = 'main',
} = {}) {
  const now = new Date().toISOString();
  return {
    format: DRAFT_FORMAT,
    id,
    title,
    author,
    note: '',
    date,
    kind: isValidKind(kind) ? kind : 'daily',
    series: isValidSeries(series) ? series : 'main',
    width,
    height,
    symmetry,
    cells: new Array(width * height).fill(''),
    locked: [],
    circles: [],
    shaded: [],
    theme: [],
    clues: {},
    createdAt: now,
    updatedAt: now,
  };
}

/** Entries of a draft, each with its current `answer` (null if incomplete) and `clue` (from draft.clues[answer]). */
export function draftEntries(draft) {
  const grid = { width: draft.width, height: draft.height, cells: draft.cells };
  const result = computeEntries(grid);
  for (const e of result.all) {
    const letters = e.cells.map((i) => draft.cells[i]);
    e.answer = letters.every(isLetter) ? letters.join('') : null;
    e.clue = e.answer ? normalizeClue(draft.clues?.[e.answer]) : '';
  }
  return result;
}

/**
 * Convert a draft into a publishable puzzle.
 * Returns { puzzle, errors: string[], warnings: string[] }. `puzzle` is null when there are errors.
 * The published id is puzzleId(draft.date, draft.kind, draft.series): the date for a daily, "<date>-mini" /
 * "<date>-midi" otherwise, prefixed "claude-" for Claude's way (series 'claude'; missing ⇒ 'main').
 */
export function draftToPuzzle(draft) {
  const errors = [];
  const warnings = [];
  const { width, height } = draft;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > MAX_SIZE || height > MAX_SIZE) {
    return { puzzle: null, errors: [`Invalid grid size ${width}x${height}`], warnings };
  }
  if (!Array.isArray(draft.cells) || draft.cells.length !== width * height) {
    return { puzzle: null, errors: ['Grid cells do not match the grid size'], warnings };
  }
  if (!isValidDateId(draft.date)) errors.push('Pick a release date (YYYY-MM-DD)');
  const kind = puzzleKind(draft);
  if (!isValidKind(kind)) errors.push(`Unknown puzzle kind "${kind}" (use mini, midi or daily)`);
  const series = puzzleSeries(draft);
  if (!isValidSeries(series)) errors.push(`Unknown puzzle series "${series}" (use ${SERIES.join(' or ')})`);
  if (!normalizeClue(draft.title)) warnings.push('The puzzle has no title');

  const grid = { width, height, cells: draft.cells };
  for (const issue of validateGrid(grid, { minLength: 3, requireFilled: true, requireChecked: false, symmetry: draft.symmetry || 'none' })) {
    (issue.severity === 'error' ? errors : warnings).push(issue.message);
  }

  const { all } = draftEntries(draft);
  const seen = new Map();
  for (const e of all) {
    if (!e.answer) continue;
    if (!e.clue) errors.push(`${e.id} (${e.answer}) needs a clue`);
    if (seen.has(e.answer)) warnings.push(`${e.answer} appears twice (${seen.get(e.answer)} and ${e.id})`);
    else seen.set(e.answer, e.id);
    if (e.clue && e.answer.length >= 3 && normalizeAnswer(e.clue).includes(e.answer)) {
      warnings.push(`The clue for ${e.id} contains its answer ${e.answer}`);
    }
  }
  if (errors.length) return { puzzle: null, errors, warnings };

  const id = puzzleId(draft.date, kind, series);
  const plain = draft.cells.map((ch) => (ch === BLOCK ? BLOCK : ch)).join('');
  const whiteSet = (list) => [...new Set((list || []).filter((i) => Number.isInteger(i) && i >= 0 && i < plain.length && plain[i] !== BLOCK))].sort((a, b) => a - b);
  const { across, down } = draftEntries(draft);
  const puzzle = {
    format: PUZZLE_FORMAT,
    id,
    date: draft.date,
    ...(kind === 'daily' ? {} : { kind }),
    ...(series === 'main' ? {} : { series }),
    title: normalizeClue(draft.title) || 'Untitled',
    author: normalizeClue(draft.author),
    note: String(draft.note ?? '').trim(),
    width,
    height,
    layout: layoutFromGrid(grid),
    circles: whiteSet(draft.circles),
    shaded: whiteSet(draft.shaded),
    solution: encodeSolution(plain, id),
    checksum: checksum(plain),
    clues: {
      across: across.map((e) => ({ num: e.num, clue: e.clue })),
      down: down.map((e) => ({ num: e.num, clue: e.clue })),
    },
  };
  return { puzzle, errors, warnings };
}

// ---------------------------------------------------------------------------
// Published puzzles (player)

/** Validate a published puzzle object. Returns { ok, errors: string[] }. */
export function validatePuzzle(p) {
  const errors = [];
  if (!p || typeof p !== 'object') return { ok: false, errors: ['Not an object'] };
  if (p.format !== PUZZLE_FORMAT) errors.push(`Unknown format ${p.format}`);
  const kind = puzzleKind(p);
  const series = puzzleSeries(p);
  if (!isValidKind(kind)) errors.push(`Unknown kind ${kind}`);
  else if (!isValidSeries(series)) errors.push(`Unknown series ${series}`);
  else if (!isValidDateId(p.date) || p.id !== puzzleId(p.date, kind, series)) {
    errors.push(kind === 'daily' && series === 'main'
      ? 'id/date must be the same YYYY-MM-DD date'
      : `id must be ${puzzleId(p.date, kind, series)} for a ${series === 'main' ? '' : `${SERIES_LABELS[series]} `}${kind} on ${p.date}`);
  }
  const { width, height } = p;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > MAX_SIZE || height > MAX_SIZE) {
    errors.push('Invalid size');
    return { ok: false, errors };
  }
  if (!Array.isArray(p.layout) || p.layout.length !== height || p.layout.some((row) => typeof row !== 'string' || row.length !== width)) {
    errors.push('Layout does not match size');
    return { ok: false, errors };
  }
  let plain;
  try {
    plain = decodeSolution(p.solution, p.id);
  } catch (e) {
    errors.push(`Solution: ${e.message}`);
    return { ok: false, errors };
  }
  if (plain.length !== width * height) errors.push('Solution length does not match size');
  else {
    for (let i = 0; i < plain.length; i++) {
      const isBlock = p.layout[Math.floor(i / width)][i % width] === BLOCK;
      if (isBlock ? plain[i] !== BLOCK : !isLetter(plain[i])) { errors.push('Solution does not match layout'); break; }
    }
  }
  if (checksum(plain) !== p.checksum) errors.push('Checksum mismatch');
  const { across, down } = computeEntries(gridFromLayout(p.layout));
  for (const [dir, entries] of [['across', across], ['down', down]]) {
    const list = p.clues?.[dir];
    if (!Array.isArray(list)) { errors.push(`Missing ${dir} clues`); continue; }
    const byNum = new Map(list.map((c) => [c.num, c]));
    for (const e of entries) {
      const c = byNum.get(e.num);
      if (!c || !normalizeClue(c.clue)) errors.push(`Missing clue ${e.id}`);
    }
    const nums = new Set(entries.map((e) => e.num));
    for (const c of list) if (!nums.has(c.num)) errors.push(`Clue ${c.num} ${dir} has no matching entry`);
  }
  for (const key of ['circles', 'shaded']) {
    if (p[key] !== undefined && (!Array.isArray(p[key]) || p[key].some((i) => !Number.isInteger(i) || i < 0 || i >= width * height))) {
      errors.push(`Invalid ${key}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Everything the player needs, derived from a published puzzle:
 * { width, height, solution: string[] (per cell: '#' or letter), isBlock: boolean[],
 *   numbers, across, down, all, acrossAt, downAt  (from computeEntries; each entry gets `.clue`),
 *   circles: Set<number>, shaded: Set<number> }
 */
export function loadPuzzle(p) {
  const plain = decodeSolution(p.solution, p.id);
  const layoutGrid = gridFromLayout(p.layout);
  const entries = computeEntries(layoutGrid);
  const clueMap = { across: new Map(), down: new Map() };
  for (const dir of ['across', 'down']) for (const c of p.clues?.[dir] || []) clueMap[dir].set(c.num, normalizeClue(c.clue));
  for (const e of entries.all) e.clue = clueMap[e.dir].get(e.num) || '';
  return {
    ...entries,
    width: p.width,
    height: p.height,
    solution: [...plain],
    isBlock: layoutGrid.cells.map((ch) => ch === BLOCK),
    circles: new Set(p.circles || []),
    shaded: new Set(p.shaded || []),
  };
}

/**
 * Index summary for one published puzzle (number is assigned by buildIndex). Claude's way entries also carry
 * `series: 'claude'` (omitted for the user's own puzzles, like in the puzzle files).
 */
export function puzzleSummary(p) {
  const series = puzzleSeries(p);
  return {
    id: p.id, date: p.date, kind: puzzleKind(p), ...(series === 'main' ? {} : { series }),
    title: p.title, author: p.author || '', width: p.width, height: p.height,
  };
}

/** Sort comparator: by date, then series (the user's own first), then kind display order (Mini, Midi, Daily). */
export function comparePuzzles(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const bySeries = SERIES.indexOf(puzzleSeries(a)) - SERIES.indexOf(puzzleSeries(b));
  if (bySeries) return bySeries;
  return KINDS.indexOf(puzzleKind(a)) - KINDS.indexOf(puzzleKind(b));
}

/**
 * Build site/puzzles/index.json (or site/puzzles/claude/index.json) from published puzzles (or summaries).
 * Puzzles are sorted by date then kind (Mini, Midi, Daily); `number` counts 1..N per kind in date order
 * (Daily #2, Mini #1), separately for each series. Entries without `kind` are dailies. Every entry carries `kind`.
 */
export function buildIndex(puzzles) {
  const list = puzzles.map(puzzleSummary).sort(comparePuzzles);
  const counts = {};
  for (const s of list) {
    const key = `${puzzleSeries(s)}:${s.kind}`;
    counts[key] = (counts[key] || 0) + 1;
    s.number = counts[key];
  }
  return { format: 'crossword-index/1', puzzles: list };
}
