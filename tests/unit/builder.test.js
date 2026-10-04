// Builder logic that does not need a browser: draft helpers (builder/js/draft-utils.js), the autosaving draft
// store (builder/js/store.js) against a real dev server on a temp root, and small view helpers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createServer } from '../../scripts/server.mjs';
import { draftEntries, draftToPuzzle, makeDraft } from '../../site/shared/puzzle.js';
import {
  LONG_CLUE_CHARS, autoClueCount, cluedWordsRefillWouldReplace, draftFingerprint, fillMissingClues, hasUnpublishedChanges,
  isLongClue, longClues, parseThemeText, puzzleFingerprint, staleThemeClues, syncThemeClues, themeCapacity, undoFilledClues,
} from '../../builder/js/draft-utils.js';
import {
  RECENT_PENALTY, RecentAnswers, nearestDate, recentPenalties, recentRepeats, shortDate, usedLabel, usedSentence,
} from '../../builder/js/recent-answers.js';
import { DraftStore } from '../../builder/js/store.js';
import { siteUrlFor } from '../../builder/js/preview.js';
import { parseScore } from '../../builder/js/views/wordlist.js';
import { previewPuzzle } from '../../builder/js/draft-utils.js';
import {
  draftKind, draftPuzzleId, entryId, idDate, numberLabel, parsePuzzleId, predictedNumber, puzzleId, recordedPuzzleId,
  renumberedBy, sortPuzzles, suggestKind, takenDatesForKind,
} from '../../builder/js/kinds.js';
import { validatePuzzle } from '../../site/shared/puzzle.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sample = JSON.parse(await fsp.readFile(path.join(REPO, 'tests', 'fixtures', 'sample-draft.json'), 'utf8'));
const clone = (x) => structuredClone(x);

// ---------------------------------------------------------------------------
// Theme clues follow the theme list (finding: an edited "| clue" was not used, the old one got published)

test('syncThemeClues: clues copied from the theme list follow edits of it; your own clues never change', () => {
  const d = makeDraft({ id: 't', width: 5 });
  const typed = (text) => parseThemeText(text, { width: 5, height: 5 }).theme;
  d.theme = typed('Pizza | Pie with toppings\nPasta | Penne or ziti');
  d.clues = { PIZZA: 'Pie with toppings', PASTA: 'My own pasta clue' };
  d.clueSources = { PIZZA: 'theme', PASTA: 'user' };

  d.theme = typed('Pizza | Neapolitan pie\nPasta | Noodles');
  assert.deepEqual(syncThemeClues(d), ['PIZZA']);
  assert.equal(d.clues.PIZZA, 'Neapolitan pie');
  assert.equal(d.clues.PASTA, 'My own pasta clue');

  // Mid-typing ("Pizza |") the theme clue is empty: the clue goes, but it comes back as the user types on.
  d.theme = typed('Pizza |\nPasta');
  syncThemeClues(d);
  assert.equal(d.clues.PIZZA, undefined);
  assert.equal(d.clueSources.PIZZA, 'theme');
  d.theme = typed('Pizza | Naples pie\nPasta');
  syncThemeClues(d);
  assert.equal(d.clues.PIZZA, 'Naples pie');
  assert.deepEqual(syncThemeClues(d), []);
});

test('staleThemeClues reports theme-sourced clues that differ from the theme list', () => {
  const d = clone(sample);
  const answer = draftEntries(d).across[0].answer;
  d.theme = [{ answer, clue: 'From the theme list', raw: answer }];
  d.clueSources = { [answer]: 'theme' };
  assert.deepEqual(staleThemeClues(d), [{ answer, clue: d.clues[answer], themeClue: 'From the theme list' }]);
  d.clues[answer] = 'From the theme list';
  assert.deepEqual(staleThemeClues(d), []);
  d.clueSources[answer] = 'user';
  d.clues[answer] = 'Mine';
  assert.deepEqual(staleThemeClues(d), []);
});

// ---------------------------------------------------------------------------
// "Suggest all missing" + Undo (finding: Undo also deleted clues typed afterwards)

test('undoFilledClues only removes the suggestions themselves, never clues typed or reviewed afterwards', () => {
  const d = clone(sample);
  const { all } = draftEntries(d);
  const [a, b, c] = all.map((e) => e.answer);
  d.clues = { [c]: 'Already there' };
  d.clueSources = { [c]: 'user' };
  const { filled, none } = fillMissingClues(d, all, (answer) => (answer === b ? null : { clue: `Suggested ${answer}`, source: 'curated' }));
  assert.equal(none, 1);
  assert.equal(filled.length, all.length - 2);
  assert.equal(d.clues[a], `Suggested ${a}`);
  assert.equal(d.clueSources[a], 'auto');
  assert.equal(d.clues[c], 'Already there');

  // During the toast: the user writes the clue that had no suggestion, rewrites one suggestion, reviews another.
  d.clues[b] = 'Typed for b';
  d.clueSources[b] = 'user';
  d.clues[a] = 'Rewritten a';
  d.clueSources[a] = 'user';
  const reviewed = all[3].answer;
  d.clueSources[reviewed] = 'user';

  const removed = undoFilledClues(d, filled);
  assert.equal(removed, filled.length - 2);
  assert.equal(d.clues[a], 'Rewritten a');
  assert.equal(d.clues[b], 'Typed for b');
  assert.equal(d.clues[c], 'Already there');
  assert.equal(d.clues[reviewed], `Suggested ${reviewed}`);
  for (const e of all.slice(4)) {
    if (e.answer === b || e.answer === c) continue;
    assert.equal(d.clues[e.answer], undefined, e.answer);
    assert.equal(d.clueSources[e.answer], undefined, e.answer);
  }
});

// ---------------------------------------------------------------------------
// Refill (finding: it silently replaced clued words; Review counted clues of words no longer in the grid)

test('autoClueCount ignores clues of words that are no longer in the grid', () => {
  const d = clone(sample);
  const answer = draftEntries(d).across[0].answer;
  d.clueSources = { [answer]: 'auto', GONEWORD: 'auto', OTHERGONE: 'auto' };
  d.clues = { ...d.clues, GONEWORD: 'Orphan', OTHERGONE: 'Orphan 2' };
  assert.equal(autoClueCount(d), 1);
});

test('cluedWordsRefillWouldReplace lists clued words that have unlocked letters', () => {
  const d = clone(sample);
  const { all } = draftEntries(d);
  d.locked = [];
  assert.equal(cluedWordsRefillWouldReplace(d).length, new Set(all.map((e) => e.answer)).size);
  d.locked = d.cells.map((c, i) => (c === '#' ? -1 : i)).filter((i) => i >= 0);
  assert.deepEqual(cluedWordsRefillWouldReplace(d), []);
  d.clues = {};
  d.locked = [];
  assert.deepEqual(cluedWordsRefillWouldReplace(d), []);
});

// ---------------------------------------------------------------------------
// Publish state (finding: edits after publishing looked live)

test('hasUnpublishedChanges compares the draft with the fingerprint recorded at publish time', () => {
  const d = clone(sample);
  const { puzzle } = draftToPuzzle(d);
  assert.equal(hasUnpublishedChanges(d), false); // nothing recorded: unknown, no warning
  d.publishedFingerprint = puzzleFingerprint({ ...puzzle, publishedAt: '2026-10-01T00:00:00.000Z' });
  assert.equal(d.publishedFingerprint, draftFingerprint(d));
  assert.equal(hasUnpublishedChanges(d), false);
  // Autosave-only fields (theme text, sources, timestamps) are not "changes to the puzzle".
  d.themeText = 'whatever';
  d.updatedAt = 'later';
  assert.equal(hasUnpublishedChanges(d), false);
  const answer = draftEntries(d).across[0].answer;
  d.clues[answer] = 'In progress';
  assert.equal(hasUnpublishedChanges(d), true);
  d.clues[answer] = '';
  assert.equal(hasUnpublishedChanges(d), true); // not even publishable any more
});

test('siteUrlFor opens scheduled puzzles in preview mode (they are locked for solvers)', () => {
  assert.equal(siteUrlFor('2026-10-02', '2026-10-02'), '/site/#/puzzle/2026-10-02');
  assert.equal(siteUrlFor('2026-09-01', '2026-10-02'), '/site/#/puzzle/2026-09-01');
  assert.equal(siteUrlFor('2026-10-05', '2026-10-02'), '/site/index.html?preview=1#/puzzle/2026-10-05');
});

test('parseScore keeps 0 ("never") and rejects empty / invalid input instead of substituting 60', () => {
  assert.equal(parseScore('0'), 0);
  assert.equal(parseScore(' 75 '), 75);
  assert.equal(parseScore('49.6'), 50);
  for (const bad of ['', '  ', 'abc', '-1', '101', null, undefined]) assert.equal(parseScore(bad), null, String(bad));
});

// ---------------------------------------------------------------------------
// The autosaving store with two "tabs" on one draft (finding: silent overwrites, a deleted draft came back)

let root;
let server;
let base;
const realFetch = globalThis.fetch;

before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'xw-builder-test-'));
  await fsp.mkdir(path.join(root, 'drafts'), { recursive: true });
  await fsp.mkdir(path.join(root, 'site', 'puzzles'), { recursive: true });
  server = createServer({ root });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  // builder/js/api.js uses page-relative URLs.
  globalThis.fetch = (url, init) => realFetch(typeof url === 'string' && url.startsWith('/') ? base + url : url, init);
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
  await fsp.rm(root, { recursive: true, force: true });
});

const onDisk = async (id) => JSON.parse(await fsp.readFile(path.join(root, 'drafts', `${id}.json`), 'utf8'));
const getDraft = async (id) => (await realFetch(`${base}/api/drafts/${id}`)).json();

test('a stale tab cannot overwrite newer work: it reports a conflict and keeps its edits', async () => {
  await realFetch(`${base}/api/drafts/two-tabs`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(clone({ ...sample, id: 'two-tabs' })) });
  const tabA = new DraftStore();
  const tabB = new DraftStore();
  tabA.load(await getDraft('two-tabs'));
  tabB.load(await getDraft('two-tabs'));
  const conflicts = [];
  tabB.addEventListener('conflict', (e) => conflicts.push(e.detail));

  tabA.update((d) => { d.note = 'Grab a cup and enjoy!'; });
  await tabA.flush();
  assert.equal(tabA.status, 'saved');
  assert.equal((await onDisk('two-tabs')).note, 'Grab a cup and enjoy!');

  const answer = draftEntries(sample).across[0].answer;
  tabB.update((d) => { d.clues[answer] = 'Shivering sound'; }, { kind: 'clues' });
  await assert.rejects(() => tabB.flush(), (err) => err.status === 409);
  assert.equal(tabB.status, 'conflict');
  assert.deepEqual(conflicts.map((c) => c.kind), ['changed']);
  // Nothing was overwritten, and tab B still has its edit.
  assert.equal((await onDisk('two-tabs')).note, 'Grab a cup and enjoy!');
  assert.equal(tabB.draft.clues[answer], 'Shivering sound');
  assert.equal(tabB.hasUnsaved, true);
  // Further edits wait for the user's decision instead of retrying into the other version.
  tabB.update((d) => { d.title = 'B title'; });
  assert.equal(tabB.status, 'conflict');

  // "Keep my version" overwrites deliberately; afterwards autosave works normally again.
  await tabB.overwrite();
  assert.equal(tabB.status, 'saved');
  let disk = await onDisk('two-tabs');
  assert.equal(disk.clues[answer], 'Shivering sound');
  assert.equal(disk.title, 'B title');

  // Tab A is stale now. "Load the other version" = load what is on disk.
  tabA.update((d) => { d.author = 'A again'; });
  await assert.rejects(() => tabA.flush(), (err) => err.status === 409);
  tabA.load(await getDraft('two-tabs'));
  assert.equal(tabA.status, 'saved');
  assert.equal(tabA.draft.title, 'B title');
  tabA.update((d) => { d.author = 'A after reload'; });
  await tabA.flush();
  disk = await onDisk('two-tabs');
  assert.equal(disk.author, 'A after reload');
  assert.equal(disk.clues[answer], 'Shivering sound');
});

test('a draft deleted in another tab is not brought back by a stale tab\'s autosave', async () => {
  await realFetch(`${base}/api/drafts/deleted-elsewhere`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(clone({ ...sample, id: 'deleted-elsewhere' })) });
  const tab = new DraftStore();
  tab.load(await getDraft('deleted-elsewhere'));
  assert.equal((await realFetch(`${base}/api/drafts/deleted-elsewhere`, { method: 'DELETE' })).status, 200);
  tab.update((d) => { d.title = 'Edited in the stale tab'; });
  await assert.rejects(() => tab.flush());
  assert.equal(tab.status, 'conflict');
  assert.equal(tab.conflict.kind, 'deleted');
  assert.equal((await realFetch(`${base}/api/drafts/deleted-elsewhere`)).status, 404);
  // Only an explicit "Restore it with my edits" recreates it.
  await tab.overwrite();
  assert.equal((await onDisk('deleted-elsewhere')).title, 'Edited in the stale tab');
});

test('saves from one tab keep working one after another (the version moves along)', async () => {
  await realFetch(`${base}/api/drafts/one-tab`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(clone({ ...sample, id: 'one-tab' })) });
  const tab = new DraftStore();
  tab.load(await getDraft('one-tab'));
  for (let i = 0; i < 5; i++) {
    tab.update((d) => { d.title = `Title ${i}`; });
    await tab.flush();
    assert.equal(tab.status, 'saved');
  }
  assert.equal((await onDisk('one-tab')).title, 'Title 4');
  assert.equal(tab.baseVersion, (await onDisk('one-tab')).updatedAt);
  assert.equal(tab.clean, true);
});

// ---------------------------------------------------------------------------
// Answer freshness (recent answers), theme capacity, long clues

test('recentPenalties: every recent answer except the theme answers, at the same number of points', () => {
  const recent = new Map([['ERA', ['2026-09-28']], ['PIZZA', ['2026-10-05']], ['ONE', ['2026-09-20', '2026-10-01']]]);
  assert.deepEqual(recentPenalties(recent, ['PIZZA']), { ERA: RECENT_PENALTY, ONE: RECENT_PENALTY });
  assert.deepEqual(recentPenalties(recent, [], 10), { ERA: 10, PIZZA: 10, ONE: 10 });
  assert.equal(recentPenalties(new Map([['PIZZA', ['2026-10-05']]]), ['PIZZA']), null);
  assert.equal(recentPenalties(new Map()), null);
  assert.equal(recentPenalties(null), null);
});

test('recentRepeats lists the grid answers a recent puzzle used (theme answers marked), in clue order', () => {
  const d = clone(sample);
  const { all } = draftEntries(d);
  const [first, second] = [all[0].answer, all.at(-1).answer];
  d.theme = [{ answer: second, clue: '', raw: second }];
  const recent = new Map([[second, ['2026-10-05']], [first, ['2026-09-28', '2026-10-01']], ['NOTHERE', ['2026-10-01']]]);
  const repeats = recentRepeats(d, recent);
  assert.deepEqual(repeats.map((r) => [r.answer, r.dates, r.entries.map((e) => e.id), r.theme]), [
    [first, ['2026-09-28', '2026-10-01'], [all[0].id], false],
    [second, ['2026-10-05'], [all.at(-1).id], true],
  ]);
  assert.deepEqual(recentRepeats(d, null), []);
  // Unfinished words are not answers yet.
  d.cells[all[0].cells[0]] = '';
  assert.ok(!recentRepeats(d, recent).some((r) => r.answer === first));
});

test('used-recently labels: nearest date to the draft, short dates, the year only when it differs', () => {
  assert.equal(shortDate('2026-10-01'), 'Oct 1');
  assert.equal(shortDate('2026-12-28', '2027-01-04'), 'Dec 28, 2026');
  assert.equal(nearestDate(['2026-09-01', '2026-10-01', '2026-10-30'], '2026-10-03'), '2026-10-01');
  assert.equal(nearestDate(['2026-10-01', '2026-10-05'], '2026-10-03'), '2026-10-01'); // a tie: the earlier one
  assert.equal(usedLabel(['2026-10-01'], '2026-10-03'), 'used Oct 1');
  assert.equal(usedLabel(['2026-09-01', '2026-10-05'], '2026-10-03'), 'used Oct 5 +1');
  assert.equal(usedSentence(['2026-09-28'], '2026-10-03'), 'Used in the puzzle of Sep 28');
  assert.equal(usedSentence(['2026-09-28', '2026-10-01', '2026-10-05'], '2026-10-03'), 'Used in the puzzles of Sep 28, Oct 1 and Oct 5');
});

test('themeCapacity: what a generated grid typically holds', () => {
  assert.deepEqual(themeCapacity(5, 5), { min: 1, max: 2, text: '1–2' });
  assert.deepEqual(themeCapacity(9, 9), { min: 2, max: 3, text: '2–3' });
  assert.deepEqual(themeCapacity(15, 15), { min: 3, max: 5, text: '3–5' });
  assert.equal(themeCapacity(7, 7).text, '1–2');
  assert.equal(themeCapacity(11, 11).text, '3–4');
  assert.equal(themeCapacity(21, 21).text, '3–5');
});

test('long clues: more than 80 characters (after normalising) may wrap on small phones', () => {
  assert.equal(LONG_CLUE_CHARS, 80);
  assert.equal(isLongClue('x'.repeat(80)), false);
  assert.equal(isLongClue(`  ${'x'.repeat(80)}  `), false);
  assert.equal(isLongClue('x'.repeat(81)), true);
  const d = clone(sample);
  const { all } = draftEntries(d);
  d.clues[all[1].answer] = 'y'.repeat(90);
  assert.deepEqual(longClues(d), [{ id: all[1].id, answer: all[1].answer, length: 90 }]);
});

test('RecentAnswers loads from the dev server, caches per date and window, and starts over after invalidate()', async () => {
  for (const date of ['2029-05-01', '2029-05-20']) {
    const res = await realFetch(`${base}/api/publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: { ...clone(sample), date } }),
    });
    assert.equal(res.status, 200, await res.text());
  }
  const answer = draftEntries(sample).across[0].answer;
  const recent = new RecentAnswers();
  const loaded = [];
  recent.addEventListener('loaded', (e) => loaded.push(e.detail));
  assert.equal(recent.get('2029-05-10', 30), null); // not loaded yet: starts loading
  const map = await recent.load('2029-05-10', 30);
  assert.deepEqual(map.get(answer), ['2029-05-01', '2029-05-20']);
  assert.equal(recent.get('2029-05-10', 30), map); // cached
  assert.deepEqual(loaded, [{ date: '2029-05-10', days: 30, kind: 'daily' }]);
  assert.deepEqual((await recent.load('2029-05-10', 5)).size, 0);
  assert.deepEqual((await recent.load('2029-05-20', 30)).get(answer), ['2029-05-01']); // its own date is left out
  // Invalid input never throws or asks the server.
  assert.equal(recent.get('', 30), null);
  assert.equal((await recent.load('2029-02-30', 30)).size, 0);

  await realFetch(`${base}/api/published/2029-05-01`, { method: 'DELETE' });
  assert.deepEqual(recent.get('2029-05-10', 30).get(answer), ['2029-05-01', '2029-05-20']); // still the cached copy
  recent.invalidate();
  assert.deepEqual((await recent.load('2029-05-10', 30)).get(answer), ['2029-05-20']);
  await realFetch(`${base}/api/published/2029-05-20`, { method: 'DELETE' });
});

test('RecentAnswers degrades to "nothing recent" when the server cannot answer', async () => {
  const recent = new RecentAnswers();
  const warn = console.warn;
  console.warn = () => {};
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Unknown API endpoint' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  try {
    const map = await recent.load('2029-05-10', 30);
    assert.equal(map.size, 0);
    assert.equal(recent.get('2029-05-10', 30).size, 0);
  } finally {
    globalThis.fetch = saved;
    console.warn = warn;
  }
});

// ---------------------------------------------------------------------------
// SPEC §8: several puzzles per day (Mini / Midi / Daily)

test('kinds: ids, labels, the size default and what a draft publishes to', () => {
  assert.equal(puzzleId('2026-10-05', 'daily'), '2026-10-05');
  assert.equal(puzzleId('2026-10-05', 'mini'), '2026-10-05-mini');
  assert.deepEqual(parsePuzzleId('2026-10-05-midi'), { date: '2026-10-05', kind: 'midi', series: 'main' });
  assert.deepEqual(parsePuzzleId('2026-10-05'), { date: '2026-10-05', kind: 'daily', series: 'main' });
  // SPEC §9: Claude's way ids parse too (the builder itself only ever publishes main-series ids).
  assert.deepEqual(parsePuzzleId('claude-2026-10-05-mini'), { date: '2026-10-05', kind: 'mini', series: 'claude' });
  assert.equal(idDate('claude-2026-10-05'), '2026-10-05');
  assert.equal(parsePuzzleId('2026-10-05-maxi'), null);
  assert.equal(idDate('2026-10-05-mini'), '2026-10-05');
  assert.equal(suggestKind(5, 5), 'mini');
  assert.equal(suggestKind(7, 7), 'mini');
  assert.equal(suggestKind(9, 9), 'midi');
  assert.equal(suggestKind(11, 11), 'midi');
  assert.equal(suggestKind(15, 15), 'daily');
  assert.equal(numberLabel({ kind: 'daily', number: 2 }), '#2');
  assert.equal(numberLabel({ number: 2 }), '#2'); // old index entries: dailies
  assert.equal(numberLabel({ kind: 'mini', number: 1 }), 'Mini #1');
  // Drafts made before kinds existed are dailies and keep their id.
  assert.equal(draftKind({}), 'daily');
  assert.equal(draftPuzzleId({ date: '2026-10-03' }), '2026-10-03');
  assert.equal(draftPuzzleId({ date: '2026-10-03', kind: 'midi' }), '2026-10-03-midi');
  assert.equal(draftPuzzleId({ date: '' , kind: 'mini' }), null);
  assert.equal(entryId({ date: '2026-10-03', number: 1 }), '2026-10-03');
  assert.equal(entryId({ id: '2026-10-03-mini', date: '2026-10-03', kind: 'mini' }), '2026-10-03-mini');
  // Where it was published: the recorded id, else (older drafts) the daily of publishedDate.
  assert.equal(recordedPuzzleId({ publishedDate: '2026-10-03', kind: 'mini' }), '2026-10-03');
  assert.equal(recordedPuzzleId({ publishedDate: '2026-10-03', publishedId: '2026-10-03-mini' }), '2026-10-03-mini');
  assert.equal(recordedPuzzleId({}), null);
});

test('kinds: next free date, numbering and order are per kind', () => {
  const published = [
    { id: '2026-10-03', date: '2026-10-03', number: 1 }, // an old entry without kind = daily
    { id: '2026-10-04-mini', date: '2026-10-04', kind: 'mini', number: 1 },
    { id: '2026-10-04', date: '2026-10-04', kind: 'daily', number: 2 },
    { id: '2026-10-06-mini', date: '2026-10-06', kind: 'mini', number: 2 },
  ];
  const drafts = [{ id: 'a', date: '2026-10-05', kind: 'mini' }, { id: 'b', date: '2026-10-05' }];
  assert.deepEqual([...takenDatesForKind('mini', { published, drafts })].sort(), ['2026-10-04', '2026-10-05', '2026-10-06']);
  assert.deepEqual([...takenDatesForKind('daily', { published, drafts })].sort(), ['2026-10-03', '2026-10-04', '2026-10-05']);
  assert.deepEqual([...takenDatesForKind('daily', { published, drafts, exceptDraft: 'b' })].sort(), ['2026-10-03', '2026-10-04']);
  assert.deepEqual([...takenDatesForKind('midi', { published, drafts })], []);
  assert.equal(predictedNumber(published, '2026-10-05', 'mini'), 2);
  assert.equal(predictedNumber(published, '2026-10-05', 'daily'), 3);
  assert.equal(predictedNumber(published, '2026-10-04', 'mini'), 1); // already there
  assert.equal(predictedNumber(published, '2026-10-01', 'midi'), 1);
  assert.equal(renumberedBy(published, '2026-10-05', 'mini'), 1);
  assert.equal(renumberedBy(published, '2026-10-05', 'daily'), 0);
  assert.equal(renumberedBy(published, '2026-10-04', 'mini'), 0); // replacing does not shift
  assert.deepEqual(sortPuzzles(published).map((p) => p.id), ['2026-10-03', '2026-10-04-mini', '2026-10-04', '2026-10-06-mini']);
  assert.deepEqual(sortPuzzles(published, { descending: true }).map((p) => p.id), ['2026-10-06-mini', '2026-10-04-mini', '2026-10-04', '2026-10-03']);
});

test('siteUrlFor takes puzzle ids: a Mini of today is open, a later one is a preview', () => {
  assert.equal(siteUrlFor('2026-10-02-mini', '2026-10-02'), '/site/#/puzzle/2026-10-02-mini');
  assert.equal(siteUrlFor('2026-10-03-midi', '2026-10-02'), '/site/index.html?preview=1#/puzzle/2026-10-03-midi');
});

test('the preview puzzle carries the kind and publishes to the same id (finished or not)', () => {
  const mini = { ...clone(sample), kind: 'mini' };
  const done = previewPuzzle(mini, '2026-10-04').puzzle;
  assert.equal(done.id, `${sample.date}-mini`);
  assert.equal(done.kind, 'mini');
  assert.deepEqual(validatePuzzle(done).errors ?? [], []);
  // Unfinished: the lenient conversion uses the same id and solution salt.
  const rough = { ...clone(sample), kind: 'midi', date: '' };
  rough.cells = rough.cells.map((c, i) => (i === rough.cells.findIndex((x) => x !== '#') ? '' : c));
  const { puzzle } = previewPuzzle(rough, '2026-10-04');
  assert.equal(puzzle.id, '2026-10-04-midi');
  assert.equal(puzzle.kind, 'midi');
  assert.equal(validatePuzzle(puzzle).ok, true);
  assert.equal(previewPuzzle(rough, '2026-10-04').puzzle.date, '2026-10-04');
  // A daily is unchanged: id = date, no kind field.
  const daily = previewPuzzle(clone(sample), '2026-10-04').puzzle;
  assert.equal(daily.id, sample.date);
  assert.equal('kind' in daily, false);
});

test('recent answers per kind: the same day\'s other kinds count, the puzzle itself does not', async () => {
  const date = '2029-07-01';
  for (const kind of ['mini', 'daily']) {
    const res = await realFetch(`${base}/api/publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: { ...clone(sample), date, kind } }),
    });
    assert.equal(res.status, 200, await res.text());
  }
  const answer = draftEntries(sample).across[0].answer;
  const recent = new RecentAnswers();
  // The daily of that day sees the mini's answers (and vice versa); a midi sees both.
  assert.ok((await recent.load(date, 7, 'daily')).has(answer));
  assert.ok((await recent.load(date, 7, 'mini')).has(answer));
  assert.ok((await recent.load(date, 7, 'midi')).has(answer));
  assert.equal(shortDate('2029-07-01-mini', '2029-07-03'), 'Jul 1 Mini');
  assert.equal(shortDate('2029-07-01', '2029-07-03'), 'Jul 1');
  for (const id of [`${date}-mini`, date]) await realFetch(`${base}/api/published/${id}`, { method: 'DELETE' });
  recent.invalidate();
  assert.equal((await recent.load(date, 7, 'daily')).size, 0);
});
