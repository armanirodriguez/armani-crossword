// The builder (SPEC §4–5), against the temp root — publishing writes to the copy, never to the real site/puzzles.
//   1. UI smoke test: theme words → generated layout → fill → clues → publish → schedule → player.
//   2. API test: save a 15×15 draft, publish it (with the 422 / 409 / overwrite paths), check the files the player
//      reads, play it in the player, then unpublish it.
//
// Both publish into the shared index, so they run one after the other in a single worker (puzzle numbers are by
// date: neither can then change a number the other one is asserting).

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { draftEntries, loadPuzzle, makeDraft, validatePuzzle } from '../../site/shared/puzzle.js';
import { Player, captureShares, noonUTC } from './support/player.js';
import { FIXTURES } from './support/root.js';

test.describe.configure({ mode: 'default' });

// Fixed far-future release dates keep the tests independent of the real date and of the fixture puzzles (three
// fixture puzzles are dated before RELEASE, so it becomes #4).
const RELEASE = '2030-06-15'; // the UI test's puzzle
const DATE = '2031-01-15'; // the API test's puzzle
const TITLE = 'E2E Pasta Night';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/draft-15x15.json', import.meta.url), 'utf8'));
const fifteen = { ...fixture, date: DATE }; // the API test's draft

// Start from the fixture state even when a test is retried or repeated against the same server.
test.beforeEach(async ({ request }) => {
  for (const date of [RELEASE, DATE]) {
    for (const id of [date, `${date}-mini`, `${date}-midi`]) {
      const res = await request.delete(`/api/published/${id}`);
      expect([200, 404]).toContain(res.status());
    }
  }
});

test('build a themed 5×5 (picked as the Daily), publish it, see it scheduled and solve it in the player', async ({ page, browser, baseURL }) => {
  test.setTimeout(150_000);
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') problems.push(`console: ${msg.text()}`); });
  page.on('dialog', (dialog) => { problems.push(`native dialog: ${dialog.message()}`); dialog.dismiss(); });

  // ---- New draft: 5×5
  await page.goto('/builder/');
  await page.getByRole('button', { name: 'New puzzle' }).first().click();
  const dialog = page.locator('.modal-new');
  await dialog.locator('input[name="title"]').fill(TITLE);
  await dialog.locator('label.size-pick', { hasText: '5×5' }).click();
  // A 5×5 suggests a Mini; this one is the day's main puzzle, so pick Daily (SPEC §8: the user chooses).
  await expect(dialog.locator('input[name="kind"][value="mini"]')).toBeChecked();
  await dialog.locator('label.seg-item', { hasText: 'Daily' }).click();
  await dialog.getByRole('button', { name: 'Create puzzle' }).click();
  await expect(page).toHaveURL(/#\/draft\/[a-z0-9-]+\/theme$/);
  const draftId = /#\/draft\/([a-z0-9-]+)\//.exec(page.url())[1];

  // ---- Setup: release date (the kind picked in the dialog stays)
  await page.getByRole('tab', { name: /Setup/ }).click();
  await expect(page.locator('input[name="setup-kind"][value="daily"]')).toBeChecked();
  await expect(page.locator('.ed-chips .chip-kind')).toHaveText('Daily');
  await page.locator('#f-date').fill(RELEASE);
  await expect(page.locator('.date-info')).toContainText('Saturday, June 15, 2030');

  // ---- Theme & Layout: two theme words, generate, use the best layout
  await page.getByRole('tab', { name: /Theme/ }).click();
  await page.locator('.theme-input').fill('Pizza | Cheesy pie\nPasta | Penne or ziti');
  await expect(page.locator('.theme-parsed .answer')).toHaveText(['PIZZA', 'PASTA']);
  await page.locator('select[aria-label="Time budget"]').selectOption('10000');
  const generate = page.getByRole('button', { name: 'Generate layouts' });
  await expect(generate).toBeEnabled({ timeout: 60_000 }); // the fill engine has loaded the word list
  await generate.click();
  const cards = page.locator('.layout-card');
  await expect(cards.first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.theme-gen .progress-line')).toBeHidden({ timeout: 60_000 });
  await expect(cards.first().locator('.lc-title .pill')).toHaveText(/^[12]\/2 theme$/);
  await cards.first().getByRole('button', { name: 'Use this layout' }).click();

  // ---- Grid & Fill: the layout comes filled with the theme letters locked. Clear the rest and autofill it.
  await expect(page).toHaveURL(new RegExp(`#/draft/${draftId}/grid$`));
  const status = page.locator('.grid-statusbar');
  const fillCard = page.locator('.fill-card');
  await expect(status).toContainText(/ · (filled|\d+ empty)/);
  const clearUnlocked = fillCard.getByRole('button', { name: 'Clear unlocked' });
  if (await clearUnlocked.isEnabled()) await clearUnlocked.click(); // (disabled when the layout came unfilled)
  await expect(status).toContainText(/ · \d+ empty/);
  await fillCard.getByRole('button', { name: 'Autofill' }).click();
  await expect(status).toContainText(' · filled', { timeout: 60_000 });
  await expect(fillCard.locator('.note.ok')).toContainText('Filled in');
  await expect(status).toContainText('No issues');
  // At least one theme word is in the grid, locked, with the clue typed after its "|".
  const afterLayout = await page.evaluate(() => window.xwb.store.draft);
  const answers = new Set(draftEntries(afterLayout).all.map((e) => e.answer));
  const placed = afterLayout.theme.filter((t) => answers.has(t.answer));
  expect(placed.length).toBeGreaterThanOrEqual(1);
  for (const t of placed) expect(afterLayout.clues[t.answer]).toBe(t.clue);
  expect(afterLayout.locked.length).toBeGreaterThanOrEqual(5);

  // ---- Clues: suggestions for everything, then hand-write whatever has no suggestion
  await page.getByRole('tab', { name: /Clues/ }).click();
  await expect(page.locator('.clue-row').first()).toBeVisible();
  await page.getByRole('button', { name: 'Suggest all missing' }).click();
  await expect(page.locator('.clue-row[data-status="auto"]').first()).toBeVisible();
  const missing = page.locator('.clue-row[data-status="missing"] .clue-input');
  for (let n = await missing.count(), k = 1; n > 0; n = await missing.count(), k++) {
    await missing.first().fill(`Hand-written clue number ${k}`);
  }
  await expect(page.locator('.clue-row[data-status="missing"]')).toHaveCount(0);
  await expect(page.locator('.clue-row[data-status="contains"]')).toHaveCount(0);
  const themeRow = page.locator('.clue-row', { has: page.locator('.badge.theme') }).first();
  await expect(themeRow.locator('.clue-input')).toHaveValue(/^(Cheesy pie|Penne or ziti)$/);

  // ---- Preview in a new tab: the real player with this draft, marked as a preview
  const [previewTab] = await Promise.all([
    page.context().waitForEvent('page'),
    page.locator('.ed-head').getByRole('button', { name: 'Preview' }).click(),
  ]);
  await expect(previewTab).toHaveURL(/\/site\/index\.html\?preview=1$/);
  await expect(previewTab.locator('.eyebrow')).toHaveText(/^Preview/);
  await expect(previewTab.locator('.intro-title')).toHaveText(TITLE);
  await previewTab.close();

  // ---- Review & Publish
  await page.getByRole('tab', { name: /Review/ }).click();
  await expect(page.locator('.check-list')).toContainText('Ready to publish');
  // The live preview is the real player in an iframe.
  const preview = page.frameLocator('.preview-frame');
  await expect(preview.locator('.eyebrow')).toHaveText(/^Preview/);
  await expect(preview.locator('.intro-title')).toHaveText(TITLE);
  await page.locator('.publish-box').getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.locator('.publish-done')).toContainText('Published as #4 for Jun 15, 2030.', { timeout: 15_000 });

  // The files on (temp) disk: a valid puzzle and an index entry.
  const index = await (await page.request.get('/api/published')).json();
  expect(index.puzzles.find((p) => p.date === RELEASE)).toMatchObject({ id: RELEASE, title: TITLE, number: 4, width: 5, height: 5 });
  const published = await (await page.request.get(`/site/puzzles/${RELEASE}.json`)).json();
  expect(validatePuzzle(published)).toEqual({ ok: true, errors: [] });
  // The draft remembers where it was published (autosaved shortly after publishing).
  const savedDraft = async () => (await page.request.get(`/api/drafts/${draftId}`)).json();
  await expect.poll(async () => (await savedDraft()).publishedDate).toBe(RELEASE);
  const saved = await savedDraft();
  expect(saved).toMatchObject({ date: RELEASE, title: TITLE });

  // ---- Schedule shows it as upcoming
  await page.locator('.publish-done').getByRole('link', { name: 'View schedule' }).click();
  await expect(page.getByRole('heading', { name: 'Schedule', level: 1 })).toBeVisible();
  const row = page.locator('table tr', { hasText: TITLE });
  await expect(row).toHaveCount(1);
  await expect(row.locator('td').nth(1)).toHaveText('Daily');
  await expect(row.locator('td').nth(2)).toHaveText('4');
  await expect(row).toContainText('Jun 15, 2030');
  await expect(row.locator('.pill')).toHaveText('Scheduled');

  // ---- Player: locked the day before, playable on the day
  const solverContext = await browser.newContext({ baseURL, timezoneId: 'UTC', locale: 'en-US', viewport: { width: 1280, height: 800 } });
  try {
    const solverPage = await solverContext.newPage();
    const p = new Player(solverPage, { mobile: false });
    await p.open(`#/puzzle/${RELEASE}`, { date: '2030-06-14' });
    await expect(solverPage.locator('.message-title')).toHaveText('Unlocks on Saturday, June 15, 2030');
    await solverPage.clock.setSystemTime(noonUTC(RELEASE));
    await solverPage.reload();
    await expect(solverPage.locator('.eyebrow')).toHaveText('Today’s puzzle · #4');
    await expect(solverPage.locator('.intro-title')).toHaveText(TITLE);
    await p.play();
    await p.type(saved.cells.filter((c) => c !== '#').join(''));
    await expect(p.solvedModal.locator('.modal-title')).toHaveText('Solved!');
    expect(p.errors).toEqual([]);
  } finally {
    await solverContext.close();
  }

  // ---- Unpublish from the schedule (asks first)
  await row.getByRole('button', { name: 'Unpublish' }).click();
  await page.locator('.modal-confirm').getByRole('button', { name: 'Unpublish' }).click();
  await expect(row).toHaveCount(0);
  const after = await (await page.request.get('/api/published')).json();
  expect(after.puzzles.some((x) => x.date === RELEASE)).toBe(false);
  expect(problems).toEqual([]);
});

// ---------------------------------------------------------------------------- API

test('publish a 15×15 draft through the API and play it', async ({ request, page }) => {
  // Save the draft.
  let res = await request.put(`/api/drafts/${fifteen.id}`, { data: fifteen });
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true });
  const list = await (await request.get('/api/drafts')).json();
  expect(list.find((d) => d.id === fifteen.id)).toMatchObject({ title: 'Fifteen Fixture', date: DATE, width: 15, height: 15 });

  // Not publishable: an empty square and a missing clue are reported, nothing is written.
  const broken = structuredClone(fifteen);
  broken.cells[broken.cells.indexOf('A')] = '';
  res = await request.post('/api/publish', { data: { draft: broken } });
  expect(res.status()).toBe(422);
  expect((await res.json()).errors).toContainEqual(expect.stringMatching(/white cell\(s\) are empty/));
  const unclued = structuredClone(fifteen);
  const firstAnswer = draftEntries(fifteen).across[0].answer;
  delete unclued.clues[firstAnswer];
  res = await request.post('/api/publish', { data: { draft: unclued } });
  expect(res.status()).toBe(422);
  expect((await res.json()).errors).toContain(`1A (${firstAnswer}) needs a clue`);
  expect((await request.get(`/site/puzzles/${DATE}.json`)).status()).toBe(404);

  // Publish.
  res = await request.post('/api/publish', { data: { draft: fifteen } });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, replaced: false, url: `/site/#/puzzle/${DATE}` });
  let index = await (await request.get('/api/published')).json();
  const entry = index.puzzles.find((p) => p.date === DATE);
  expect(entry).toMatchObject({ id: DATE, title: 'Fifteen Fixture', author: 'E2E Bot', width: 15, height: 15 });
  expect(entry.number).toBe(body.number);
  expect(index.puzzles.map((p) => p.number)).toEqual(index.puzzles.map((_, i) => i + 1)); // numbered in date order

  // The published file is what the player loads: valid, and it decodes to the draft's letters and clues.
  const published = await (await request.get(`/site/puzzles/${DATE}.json`)).json();
  expect(validatePuzzle(published)).toEqual({ ok: true, errors: [] });
  expect(published.publishedAt).toEqual(expect.any(String));
  const loaded = loadPuzzle(published);
  expect(loaded.solution.join('')).toBe(fifteen.cells.join(''));
  for (const e of draftEntries(fifteen).all) {
    expect(loaded.all.find((x) => x.id === e.id).clue).toBe(e.clue);
  }
  // Its clues are remembered for future suggestions.
  const userClues = await (await request.get('/api/user-clues')).json();
  expect(userClues[firstAnswer]?.[0]).toBe(fifteen.clues[firstAnswer]);

  // Same date again: 409 unless overwriting.
  res = await request.post('/api/publish', { data: { draft: fifteen } });
  expect(res.status()).toBe(409);
  expect((await res.json()).existing).toMatchObject({ date: DATE, title: 'Fifteen Fixture' });
  res = await request.post('/api/publish', { data: { draft: { ...fifteen, title: 'Fifteen Fixture v2' }, overwrite: true } });
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, replaced: true, number: entry.number });

  // The player shows it on its day: a 15×15 with every clue.
  const p = new Player(page, { mobile: false });
  await p.open(`#/puzzle/${DATE}`, { date: DATE });
  await expect(page.locator('.intro-title')).toHaveText('Fifteen Fixture v2');
  await expect(page.locator('.intro-meta')).toContainText('15×15');
  await p.play();
  await expect(page.locator('.grid .cell')).toHaveCount(225);
  await expect(page.locator('.area-lists .clue')).toHaveCount(loaded.all.length);
  await expect(page.locator('.area-lists .clue[data-id="1A"] .clue-text')).toHaveText(fifteen.clues[firstAnswer]);
  expect(p.errors).toEqual([]);

  // Unpublish: file and index entry are gone.
  res = await request.delete(`/api/published/${DATE}`);
  expect(res.status()).toBe(200);
  index = (await res.json()).index;
  expect(index.puzzles.some((p2) => p2.date === DATE)).toBe(false);
  expect((await request.get(`/site/puzzles/${DATE}.json`)).status()).toBe(404);
  expect((await request.delete(`/api/published/${DATE}`)).status()).toBe(404);
  expect((await request.delete(`/api/drafts/${fifteen.id}`)).status()).toBe(200);
});

// ---------------------------------------------------------------------------- review findings (regressions)
//
// Each test makes its own drafts (ids starting with "e2e-") and removes them, and publishes only on far-future
// dates after RELEASE / DATE, so puzzle numbers asserted above never change.

const sampleDraft = JSON.parse(readFileSync(new URL('../fixtures/sample-draft.json', import.meta.url), 'utf8'));

/** The 5×5 sample draft (fully filled and clued) as a new draft. */
function draftOf(id, overrides = {}) {
  return { ...structuredClone(sampleDraft), id, title: id, date: '', ...overrides };
}

/** A 5×5 draft with PIZZA in the middle row (its clue copied from the theme list) and nothing else. */
function pizzaDraft(id, overrides = {}) {
  const cells = Array(25).fill('');
  'PIZZA'.split('').forEach((ch, k) => { cells[10 + k] = ch; });
  return {
    ...draftOf(id), cells, locked: [10, 11, 12, 13, 14],
    theme: [{ answer: 'PIZZA', clue: 'Pie with toppings', raw: 'Pizza' }], themeText: 'Pizza | Pie with toppings',
    clues: { PIZZA: 'Pie with toppings' }, clueSources: { PIZZA: 'theme' },
    ...overrides,
  };
}

async function putDraft(request, draft) {
  const res = await request.put(`/api/drafts/${draft.id}`, { data: draft });
  expect(res.status(), await res.text()).toBe(200);
  return draft.id;
}

async function dropDrafts(request, ...ids) {
  for (const id of ids) await request.delete(`/api/drafts/${id}`);
}

const diskDraft = async (request, id) => (await request.get(`/api/drafts/${id}`)).json();
const storeDraft = (page) => page.evaluate(() => structuredClone(window.xwb.store.draft));
const waitEngine = (page) => page.waitForFunction(() => window.xwb?.engine?.status === 'ready', null, { timeout: 60_000 });

/** Fail on page errors and on native dialogs (the builder must only use its own). */
function watch(page) {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('dialog', (dialog) => { problems.push(`native dialog: ${dialog.message()}`); dialog.dismiss(); });
  return problems;
}

test('two tabs on one draft: a clean tab catches up, a stale tab asks instead of overwriting', async ({ page, context, request }) => {
  const id = 'e2e-two-tabs';
  await putDraft(request, draftOf(id, { title: 'Two Tabs' }));
  try {
    const a = page;
    const b = await context.newPage();
    const problems = [...watch(a), ...watch(b)];
    await a.goto(`/builder/#/draft/${id}/setup`);
    await b.goto(`/builder/#/draft/${id}/clues`);
    await expect(a.locator('#f-note')).toBeVisible();
    await expect(b.locator('.clue-row').first()).toBeVisible();

    // A saves. B has no unsaved edits, so it quietly loads A's version (it would otherwise save over it later).
    await a.locator('#f-note').fill('Grab a cup and enjoy!');
    await expect(a.locator('.save-status')).toHaveText('Saved');
    await expect.poll(() => b.evaluate(() => window.xwb.store.draft.note)).toBe('Grab a cup and enjoy!');
    await b.locator('.clue-row[data-id="7A"] .clue-input').fill('Shivering sound'); // 7A = BREAK
    await expect(b.locator('.save-status')).toHaveText('Saved');
    let disk = await diskDraft(request, id);
    expect(disk.note).toBe('Grab a cup and enjoy!');
    expect(disk.clues.BREAK).toBe('Shivering sound');

    // Another window saves without telling B (simulated through the API). B's next save is refused, B asks, and
    // nothing is overwritten until the user decides.
    await request.put(`/api/drafts/${id}`, { data: { ...disk, title: 'Renamed elsewhere' } });
    await b.locator('.clue-row[data-id="8A"] .clue-input').fill('Finish line?'); // 8A = TERM
    const conflict = b.locator('.modal-conflict');
    await expect(conflict).toContainText('was saved from another tab');
    expect((await diskDraft(request, id)).title).toBe('Renamed elsewhere');
    expect((await diskDraft(request, id)).clues.TERM).not.toBe('Finish line?');
    // Dismissed: the header keeps saying so; clicking it asks again.
    await conflict.getByRole('button', { name: 'Close' }).click();
    await expect(b.locator('.save-status')).toHaveText('Not saved — changed in another tab');
    await b.locator('.save-status').click();
    await b.locator('.modal-conflict').getByRole('button', { name: 'Load the other version' }).click();
    await expect(b.locator('.clue-row[data-id="8A"] .clue-input')).toHaveValue(sampleDraft.clues.TERM);
    await expect(b.locator('.save-status')).toHaveText('Saved');

    // Same again, but keep B's version this time.
    await request.put(`/api/drafts/${id}`, { data: { ...(await diskDraft(request, id)), title: 'Renamed again' } });
    await b.locator('.clue-row[data-id="8A"] .clue-input').fill('Finish line?');
    await b.locator('.modal-conflict').getByRole('button', { name: 'Keep my version' }).click();
    await expect(b.locator('.save-status')).toHaveText('Saved');
    disk = await diskDraft(request, id);
    expect(disk.clues.TERM).toBe('Finish line?');
    expect(disk.title).toBe('Renamed elsewhere'); // B's copy (it had loaded this title)

    // Deleted elsewhere: a stale tab does not bring it back by autosaving.
    await request.delete(`/api/drafts/${id}`);
    await b.locator('.clue-row[data-id="1A"] .clue-input').fill('Oh!');
    await expect(b.locator('.modal-conflict')).toContainText('was deleted in another tab');
    expect((await request.get(`/api/drafts/${id}`)).status()).toBe(404);
    await b.locator('.modal-conflict').getByRole('button', { name: 'Let it go' }).click();
    await expect(b).toHaveURL(/#\/$/);
    expect((await request.get(`/api/drafts/${id}`)).status()).toBe(404);
    expect(problems).toEqual([]);
  } finally {
    await dropDrafts(request, id);
  }
});

test('editing a theme word’s clue on Theme & Layout updates the clue that gets published', async ({ page, request }) => {
  const id = 'e2e-theme-clue';
  await putDraft(request, pizzaDraft(id));
  try {
    const problems = watch(page);
    await page.goto(`/builder/#/draft/${id}/theme`);
    await page.locator('.theme-input').fill('Pizza | Neapolitan pie');
    await page.getByRole('tab', { name: /Clues/ }).click();
    const row = page.locator('.clue-row', { has: page.locator('.cr-answer', { hasText: /^PIZZA$/ }) });
    await expect(row.locator('.clue-input')).toHaveValue('Neapolitan pie');
    await expect(page.locator('.save-status')).toHaveText('Saved');
    expect((await diskDraft(request, id)).clues.PIZZA).toBe('Neapolitan pie');
    // A clue written by hand is the user's: later theme-list edits leave it alone.
    await row.locator('.clue-input').fill('My own pizza clue');
    await page.getByRole('tab', { name: /Theme/ }).click();
    await page.locator('.theme-input').fill('Pizza | Something else');
    await page.getByRole('tab', { name: /Clues/ }).click();
    await expect(row.locator('.clue-input')).toHaveValue('My own pizza clue');
    expect(problems).toEqual([]);
  } finally {
    await dropDrafts(request, id);
  }
});

test('when saving fails, opening another draft asks instead of dropping the edits', async ({ page, request }) => {
  const id = 'e2e-save-fails';
  const other = 'e2e-save-other';
  await putDraft(request, draftOf(id, { title: 'Save Fails' }));
  await putDraft(request, draftOf(other, { title: 'Other Draft' }));
  try {
    const problems = watch(page);
    await page.goto(`/builder/#/draft/${id}/setup`);
    await page.route(`**/api/drafts/${id}`, (route) => (route.request().method() === 'PUT'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'disk full (simulated)' }) })
      : route.continue()));
    await page.locator('#f-note').fill('Typed while the disk was full');
    await expect(page.locator('.save-status')).toHaveText('Save failed — retrying');

    await page.locator('.draft-link', { hasText: 'Other Draft' }).click();
    const dialog = page.locator('.modal-unsaved');
    await expect(dialog).toContainText('could not be saved: disk full (simulated)');
    await dialog.getByRole('button', { name: 'Stay here' }).click();
    await expect(page).toHaveURL(new RegExp(`#/draft/${id}/setup$`));
    await expect(page.locator('#f-note')).toHaveValue('Typed while the disk was full');

    // The server is back: "Try saving again" saves and then goes where the user wanted.
    await page.locator('.draft-link', { hasText: 'Other Draft' }).click();
    await expect(dialog).toBeVisible();
    await page.unroute(`**/api/drafts/${id}`);
    await dialog.getByRole('button', { name: 'Try saving again' }).click();
    await expect(page).toHaveURL(new RegExp(`#/draft/${other}`));
    expect((await diskDraft(request, id)).note).toBe('Typed while the disk was full');
    expect(problems).toEqual([]);
  } finally {
    await dropDrafts(request, id, other);
  }
});

test('switching drafts while a publish is in flight records it on the published draft only', async ({ page, request }) => {
  const a = 'e2e-race-a';
  const b = 'e2e-race-b';
  const dateA = '2032-03-01';
  await putDraft(request, draftOf(a, { title: 'Race A', date: dateA }));
  await putDraft(request, draftOf(b, { title: 'Race B', date: '2032-03-02' }));
  try {
    const problems = watch(page);
    await page.goto(`/builder/#/draft/${a}/review`);
    await expect(page.locator('.check-list')).toContainText('Ready to publish');
    await page.route('**/api/publish', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    const sent = page.waitForRequest((r) => r.url().endsWith('/api/publish'));
    await page.locator('.publish-box').getByRole('button', { name: 'Publish', exact: true }).click();
    await sent; // the publish request is on its way (held back 1.5 s) — now open another draft
    await page.locator('.draft-link', { hasText: 'Race B' }).click();
    await expect(page.locator('.ed-title')).toHaveText('Race B');
    await expect(page.locator('.toast', { hasText: '“Race A” as #' })).toBeVisible({ timeout: 10_000 });

    await expect.poll(async () => (await diskDraft(request, a)).publishedDate).toBe(dateA);
    const diskA = await diskDraft(request, a);
    expect(diskA.publishedAt).toEqual(expect.any(String));
    expect(diskA.publishedFingerprint).toEqual(expect.any(String));
    const diskB = await diskDraft(request, b);
    expect(diskB.publishedAt).toBeUndefined();
    expect(diskB.publishedDate).toBeUndefined();
    const open = await storeDraft(page);
    expect(open.id).toBe(b);
    expect(open.publishedAt).toBeUndefined();
    await expect(page.locator('.ed-chips')).not.toContainText('Published');
    expect(problems).toEqual([]);
  } finally {
    await request.delete(`/api/published/${dateA}`);
    await dropDrafts(request, a, b);
  }
});

test('edits after publishing are flagged until the update is published; scheduled puzzles open as a preview', async ({ page, request }) => {
  const id = 'e2e-pub-edit';
  const date = '2032-04-01';
  await putDraft(request, draftOf(id, { title: 'Edit After Publish', date }));
  try {
    const problems = watch(page);
    await page.goto(`/builder/#/draft/${id}/review`);
    await page.locator('.publish-box').getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.locator('.publish-done')).toContainText('Published as #');
    // A scheduled puzzle would show "No peeking!" to its creator: the link opens the player's preview mode.
    await expect(page.locator('.publish-done').getByRole('link', { name: 'Preview in the site' }))
      .toHaveAttribute('href', `/site/index.html?preview=1#/puzzle/${date}`);
    await expect(page.locator('.publish-state')).toContainText('up to date');
    await expect(page.locator('.chip-unpublished')).toHaveCount(0);

    await page.getByRole('tab', { name: /Clues/ }).click();
    await page.locator('.clue-row[data-id="5A"] .clue-input').fill('In progress');
    await expect(page.locator('.save-status')).toHaveText('Saved');
    await expect(page.locator('.chip-unpublished')).toHaveText('Changes not published');
    await expect(page.locator('.draft-row.active .dr-status')).toContainText('edited');
    await page.getByRole('tab', { name: /Review/ }).click();
    await expect(page.locator('.check-list')).toContainText('Changes since publishing are not live yet');
    // The live file still has the old clue…
    const before = await (await request.get(`/site/puzzles/${date}.json`)).json();
    expect(before.clues.across.find((c) => c.num === 5).clue).toBe(sampleDraft.clues.DELTA);
    // …until the update is published.
    await page.locator('.publish-box').getByRole('button', { name: 'Publish update' }).click();
    await expect(page.locator('.chip-unpublished')).toHaveCount(0);
    await expect(page.locator('.publish-state')).toContainText('up to date');
    const after = await (await request.get(`/site/puzzles/${date}.json`)).json();
    expect(after.clues.across.find((c) => c.num === 5).clue).toBe('In progress');

    await page.goto('/builder/#/schedule');
    const row = page.locator('table tr', { hasText: 'Edit After Publish' });
    await expect(row.getByRole('link', { name: /^Preview #\d+ in the player$/ })).toHaveAttribute('href', `/site/index.html?preview=1#/puzzle/${date}`);
    expect(problems).toEqual([]);
  } finally {
    await request.delete(`/api/published/${date}`);
    await dropDrafts(request, id);
  }
});

test('site settings: leaving with unsaved edits asks; the share example never shows the dev server', async ({ page, request }) => {
  const problems = watch(page);
  await page.goto('/builder/#/settings');
  const sample = page.locator('.share-sample');
  await expect(sample).toContainText('https://your-site-address/');
  await expect(sample).not.toContainText(new URL(page.url()).host);
  await expect(page.locator('.share-sample-note')).toContainText('filled in automatically');

  await page.locator('#s-url').fill('https://friends.example/xw/');
  await expect(sample).toContainText('https://friends.example/xw/');
  await page.locator('.side-link', { hasText: 'Schedule' }).click();
  const dialog = page.locator('.modal', { hasText: 'Unsaved settings' });
  await dialog.getByRole('button', { name: 'Stay here' }).click();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.locator('#s-url')).toHaveValue('https://friends.example/xw/');
  await page.locator('.side-link', { hasText: 'Schedule' }).click();
  await dialog.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page).toHaveURL(/#\/schedule$/);
  // Nothing was written (the player tests running alongside rely on the default config).
  expect((await (await request.get('/api/config')).json()).shareUrl).toBe('');
  expect(problems).toEqual([]);
});

test('typing a phrase straight into the grid keeps it in one word', async ({ page, request }) => {
  const id = 'e2e-phrase';
  await putDraft(request, { ...makeDraft({ id, width: 15, height: 15, title: 'Phrase' }) });
  try {
    const problems = watch(page);
    await page.goto(`/builder/#/draft/${id}/grid`);
    await page.locator('.xw-grid .xc[data-i="45"]').click();
    await page.keyboard.type('peanut butter');
    const d = await storeDraft(page);
    expect(d.cells.slice(45, 60).map((c) => c || '.').join('')).toBe('PEANUTBUTTER...');
    expect(d.cells[45 + 15 + 6]).toBe(''); // nothing ran down from the space
    // Space still toggles the direction when it does not follow a letter.
    await page.locator('.xw-grid .xc[data-i="0"]').click();
    await page.keyboard.press('Space');
    expect(await page.evaluate((x) => window.xwb.session(x).dir, id)).toBe('down');
    expect(problems).toEqual([]);
  } finally {
    await dropDrafts(request, id);
  }
});

test('"Retry once with min score" does not change the saved fill options', async ({ page, request }) => {
  const id = 'e2e-retry';
  const cells = sampleDraft.cells.map((c, i) => (i >= 1 && i <= 4 ? '' : c)); // 1A GASP emptied
  await putDraft(request, draftOf(id, { cells }));
  try {
    const problems = watch(page);
    await page.goto(`/builder/#/draft/${id}/grid`);
    await waitEngine(page);
    await page.evaluate(() => {
      window.__fills = [];
      window.xwb.engine.fill = (grid, options) => {
        window.__fills.push(options);
        return {
          promise: Promise.resolve({ ok: false, reason: 'impossible', cells: null, stats: {}, problem: { entryId: '1A', pattern: '....', message: 'stuck' } }),
          cancel() {},
        };
      };
    });
    const card = page.locator('.fill-card');
    await card.getByRole('button', { name: 'Autofill' }).click();
    await card.getByRole('button', { name: 'Retry once with min score 20' }).click();
    await expect(card.getByRole('button', { name: 'Retry once with min score 10' })).toBeVisible();
    expect(await page.evaluate(() => window.__fills.map((o) => o.minScore))).toEqual([30, 20]);
    const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('xwb:fillOptions') || '{}'));
    expect(prefs.minScore ?? 30).toBe(30);
    await card.locator('summary', { hasText: 'Fill options' }).click();
    await expect(card.locator('.fill-options input[type="number"]')).toHaveValue('30');
    expect(problems).toEqual([]);
  } finally {
    await dropDrafts(request, id);
  }
});

test('candidate viability counts crossings at the fill’s min score; Refill asks before replacing clued words', async ({ page, request }) => {
  const id = 'e2e-viability';
  await putDraft(request, draftOf(id));
  try {
    const problems = watch(page);
    await page.goto(`/builder/#/draft/${id}/grid`);
    await waitEngine(page);
    await page.evaluate(() => {
      window.__cand = [];
      window.xwb.engine.candidates = async (grid, entryId, o) => {
        window.__cand.push(o.minScore);
        // At min score 30 IGLOO leaves a crossing with no word; counting junk (min 0) it seemed to have one.
        return o.minScore === 30
          ? [{ word: 'PIZZA', score: 80, viability: 12 }, { word: 'IGLOO', score: 76, viability: 0 }]
          : [{ word: 'PIZZA', score: 80, viability: 40 }, { word: 'IGLOO', score: 76, viability: 1 }, { word: 'PLZEN', score: 26, viability: 3 }];
      };
      window.__fills = 0;
      window.xwb.engine.fill = () => {
        window.__fills++;
        return { promise: Promise.resolve({ ok: false, reason: 'aborted', cells: null, stats: {} }), cancel() {} };
      };
    });
    await page.locator('.xw-grid .xc[data-i="10"]').click(); // ENTER (6A)
    const igloo = page.locator('.cand', { hasText: 'IGLOO' });
    await expect(igloo).toHaveClass(/dead/);
    await expect(page.locator('.cand', { hasText: 'PLZEN' })).toBeVisible();
    await expect(page.locator('.cand').first()).toContainText('PIZZA');
    expect(await page.evaluate(() => window.__cand.slice(-2).sort())).toEqual([0, 30]);

    // Every word of the sample is clued and unlocked: Refill asks first.
    await page.locator('.fill-card').getByRole('button', { name: 'Refill', exact: true }).click();
    const ask = page.locator('.modal-confirm', { hasText: 'have clues' });
    await expect(ask).toContainText('Their clues stay saved');
    await ask.getByRole('button', { name: 'Cancel' }).click();
    expect(await page.evaluate(() => window.__fills)).toBe(0);
    await page.locator('.fill-card').getByRole('button', { name: 'Refill', exact: true }).click();
    await ask.getByRole('button', { name: 'Refill anyway' }).click();
    await expect.poll(() => page.evaluate(() => window.__fills)).toBe(1);
    expect(problems).toEqual([]);
  } finally {
    await dropDrafts(request, id);
  }
});

test('Undo after "Suggest all missing" keeps clues typed meanwhile', async ({ page, request }) => {
  const id = 'e2e-suggest-undo';
  await putDraft(request, draftOf(id, { clues: {}, clueSources: {} }));
  try {
    const problems = watch(page);
    await page.goto(`/builder/#/draft/${id}/clues`);
    await page.waitForFunction(() => window.xwb.clueBank.loaded, null, { timeout: 30_000 });
    await page.evaluate(() => {
      window.xwb.clueBank.suggestions = (answer) => (answer === 'GASP' ? [] : [{ clue: `Suggested ${answer}`, source: 'curated' }]);
    });
    await page.getByRole('button', { name: 'Suggest all missing' }).click();
    const toastEl = page.locator('.toast', { hasText: 'suggested clue' });
    await expect(toastEl).toBeVisible();
    await page.locator('.clue-row[data-id="1A"] .clue-input').fill('Typed by hand'); // GASP had no suggestion
    await page.locator('.clue-row[data-id="5A"] .clue-input').fill('Rewritten'); // DELTA's suggestion, rewritten
    await toastEl.getByRole('button', { name: 'Undo' }).click();
    const d = await storeDraft(page);
    expect(d.clues.GASP).toBe('Typed by hand');
    expect(d.clues.DELTA).toBe('Rewritten');
    expect(d.clues.ENTER).toBeUndefined();
    expect(d.clueSources.ENTER).toBeUndefined();
    expect(problems).toEqual([]);
  } finally {
    await dropDrafts(request, id);
  }
});

test('layout generation keeps running while another step is open; a stopped run only keeps proven layouts', async ({ page, request }) => {
  const id = 'e2e-layouts';
  await putDraft(request, pizzaDraft(id, { cells: Array(25).fill(''), locked: [], clues: {}, clueSources: {} }));
  try {
    const problems = watch(page);
    await page.goto(`/builder/#/draft/${id}/theme`);
    await waitEngine(page);
    await page.evaluate((filled) => {
      const cells = Array(25).fill('');
      'PIZZA'.split('').forEach((ch, k) => { cells[10 + k] = ch; });
      const base = { cells, placements: [{ answer: 'PIZZA', row: 2, col: 0, dir: 'across' }], unplaced: [], locked: [10, 11, 12, 13, 14] };
      const proven = { ...base, filled, stats: { blocks: 2, words: 10, avgLength: 4.4, fillAvgScore: 60 } };
      const unproven = { ...base, filled: null, stats: { blocks: 0, words: 10, avgLength: 5 } };
      window.__layoutRuns = [];
      window.xwb.engine.layouts = () => {
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        window.__layoutRuns.push({ finish: (reason) => resolve({ layouts: [unproven, proven], reason, attempts: 9, ms: 500 }) });
        return { promise, cancel: () => resolve({ layouts: [unproven, proven], reason: 'aborted', attempts: 9, ms: 500 }) };
      };
    }, sampleDraft.cells);
    await page.getByRole('button', { name: 'Generate layouts' }).click();
    await expect(page.locator('.theme-gen .progress-line')).toBeVisible();
    // Look at another step and come back: still running.
    await page.getByRole('tab', { name: /Setup/ }).click();
    await page.getByRole('tab', { name: /Theme/ }).click();
    await expect(page.locator('.theme-gen .progress-line')).toBeVisible();
    await expect(page.locator('.run-hint')).toContainText('Stop keeps the layouts proven so far');
    await page.locator('.theme-gen').getByRole('button', { name: 'Stop' }).click();
    await expect(page.locator('.layout-card')).toHaveCount(1);
    await expect(page.locator('.gallery-meta')).toContainText('1 unproven candidate left out');
    await expect(page.locator('.layout-card')).not.toContainText('Not verified');

    // A finished (not stopped) run shows unproven layouts, clearly marked.
    await page.getByRole('button', { name: 'Show me different ones' }).click();
    await page.evaluate(() => window.__layoutRuns.at(-1).finish(undefined));
    await expect(page.locator('.layout-card')).toHaveCount(2);
    await expect(page.locator('.layout-card').first()).toContainText('Not verified — may not fill');
    expect(problems).toEqual([]);
  } finally {
    await dropDrafts(request, id);
  }
});

test('word list: score 0 means "never" (it is banned), an empty score is refused', async ({ page, request }) => {
  const word = 'QXZJWORD';
  const problems = watch(page);
  try {
    await page.goto('/builder/#/words');
    await page.waitForFunction(() => window.xwb.wordIndex, null, { timeout: 30_000 });
    await page.getByRole('searchbox', { name: 'Search the word list' }).fill(word.toLowerCase());
    const card = page.locator('.word-card');
    const score = card.getByRole('spinbutton', { name: `Score for ${word}` });
    await score.fill('');
    await card.getByRole('button', { name: 'Add word' }).click();
    await expect(page.locator('.toast', { hasText: 'Enter a score from 0 to 100' })).toBeVisible();
    expect(await (await request.get('/api/user-words')).text()).not.toContain(word);
    await score.fill('0');
    await card.getByRole('button', { name: 'Add word' }).click();
    await expect(page.locator('.toast', { hasText: `${word} banned (score 0 = never use)` })).toBeVisible();
    const text = await (await request.get('/api/user-words')).text();
    expect(text).toContain(`-${word}`);
    expect(text).not.toContain(`${word};60`);
    expect(problems).toEqual([]);
  } finally {
    await request.patch('/api/user-words', { data: { remove: [word] } });
  }
});

// ---------------------------------------------------------------------------------- answer freshness & hints

/** Answers of the fixture puzzles of Sep 28, Oct 2 (the sample) and Oct 5 (see support/root.js). */
const OCT5_ANSWERS = ['DAB', 'ERA', 'WET', 'DEW', 'ARE', 'BAT'];
const FIXTURE_RECENT = ['SPA', 'OAR', 'BYE', 'SOB', 'PAY', 'ARE', ...OCT5_ANSWERS, ...draftEntries(sampleDraft).all.map((e) => e.answer)];
const penalties = (words, without = []) => Object.fromEntries([...new Set(words)].filter((w) => !without.includes(w)).map((w) => [w, 30]));

test('answer freshness: autofill, layouts and "fit" avoid recent answers; the grid, Words and Review flag them', async ({ page, request }) => {
  const id = 'e2e-fresh';
  // The sample puzzle (published on Oct 2) as a draft for Oct 12 with 1A GASP emptied, GASP as its theme word.
  // Within ±30 days of Oct 12 are the fixture puzzles of Sep 28, Oct 2 and Oct 5; within ±7 days only Oct 5's.
  const cells = sampleDraft.cells.map((c, i) => (i >= 1 && i <= 4 ? '' : c));
  await putDraft(request, draftOf(id, {
    date: '2026-10-12', cells, theme: [{ answer: 'GASP', clue: 'Sharp breath', raw: 'Gasp' }], themeText: 'Gasp | Sharp breath',
  }));
  try {
    const problems = watch(page);
    await page.goto(`/builder/#/draft/${id}/grid`);
    await waitEngine(page);
    await page.evaluate(() => {
      window.__calls = [];
      const e = window.xwb.engine;
      e.fill = (grid, options) => {
        window.__calls.push(['fill', options.penalize ?? null]);
        return { promise: Promise.resolve({ ok: false, reason: 'aborted', cells: null, stats: {} }), cancel() {} };
      };
      e.fitWords = (grid, options) => {
        window.__calls.push(['fitWords', options.penalize ?? null]);
        return { promise: Promise.resolve({ added: [], filled: null, left: options.words }), cancel() {} };
      };
      e.layouts = (params) => {
        window.__calls.push(['layouts', params.penalize ?? null]);
        return { promise: Promise.resolve({ layouts: [], attempts: 3, ms: 20 }), cancel() {} };
      };
      e.candidates = async () => [{ word: 'DELTA', score: 60, viability: 9 }, { word: 'ZEBRA', score: 55, viability: 4 }];
    });

    // The status bar and the Checks panel list the answers that a recent puzzle used (5 complete ones repeat Oct 2).
    const recentLink = page.locator('.grid-statusbar .recent-link');
    await expect(recentLink).toHaveText('5 used recently');
    await recentLink.click();
    await expect(page.locator('.panel-title', { hasText: 'Used recently (± 30 days)' })).toBeVisible();
    await expect(page.locator('.recent-list .issue')).toHaveText([
      /^DELTA \(5A\) — used in the puzzle of Oct 2$/, /^ENTER \(6A\)/, /^BREAK \(7A\)/, /^TERM \(8A\)/, /^DEBT \(5D\)/,
    ]);
    // Clicking one shows its alternatives, tagged when they were used recently.
    await page.locator('.recent-list .issue', { hasText: 'DELTA' }).click();
    await expect(page.locator('.side-tab.active')).toHaveText('Words');
    await expect(page.locator('.cand', { hasText: 'DELTA' }).locator('.cand-recent')).toHaveText('used Oct 2');
    await expect(page.locator('.cand', { hasText: 'ZEBRA' }).locator('.cand-recent')).toHaveCount(0);

    // Autofill passes the recent answers (not the theme word GASP) to the engine as `penalize`.
    const expected = penalties(FIXTURE_RECENT, ['GASP']);
    await page.locator('.fill-card').getByRole('button', { name: 'Autofill' }).click();
    await expect.poll(() => page.evaluate(() => window.__calls.length)).toBe(1);
    expect(await page.evaluate(() => window.__calls[0])).toEqual(['fill', expected]);

    // "Fit it in for me" too; when nothing fits it says why.
    await page.locator('.side-tab', { hasText: 'Theme' }).click();
    await page.getByRole('button', { name: 'Fit it in for me' }).click();
    await expect(page.locator('.toast', { hasText: 'never makes up crossings' })).toBeVisible();
    expect(await page.evaluate(() => window.__calls[1])).toEqual(['fitWords', expected]);

    // The option is on by default and remembered; turned off, nothing is penalized (the flags stay).
    const card = page.locator('.fill-card');
    await card.locator('summary', { hasText: 'Fill options' }).click();
    const avoid = card.getByRole('checkbox', { name: /Avoid repeating recent answers/ });
    await expect(avoid).toBeChecked();
    await expect(card.getByRole('combobox', { name: 'Recent means within' })).toHaveValue('30');
    await avoid.uncheck();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('xwb:fillOptions')).avoidRecent)).toBe(false);
    await card.getByRole('button', { name: 'Autofill' }).click();
    await expect.poll(() => page.evaluate(() => window.__calls.length)).toBe(3);
    expect(await page.evaluate(() => window.__calls[2])).toEqual(['fill', null]);
    await expect(recentLink).toHaveText('5 used recently');
    // A smaller window: only Oct 5 is within 7 days of Oct 12 (and the sample's answers are no longer flagged).
    await avoid.check();
    const windowSelect = card.getByRole('combobox', { name: 'Recent means within' });
    await windowSelect.selectOption('7');
    await expect(recentLink).toHaveCount(0);
    await card.getByRole('button', { name: 'Autofill' }).click();
    await expect.poll(() => page.evaluate(() => window.__calls.length)).toBe(4);
    expect(await page.evaluate(() => window.__calls[3])).toEqual(['fill', penalties(OCT5_ANSWERS)]);
    await windowSelect.selectOption('30');
    await expect(recentLink).toHaveText('5 used recently');

    // Layout generation gets them as well (the window and option are shared).
    await page.getByRole('tab', { name: /Theme & Layout/ }).click();
    await page.getByRole('button', { name: 'Generate layouts' }).click();
    await expect.poll(() => page.evaluate(() => window.__calls.length)).toBe(5);
    expect(await page.evaluate(() => window.__calls[4])).toEqual(['layouts', expected]);

    // Review: a warning (not an error) listing them.
    await page.getByRole('tab', { name: /Review/ }).click();
    const warning = page.locator('.check.warn', { hasText: 'also in puzzles within 30 days' });
    await expect(warning).toContainText('5 answers also in puzzles within 30 days: DELTA (Oct 2), ENTER (Oct 2)');
    await warning.click();
    await expect(page).toHaveURL(new RegExp(`#/draft/${id}/grid$`));
    await expect(page.locator('.side-tab.active')).toHaveText(/^Checks/);
    expect(problems).toEqual([]);
  } finally {
    await dropDrafts(request, id);
  }
});

test('hints: theme capacity and Stop, long clues, and "Use my time zone" in Site settings', async ({ page, request }) => {
  const id = 'e2e-hints';
  const longClue = 'An extremely long clue that keeps going and going, well past what fits on one line of a phone';
  await putDraft(request, draftOf(id, { clues: { ...sampleDraft.clues, DELTA: longClue } }));
  try {
    const problems = watch(page);
    await page.goto(`/builder/#/draft/${id}/theme`);
    await page.locator('.theme-input').fill('Pizza\nPasta\nRisotto');
    await expect(page.locator('.theme-summary')).toHaveText('3 theme words · 1 too long for this grid · a 5×5 usually holds 1–2, so the top ones get placed first');
    await expect(page.locator('.theme-words .card-help')).toContainText('put your favourite answers at the top');
    await expect(page.locator('.gen-help')).toContainText('more blocks than you picked');

    await page.getByRole('tab', { name: /Clues/ }).click();
    await expect(page.locator('.clue-row[data-id="5A"] .cr-len')).toHaveText(`${longClue.length} · long — may wrap on small phones`);
    await expect(page.locator('.clue-row[data-id="6A"] .cr-len')).not.toContainText('long');
    await page.getByRole('tab', { name: /Review/ }).click();
    await expect(page.locator('.check.warn', { hasText: 'long — may wrap on small phones' })).toContainText('The clue for 5A is long');

    await page.goto('/builder/#/settings');
    const useMine = page.getByRole('button', { name: 'Use my time zone (UTC)' }); // the test browser runs in UTC
    await expect(page.locator('#s-tz')).toHaveValue('');
    await expect(page.locator('.tz-help')).toContainText('their own midnight');
    await useMine.click();
    await expect(page.locator('#s-tz')).toHaveValue('UTC');
    await expect(useMine).toBeHidden();
    await expect(page.locator('.tz-help')).toContainText('The new puzzle unlocks at midnight in this zone for everyone; the hosted site picks it up within an hour if you use the included GitHub Pages workflow.');
    // Not saved (the player tests running alongside rely on the default config).
    await page.locator('.side-link', { hasText: 'Schedule' }).click();
    await page.locator('.modal', { hasText: 'Unsaved settings' }).getByRole('button', { name: 'Discard changes' }).click();
    expect((await (await request.get('/api/config')).json()).timeZone).toBeNull();
    expect(problems).toEqual([]);
  } finally {
    await dropDrafts(request, id);
  }
});

test('"Ban word" bans the selected word and refills just its squares', async ({ page, request }) => {
  const id = 'e2e-ban-word';
  await putDraft(request, draftOf(id)); // the sample mini: GASP / DELTA / ENTER / BREAK / TERM, nothing locked
  try {
    const problems = watch(page);
    await page.goto(`/builder/#/draft/${id}/grid`);
    await waitEngine(page);
    // Select 1A GASP. Clicking an already-selected square flips the direction, so click until it reads Across.
    const cell = page.locator('.xw-grid .xc[data-i="2"]');
    await cell.click();
    if (!(await page.getByText('1 Across', { exact: true }).first().isVisible())) await cell.click();
    await expect(page.getByText('1 Across', { exact: true }).first()).toBeVisible();
    await page.locator('.fill-card').getByRole('button', { name: 'Ban word', exact: true }).click();
    await expect(page.getByText('GASP banned')).toBeVisible();
    // Only 1A's squares were cleared and refilled (its crossings allow e.g. GASH/HARK); the rest is untouched.
    await expect.poll(async () => {
      const d = await diskDraft(request, id);
      return d.cells.slice(1, 5).every((c) => /^[A-Z]$/.test(c)) && d.cells.slice(1, 5).join('') !== 'GASP';
    }).toBe(true);
    const d = await diskDraft(request, id);
    expect(d.cells.slice(5, 9).join('')).toBe('DELT'); // row 2 (5A DELTA) keeps its letters except 4D's column
    const words = await (await request.get('/api/user-words')).text();
    expect(words).toMatch(/^-GASP$/m);
    expect(problems).toEqual([]);
  } finally {
    await request.patch('/api/user-words', { data: { remove: ['GASP', 'GENRE'] } });
    await dropDrafts(request, id);
  }
});

// ---------------------------------------------------------------------------- "Put it online"
// The e2e temp root is not a git repository, so /api/go-live is stubbed (page.route) to drive every button state;
// the real endpoint is covered by tests/unit/golive.test.js.

/** Stub GET/POST /api/go-live. `state.status` answers GETs; each POST takes the next of `state.posts`. */
async function stubGoLive(page, status) {
  const state = { status, posts: [], posted: [] };
  await page.route('**/api/go-live', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.status) });
      return;
    }
    state.posted.push({ body: req.postData(), type: req.headers()['content-type'] });
    const next = state.posts.shift() || { status: 500, body: { error: 'unexpected POST' } };
    if (next.delay) await new Promise((resolve) => setTimeout(resolve, next.delay));
    if (next.then) next.then();
    await route.fulfill({ status: next.status, contentType: 'application/json', body: JSON.stringify(next.body) });
  });
  return state;
}

const goLiveStatus = (pending, extra = {}) => ({
  git: true, branch: 'main', remote: 'https://github.com/friend/xw.git', upstream: true, pending, ahead: 0,
  siteUrl: 'https://friends.example/xw/', pagesUrl: 'https://friend.github.io/xw/', busy: false, ready: true, problem: null, ...extra,
});

test('Put it online after publishing: pending count, progress, friendly error with hint, success', async ({ page, request }) => {
  const id = 'e2e-golive';
  const date = '2033-05-01';
  await putDraft(request, draftOf(id, { title: 'Go Live', date }));
  try {
    const problems = watch(page);
    // The real endpoint answers in the (non-git) temp root: not set up, nothing pending.
    const real = await (await request.get('/api/go-live')).json();
    expect(real).toMatchObject({ git: false, ready: false, pending: [], problem: { code: 'not-git' } });

    const gl = await stubGoLive(page, goLiveStatus([]));
    await page.goto(`/builder/#/draft/${id}/review`);
    const side = page.locator('.golive-status');
    await expect(side).toHaveText('Online ✓');

    gl.status = goLiveStatus([
      { path: `site/puzzles/${date}.json`, change: 'added' },
      { path: 'site/puzzles/index.json', change: 'modified' },
    ]);
    await page.locator('.publish-box').getByRole('button', { name: 'Publish', exact: true }).click();
    const box = page.locator('.publish-done');
    await expect(box).toContainText('Published as #');
    const button = box.locator('.golive-btn');
    await expect(button).toHaveText(/^Put it online\s*2$/);
    await expect(button).toHaveClass(/\bprimary\b/);
    await expect(box.locator('.golive-msg')).toHaveText('Only on this computer until you put it online.');
    await expect(side).toHaveText('2 changes to put online'); // refreshed after publishing

    // GitHub refuses: the friendly message and its hint, in the box and in the sidebar.
    gl.posts.push({
      status: 409,
      body: {
        error: 'GitHub has changes that this computer does not have yet, so it refused the update.',
        hint: 'Run "git pull --rebase" in the project folder (or ask Claude to sort it out), then try again.',
        code: 'rejected', committed: true,
      },
      then: () => { gl.status = goLiveStatus([], { ahead: 1 }); },
    });
    await button.click();
    const msg = box.locator('.golive-msg');
    await expect(msg).toHaveClass(/\berror\b/);
    await expect(msg).toContainText('GitHub has changes that this computer does not have yet');
    await expect(msg).toContainText('git pull --rebase');
    await expect(msg).toContainText('saved in a commit on this computer');
    await expect(side).toHaveText('Couldn’t put it online');
    expect(gl.posted).toEqual([{ body: '{}', type: 'application/json' }]);

    // Try again: progress while it runs, then the result with the site link (a future puzzle unlocks at midnight).
    gl.posts.push({
      status: 200, delay: 800,
      body: { ok: true, upToDate: false, committed: false, pushed: true, commit: null, branch: 'main', siteUrl: 'https://friends.example/xw/' },
      then: () => { gl.status = goLiveStatus([]); },
    });
    await button.click();
    await expect(button).toBeDisabled();
    await expect(button).toHaveText('Putting it online…');
    await expect(side).toHaveText('Putting it online…');
    await expect(msg).toContainText('Online — it unlocks at midnight on Sunday, May 1, 2033.');
    await expect(msg.getByRole('link', { name: 'Open your site' })).toHaveAttribute('href', 'https://friends.example/xw/');
    await expect(button).toBeEnabled();
    await expect(button).not.toHaveClass(/\bprimary\b/);
    await expect(side).toHaveText('Online ✓');
    expect(gl.posted).toHaveLength(2);
    expect(problems).toEqual([]);
  } finally {
    await request.delete(`/api/published/${date}`);
    await dropDrafts(request, id);
  }
});

test('Put it online from the Schedule: count after unpublishing, the sidebar line, and "GitHub not set up"', async ({ page, request }) => {
  const date = '2033-05-02';
  const published = await request.post('/api/publish', { data: { draft: draftOf('e2e-golive-sched', { title: 'Go Live Schedule', date }) } });
  expect(published.status()).toBe(200);
  try {
    const problems = watch(page);
    const gl = await stubGoLive(page, goLiveStatus([]));
    await page.goto('/builder/#/schedule');
    const head = page.locator('.golive-head');
    const side = page.locator('.golive-status');
    await expect(side).toHaveText('Online ✓');
    await expect(head.locator('.golive-msg')).toHaveText('Everything is online.');

    // Unpublish: the header button gets the number of changes waiting, the toast offers to put it online.
    gl.status = goLiveStatus([
      { path: `site/puzzles/${date}.json`, change: 'deleted' },
      { path: 'site/puzzles/index.json', change: 'modified' },
    ]);
    await page.locator('table tr', { hasText: 'Go Live Schedule' }).getByRole('button', { name: 'Unpublish' }).click();
    await page.locator('.modal-confirm').getByRole('button', { name: 'Unpublish' }).click();
    await expect(page.locator('.toast', { hasText: 'Unpublished “Go Live Schedule”' }).getByRole('button', { name: 'Put it online' })).toBeVisible();
    await expect(head.locator('.golive-btn')).toHaveText(/^Put it online\s*2$/);
    await expect(head.locator('.golive-btn')).toHaveClass(/\bprimary\b/);
    await expect(side).toHaveText('2 changes to put online');

    // Clicking the sidebar line runs it; the header shows the progress and the result.
    gl.posts.push({
      status: 200, delay: 600,
      body: { ok: true, upToDate: false, committed: true, pushed: true, commit: { sha: 'abc1234', message: `Unpublish ${date}`, files: [] }, siteUrl: 'https://friends.example/xw/' },
      then: () => { gl.status = goLiveStatus([]); },
    });
    await side.click();
    await expect(head.locator('.golive-btn')).toHaveText('Putting it online…');
    await expect(head.locator('.golive-msg')).toContainText('Online — your site updates in about a minute.');
    await expect(side).toHaveText('Online ✓');
    expect(gl.posted).toHaveLength(1);

    // Not a git repository: the sidebar says so and explains in a custom dialog; the button is not pushed forward.
    gl.status = {
      git: false, branch: null, remote: null, upstream: false, pending: [], ahead: 0, siteUrl: null, pagesUrl: null, busy: false, ready: false,
      problem: {
        code: 'not-git',
        error: 'This project folder is not a git repository yet, so there is nothing to put online.',
        hint: 'Do the one-time GitHub setup in README.md (“Putting the site online”), or ask Claude to set it up.',
      },
    };
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); // the builder re-checks when it regains focus
    await expect(side).toHaveText('GitHub not set up');
    await expect(side).toHaveAttribute('title', /README\.md/);
    await expect(head.locator('.golive-msg')).toContainText('GitHub is not set up yet');
    await expect(head.locator('.golive-btn')).not.toHaveClass(/\bprimary\b/);
    await side.click();
    const dialog = page.locator('.modal-golive');
    await expect(dialog).toContainText('not a git repository yet');
    await expect(dialog).toContainText('README.md');
    await dialog.getByRole('button', { name: 'Not now' }).click();
    await expect(dialog).toHaveCount(0);
    expect(gl.posted).toHaveLength(1);
    expect(problems).toEqual([]);
  } finally {
    await request.delete(`/api/published/${date}`);
  }
});

// ---------------------------------------------------------------------------- SPEC §8: Mini / Midi / Daily

test('a Mini and a Daily on the same day: kind picker, per-kind dates and clashes, schedule, unpublish one', async ({ page, request }) => {
  test.setTimeout(90_000);
  const day = '2033-03-03';
  const next = '2033-03-04';
  const ids = { mini: 'e2e-kind-mini', daily: 'e2e-kind-daily', third: 'e2e-kind-third' };
  await putDraft(request, draftOf(ids.mini, { title: 'Tiny Tuesday', date: day, kind: 'mini', kindSource: 'user' }));
  await putDraft(request, draftOf(ids.daily, { title: 'Big Tuesday', date: day, kind: 'daily', kindSource: 'user' }));
  // An empty draft without a kind (like drafts made before kinds existed): a daily until Setup says otherwise.
  const empty = makeDraft({ id: ids.third, width: 5, height: 5, title: 'Third One' });
  delete empty.kind;
  await putDraft(request, empty);
  try {
    const problems = watch(page);
    await page.clock.setFixedTime(new Date(`${day}T12:00:00Z`)); // the builder's "today" is the day itself

    // ---- Publish the Mini, then the Daily: no clash between them
    await page.goto(`/builder/#/draft/${ids.mini}/review`);
    await expect(page.locator('.ed-chips .chip-kind')).toHaveText('Mini');
    await expect(page.locator('.summary')).toContainText('Mini #1');
    await page.locator('.publish-box').getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.locator('.publish-done')).toContainText(/Published as Mini #1 for Mar 3, 2033\./);
    await expect(page.locator('.publish-done').getByRole('link', { name: 'Open in the site' }))
      .toHaveAttribute('href', `/site/#/puzzle/${day}-mini`);
    await expect(page.locator('.draft-row', { hasText: 'Tiny Tuesday' }).locator('.kind-badge')).toHaveText('Mini');

    await page.goto(`/builder/#/draft/${ids.daily}/review`);
    await expect(page.locator('.ed-chips .chip-kind')).toHaveText('Daily');
    await expect(page.locator('.check-list')).not.toContainText('already published');
    await page.locator('.publish-box').getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.locator('.publish-done')).toContainText(/Published as #\d+ for Mar 3, 2033\./);
    await expect(page.locator('.modal')).toHaveCount(0); // no "replace it?" question

    const mini = await (await request.get(`/site/puzzles/${day}-mini.json`)).json();
    expect(mini).toMatchObject({ id: `${day}-mini`, date: day, kind: 'mini', title: 'Tiny Tuesday' });
    expect(validatePuzzle(mini)).toEqual({ ok: true, errors: [] });
    const daily = await (await request.get(`/site/puzzles/${day}.json`)).json();
    expect(daily).toMatchObject({ id: day, date: day, title: 'Big Tuesday' });
    expect(daily.kind ?? 'daily').toBe('daily');
    await expect.poll(async () => (await diskDraft(request, ids.mini)).publishedId).toBe(`${day}-mini`);

    // ---- Setup of a third draft: the kind follows the size until picked; dates and clashes are per kind
    await page.goto(`/builder/#/draft/${ids.third}/setup`);
    const kind = (k) => page.locator(`input[name="setup-kind"][value="${k}"]`);
    await expect(kind('daily')).toBeChecked();
    await page.locator('label.size-pick', { hasText: '7×7' }).click();
    await expect(kind('mini')).toBeChecked(); // re-suggested from the size
    await page.locator('label.size-pick', { hasText: '11×11' }).click();
    await expect(kind('midi')).toBeChecked();
    await expect(page.locator('.date-info')).toContainText(`Use next free date for a Midi: ${'Mar 3, 2033'}`);
    await page.locator('.seg-card[data-kind="mini"]').click();
    await expect(page.locator('.ed-chips .chip-kind')).toHaveText('Mini');
    await expect(page.locator('.date-info')).toContainText('Use next free date for a Mini: Mar 4, 2033');
    await page.locator('label.size-pick', { hasText: '15×15' }).click();
    await expect(kind('mini')).toBeChecked(); // picked explicitly: the size no longer changes it
    await page.locator('#f-date').fill(day);
    await expect(page.locator('.date-info')).toContainText('Mini #1 “Tiny Tuesday” is already published on this date');
    await page.locator('.seg-card[data-kind="midi"]').click();
    await expect(page.locator('.date-info')).not.toContainText('already published');
    await expect(page.locator('.date-info')).toContainText('Also on this day: Mini #1 “Tiny Tuesday”');
    await expect.poll(async () => (await diskDraft(request, ids.third))).toMatchObject({ kind: 'midi', kindSource: 'user', date: day, width: 15 });
    await expect(page.locator('.draft-row', { hasText: 'Third One' }).locator('.kind-badge')).toHaveText('Midi');

    // ---- Home: the day lists both puzzles with their kinds (and the planned Midi)
    await page.goto('/builder/#/');
    const today = page.locator('.home-upcoming .day').first();
    await expect(today.locator('.kind-badge')).toHaveText(['Mini', 'Daily', 'Midi']);

    // ---- Schedule: the day shows each puzzle with its kind; "Add" plans the free kind
    await page.goto('/builder/#/schedule');
    const cell = page.locator(`.day-cell[data-date="${day}"]`);
    await expect(cell.locator('.dc-item .kind-badge')).toHaveText(['Mini', 'Daily', 'Midi']);
    await expect(cell.locator('.dc-more')).toHaveCount(0); // Midi is planned: no free kind that day
    await expect(page.locator(`.day-cell[data-date="${next}"] .dc-add`)).toBeVisible();
    const miniRow = page.locator(`tr[data-id="${day}-mini"]`);
    const dailyRow = page.locator(`tr[data-id="${day}"]`);
    await expect(miniRow.locator('td').nth(1)).toHaveText('Mini');
    await expect(dailyRow.locator('td').nth(1)).toHaveText('Daily');
    await expect(miniRow.getByRole('link', { name: 'Open draft' })).toHaveAttribute('href', `#/draft/${ids.mini}`);
    await expect(miniRow.getByRole('link', { name: 'Open Mini #1 in the player' })).toHaveAttribute('href', `/site/#/puzzle/${day}-mini`);

    // Unpublish the Mini only.
    await miniRow.getByRole('button', { name: 'Unpublish' }).click();
    await expect(page.locator('.modal-confirm')).toContainText('Other puzzles of that day stay');
    await page.locator('.modal-confirm').getByRole('button', { name: 'Unpublish' }).click();
    await expect(miniRow).toHaveCount(0);
    await expect(dailyRow).toHaveCount(1);
    expect((await request.get(`/site/puzzles/${day}-mini.json`)).status()).toBe(404);
    expect((await request.get(`/site/puzzles/${day}.json`)).status()).toBe(200);
    // The Mini's draft is now planned for the day again.
    await expect(cell.locator('.dc-item.planned .kind-badge')).toHaveText(['Mini', 'Midi']);

    // The "New puzzle" dialog from a day with room: the free kind is preselected; the date is that day.
    await page.locator(`.day-cell[data-date="${next}"] .dc-add`).click();
    const dialog = page.locator('.modal-new');
    await expect(dialog.locator('.new-when')).toContainText('Friday, March 4, 2033');
    await dialog.locator('label.size-pick', { hasText: '5×5' }).click();
    await expect(dialog.locator('input[name="kind"][value="mini"]')).toBeChecked();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(problems).toEqual([]);
  } finally {
    for (const id of [`${day}-mini`, `${day}-midi`, day]) await request.delete(`/api/published/${id}`);
    await dropDrafts(request, ...Object.values(ids));
  }
});

test('New puzzle dialog: the kind follows the size until picked, and the date is the next free day of that kind', async ({ page, request }) => {
  const day = '2034-05-05';
  const id = 'e2e-kind-dialog';
  await putDraft(request, draftOf(id, { title: 'Occupies Mini', date: day, kind: 'mini' }));
  try {
    const problems = watch(page);
    await page.clock.setFixedTime(new Date(`${day}T12:00:00Z`));
    await page.goto('/builder/');
    await page.getByRole('button', { name: 'New puzzle' }).first().click();
    const dialog = page.locator('.modal-new');
    const checked = (k) => dialog.locator(`input[name="kind"][value="${k}"]`);
    await dialog.locator('label.size-pick', { hasText: '15×15' }).click();
    await expect(checked('daily')).toBeChecked();
    await expect(dialog.locator('.new-when')).toContainText('Friday, May 5, 2034');
    await dialog.locator('label.size-pick', { hasText: '5×5' }).click();
    await expect(checked('mini')).toBeChecked();
    // A Mini is planned for today already: the next free day for a Mini is tomorrow.
    await expect(dialog.locator('.new-when')).toContainText('Saturday, May 6, 2034');
    await dialog.locator('label.seg-item', { hasText: 'Midi' }).click();
    await dialog.locator('label.size-pick', { hasText: '15×15' }).click();
    await expect(checked('midi')).toBeChecked();
    await dialog.locator('input[name="title"]').fill('E2E Kind Dialog');
    await dialog.getByRole('button', { name: 'Create puzzle' }).click();
    await expect(page).toHaveURL(/#\/draft\/[a-z0-9-]+\/theme$/);
    const created = await storeDraft(page);
    expect(created).toMatchObject({ kind: 'midi', kindSource: 'user', date: day, width: 15 });
    await expect(page.locator('.ed-chips .chip-kind')).toHaveText('Midi');
    await dropDrafts(request, created.id);
    expect(problems).toEqual([]);
  } finally {
    await dropDrafts(request, id);
  }
});

test('changing the kind of a published Daily (published before kinds existed) offers to move it', async ({ page, request }) => {
  const day = '2035-07-07';
  const id = 'e2e-kind-move';
  const draft = draftOf(id, { title: 'Moving Day', date: day });
  delete draft.kind;
  const res = await request.post('/api/publish', { data: { draft } });
  expect(res.status(), await res.text()).toBe(200);
  const { puzzle } = await res.json();
  // Recorded the old way: only the date (no publishedId).
  await putDraft(request, { ...draft, publishedAt: puzzle.publishedAt, publishedDate: day });
  try {
    const problems = watch(page);
    await page.goto(`/builder/#/draft/${id}/setup`);
    await expect(page.locator('input[name="setup-kind"][value="daily"]')).toBeChecked();
    await expect(page.locator('.date-info')).toContainText('Published as #');
    await page.locator('.seg-card[data-kind="midi"]').click();
    await expect(page.locator('.kind-picks + .field-help')).toContainText('Publishing it as a Midi adds a new puzzle');
    // The old place is pinned down before the kind changes.
    await expect.poll(async () => (await diskDraft(request, id))).toMatchObject({ kind: 'midi', publishedId: day });

    await page.getByRole('tab', { name: /Review/ }).click();
    await page.locator('.publish-box').getByRole('button', { name: 'Publish', exact: true }).click();
    const modal = page.locator('.modal-confirm');
    await expect(modal).toContainText('already published as #');
    await modal.getByRole('button', { name: 'Move to Midi' }).click();
    await expect(page.locator('.publish-done')).toContainText(/Published as Midi #1 for/);
    expect((await request.get(`/site/puzzles/${day}-midi.json`)).status()).toBe(200);
    await expect.poll(async () => (await request.get(`/site/puzzles/${day}.json`)).status()).toBe(404);
    await expect.poll(async () => (await diskDraft(request, id)).publishedId).toBe(`${day}-midi`);
    expect(problems).toEqual([]);
  } finally {
    for (const pid of [day, `${day}-midi`]) await request.delete(`/api/published/${pid}`);
    await dropDrafts(request, id);
  }
});

test('a Mini, a Midi and a Daily on one date: published from the builder, all three on the player’s day screen', async ({ page, request, browser, baseURL }) => {
  test.setTimeout(120_000);
  const day = '2036-06-06';
  const ids = { mini: 'e2e-three-mini', midi: 'e2e-three-midi', daily: 'e2e-three-daily' };
  const drafts = {
    mini: draftOf(ids.mini, { title: 'Three Mini', date: day, kind: 'mini', kindSource: 'user' }),
    midi: { ...structuredClone(FIXTURES['2026-09-28']), id: ids.midi, title: 'Three Midi', date: day, kind: 'midi', kindSource: 'user' },
    daily: { ...structuredClone(fifteen), id: ids.daily, title: 'Three Daily', date: day, kind: 'daily', kindSource: 'user' },
  };
  for (const d of Object.values(drafts)) await putDraft(request, d);
  const solution = (kind) => drafts[kind].cells.filter((c) => c !== '#').join('');
  try {
    const problems = watch(page);
    await page.clock.setFixedTime(new Date(`${day}T12:00:00Z`));
    // ---- Publish all three from Review: no clash, each numbered within its kind
    for (const kind of ['daily', 'mini', 'midi']) {
      await page.goto(`/builder/#/draft/${ids[kind]}/review`);
      await expect(page.locator('.check-list')).toContainText('Ready to publish');
      await page.locator('.publish-box').getByRole('button', { name: 'Publish', exact: true }).click();
      await expect(page.locator('.publish-done')).toContainText(/Published as /);
      await expect(page.locator('.modal')).toHaveCount(0);
    }
    const index = (await (await request.get('/api/published')).json()).puzzles;
    const entries = index.filter((p) => p.date === day);
    expect(entries.map((p) => [p.id, p.kind])).toEqual([[`${day}-mini`, 'mini'], [`${day}-midi`, 'midi'], [day, 'daily']]);
    const num = Object.fromEntries(entries.map((p) => [p.kind, p.number]));
    expect(num.mini).toBe(index.filter((p) => p.kind === 'mini').length); // the latest of each kind
    expect(num.midi).toBe(index.filter((p) => p.kind === 'midi').length);
    for (const p of entries) expect(validatePuzzle(await (await request.get(`/site/puzzles/${p.id}.json`)).json())).toEqual({ ok: true, errors: [] });
    const dup = await request.post('/api/publish', { data: { draft: { ...drafts.mini, id: 'e2e-three-dup' } } });
    expect(dup.status()).toBe(409);
    await page.goto('/builder/#/schedule');
    await expect(page.locator(`.day-cell[data-date="${day}"] .dc-item .kind-badge`)).toHaveText(['Mini', 'Midi', 'Daily']);
    expect(problems).toEqual([]);

    // ---- Player on that day: three cards, each plays and saves on its own
    const ctx = await browser.newContext({ baseURL, timezoneId: 'America/Chicago', locale: 'en-US', viewport: { width: 1280, height: 800 } });
    try {
      await captureShares(ctx);
      const solver = await ctx.newPage();
      const p = new Player(solver, { mobile: false });
      const cards = solver.locator('.day-card');
      await p.open(`#/puzzle/${day}-mini`, { at: new Date(`${day}T04:00:00Z`) }); // 11 pm the day before in Chicago
      await expect(solver.locator('.message-title')).toHaveText('Unlocks on Friday, June 6, 2036');
      await solver.clock.setSystemTime(new Date(`${day}T17:00:00Z`));
      await solver.goto('/site/#/');
      await expect(solver.locator('.day-header .eyebrow')).toHaveText('Today’s puzzles');
      await expect(cards.locator('.kind-badge')).toHaveText(['Mini', 'Midi', 'Daily']);
      await expect(cards.locator('.day-card-title')).toHaveText(['Three Mini', 'Three Midi', 'Three Daily']);
      await expect(cards.locator('.day-card-num')).toHaveText([`#${num.mini}`, `#${num.midi}`, `#${num.daily}`]);
      await expect(cards.locator('.day-card-status')).toHaveText(['New', 'New', 'New']);

      await p.freezeClock();
      await p.press(cards.nth(1).getByRole('button', { name: /^Play/ }));
      await expect(solver.locator('.sub-num')).toHaveText(`Midi #${num.midi}`);
      await p.tick(12_000);
      await p.type(solution('midi'));
      await p.tick(1_000);
      await expect(p.solvedModal).toBeVisible();
      await p.press(p.solvedModal.getByRole('button', { name: 'Share' }));
      expect((await p.lastShare(1)).text.split('\n')[0]).toBe(`🧩 Crossword Club Midi #${num.midi} · Fri, Jun 6`);
      await p.press(p.solvedModal.getByRole('button', { name: 'View puzzle' }));
      await p.settle();
      await p.press(solver.locator('.play-header .back-btn'));
      await expect(cards.locator('.day-card-status')).toHaveText(['New', '✓ Solved 0:12', 'New']);

      await p.press(cards.nth(0).getByRole('button', { name: /^Play/ }));
      await p.tick(3_000);
      await p.type(solution('mini').slice(0, 2));
      await p.press(solver.locator('.play-header .back-btn'));
      await expect(cards.locator('.day-card-status')).toHaveText([/^In progress 0:0\d$/, '✓ Solved 0:12', 'New']);

      // The Daily keeps the date-only id: an old date link opens it, its progress key is the date.
      await solver.goto(`/site/#/puzzle/${day}`);
      await expect(solver.locator('.intro-title')).toHaveText('Three Daily');
      await expect(solver.locator('.intro-siblings .kind-chip')).toHaveText(['MiniThree Mini', 'MidiThree Midi']);
      await p.play();
      await p.type(solution('daily').slice(0, 1));
      await p.tick(2_000);
      const keys = await solver.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('xw:v1:progress:')).sort());
      expect(keys).toEqual([`xw:v1:progress:${day}`, `xw:v1:progress:${day}-midi`, `xw:v1:progress:${day}-mini`]);

      await solver.goto('/site/#/archive');
      const group = solver.locator('.archive-day').first();
      await expect(group.locator('.archive-item .kind-badge')).toHaveText(['Mini', 'Midi', 'Daily']);
      expect(p.errors).toEqual([]);
    } finally {
      await ctx.close();
    }
  } finally {
    for (const pid of [`${day}-mini`, `${day}-midi`, day]) await request.delete(`/api/published/${pid}`);
    await dropDrafts(request, ...Object.values(ids), 'e2e-three-dup');
  }
});

// ---------------------------------------------------------------------------- Ask Claude (Clues step)
// /api/claude/* is stubbed with page.route — no real Claude in e2e. The server side (providers, prompt, checks, the
// fake-CLI runs) is covered by tests/unit/claude-clues.test.js.

const CLAUDE_REPLY = {
  straightforward: ['Greek letter after gamma', 'Atlanta-based airline', 'Nile ___ (fertile region)'],
  lateral: ['Symbol of change?', 'Spread at the mouth?', 'Carrier with lots of baggage?'],
  via: 'cli', model: 'claude-opus-5-5', ms: 4200,
};

test('Ask Claude: six clues, pick a lateral one, reopen without asking again, Try again shows an error inline', async ({ page, request }) => {
  const id = 'e2e-ask-claude';
  await putDraft(request, draftOf(id, { title: 'River Day' }));
  try {
    const problems = watch(page);
    const posted = [];
    const replies = [
      { status: 200, body: CLAUDE_REPLY, delay: 1500 },
      { status: 503, body: { error: 'Claude Code isn’t logged in.', hint: 'Run claude in a terminal and log in (type /login), then try again.', code: 'not-logged-in' } },
    ];
    await page.route('**/api/claude/clues', async (route) => {
      const req = route.request();
      posted.push({ body: JSON.parse(req.postData()), type: req.headers()['content-type'] });
      const next = replies.shift() || { status: 500, body: { error: 'unexpected request' } };
      if (next.delay) await new Promise((resolve) => setTimeout(resolve, next.delay));
      await route.fulfill({ status: next.status, contentType: 'application/json', body: JSON.stringify(next.body) });
    });
    await page.goto(`/builder/#/draft/${id}/clues`);
    const row = page.locator('.clue-row[data-id="5A"]');
    const ask = row.getByRole('button', { name: 'Ask Claude for clues for DELTA' });
    await expect(ask).toHaveAttribute('title', 'Ask Claude for clues');

    // ---- one click: thinking (with seconds), then three straightforward + three lateral
    await ask.click();
    const panel = row.locator('.claude-panel');
    await expect(panel.locator('.claude-thinking')).toContainText(/Claude is thinking… *\d+ s/);
    await expect(ask).toHaveAttribute('aria-busy', 'true');
    await expect(panel.getByRole('button', { name: 'Try again' })).toBeDisabled();
    await expect(panel.locator('.claude-clue')).toHaveCount(6);
    await expect(panel.getByRole('group', { name: 'Straightforward' }).locator('.claude-clue-text')).toHaveText(CLAUDE_REPLY.straightforward);
    await expect(panel.getByRole('group', { name: 'Lateral ?' }).locator('.claude-clue-text')).toHaveText(CLAUDE_REPLY.lateral);
    await expect(panel.locator('.claude-meta')).toHaveText('via Claude Code · 4 s');
    await expect(ask).toHaveAttribute('aria-busy', 'false');
    // What the builder told Claude about the puzzle.
    expect(posted).toHaveLength(1);
    expect(posted[0].type).toMatch(/^application\/json/);
    expect(posted[0].body).toMatchObject({ answer: 'DELTA', entryId: '5A', isTheme: false, title: 'River Day', theme: [], avoid: ['River\'s mouth, often'] });
    expect(posted[0].body.otherClues).toContain('Sharp intake of breath');
    expect(posted[0].body.otherClues).not.toContain('River\'s mouth, often');

    // ---- pick a lateral clue: it lands in the input as the user's own clue, and the panel closes
    await panel.getByRole('button', { name: /Spread at the mouth\?/ }).click();
    const input = row.locator('.clue-input');
    await expect(input).toHaveValue('Spread at the mouth?');
    await expect(input).toBeFocused();
    await expect(panel).toHaveCount(0);
    const d = await storeDraft(page);
    expect(d.clues.DELTA).toBe('Spread at the mouth?');
    expect(d.clueSources.DELTA).toBe('user');
    await expect(row).toHaveAttribute('data-status', 'ok');
    await expect.poll(async () => (await diskDraft(request, id)).clues.DELTA).toBe('Spread at the mouth?');

    // ---- reopening shows the same six without asking again; keyboard: arrows move, Esc closes back to the button
    await ask.click();
    await expect(panel.locator('.claude-clue')).toHaveCount(6);
    expect(posted).toHaveLength(1);
    await expect(panel.locator('.claude-clue').first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(panel.locator('.claude-clue').nth(1)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(ask).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(panel.locator('.claude-clue')).toHaveCount(6);

    // ---- Try again sends what was already suggested; a failure is shown inline with its hint
    await panel.getByRole('button', { name: 'Try again' }).click();
    const error = panel.locator('.claude-error');
    await expect(error).toContainText('Claude Code isn’t logged in.');
    await expect(error).toContainText('type /login');
    expect(posted).toHaveLength(2);
    expect(posted[1].body.avoid).toEqual([...CLAUDE_REPLY.straightforward, ...CLAUDE_REPLY.lateral]);
    await expect(panel.getByRole('button', { name: 'Try again' })).toBeEnabled();
    await expect(input).toHaveValue('Spread at the mouth?');
    await panel.getByRole('button', { name: 'Close Claude’s clues' }).click();
    await expect(panel).toHaveCount(0);
    expect(problems).toEqual([]);
  } finally {
    await dropDrafts(request, id);
  }
});

test('Site settings shows whether Claude is connected, and how to set it up when it is not', async ({ page }) => {
  const problems = watch(page);
  const status = { available: true, via: 'cli', model: 'claude-opus-5-5', hint: 'Runs Claude Code on this computer with your login, so clues count toward your Claude plan’s usage.' };
  await page.route('**/api/claude/status', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) }));
  await page.goto('/builder/#/settings');
  const card = page.locator('.claude-card');
  await expect(card).toContainText('Connected via your Claude Code login');
  await expect(card.locator('.pill')).toHaveText('Connected');
  await expect(card).toContainText('claude-opus-5-5');
  Object.assign(status, { available: false, via: null, error: 'Claude isn’t connected on this computer.', code: 'unavailable', hint: 'Install Claude Code…' });
  await card.getByRole('button', { name: 'Check again' }).click();
  await expect(card).toContainText('Not available — how to set up');
  await expect(card.locator('.claude-setup li')).toHaveCount(2);
  await expect(card).toContainText('ANTHROPIC_API_KEY');
  expect(problems).toEqual([]);
});
