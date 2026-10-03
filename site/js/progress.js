// Per-browser progress records (SPEC §6):
//   localStorage['xw:v1:progress:<puzzleId>'] = {
//     v: 1, letters: string[], marks: string[], everWrong: number[], elapsedMs, started, solved, solvedAt,
//     checks, reveals, updatedAt, checksum, finish }
// Additions to the SPEC shape:
//   checksum  the puzzle's checksum at save time, so a re-published puzzle can be noticed
//   finish    how a finished puzzle ended: 'solved' | 'revealed' (Reveal › Puzzle); null while unsolved
//
// Several tabs of the same puzzle share one record. Writes therefore go through ProgressSync (below), which
// merges with whatever another tab saved since this tab last read or wrote the record instead of blindly
// overwriting it (see mergeProgress).
//
// Everything here is pure except load/save and ProgressSync, which go through the safe storage wrapper.

import { formatDuration } from '../shared/puzzle.js';

export const PROGRESS_PREFIX = 'xw:v1:progress:';
export const progressKey = (puzzleId) => `${PROGRESS_PREFIX}${puzzleId}`;

const LETTER_RE = /^[A-Z]$/;
const MARKS = new Set(['', 'wrong', 'revealed']);

/** A fresh record for a puzzle with `size` cells. */
export function emptyProgress(size) {
  return {
    v: 1,
    letters: new Array(size).fill(''),
    marks: new Array(size).fill(''),
    everWrong: [],
    elapsedMs: 0,
    started: false,
    solved: false,
    solvedAt: null,
    finish: null,
    checks: 0,
    reveals: 0,
    updatedAt: null,
  };
}

const nonNegInt = (x) => (Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);
const finishOf = (raw) => (raw.finish === 'revealed' ? 'revealed' : 'solved');

/**
 * Validate a stored record against a loaded puzzle (loadPuzzle() result + checksum).
 * Anything malformed is repaired or dropped; the result is always safe to use.
 *  - layout changed (block pattern differs) -> start over, except a solved record stays solved
 *  - solution changed (re-published fix)   -> revealed squares follow the new solution, 'wrong' marks on
 *    letters that are now right are dropped, and a solved record stays solved (keeping its hint colours)
 */
export function normalizeProgress(raw, puzzle, checksum = null) {
  const size = puzzle.width * puzzle.height;
  const fresh = emptyProgress(size);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.letters)) return fresh;

  const solution = (i) => (puzzle.isBlock[i] ? '' : puzzle.solution[i]);
  const solvedKeep = (marks = fresh.marks, everWrong = []) => ({
    ...fresh,
    letters: puzzle.solution.map((_, i) => solution(i)),
    // Hint colours survive a re-published answer fix when the block layout is unchanged.
    marks: marks.map((m) => (m === 'revealed' ? 'revealed' : '')),
    everWrong,
    elapsedMs: nonNegInt(raw.elapsedMs),
    started: true,
    solved: true,
    solvedAt: typeof raw.solvedAt === 'string' ? raw.solvedAt : null,
    finish: finishOf(raw),
    checks: nonNegInt(raw.checks),
    reveals: nonNegInt(raw.reveals),
    updatedAt: raw.updatedAt ?? null,
    checksum,
  });

  const layoutMatches = raw.letters.length === size
    && raw.letters.every((ch, i) => !(puzzle.isBlock[i] && ch && ch !== '#'));
  if (!layoutMatches) return raw.solved ? solvedKeep() : fresh;

  const letters = raw.letters.map((ch, i) => (!puzzle.isBlock[i] && LETTER_RE.test(ch) ? ch : ''));
  const marks = Array.isArray(raw.marks) && raw.marks.length === size
    ? raw.marks.map((m, i) => (!puzzle.isBlock[i] && MARKS.has(m) ? m : ''))
    : new Array(size).fill('');
  marks.forEach((m, i) => {
    // A 'wrong' mark only makes sense on a filled square that is actually wrong (the answer can change when
    // the puzzle is re-published); revealed squares carry the solution.
    if (m === 'wrong' && (!letters[i] || letters[i] === solution(i))) marks[i] = '';
    if (m === 'revealed') letters[i] = solution(i);
  });
  const everWrong = [...new Set((Array.isArray(raw.everWrong) ? raw.everWrong : [])
    .filter((i) => Number.isInteger(i) && i >= 0 && i < size && !puzzle.isBlock[i]))].sort((a, b) => a - b);

  const solvedNow = letters.every((ch, i) => puzzle.isBlock[i] || ch === puzzle.solution[i]);
  let solved = Boolean(raw.solved);
  if (solved && !solvedNow) {
    // The puzzle was re-published with a different answer: they did solve it, so keep it solved.
    if (checksum && raw.checksum && raw.checksum !== checksum) return solvedKeep(marks, everWrong);
    solved = solvedNow; // corrupted record
  }

  return {
    v: 1,
    letters,
    marks,
    everWrong,
    elapsedMs: nonNegInt(raw.elapsedMs),
    started: Boolean(raw.started) || solved || letters.some(Boolean),
    solved,
    solvedAt: solved && typeof raw.solvedAt === 'string' ? raw.solvedAt : null,
    finish: solved ? finishOf(raw) : null,
    checks: nonNegInt(raw.checks),
    reveals: nonNegInt(raw.reveals),
    updatedAt: raw.updatedAt ?? null,
    checksum,
  };
}

export function loadProgress(storage, puzzleId, puzzle, checksum = null) {
  return normalizeProgress(storage.getJSON(progressKey(puzzleId), null), puzzle, checksum);
}

/** Plain overwrite (no merging). The player saves through ProgressSync instead. */
export function saveProgress(storage, puzzleId, record) {
  return storage.setJSON(progressKey(puzzleId), { ...record, v: 1, updatedAt: new Date().toISOString() });
}

/**
 * Three-way merge of progress records (all normalized against the same puzzle):
 *   stored  what is in storage now (another tab may have written it)
 *   base    what this tab last read or wrote (the common ancestor)
 *   local   this tab's current state
 * Returns stored + this tab's changes since base:
 *  - a finished puzzle is final: a solved `stored` is never downgraded (and wins over a later local finish)
 *  - squares this tab changed since base keep this tab's letter/mark, all others take the stored one
 *  - time and hint counts are additive (each tab adds what it accumulated since base)
 */
export function mergeProgress(stored, base, local) {
  if (!stored) return { ...local };
  if (stored.solved) return { ...stored, checksum: stored.checksum ?? local.checksum };
  const b = base || emptyProgress(local.letters.length);
  const n = local.letters.length;
  const letters = new Array(n);
  const marks = new Array(n);
  for (let i = 0; i < n; i++) {
    const mine = local.solved || local.letters[i] !== b.letters[i] || local.marks[i] !== b.marks[i];
    const src = mine ? local : stored;
    letters[i] = src.letters[i];
    marks[i] = src.marks[i];
  }
  const delta = (k) => Math.max(0, Math.round((local[k] || 0) - (b[k] || 0)));
  return {
    v: 1,
    letters,
    marks,
    everWrong: [...new Set([...stored.everWrong, ...local.everWrong])].sort((x, y) => x - y),
    elapsedMs: (stored.elapsedMs || 0) + delta('elapsedMs'),
    started: Boolean(stored.started || local.started),
    solved: Boolean(local.solved),
    solvedAt: local.solved ? local.solvedAt ?? null : null,
    finish: local.solved ? local.finish || 'solved' : null,
    checks: (stored.checks || 0) + delta('checks'),
    reveals: (stored.reveals || 0) + delta('reveals'),
    updatedAt: stored.updatedAt ?? null,
    checksum: local.checksum ?? stored.checksum ?? null,
  };
}

/** The fields that matter when comparing two records (everything but timestamps/version). */
function contentKey(r) {
  return JSON.stringify([r.letters, r.marks, r.everWrong, Math.round(r.elapsedMs || 0), Boolean(r.started),
    Boolean(r.solved), r.finish ?? null, r.checks || 0, r.reveals || 0]);
}

/** True when two records hold the same progress. */
export function sameProgress(a, b) {
  return contentKey(a) === contentKey(b);
}

/**
 * Keeps one tab's progress for one puzzle in step with storage that other tabs may write too.
 *
 *   const sync = new ProgressSync({ storage, puzzleId, puzzle, checksum });
 *   let state = sync.load();
 *   sync.save(state)  -> { ok, record, merged }   merged: another tab wrote meanwhile; `record` (what was
 *                                                 written) folds in their changes and must be adopted
 *   sync.pull(state)  -> null | { record, needsWrite }   another tab wrote: adopt `record` (= their record +
 *                                                 this tab's unsaved changes); needsWrite: save it back
 *
 * Changes made by other tabs are detected by comparing the raw stored string with the last one this tab
 * read or wrote, so no extra fields or clocks are needed.
 */
export class ProgressSync {
  constructor({ storage, puzzleId, puzzle, checksum = null }) {
    this.storage = storage;
    this.key = progressKey(puzzleId);
    this.puzzle = puzzle;
    this.checksum = checksum;
    this.baseRaw = null;
    this.base = null;
  }

  _parse(raw) {
    let obj = null;
    if (raw != null) {
      try { obj = JSON.parse(raw); } catch { obj = null; }
    }
    return normalizeProgress(obj, this.puzzle, this.checksum);
  }

  /** Read the stored record (normalized) and remember it as the base. */
  load() {
    this.baseRaw = this.storage.getRaw(this.key);
    this.base = this._parse(this.baseRaw);
    return this.base;
  }

  /** Has another tab written the record since this tab last read or wrote it? */
  changedElsewhere() {
    return this.storage.getRaw(this.key) !== this.baseRaw;
  }

  /** Save `local`, merged with another tab's changes when there are any. */
  save(local) {
    const raw = this.storage.getRaw(this.key);
    let record = local;
    let merged = false;
    if (raw !== this.baseRaw && raw != null) {
      record = mergeProgress(this._parse(raw), this.base, local);
      merged = !sameProgress(record, local);
    }
    const out = { ...record, v: 1, updatedAt: new Date().toISOString() };
    const str = JSON.stringify(out);
    const ok = this.storage.setRaw(this.key, str);
    this.baseRaw = str;
    this.base = out;
    return { ok, record: out, merged };
  }

  /** Fold in a record another tab wrote (null when nothing changed since this tab's last read/write). */
  pull(local) {
    const raw = this.storage.getRaw(this.key);
    if (raw === this.baseRaw || raw == null) return null;
    const stored = this._parse(raw);
    const record = mergeProgress(stored, this.base, local);
    this.baseRaw = raw;
    this.base = stored;
    return { record, needsWrite: !sameProgress(record, stored) };
  }
}

/**
 * Archive/intro status from a raw stored record (no puzzle needed):
 *   { state: 'new' | 'progress' | 'solved' | 'revealed', elapsedMs, label }
 */
export function progressStatus(raw) {
  if (!raw || typeof raw !== 'object') return { state: 'new', elapsedMs: 0, label: 'New' };
  const elapsedMs = nonNegInt(raw.elapsedMs);
  if (raw.solved && raw.finish === 'revealed') return { state: 'revealed', elapsedMs, label: 'Revealed' };
  if (raw.solved) return { state: 'solved', elapsedMs, label: `✓ Solved ${formatDuration(elapsedMs)}` };
  const touched = raw.started || (Array.isArray(raw.letters) && raw.letters.some((ch) => LETTER_RE.test(ch)));
  if (touched) return { state: 'progress', elapsedMs, label: `In progress ${formatDuration(elapsedMs)}` };
  return { state: 'new', elapsedMs: 0, label: 'New' };
}
