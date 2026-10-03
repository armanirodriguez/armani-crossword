// Unit tests for the player's progress records, daily selection/routing and safe storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPuzzle } from '../../site/shared/puzzle.js';
import {
  normalizeProgress, progressStatus, emptyProgress, loadProgress, saveProgress, progressKey, mergeProgress, ProgressSync,
} from '../../site/js/progress.js';
import { shareGridRows } from '../../site/js/share.js';
import { pickDaily, releasedPuzzles, isLocked, parseRoute, sizeLabel, findEntry } from '../../site/js/daily.js';
import { createStorage, MemoryStorage } from '../../site/js/storage.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/sample-puzzle.json', import.meta.url), 'utf8'));
const puzzle = loadPuzzle(fixture);
const SOLUTION = [...'#GASPDELTAENTERBREAKTERM#'].map((c) => (c === '#' ? '' : c));

test('normalizeProgress: garbage -> fresh record', () => {
  for (const raw of [null, 'x', 42, {}, { letters: 'ABC' }]) {
    assert.deepEqual(normalizeProgress(raw, puzzle), emptyProgress(25));
  }
});

test('normalizeProgress repairs bad cells, marks and counters', () => {
  const letters = new Array(25).fill('');
  letters[1] = 'X'; letters[2] = 'a'; letters[3] = '??'; letters[0] = '';
  const marks = new Array(25).fill('');
  marks[1] = 'wrong'; marks[4] = 'wrong' /* empty -> dropped */; marks[5] = 'revealed'; marks[6] = 'bogus';
  const p = normalizeProgress({ letters, marks, everWrong: [1, 0, 99, 'x', 1], elapsedMs: -5, checks: 2.7, reveals: 'no', started: false }, puzzle);
  assert.equal(p.letters[1], 'X');
  assert.equal(p.letters[2], '', 'lowercase is not a valid stored letter');
  assert.equal(p.letters[3], '');
  assert.equal(p.letters[5], 'D', 'revealed squares carry the solution');
  assert.deepEqual(p.marks.slice(0, 7), ['', 'wrong', '', '', '', 'revealed', '']);
  assert.deepEqual(p.everWrong, [1], 'blocks / out of range / duplicates removed');
  assert.equal(p.elapsedMs, 0);
  assert.equal(p.checks, 2);
  assert.equal(p.reveals, 0);
  assert.equal(p.started, true, 'letters imply started');
});

test('normalizeProgress: a solved flag must match the letters unless the puzzle was re-published', () => {
  const bogus = normalizeProgress({ letters: new Array(25).fill(''), solved: true, elapsedMs: 1000 }, puzzle, 'abc');
  assert.equal(bogus.solved, false);
  const republished = normalizeProgress({ letters: new Array(25).fill(''), solved: true, elapsedMs: 9000, checksum: 'old' }, puzzle, 'new');
  assert.equal(republished.solved, true);
  assert.deepEqual(republished.letters, SOLUTION);
  assert.equal(republished.elapsedMs, 9000);
  const real = normalizeProgress({ letters: SOLUTION, solved: true, elapsedMs: 9000, solvedAt: '2026-10-02T10:00:00Z' }, puzzle);
  assert.equal(real.solved, true);
  assert.equal(real.solvedAt, '2026-10-02T10:00:00Z');
});

test('normalizeProgress: different layout -> fresh (or solved kept)', () => {
  const wrongSize = normalizeProgress({ letters: new Array(9).fill('A'), started: true }, puzzle);
  assert.deepEqual(wrongSize, emptyProgress(25));
  const letterOnBlock = new Array(25).fill('');
  letterOnBlock[0] = 'A';
  assert.equal(normalizeProgress({ letters: letterOnBlock, started: true }, puzzle).started, false);
});

test('normalizeProgress: a re-published answer fix drops the stale wrong mark on a now-correct letter', () => {
  const letters = [...SOLUTION]; // the solver typed the intended answer (M of TERM) …
  const marks = new Array(25).fill('');
  marks[23] = 'wrong'; // … which a check flagged against the old, typo'd solution
  const p = normalizeProgress({ letters, marks, everWrong: [23], started: true, solved: false, checksum: 'old' }, puzzle, 'new');
  assert.equal(p.marks[23], '', 'no red slash on a square that is now right');
  assert.deepEqual(p.everWrong, [23], 'it was flagged, so the share grid keeps its 🟨');
  assert.equal(p.solved, false, 'completing is the play view’s job (it celebrates and records the time)');
});

test('normalizeProgress: a solved record keeps its hint colours across a re-published answer fix', () => {
  // Solved under an older solution (one letter differs), with two revealed squares and one checked square.
  const letters = [...SOLUTION];
  letters[9] = 'O'; // old answer letter
  const marks = new Array(25).fill('');
  marks[1] = 'revealed'; marks[2] = 'revealed'; marks[9] = 'wrong';
  const raw = { letters, marks, everWrong: [6], elapsedMs: 75_000, started: true, solved: true, solvedAt: '2026-10-02T10:00:00Z', checks: 1, reveals: 2, checksum: 'old' };
  const p = normalizeProgress(raw, puzzle, 'new');
  assert.equal(p.solved, true);
  assert.deepEqual(p.letters, SOLUTION);
  assert.deepEqual(p.everWrong, [6]);
  assert.equal(p.marks[1], 'revealed');
  assert.equal(p.marks[2], 'revealed');
  assert.equal(p.marks[9], '', 'wrong marks go');
  assert.deepEqual(shareGridRows(puzzle, p.marks, p.everWrong).slice(0, 2), ['⬛🟪🟪🟩🟩', '🟩🟨🟩🟩🟩']);
  assert.equal(p.checks, 1);
  assert.equal(p.reveals, 2);
  // A changed block layout still starts the colours over (the old indices mean nothing).
  const moved = normalizeProgress({ ...raw, letters: new Array(9).fill('A') }, puzzle, 'new');
  assert.equal(moved.solved, true);
  assert.deepEqual(moved.everWrong, []);
  assert.ok(moved.marks.every((m) => m === ''));
});

test('a puzzle finished with Reveal › Puzzle is "Revealed", not "Solved"', () => {
  const p = normalizeProgress({ letters: SOLUTION, solved: true, finish: 'revealed', elapsedMs: 3000, reveals: 23 }, puzzle);
  assert.equal(p.finish, 'revealed');
  assert.equal(normalizeProgress({ letters: SOLUTION, solved: true, elapsedMs: 3000 }, puzzle).finish, 'solved', 'older records were solves');
  assert.equal(normalizeProgress({ letters: new Array(25).fill(''), finish: 'revealed' }, puzzle).finish, null);
  assert.deepEqual(progressStatus({ solved: true, finish: 'revealed', elapsedMs: 3000 }), { state: 'revealed', elapsedMs: 3000, label: 'Revealed' });
  assert.equal(progressStatus({ solved: true, finish: 'solved', elapsedMs: 3000 }).label, '✓ Solved 0:03');
});

test('progressStatus labels for the archive', () => {
  assert.deepEqual(progressStatus(null), { state: 'new', elapsedMs: 0, label: 'New' });
  assert.equal(progressStatus({ started: true, elapsedMs: 133_000, letters: [] }).label, 'In progress 2:13');
  assert.equal(progressStatus({ solved: true, elapsedMs: 272_000 }).label, '✓ Solved 4:32');
  assert.equal(progressStatus({ started: false, letters: ['', ''] }).state, 'new');
});

test('load/save round trip through storage', () => {
  const storage = createStorage({ backing: new MemoryStorage() });
  const rec = { ...emptyProgress(25), started: true, elapsedMs: 5000 };
  rec.letters[1] = 'G';
  saveProgress(storage, '2026-10-02', rec);
  const raw = storage.getJSON(progressKey('2026-10-02'));
  assert.equal(raw.v, 1);
  assert.ok(raw.updatedAt);
  const back = loadProgress(storage, '2026-10-02', puzzle);
  assert.equal(back.letters[1], 'G');
  assert.equal(back.elapsedMs, 5000);
});

const index = { puzzles: [
  { id: '2026-10-01', date: '2026-10-01', number: 1, title: 'A' },
  { id: '2026-10-03', date: '2026-10-03', number: 3, title: 'C' },
  { id: '2026-10-02', date: '2026-10-02', number: 2, title: 'B' },
  { id: 'bad', date: 'nope' },
] };

test('pickDaily: today, else latest before today, else the next unlock date', () => {
  assert.deepEqual(pickDaily(index, '2026-10-02'), { entry: index.puzzles[2], isToday: true });
  assert.equal(pickDaily(index, '2026-10-05').entry.date, '2026-10-03');
  assert.equal(pickDaily(index, '2026-10-05').isToday, false);
  assert.deepEqual(pickDaily(index, '2026-09-01'), { entry: null, isToday: false, nextDate: '2026-10-01' });
  assert.deepEqual(pickDaily({ puzzles: [] }, '2026-09-01'), { entry: null, isToday: false, nextDate: null });
  assert.deepEqual(pickDaily(null, '2026-09-01'), { entry: null, isToday: false, nextDate: null });
});

test('releasedPuzzles hides the future (except in preview), newest first', () => {
  assert.deepEqual(releasedPuzzles(index, '2026-10-02').map((p) => p.date), ['2026-10-02', '2026-10-01']);
  assert.deepEqual(releasedPuzzles(index, '2026-10-02', true).map((p) => p.date), ['2026-10-03', '2026-10-02', '2026-10-01']);
  assert.equal(isLocked('2026-10-03', '2026-10-02'), true);
  assert.equal(isLocked('2026-10-03', '2026-10-02', true), false);
  assert.equal(findEntry(index, '2026-10-03').number, 3);
  assert.equal(findEntry(index, '2026-10-09'), null);
});

test('parseRoute', () => {
  assert.deepEqual(parseRoute(''), { name: 'today' });
  assert.deepEqual(parseRoute('#/'), { name: 'today' });
  assert.deepEqual(parseRoute('#/archive'), { name: 'archive' });
  assert.deepEqual(parseRoute('#/puzzle/2026-10-03'), { name: 'puzzle', date: '2026-10-03' });
  assert.deepEqual(parseRoute('#/puzzle/2026-02-30'), { name: 'today', unknown: true });
  assert.deepEqual(parseRoute('#/what'), { name: 'today', unknown: true });
});

test('sizeLabel', () => {
  assert.equal(sizeLabel(5, 5), '5×5 Mini');
  assert.equal(sizeLabel(15, 15), '15×15');
});

test('storage: works without localStorage and never persists in preview mode', () => {
  const blocked = { setItem() { throw new Error('SecurityError'); }, getItem() { throw new Error('SecurityError'); }, removeItem() {}, key() { return null; }, length: 0 };
  const s = createStorage({ backing: blocked });
  assert.equal(s.available, false);
  s.setJSON('k', { a: 1 });
  assert.deepEqual(s.getJSON('k'), { a: 1 }, 'memory fallback for this visit');

  const real = new MemoryStorage();
  real.setItem('xw:v1:progress:x', '{"started":true}');
  const preview = createStorage({ backing: real, persist: false });
  assert.equal(preview.persistent, false);
  preview.setJSON('xw:v1:progress:y', { a: 1 });
  preview.remove('xw:v1:progress:x');
  assert.equal(real.getItem('xw:v1:progress:y'), null, 'nothing written to real storage');
  assert.equal(real.getItem('xw:v1:progress:x'), '{"started":true}');
  assert.equal(preview.getJSON('xw:v1:progress:x'), null);
  assert.deepEqual(preview.keys('xw:v1:progress:'), ['xw:v1:progress:y']);

  const quota = new MemoryStorage();
  const s2 = createStorage({ backing: quota });
  let errors = 0;
  s2.onWriteError(() => errors++);
  quota.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(s2.setRaw('a', 'b'), false);
  assert.equal(s2.getRaw('a'), 'b');
  assert.equal(errors, 1);
});

// -- several tabs of the same puzzle (review finding: a stale tab overwrote a finished solve) ---------------------

/** A progress record for the sample puzzle from a letter string ('.' = empty, '#' = block). */
function rec(str, extra = {}) {
  const letters = [...str].map((c) => (c === '.' || c === '#' ? '' : c));
  return normalizeProgress({ letters, started: true, ...extra }, puzzle, fixture.checksum);
}

test('mergeProgress: a finished solve in storage is never downgraded by a stale tab', () => {
  const base = rec('#G.......................', { elapsedMs: 1200 });
  const stored = rec(SOLUTION.map((c) => c || '#').join(''), { solved: true, elapsedMs: 4200, solvedAt: '2026-10-02T12:00:00Z' });
  const stale = rec('#G.......................', { elapsedMs: 1200 });
  const m = mergeProgress(stored, base, stale);
  assert.equal(m.solved, true);
  assert.equal(m.elapsedMs, 4200);
  assert.deepEqual(m.letters, SOLUTION);
});

test('mergeProgress: letters this tab changed win, the rest come from storage; time and hints add up', () => {
  const base = rec('#G.......................', { elapsedMs: 10_000, checks: 1 });
  // The other tab typed A S P (1A) and used a reveal, running 5 s.
  const stored = rec(`#GASP${'.'.repeat(20)}`, { elapsedMs: 15_000, checks: 1, reveals: 1 });
  stored.marks[4] = 'revealed';
  // This tab (unaware) typed D E (5A) and used a check, running 3 s.
  const local = rec('#G...DE..................', { elapsedMs: 13_000, checks: 2, everWrong: [6] });
  const m = mergeProgress(stored, base, local);
  assert.deepEqual(m.letters.slice(0, 8), ['', 'G', 'A', 'S', 'P', 'D', 'E', '']);
  assert.equal(m.marks[4], 'revealed');
  assert.equal(m.elapsedMs, 18_000, 'stored 15 s + 3 s run in this tab');
  assert.equal(m.checks, 2);
  assert.equal(m.reveals, 1);
  assert.deepEqual(m.everWrong, [6]);
  assert.equal(m.solved, false);
});

test('mergeProgress: this tab’s fresh solve survives a merge (adding the other tab’s time)', () => {
  const base = rec('#GASPDELTAENTERBREAKTER.#', { elapsedMs: 20_000 });
  const stored = rec('#GASPDELTAENTERBREAKTER.#', { elapsedMs: 22_000 });
  const local = { ...rec(SOLUTION.map((c) => c || '#').join(''), { elapsedMs: 21_000 }), solved: true, finish: 'solved', solvedAt: 'now' };
  const m = mergeProgress(stored, base, local);
  assert.equal(m.solved, true);
  assert.equal(m.finish, 'solved');
  assert.deepEqual(m.letters, SOLUTION);
  assert.equal(m.elapsedMs, 23_000);
});

test('ProgressSync: two tabs on one storage — a stale tab’s save merges instead of overwriting', () => {
  const storage = createStorage({ backing: new MemoryStorage() });
  const opts = { storage, puzzleId: fixture.id, puzzle, checksum: fixture.checksum };
  const A = new ProgressSync(opts);
  const B = new ProgressSync(opts);

  // Tab A: type G, run 1.2 s, save.
  let a = A.load();
  a = { ...a, letters: rec('#G.......................').letters, started: true, elapsedMs: 1200 };
  assert.equal(A.save(a).merged, false);

  // Tab B opens later (sees A's save), solves the puzzle in 3 s more.
  const b0 = B.load();
  assert.equal(b0.letters[1], 'G');
  const b = { ...b0, letters: SOLUTION.slice(), elapsedMs: 4200, solved: true, finish: 'solved', solvedAt: 'now' };
  B.save(b);

  // Tab A, never brought to the front, is closed: its pagehide save carries its stale state.
  assert.equal(A.changedElsewhere(), true);
  const res = A.save(a);
  assert.equal(res.merged, true, 'A must adopt what was written');
  const stored = loadProgress(storage, fixture.id, puzzle, fixture.checksum);
  assert.equal(stored.solved, true);
  assert.equal(stored.elapsedMs, 4200);
  assert.deepEqual(stored.letters, SOLUTION);
  assert.deepEqual(res.record.letters, SOLUTION);
});

test('ProgressSync.pull: picks up another tab’s save and keeps this tab’s unsaved time', () => {
  const storage = createStorage({ backing: new MemoryStorage() });
  const opts = { storage, puzzleId: fixture.id, puzzle, checksum: fixture.checksum };
  const A = new ProgressSync(opts);
  const B = new ProgressSync(opts);
  const a0 = A.load();
  B.load();
  assert.equal(A.pull(a0), null, 'nothing changed elsewhere');

  const b = { ...emptyProgress(25), letters: rec('#GAS.....................').letters, started: true, elapsedMs: 5000, checksum: fixture.checksum };
  B.save(b);
  // A has run 2 s since its base without saving.
  const res = A.pull({ ...a0, elapsedMs: 2000 });
  assert.deepEqual(res.record.letters.slice(0, 4), ['', 'G', 'A', 'S']);
  assert.equal(res.record.elapsedMs, 7000);
  assert.equal(res.needsWrite, true, 'its 2 s still need saving');
  assert.equal(A.pull(res.record), null, 'pulled once');
  // A then saves the merged state; B sees it with nothing of its own to add.
  A.save(res.record);
  const back = B.pull(b);
  assert.equal(back.record.elapsedMs, 7000);
  assert.equal(back.needsWrite, false, 'no ping-pong between tabs');
});
