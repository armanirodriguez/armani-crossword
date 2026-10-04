// Unit tests for the player's side of SPEC §8 (Mini / Midi / Daily on the same date): today's puzzles, ids in
// routes and the index, archive grouping, size labels and the share text's kind word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  entriesOn, entryId, entryKind, findEntry, groupByDate, indexEntries, kindLabel, parseRoute, pickDaily, pickToday,
  releasedPuzzles, sizeLabel, todaySignature,
} from '../../site/js/daily.js';
import { buildShareText } from '../../site/js/share.js';

const e = (date, kind, number, extra = {}) => ({
  id: kind === 'daily' ? date : `${date}-${kind}`, date, kind, number, title: `${kind} ${date}`, width: 5, height: 5, ...extra,
});

// Deliberately shuffled; the Oct 1 daily has no `kind` (as published before §8).
const index = { puzzles: [
  e('2026-10-04', 'daily', 3),
  e('2026-10-03', 'midi', 1),
  { id: '2026-10-01', date: '2026-10-01', number: 1, title: 'Old daily', width: 15, height: 15 },
  e('2026-10-04', 'mini', 2),
  e('2026-10-03', 'daily', 2),
  e('2026-10-04', 'midi', 2),
  e('2026-10-03', 'mini', 1),
  e('2026-10-06', 'mini', 3),
] };

test('entryKind / entryId: missing kind is a daily; ids follow puzzleId', () => {
  assert.equal(entryKind({ date: '2026-10-01' }), 'daily');
  assert.equal(entryKind({ kind: 'bogus' }), 'daily');
  assert.equal(entryKind({ kind: 'midi' }), 'midi');
  assert.equal(entryId({ id: '2026-10-01', date: '2026-10-01' }), '2026-10-01');
  assert.equal(entryId({ date: '2026-10-01', kind: 'mini' }), '2026-10-01-mini');
  // An id that disagrees with date + kind is rebuilt from them.
  assert.equal(entryId({ id: '2026-10-01', date: '2026-10-01', kind: 'mini' }), '2026-10-01-mini');
  assert.equal(kindLabel('mini'), 'Mini');
  assert.equal(kindLabel(undefined), 'Daily');
});

test('indexEntries sorts by date, then Mini, Midi, Daily; drops duplicates of an id', () => {
  const ids = indexEntries({ puzzles: [...index.puzzles, e('2026-10-04', 'mini', 9)] }).map(entryId);
  assert.deepEqual(ids, [
    '2026-10-01', '2026-10-03-mini', '2026-10-03-midi', '2026-10-03', '2026-10-04-mini', '2026-10-04-midi', '2026-10-04',
    '2026-10-06-mini',
  ]);
});

test('pickToday: every puzzle of today, else of the latest date before it', () => {
  const t = pickToday(index, '2026-10-04');
  assert.equal(t.date, '2026-10-04');
  assert.equal(t.isToday, true);
  assert.deepEqual(t.entries.map(entryKind), ['mini', 'midi', 'daily']);

  const latest = pickToday(index, '2026-10-05'); // nothing on Oct 5; Oct 6 is locked
  assert.equal(latest.date, '2026-10-04');
  assert.equal(latest.isToday, false);
  assert.equal(latest.entries.length, 3);

  assert.deepEqual(pickToday(index, '2026-09-01'), { date: null, entries: [], isToday: false, nextDate: '2026-10-01' });
  assert.deepEqual(pickToday(null, '2026-09-01'), { date: null, entries: [], isToday: false, nextDate: null });

  // A day with only a mini still counts as a day with a puzzle.
  const mini = pickToday(index, '2026-10-06');
  assert.deepEqual(mini.entries.map(entryId), ['2026-10-06-mini']);
  // pickDaily (single-puzzle view) prefers the day's daily.
  assert.equal(entryId(pickDaily(index, '2026-10-04').entry), '2026-10-04');
});

test('findEntry by id; a bare date is that date’s daily', () => {
  assert.equal(findEntry(index, '2026-10-04-mini').number, 2);
  assert.equal(findEntry(index, '2026-10-04').kind, 'daily');
  assert.equal(findEntry(index, '2026-10-01').title, 'Old daily');
  assert.equal(findEntry(index, '2026-10-06'), null); // Oct 6 has only a mini
  assert.equal(findEntry(index, '2026-10-01-mini'), null);
  assert.equal(findEntry(index, 'nope'), null);
  assert.deepEqual(entriesOn(index, '2026-10-03').map(entryKind), ['mini', 'midi', 'daily']);
});

test('releasedPuzzles: newest date first, Mini/Midi/Daily within a date; groupByDate keeps that order', () => {
  const list = releasedPuzzles(index, '2026-10-04');
  assert.deepEqual(list.map(entryId), [
    '2026-10-04-mini', '2026-10-04-midi', '2026-10-04', '2026-10-03-mini', '2026-10-03-midi', '2026-10-03', '2026-10-01',
  ]);
  const groups = groupByDate(list);
  assert.deepEqual(groups.map((g) => [g.date, g.entries.length]), [['2026-10-04', 3], ['2026-10-03', 3], ['2026-10-01', 1]]);
});

test('todaySignature changes when a puzzle of today lands', () => {
  const before = todaySignature(index, '2026-10-05');
  const after = todaySignature({ puzzles: [...index.puzzles, e('2026-10-05', 'mini', 4)] }, '2026-10-05');
  assert.notEqual(before, after);
  assert.equal(todaySignature(index, '2026-10-04'), todaySignature({ puzzles: [...index.puzzles].reverse() }, '2026-10-04'));
});

test('parseRoute understands kinded ids; date-only links stay dailies', () => {
  assert.deepEqual(parseRoute('#/puzzle/2026-10-04-mini'), { name: 'puzzle', id: '2026-10-04-mini', date: '2026-10-04', kind: 'mini' });
  assert.deepEqual(parseRoute('#/puzzle/2026-10-04-midi/'), { name: 'puzzle', id: '2026-10-04-midi', date: '2026-10-04', kind: 'midi' });
  assert.deepEqual(parseRoute('#/puzzle/2026-10-04'), { name: 'puzzle', id: '2026-10-04', date: '2026-10-04', kind: 'daily' });
  assert.deepEqual(parseRoute('#/puzzle/2026-10-04-daily'), { name: 'today', unknown: true });
  assert.deepEqual(parseRoute('#/puzzle/2026-10-04-maxi'), { name: 'today', unknown: true });
  assert.deepEqual(parseRoute('#/puzzle/2026-02-30-mini'), { name: 'today', unknown: true });
});

test('sizeLabel: a small daily is still called a Mini; a kinded puzzle shows only its size', () => {
  assert.equal(sizeLabel(5, 5), '5×5 Mini');
  assert.equal(sizeLabel(5, 5, 'daily'), '5×5 Mini');
  assert.equal(sizeLabel(5, 5, 'mini'), '5×5');
  assert.equal(sizeLabel(9, 9, 'midi'), '9×9');
  assert.equal(sizeLabel(15, 15, 'daily'), '15×15');
});

test('share text: kind word before the number for a mini / midi, none for a daily', () => {
  const base = { siteName: 'Armani Crossword', date: '2026-10-04', elapsedMs: 42_000, gridRows: null, url: '' };
  assert.equal(buildShareText({ ...base, number: 1, kind: 'mini' }).split('\n')[0], '🧩 Armani Crossword Mini #1 · Sun, Oct 4');
  assert.equal(buildShareText({ ...base, number: 4, kind: 'midi' }).split('\n')[0], '🧩 Armani Crossword Midi #4 · Sun, Oct 4');
  assert.equal(buildShareText({ ...base, number: 2, kind: 'daily' }).split('\n')[0], '🧩 Armani Crossword #2 · Sun, Oct 4');
  assert.equal(buildShareText({ ...base, number: 2 }).split('\n')[0], '🧩 Armani Crossword #2 · Sun, Oct 4');
  assert.equal(buildShareText({ ...base, number: null, kind: 'mini' }).split('\n')[0], '🧩 Armani Crossword Mini · Sun, Oct 4');
});
