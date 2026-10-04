// Shared helpers for scripts/claude-way.mjs ("Claude's way", SPEC §9): paths, files, dates and difficulty, the
// word list, banned words, clue banks, answer freshness and the Claude index. Node built-ins + engine/ + site/shared/
// only, so the CLI runs with plain `node` in a fresh clone (no npm install, no network).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { WordList } from '../../engine/wordlist.js';
import {
  addDays, buildIndex, isValidDateId, loadPuzzle, parsePuzzleId, puzzleId, todayISO,
} from '../../site/shared/puzzle.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SERIES = 'claude';
export const AUTHOR = 'Claude';
/** Grid size per kind (square grids). */
export const SIZES = Object.freeze({ mini: 5, midi: 9, daily: 15 });
/** Default layout-search budget per kind, in seconds (--time). */
export const DEFAULT_TIME = Object.freeze({ mini: 6, midi: 20, daily: 45 });
/** Time for each final fill attempt, in ms. */
export const FILL_MS = Object.freeze({ mini: 1500, midi: 4000, daily: 12000 });

export const DEFAULT_MIN_SCORE = 35;
export const FALLBACK_MIN_SCORE = 30;
/**
 * Fill entries scoring below this are flagged (only possible after the fallback to min score 30: the 35–39 band is
 * mostly fine inflections). Obscure entries are caught by the "no clue-bank entry" flag instead.
 */
export const LOW_SCORE = 35;
/** Entries below this score without any clue-bank entry are flagged as possibly obscure. */
export const OBSCURE_BELOW = 50;
export const MAX_CLUE_LENGTH = 80;
/** Answer freshness window (days before and after the puzzle date), both series. */
export const RECENT_DAYS = 30;
/** How far back `status` lists Claude's themes (to avoid repeating one). */
export const THEME_HISTORY_DAYS = 120;
/** Value-ordering penalty for a recently used answer (like the builder), and for one used on the same date. */
export const RECENT_PENALTY = 30;
export const SAME_DAY_PENALTY = 60;

// ---------------------------------------------------------------------------
// Difficulty (SPEC §9): classic newspaper ramp by the puzzle date's weekday; the Mini is one level gentler.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_LEVEL = [4, 1, 2, 3, 4, 5, 6]; // Sun..Sat

export const LEVEL_GUIDES = Object.freeze({
  1: 'Monday-easy: plain definitions and everyday knowledge, no tricks; every clue a gimme for a casual solver.',
  2: 'Tuesday: mostly direct definitions with a little more variety and light trivia.',
  3: 'Wednesday: a mix of straight clues with some wordplay and light misdirection; one or two "?" clues.',
  4: 'Thursday: trickier, vaguer definitions, more misdirection and wordplay; several "?" clues.',
  5: 'Friday: oblique and misdirecting clues, few gimmes; definitions hide behind second meanings.',
  6: 'Saturday: hardest; heavy misdirection and wordplay throughout, almost no gimmes (still fair and accurate).',
});

export function weekdayIndex(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function weekdayName(date) {
  return WEEKDAYS[weekdayIndex(date)];
}

/** Difficulty level 1–6 of a Claude puzzle: the weekday's level, one lower (min 1) for the Mini. */
export function difficulty(date, kind) {
  const day = WEEKDAY_LEVEL[weekdayIndex(date)];
  return kind === 'mini' ? Math.max(1, day - 1) : day;
}

export const claudeId = (date, kind) => puzzleId(date, kind, SERIES);

/** The shared core must implement SPEC §9 (series-aware ids); fail loudly instead of publishing wrong ids. */
export function assertSeriesSupport() {
  const ok = puzzleId('2026-01-05', 'mini', SERIES) === 'claude-2026-01-05-mini'
    && parsePuzzleId('claude-2026-01-05')?.series === SERIES
    && parsePuzzleId('2026-01-05')?.series === 'main';
  if (!ok) throw new CliError('site/shared/puzzle.js has no series support (SPEC §9): update the checkout.');
}

// ---------------------------------------------------------------------------
// Errors, paths, files

/** An error with a message meant for the user (no stack trace); `details` are extra lines. */
export class CliError extends Error {
  constructor(message, { details = [], code = 1, data = null } = {}) {
    super(message);
    this.details = details;
    this.exitCode = code;
    this.data = data;
  }
}

export function paths(root) {
  const r = path.resolve(root || REPO_ROOT);
  return {
    root: r,
    config: path.join(r, 'site', 'config.json'),
    puzzles: path.join(r, 'site', 'puzzles'),
    claudeDir: path.join(r, 'site', 'puzzles', 'claude'),
    claudeIndex: path.join(r, 'site', 'puzzles', 'claude', 'index.json'),
    work: path.join(r, '.claude-way'),
    wordlist: path.join(r, 'data', 'wordlist.txt'),
    userWords: path.join(r, 'data', 'user-words.txt'),
    banned: path.join(r, 'data', 'banned.txt'),
    cluesCurated: path.join(r, 'data', 'clues-curated.json'),
    cluesDictionary: path.join(r, 'data', 'clues-dictionary.json'),
    userClues: path.join(r, 'data', 'user-clues.json'),
  };
}

export const draftFile = (P, id) => path.join(P.work, `${id}.draft.json`);
export const worksheetFile = (P, id) => path.join(P.work, `${id}.clues.json`);
export const claudeFile = (P, id) => path.join(P.claudeDir, `${id}.json`);

/** Path relative to the root (for messages), with forward slashes. */
export function rel(P, file) {
  return path.relative(P.root, file).split(path.sep).join('/');
}

/** Write a file atomically: temp file in the same folder, then rename over the target. */
export async function writeFileAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export const writeJsonAtomic = (file, value) => writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);

/** Parsed JSON, `fallback` when the file does not exist; a CliError naming the file when it is not valid JSON. */
export async function readJson(file, fallback = undefined) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    if (err.code === 'ENOENT') throw new CliError(`File not found: ${file}`);
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CliError(`${file} is not valid JSON: ${err.message}`);
  }
}

function readTextIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Site config / today

export async function readConfig(P) {
  const cfg = await readJson(P.config, {}).catch(() => ({}));
  return cfg && typeof cfg === 'object' ? cfg : {};
}

/** The site's time zone: config.timeZone; null (each solver's local date) uses this machine's zone. */
export async function siteTimeZone(P) {
  const cfg = await readConfig(P);
  return Object.prototype.hasOwnProperty.call(cfg, 'timeZone') ? cfg.timeZone || null : 'America/Chicago';
}

/** Today in the site's zone, or `override` (tests / what-if runs). */
export async function siteToday(P, override = null) {
  if (override) {
    if (!isValidDateId(override)) throw new CliError(`--today must be YYYY-MM-DD (got "${override}")`);
    return override;
  }
  return todayISO(await siteTimeZone(P));
}

// ---------------------------------------------------------------------------
// Published puzzles

/** Published puzzle files of a series: [{ id, date, kind, series, file }]. */
export async function listPublished(P, series) {
  const dir = series === SERIES ? P.claudeDir : P.puzzles;
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    const parsed = parsePuzzleId(id);
    if (!parsed || parsed.series !== series) continue;
    out.push({ id, ...parsed, file: path.join(dir, name) });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The answers (complete entries) of a published puzzle, decoded from its solution. */
export function puzzleAnswers(puzzle) {
  const { all, solution } = loadPuzzle(puzzle);
  return all.map((e) => e.cells.map((i) => solution[i]).join('')).filter((a) => /^[A-Z]{2,}$/.test(a));
}

/** Claude drafts in .claude-way/: [{ id, date, kind, file }]. */
export async function listDrafts(P) {
  let names;
  try {
    names = await fsp.readdir(P.work);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    const m = /^(.+)\.draft\.json$/.exec(name);
    const parsed = m && parsePuzzleId(m[1]);
    if (parsed && parsed.series === SERIES) out.push({ id: m[1], ...parsed, file: path.join(P.work, name) });
  }
  return out;
}

/**
 * Answers used within ±days of `date` by published puzzles of BOTH series and by Claude drafts not published yet
 * (so a Mini, Midi and Daily built for the same day avoid each other), except `excludeId` itself.
 * Returns Map<WORD, [{ id, date, draft? }]>.
 */
export async function recentAnswers(P, { date, excludeId = null, days = RECENT_DAYS }) {
  const from = addDays(date, -days);
  const to = addDays(date, days);
  const out = new Map();
  const add = (word, src) => {
    if (!out.has(word)) out.set(word, []);
    out.get(word).push(src);
  };
  const published = new Set();
  for (const series of ['main', SERIES]) {
    for (const p of await listPublished(P, series)) {
      published.add(p.id);
      if (p.id === excludeId || p.date < from || p.date > to) continue;
      let words = [];
      try {
        words = puzzleAnswers(JSON.parse(await fsp.readFile(p.file, 'utf8')));
      } catch {
        continue; // unreadable puzzle: `check` reports it
      }
      for (const w of new Set(words)) add(w, { id: p.id, date: p.date });
    }
  }
  for (const d of await listDrafts(P)) {
    if (d.id === excludeId || published.has(d.id) || d.date < from || d.date > to) continue;
    try {
      const draft = JSON.parse(await fsp.readFile(d.file, 'utf8'));
      for (const w of new Set(draftAnswers(draft))) add(w, { id: d.id, date: d.date, draft: true });
    } catch {
      // ignore a broken draft
    }
  }
  return out;
}

/** Complete across/down words of a draft-like { width, height, cells }. */
export function draftAnswers(draft) {
  const { width, height, cells } = draft;
  if (!Array.isArray(cells) || cells.length !== width * height) return [];
  const words = [];
  const scan = (len, outer, at) => {
    for (let a = 0; a < outer; a++) {
      let run = '';
      for (let b = 0; b <= len; b++) {
        const ch = b < len ? cells[at(a, b)] : '#';
        if (/^[A-Z]$/.test(ch)) run += ch;
        else {
          if (run.length >= 2) words.push(run);
          run = '';
        }
      }
    }
  };
  scan(width, height, (r, c) => r * width + c);
  scan(height, width, (c, r) => r * width + c);
  return words;
}

/** `penalize` option for the engine: recent answers (same date: heavier), never the theme answers. */
export function penaltiesFor(recent, date, themeAnswers = []) {
  const theme = new Set(themeAnswers);
  const out = {};
  for (const [word, srcs] of recent) {
    if (theme.has(word)) continue;
    out[word] = srcs.some((s) => s.date === date) ? SAME_DAY_PENALTY : RECENT_PENALTY;
  }
  return out;
}

/** "2026-10-01 (claude-2026-10-01-mini)" style description of where an answer was used. */
export function describeUses(srcs) {
  return srcs.map((s) => `${s.id}${s.draft ? ' draft' : ''}`).join(', ');
}

// ---------------------------------------------------------------------------
// Word list, banned words, clue banks

/** data/wordlist.txt plus data/user-words.txt (the user's own additions and bans). */
export function loadWordList(P) {
  let text;
  try {
    text = fs.readFileSync(P.wordlist, 'utf8');
  } catch (err) {
    throw new CliError(`Cannot read the word list ${rel(P, P.wordlist)} (${err.code || err.message})`);
  }
  const wl = WordList.fromText(text);
  const user = readTextIfExists(P.userWords);
  if (user) wl.applyUserWords(user);
  return wl;
}

/**
 * Substrings that never occur in an acceptable entry (same list as scripts/data/banned.mjs, which builds the word
 * list; repeated here so this CLI depends on nothing outside engine/ and site/shared/).
 */
const BANNED_ROOTS = [
  'fuck', 'shit', 'cunt', 'whore', 'bitch', 'porn', 'dildo', 'jizz', 'asshole', 'arsehole', 'dickhead', 'cocksuck',
  'nigger', 'nigga', 'faggot', 'slut', 'blowjob', 'handjob', 'rimjob', 'masturbat', 'ejaculat', 'pedophil',
  'paedophil', 'jigaboo', 'pickaninny', 'wetback', 'raghead', 'towelhead',
].map((r) => r.toUpperCase());

/** Regular plural / 3rd-person spellings of a word (SLUR -> SLURS, WITCH -> WITCHES, PARTY -> PARTIES). */
function sForms(w) {
  const out = [`${w}S`];
  if (/(S|X|Z|CH|SH)$/.test(w)) out.push(`${w}ES`);
  if (/[^AEIOU]Y$/.test(w)) out.push(`${w.slice(0, -1)}IES`);
  return out;
}

/**
 * Banned words: data/banned.txt (plus plural forms), the banned roots, and the user's own bans in
 * data/user-words.txt ("-WORD"). Returns { isBanned(WORD) -> reason | null }.
 */
export function loadBanned(P) {
  const listed = new Set();
  for (const raw of readTextIfExists(P.banned).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const w = line.split(/[\s;#]/)[0].toUpperCase().replace(/[^A-Z]/g, '');
    if (!w) continue;
    listed.add(w);
    for (const f of sForms(w)) listed.add(f);
  }
  const userBans = new Set();
  for (const raw of readTextIfExists(P.userWords).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('-')) {
      const w = line.slice(1).toUpperCase().replace(/[^A-Z]/g, '');
      if (w) userBans.add(w);
    }
  }
  return {
    isBanned(word) {
      const w = String(word).toUpperCase().replace(/[^A-Z]/g, '');
      if (!w) return null;
      if (listed.has(w)) return 'listed in data/banned.txt';
      if (userBans.has(w)) return 'banned in data/user-words.txt';
      const root = BANNED_ROOTS.find((r) => w.includes(r));
      return root ? `contains "${root.toLowerCase()}"` : null;
    },
  };
}

/**
 * Clue banks: data/user-clues.json (if present) → data/clues-curated.json → data/clues-dictionary.json.
 * `suggest(word, n)` returns up to n distinct clues, never one that contains the word.
 */
export function loadClueBanks(P, { dictionary = true } = {}) {
  const banks = [];
  for (const [file, source] of [[P.userClues, 'user'], [P.cluesCurated, 'curated'], ...(dictionary ? [[P.cluesDictionary, 'dictionary']] : [])]) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && typeof data === 'object' && !Array.isArray(data)) banks.push({ source, data });
    } catch {
      // optional
    }
  }
  return {
    has(word) {
      return banks.some((b) => Array.isArray(b.data[word]) && b.data[word].length > 0);
    },
    suggest(word, n = 3) {
      const out = [];
      const seen = new Set();
      for (const b of banks) {
        for (const clue of Array.isArray(b.data[word]) ? b.data[word] : []) {
          if (typeof clue !== 'string' || !clue.trim()) continue;
          const key = clue.trim().toLowerCase();
          if (seen.has(key) || clue.toUpperCase().replace(/[^A-Z]/g, '').includes(word)) continue;
          seen.add(key);
          out.push(clue.trim());
          if (out.length >= n) return out;
        }
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// The Claude index (site/puzzles/claude/index.json)

/**
 * Rebuild site/puzzles/claude/index.json from the Claude puzzle files with buildIndex (numbering per kind within
 * the series), adding each entry's `theme` (from the puzzle file, else from the previous index). Atomic write.
 * Returns { index, skipped: [names] }.
 */
export async function rebuildClaudeIndex(P) {
  const previous = await readJson(P.claudeIndex, null).catch(() => null);
  const oldThemes = new Map((previous?.puzzles || []).filter((e) => e && e.id).map((e) => [e.id, e.theme]));
  const puzzles = [];
  const skipped = [];
  for (const f of await listPublished(P, SERIES)) {
    try {
      const p = JSON.parse(await fsp.readFile(f.file, 'utf8'));
      if (p && p.id === f.id) puzzles.push(p);
      else skipped.push(path.basename(f.file));
    } catch {
      skipped.push(path.basename(f.file));
    }
  }
  const themes = new Map(puzzles.map((p) => [p.id, typeof p.theme === 'string' && p.theme ? p.theme : oldThemes.get(p.id)]));
  const index = buildIndex(puzzles);
  for (const e of index.puzzles) if (themes.get(e.id)) e.theme = themes.get(e.id);
  await writeJsonAtomic(P.claudeIndex, index);
  return { index, skipped };
}

/** Rows of a grid as text: letters, '#' blocks, '.' empty. */
export function gridRows(width, height, cells) {
  const rows = [];
  for (let r = 0; r < height; r++) {
    let row = '';
    for (let c = 0; c < width; c++) {
      const ch = cells[r * width + c];
      row += ch === '#' ? '#' : /^[A-Z]$/.test(ch) ? ch : '.';
    }
    rows.push(row);
  }
  return rows;
}

/** A grid drawn for the terminal: letters spaced out, blocks as '#', with column / row coordinates. */
export function drawGrid(rows) {
  const w = rows[0]?.length || 0;
  const head = `    ${Array.from({ length: w }, (_, c) => String(c % 10)).join(' ')}`;
  return [head, ...rows.map((row, r) => `${String(r).padStart(2)}  ${[...row].join(' ')}`)].join('\n');
}
