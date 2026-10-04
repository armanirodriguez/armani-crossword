import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeEntries, validateGrid, symmetricIndex, isSymmetric, gridFromLayout, layoutFromGrid, entryPattern,
} from '../../site/shared/grid.js';
import {
  encodeSolution, decodeSolution, draftToPuzzle, validatePuzzle, loadPuzzle, makeDraft, normalizeAnswer,
  formatDuration, isValidDateId, todayISO, addDays, buildIndex, formatDate,
  KINDS, KIND_LABELS, puzzleId, parsePuzzleId, isValidPuzzleId, puzzleKind, suggestKind, isValidKind,
} from '../../site/shared/puzzle.js';

const g = (rows) => gridFromLayout(rows.map((r) => r.replace(/[A-Z]/g, '.')), rows.join('').replace(/\./g, ' '));

test('computeEntries numbers a mini in standard order', () => {
  const grid = gridFromLayout(['#....', '.....', '.....', '.....', '....#']);
  const { numbers, across, down } = computeEntries(grid);
  assert.deepEqual(across.map((e) => e.id), ['1A', '5A', '6A', '7A', '8A']);
  assert.deepEqual(down.map((e) => e.id), ['1D', '2D', '3D', '4D', '5D']);
  assert.equal(numbers[1], 1);
  assert.equal(numbers[5], 5);
  assert.equal(across[0].length, 4);
  assert.deepEqual(down[4].cells, [5, 10, 15, 20]);
});

test('single-cell runs are not entries and are flagged unchecked', () => {
  const grid = gridFromLayout(['...', '#.#', '...']);
  const { across, down, acrossAt } = computeEntries(grid);
  assert.deepEqual(across.map((e) => e.id), ['1A', '3A']);
  assert.deepEqual(down.map((e) => e.id), ['2D']);
  assert.equal(acrossAt[4], -1);
  const issues = validateGrid(grid, { minLength: 3 });
  assert.ok(issues.some((i) => i.type === 'unchecked'));
});

test('validateGrid finds short entries and disconnection', () => {
  const grid = gridFromLayout(['..#..', '..#..', '#####', '..#..', '..#..']);
  const types = validateGrid(grid).map((i) => i.type);
  assert.ok(types.includes('short-entry'));
  assert.ok(types.includes('disconnected'));
});

test('symmetry helpers', () => {
  const grid = gridFromLayout(['#....', '.....', '.....', '.....', '....#']);
  assert.equal(symmetricIndex(grid, 0, 'rotational'), 24);
  assert.equal(symmetricIndex(grid, 0, 'mirror'), 4);
  assert.ok(isSymmetric(grid, 'rotational'));
  assert.ok(!isSymmetric(grid, 'mirror'));
  assert.deepEqual(layoutFromGrid(grid), ['#....', '.....', '.....', '.....', '....#']);
  grid.cells[6] = 'Q';
  assert.equal(entryPattern(grid, computeEntries(grid).across[1]), '.Q...');
});

test('solution encoding round-trips and hides letters', () => {
  const plain = '#HELLO#WORLD';
  const enc = encodeSolution(plain, '2026-10-02');
  assert.ok(enc.startsWith('x1:'));
  assert.ok(!enc.includes('HELLO'));
  assert.equal(decodeSolution(enc, '2026-10-02'), plain);
  assert.notEqual(decodeSolution(enc, '2026-10-03'), plain);
});

function sampleDraft() {
  const d = makeDraft({ id: 'test', width: 3, height: 3, title: 'T', date: '2026-10-02', symmetry: 'rotational' });
  d.cells = [...'CATAREPEN'];
  d.clues = { CAT: 'Feline', ARE: 'Exist', PEN: 'Writer', CAP: 'Hat' };
  return d;
}

test('draftToPuzzle requires clues for every entry', () => {
  const d = sampleDraft();
  const { puzzle, errors } = draftToPuzzle(d);
  assert.equal(puzzle, null);
  assert.ok(errors.some((e) => e.includes('3D (TEN)')));
});

test('draftToPuzzle -> validatePuzzle -> loadPuzzle', () => {
  const d = sampleDraft();
  d.clues.TEN = 'Decade';
  // CAT/ARE/PEN across, CAP/ARE/TEN down: ARE appears twice -> warning only
  const { puzzle, errors, warnings } = draftToPuzzle(d);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('twice')));
  assert.equal(puzzle.id, '2026-10-02');
  assert.ok(!JSON.stringify(puzzle).includes('CAT'));
  assert.deepEqual(validatePuzzle(puzzle), { ok: true, errors: [] });
  const loaded = loadPuzzle(puzzle);
  assert.equal(loaded.solution.join(''), 'CATAREPEN');
  assert.equal(loaded.across[0].clue, 'Feline');
  assert.equal(loaded.down[2].clue, 'Decade');
  const tampered = { ...puzzle, checksum: '00000000' };
  assert.equal(validatePuzzle(tampered).ok, false);
});

test('misc helpers', () => {
  assert.equal(normalizeAnswer('Trick or treat!'), 'TRICKORTREAT');
  assert.equal(normalizeAnswer('Café'), 'CAFE');
  assert.equal(formatDuration(272000), '4:32');
  assert.equal(formatDuration(3725000), '1:02:05');
  assert.ok(isValidDateId('2024-02-29'));
  assert.ok(!isValidDateId('2025-02-29'));
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(todayISO('America/New_York', new Date('2026-10-03T02:00:00Z')), '2026-10-02');
  assert.equal(todayISO('Asia/Tokyo', new Date('2026-10-03T02:00:00Z')), '2026-10-03');
  assert.equal(formatDate('2026-10-03'), 'Saturday, October 3, 2026');
  const idx = buildIndex([{ id: '2026-10-05', date: '2026-10-05', title: 'B', width: 5, height: 5 }, { id: '2026-10-01', date: '2026-10-01', title: 'A', width: 5, height: 5 }]);
  assert.deepEqual(idx.puzzles.map((p) => [p.id, p.number]), [['2026-10-01', 1], ['2026-10-05', 2]]);
});

// --- §8 multiple puzzles per day -------------------------------------------------------------

test('kind ids: puzzleId / parsePuzzleId / isValidPuzzleId / puzzleKind / suggestKind', () => {
  assert.deepEqual([...KINDS], ['mini', 'midi', 'daily']);
  assert.deepEqual(KIND_LABELS, { mini: 'Mini', midi: 'Midi', daily: 'Daily' });
  assert.ok(isValidKind('midi') && !isValidKind('maxi') && !isValidKind(undefined));
  assert.equal(puzzleId('2026-10-05'), '2026-10-05');
  assert.equal(puzzleId('2026-10-05', 'daily'), '2026-10-05');
  assert.equal(puzzleId('2026-10-05', 'mini'), '2026-10-05-mini');
  assert.equal(puzzleId('2026-10-05', 'midi'), '2026-10-05-midi');
  assert.deepEqual(parsePuzzleId('2026-10-05'), { date: '2026-10-05', kind: 'daily' });
  assert.deepEqual(parsePuzzleId('2026-10-05-mini'), { date: '2026-10-05', kind: 'mini' });
  assert.deepEqual(parsePuzzleId('2026-10-05-midi'), { date: '2026-10-05', kind: 'midi' });
  for (const bad of ['2026-10-05-daily', '2026-10-05-maxi', '2025-02-29', '2025-02-29-mini', '../x', '', null, 5, '2026-10-05-mini-x']) {
    assert.equal(parsePuzzleId(bad), null, String(bad));
    assert.equal(isValidPuzzleId(bad), false, String(bad));
  }
  assert.ok(isValidPuzzleId('2026-10-05-midi'));
  assert.equal(puzzleKind({}), 'daily');
  assert.equal(puzzleKind({ kind: 'mini' }), 'mini');
  assert.equal(puzzleKind(null), 'daily');
  assert.equal(suggestKind(5, 5), 'mini');
  assert.equal(suggestKind(7), 'mini');
  assert.equal(suggestKind(9, 9), 'midi');
  assert.equal(suggestKind(11, 8), 'midi');
  assert.equal(suggestKind(15, 15), 'daily');
  assert.equal(suggestKind(7, 13), 'daily');
});

test('makeDraft has kind (default daily)', () => {
  assert.equal(makeDraft({ id: 'a' }).kind, 'daily');
  assert.equal(makeDraft({ id: 'a', kind: 'mini' }).kind, 'mini');
  assert.equal(makeDraft({ id: 'a', kind: 'bogus' }).kind, 'daily');
});

test('draftToPuzzle publishes kinded ids; dailies unchanged; validatePuzzle checks id', () => {
  const base = sampleDraft();
  base.clues.TEN = 'Decade';
  const legacy = { ...base };
  delete legacy.kind; // drafts saved before kinds existed
  const daily = draftToPuzzle(legacy).puzzle;
  assert.equal(daily.id, '2026-10-02');
  assert.ok(!('kind' in daily));
  assert.equal(draftToPuzzle({ ...base, kind: 'daily' }).puzzle.solution, daily.solution);

  const mini = draftToPuzzle({ ...base, kind: 'mini' }).puzzle;
  assert.equal(mini.id, '2026-10-02-mini');
  assert.equal(mini.kind, 'mini');
  assert.equal(mini.date, '2026-10-02');
  assert.deepEqual(validatePuzzle(mini), { ok: true, errors: [] });
  assert.equal(loadPuzzle(mini).solution.join(''), 'CATAREPEN'); // salt is the id
  assert.notEqual(mini.solution, daily.solution);

  // id must match date + kind
  assert.equal(validatePuzzle({ ...mini, kind: 'midi' }).ok, false);
  assert.equal(validatePuzzle({ ...mini, kind: undefined }).ok, false);
  assert.equal(validatePuzzle({ ...daily, kind: 'mini' }).ok, false);
  assert.equal(validatePuzzle({ ...daily, kind: 'daily' }).ok, true);
  assert.equal(validatePuzzle({ ...mini, kind: 'jumbo' }).ok, false);

  const bad = draftToPuzzle({ ...base, kind: 'jumbo' });
  assert.equal(bad.puzzle, null);
  assert.ok(bad.errors.some((e) => e.includes('kind')));
});

test('the sample published puzzle (no kind) still validates', async () => {
  const { readFile } = await import('node:fs/promises');
  const p = JSON.parse(await readFile(new URL('../fixtures/sample-puzzle.json', import.meta.url), 'utf8'));
  assert.equal(validatePuzzle(p).ok, true);
  assert.equal(puzzleKind(p), 'daily');
});

test('buildIndex numbers per kind and sorts by date then kind', () => {
  const e = (id, date, kind) => ({ id, date, ...(kind ? { kind } : {}), title: id, width: 5, height: 5 });
  const idx = buildIndex([
    e('2026-10-05', '2026-10-05'),
    e('2026-10-05-midi', '2026-10-05', 'midi'),
    e('2026-10-03', '2026-10-03'),
    e('2026-10-05-mini', '2026-10-05', 'mini'),
    e('2026-10-04-mini', '2026-10-04', 'mini'),
    e('2026-10-06', '2026-10-06', 'daily'),
  ]);
  assert.deepEqual(idx.puzzles.map((p) => [p.id, p.kind, p.number]), [
    ['2026-10-03', 'daily', 1],
    ['2026-10-04-mini', 'mini', 1],
    ['2026-10-05-mini', 'mini', 2],
    ['2026-10-05-midi', 'midi', 1],
    ['2026-10-05', 'daily', 2],
    ['2026-10-06', 'daily', 3],
  ]);
});
