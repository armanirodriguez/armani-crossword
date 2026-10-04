// Unit tests for the player's side of SPEC §9 ("Claude's way", a second series of puzzles): ids and routes,
// the separate index (tagged entries, 404 = none), puzzle file paths and the share text's series label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE, CLAUDE_LABEL, CLAUDE_TITLE, MAIN, archiveHref, idSeries, indexPath, puzzlePath, seriesOf,
} from '../../site/js/series.js';
import {
  entriesOn, entryId, entrySeries, findEntry, indexEntries, parseRoute, pickToday, releasedPuzzles, routeSeries,
  todaySignature,
} from '../../site/js/daily.js';
import { LoadError, loadIndex, loadPuzzleFile } from '../../site/js/data.js';
import { buildShareText } from '../../site/js/share.js';
import { SERIES_LABELS, buildIndex, draftToPuzzle, makeDraft } from '../../site/shared/puzzle.js';

const ce = (date, kind, number) => ({
  id: `claude-${kind === 'daily' ? date : `${date}-${kind}`}`, date, kind, number, title: `Claude ${kind}`, width: 5, height: 5, series: CLAUDE,
});
const claudeIndex = { puzzles: [
  ce('2026-10-05', 'daily', 2), ce('2026-10-04', 'midi', 1), ce('2026-10-05', 'mini', 2), ce('2026-10-04', 'mini', 1),
  ce('2026-10-04', 'daily', 1), ce('2026-10-05', 'midi', 2), ce('2026-10-07', 'mini', 3),
] };

test('series helpers: labels, paths and routes', () => {
  assert.equal(CLAUDE_LABEL, SERIES_LABELS.claude);
  assert.equal(CLAUDE_LABEL, "Claude's way");
  assert.equal(CLAUDE_TITLE, 'Claude’s way');
  assert.equal(seriesOf({ series: 'claude' }), CLAUDE);
  assert.equal(seriesOf({}), MAIN);
  assert.equal(seriesOf(null), MAIN);
  assert.equal(seriesOf({ series: 'bogus' }), MAIN);
  assert.equal(indexPath(), 'puzzles/index.json');
  assert.equal(indexPath(CLAUDE), 'puzzles/claude/index.json');
  assert.equal(puzzlePath('2026-10-04'), 'puzzles/2026-10-04.json');
  assert.equal(puzzlePath('2026-10-04-mini'), 'puzzles/2026-10-04-mini.json');
  assert.equal(puzzlePath('claude-2026-10-04-mini'), 'puzzles/claude/claude-2026-10-04-mini.json');
  assert.equal(puzzlePath('claude-2026-10-04'), 'puzzles/claude/claude-2026-10-04.json');
  assert.equal(idSeries('claude-2026-10-04'), CLAUDE);
  assert.equal(idSeries('2026-10-04'), MAIN);
  assert.equal(archiveHref(MAIN), '#/archive');
  assert.equal(archiveHref(CLAUDE), '#/archive/claude');
});

test('entries of Claude’s index have Claude ids; main entries keep theirs', () => {
  assert.equal(entrySeries(claudeIndex.puzzles[0]), CLAUDE);
  assert.equal(entryId({ date: '2026-10-04', kind: 'mini', series: CLAUDE }), 'claude-2026-10-04-mini');
  assert.equal(entryId({ id: 'claude-2026-10-04', date: '2026-10-04', series: CLAUDE }), 'claude-2026-10-04');
  // An entry whose id disagrees with its series is rebuilt from date + kind + series.
  assert.equal(entryId({ id: '2026-10-04', date: '2026-10-04', series: CLAUDE }), 'claude-2026-10-04');
  assert.equal(entryId({ id: 'claude-2026-10-04', date: '2026-10-04' }), '2026-10-04');
  assert.equal(entryId({ id: '2026-10-04-midi', date: '2026-10-04', kind: 'midi' }), '2026-10-04-midi');
  assert.deepEqual(indexEntries(claudeIndex).map(entryId), [
    'claude-2026-10-04-mini', 'claude-2026-10-04-midi', 'claude-2026-10-04',
    'claude-2026-10-05-mini', 'claude-2026-10-05-midi', 'claude-2026-10-05', 'claude-2026-10-07-mini',
  ]);
});

test('today’s Claude set, the latest one, lookups by id and the late-deploy signature', () => {
  const today = pickToday(claudeIndex, '2026-10-05');
  assert.equal(today.isToday, true);
  assert.deepEqual(today.entries.map(entryId), ['claude-2026-10-05-mini', 'claude-2026-10-05-midi', 'claude-2026-10-05']);
  const latest = pickToday(claudeIndex, '2026-10-06');
  assert.equal(latest.date, '2026-10-05');
  assert.equal(latest.isToday, false);
  assert.deepEqual(pickToday({ puzzles: [] }, '2026-10-06'), { date: null, entries: [], isToday: false, nextDate: null });

  assert.equal(findEntry(claudeIndex, 'claude-2026-10-04-midi').number, 1);
  assert.equal(findEntry(claudeIndex, 'claude-2026-10-05').kind, 'daily');
  assert.equal(findEntry(claudeIndex, '2026-10-05'), null); // a main id is never found in Claude's index
  assert.equal(findEntry(claudeIndex, 'claude-2026-10-06'), null);
  assert.equal(findEntry({ puzzles: [{ id: '2026-10-05', date: '2026-10-05', number: 1 }] }, 'claude-2026-10-05'), null);
  assert.equal(entriesOn(claudeIndex, '2026-10-04').length, 3);
  assert.deepEqual(releasedPuzzles(claudeIndex, '2026-10-05').map(entryId).slice(0, 3),
    ['claude-2026-10-05-mini', 'claude-2026-10-05-midi', 'claude-2026-10-05']);

  const before = todaySignature({ puzzles: claudeIndex.puzzles.filter((p) => p.date !== '2026-10-05') }, '2026-10-05');
  assert.notEqual(before, todaySignature(claudeIndex, '2026-10-05'));
});

test('routes: Claude puzzle ids and Claude’s archive; main routes keep their shape', () => {
  assert.deepEqual(parseRoute('#/puzzle/claude-2026-10-05-mini'),
    { name: 'puzzle', id: 'claude-2026-10-05-mini', date: '2026-10-05', kind: 'mini', series: CLAUDE });
  assert.deepEqual(parseRoute('#/puzzle/claude-2026-10-05/'),
    { name: 'puzzle', id: 'claude-2026-10-05', date: '2026-10-05', kind: 'daily', series: CLAUDE });
  assert.deepEqual(parseRoute('#/puzzle/2026-10-05'), { name: 'puzzle', id: '2026-10-05', date: '2026-10-05', kind: 'daily' });
  assert.deepEqual(parseRoute('#/archive/claude'), { name: 'archive', series: CLAUDE });
  assert.deepEqual(parseRoute('#/archive/claude/'), { name: 'archive', series: CLAUDE });
  assert.deepEqual(parseRoute('#/archive'), { name: 'archive' });
  for (const bad of ['#/archive/claudes', '#/archive/main', '#/puzzle/claude-claude-2026-10-05', '#/puzzle/claude-2026-10-05-maxi',
    '#/puzzle/claude-2026-02-30', '#/puzzle/claude-', '#/puzzle/robot-2026-10-05']) {
    assert.deepEqual(parseRoute(bad), { name: 'today', unknown: true }, bad);
  }
  assert.equal(routeSeries(parseRoute('#/puzzle/claude-2026-10-05')), CLAUDE);
  assert.equal(routeSeries(parseRoute('#/archive/claude')), CLAUDE);
  assert.equal(routeSeries(parseRoute('#/puzzle/2026-10-05')), MAIN);
  assert.equal(routeSeries(parseRoute('#/')), MAIN);
});

/** Run `fn` with a fake fetch that answers from `files` (path -> JSON value, or a Response). */
async function withFetch(files, fn) {
  const requested = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requested.push(url);
    const v = files[url];
    if (v instanceof Response) return v;
    if (v === undefined) return new Response('Not found', { status: 404 });
    return new Response(JSON.stringify(v), { status: 200 });
  };
  try {
    await fn(requested);
  } finally {
    globalThis.fetch = original;
  }
}

test('loadIndex: Claude’s index is separate, optional (404 = none) and its entries are tagged', async () => {
  await withFetch({}, async (requested) => {
    assert.deepEqual(await loadIndex(CLAUDE), { format: 'crossword-index/1', puzzles: [] });
    assert.deepEqual(requested, ['puzzles/claude/index.json']);
  });
  const untagged = { format: 'crossword-index/1', puzzles: [{ id: 'claude-2026-10-05-mini', date: '2026-10-05', kind: 'mini', number: 1 }] };
  const main = { format: 'crossword-index/1', puzzles: [{ id: '2026-10-05', date: '2026-10-05', kind: 'daily', number: 1 }] };
  await withFetch({ 'puzzles/claude/index.json': untagged, 'puzzles/index.json': main }, async () => {
    const idx = await loadIndex(CLAUDE);
    assert.equal(idx.puzzles[0].series, CLAUDE);
    assert.equal(entryId(idx.puzzles[0]), 'claude-2026-10-05-mini');
    assert.deepEqual(await loadIndex(), main); // the user's index is returned as it is
  });
  await withFetch({ 'puzzles/claude/index.json': { nope: true } }, async () => {
    await assert.rejects(loadIndex(CLAUDE), (err) => err instanceof LoadError && err.kind === 'bad-json');
  });
  await withFetch({ 'puzzles/claude/index.json': new Response('oops', { status: 500 }) }, async () => {
    await assert.rejects(loadIndex(CLAUDE), (err) => err instanceof LoadError && err.kind === 'http');
  });
});

function claudeMini(date = '2026-10-05') {
  const draft = makeDraft({ id: 'unit-claude', width: 3, height: 3, title: 'Unit Mini', author: 'Claude', date, kind: 'mini', series: CLAUDE });
  draft.cells = 'SPAOARBYE'.split('');
  draft.clues = { SPA: 'Mud bath place', OAR: 'Rowing blade', BYE: 'See you!', SOB: 'Cry', PAY: 'Wages', ARE: 'Exist' };
  const { puzzle, errors } = draftToPuzzle(draft);
  assert.deepEqual(errors, []);
  return puzzle;
}

test('loadPuzzleFile reads Claude puzzles from puzzles/claude/ and checks the file is the one asked for', async () => {
  const p = claudeMini();
  assert.equal(p.id, 'claude-2026-10-05-mini');
  await withFetch({ 'puzzles/claude/claude-2026-10-05-mini.json': p }, async (requested) => {
    assert.equal((await loadPuzzleFile('claude-2026-10-05-mini')).title, 'Unit Mini');
    assert.deepEqual(requested, ['puzzles/claude/claude-2026-10-05-mini.json']);
  });
  // The same file under another Claude id is damaged, not silently another puzzle.
  await withFetch({ 'puzzles/claude/claude-2026-10-06-mini.json': p }, async () => {
    await assert.rejects(loadPuzzleFile('claude-2026-10-06-mini'), (err) => err.kind === 'invalid');
  });
  await withFetch({}, async () => {
    await assert.rejects(loadPuzzleFile('claude-2026-10-07-mini'), (err) => err.kind === 'not-found');
  });
  // buildIndex of Claude's puzzles numbers them on their own.
  const idx = buildIndex([claudeMini('2026-10-04'), p]);
  assert.deepEqual(idx.puzzles.map((e) => [entryId(e), e.number]), [['claude-2026-10-04-mini', 1], ['claude-2026-10-05-mini', 2]]);
});

test('share text: the series label instead of the site name (SPEC §9)', () => {
  const base = { siteName: CLAUDE_LABEL, date: '2026-10-05', elapsedMs: 61_000, gridRows: null, url: '' };
  assert.equal(buildShareText({ ...base, number: 3, kind: 'mini' }).split('\n')[0], "🧩 Claude's way Mini #3 · Mon, Oct 5");
  assert.equal(buildShareText({ ...base, number: 3, kind: 'midi' }).split('\n')[0], "🧩 Claude's way Midi #3 · Mon, Oct 5");
  assert.equal(buildShareText({ ...base, number: 3, kind: 'daily' }).split('\n')[0], "🧩 Claude's way #3 · Mon, Oct 5");
});
