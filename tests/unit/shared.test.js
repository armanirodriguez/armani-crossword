import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeEntries, validateGrid, symmetricIndex, isSymmetric, gridFromLayout, layoutFromGrid, entryPattern,
} from '../../site/shared/grid.js';
import {
  encodeSolution, decodeSolution, draftToPuzzle, validatePuzzle, loadPuzzle, makeDraft, normalizeAnswer,
  formatDuration, isValidDateId, todayISO, addDays, buildIndex, formatDate,
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
