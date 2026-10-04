// Player site (SPEC §6) on desktop (hardware keyboard) and phones (on-screen keyboard taps).
//
// The fake clock makes "today" 2026-10-02 (the sample "Warm-Up" puzzle) and lets every test control exactly how
// much solving time passes, so times in the UI and in the share text are asserted exactly.

import { draftToPuzzle } from '../../site/shared/puzzle.js';
import { FIXTURES, SITE_CONFIG, TODAY, fixturePuzzle, solutionLetters } from './support/root.js';
import { expect, test } from './support/player.js';
import { MULTI_DATE, multiSolution, serveMultiKind } from './support/multi.js';

const SOLUTION = solutionLetters(TODAY); // GASPDELTAENTERBREAKTERM
const PAST = '2026-09-28'; // #1 "Tiny Three" (3×3)
const FUTURE = '2026-10-05'; // #3 "From The Future" (3×3)

const CLEAN_ROWS = ['⬛🟩🟩🟩🟩', '🟩🟩🟩🟩🟩', '🟩🟩🟩🟩🟩', '🟩🟩🟩🟩🟩', '🟩🟩🟩🟩⬛'];

/** The SPEC §6 share text for today's puzzle (#2, Fri Oct 2) as served by the dev server. */
function shareText(baseURL, { time, hints = '✨ no hints', rows = CLEAN_ROWS }) {
  return ['🧩 Crossword Club #2 · Fri, Oct 2', `⏱️ ${time} · ${hints}`, ...rows, `${baseURL}/site/`].join('\n');
}

/** The toast with this message (several can be on screen at once). */
const toast = (page, text) => page.locator('.toast', { hasText: text });

/** There is no login of any kind: no form fields at all, and no account wording. */
async function expectNoAccountUi(page) {
  await expect(page.locator('input, textarea, select, [contenteditable="true"]')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(
    /log ?in|sign ?(in|up)|display name|your name|nickname|user ?name|passcode|access code|password|profile/i,
  );
}

test('first visit lands on today’s intro card — no login, name or passcode anywhere', async ({ page, player: p }) => {
  await p.open();
  await expect(p.intro).toBeVisible();
  await expect(page.locator('.eyebrow')).toHaveText('Today’s puzzle · #2');
  await expect(page.locator('.intro-title')).toHaveText('Warm-Up');
  await expect(page.locator('.intro-byline')).toHaveText('by Crossword Club');
  await expect(page.locator('.intro-meta')).toContainText('Friday, October 2, 2026');
  await expect(page.locator('.intro-meta')).toContainText('5×5 Mini');
  await expect(page.locator('.intro-note')).toHaveText(FIXTURES[TODAY].note);
  await expect(p.playButton).toHaveText('Play');
  await expect(p.grid).toHaveCount(0); // the grid stays hidden until Play
  await expectNoAccountUi(page);

  await p.play();
  await expect(page.locator('.play-title-main')).toHaveText('Warm-Up');
  await expectNoAccountUi(page);
  // Progress is the only thing this browser stores: no player name or profile.
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([`xw:v1:progress:${TODAY}`]);
});

test('solve today’s puzzle: solved modal with the time, exact share text, solved state survives a reload', async ({ page, baseURL, player: p }) => {
  await p.open();
  await p.freezeClock();
  await p.play();
  await expect(p.timerText).toHaveText('0:00');
  await expect(p.clueNum).toHaveText('1A');
  await p.tick(83_000);
  await expect(p.timerText).toHaveText('1:23');

  // Letters advance through each entry and then jump to the next incomplete one, so the solution types straight.
  await p.type(SOLUTION.slice(0, -1));
  await expect(p.clueNum).toHaveText('8A');
  await p.type(SOLUTION.slice(-1));
  await p.tick(1_000); // the modal opens after the solve ripple
  const modal = p.solvedModal;
  await expect(modal).toBeVisible();
  await expect(modal.locator('.modal-title')).toHaveText('Solved!');
  await expect(modal.locator('.solved-time')).toHaveText('1:23');
  await expect(modal.locator('.solved-hints')).toHaveText('✨ no hints');
  await expectNoAccountUi(page);

  await p.press(modal.getByRole('button', { name: 'Share' }));
  const shared = await p.lastShare();
  expect(shared.via).toBe(p.shareChannel); // share sheet on touch devices, clipboard on desktop
  expect(shared.text).toBe(shareText(baseURL, { time: '1:23' }));
  if (!p.mobile) await expect(toast(page, 'Copied to clipboard')).toBeVisible();

  // The solved grid stays viewable but read-only, and the clock has stopped.
  await p.press(modal.getByRole('button', { name: 'View puzzle' }));
  await p.settle();
  await expect(modal).toHaveCount(0);
  await expect(page.locator('.hints-btn')).toBeHidden();
  await expect(page.locator('.play-header .share-btn')).toBeVisible();
  await expect(page.locator('.keyboard')).toBeHidden(); // read-only grid: no dead on-screen keyboard
  await p.press(p.cell(1));
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Z');
  await expect(p.letter(1)).toHaveText('G');
  await p.tick(10_000);
  await expect(p.timerText).toHaveText('1:23');
  expect(await p.progress(TODAY)).toMatchObject({ solved: true, elapsedMs: 83_000, checks: 0, reveals: 0, started: true });

  await page.reload();
  await expect(page.locator('.intro-status')).toHaveText('Solved in 1:23');
  await expect(p.playButton).toHaveText('See your solve');
  await p.play();
  await expect(page.locator('.screen-play')).toHaveClass(/is-solved/);
  await expect(page.locator('.grid .cell:not(.is-block) .letter')).toHaveText([...SOLUTION]);
  await expect(p.timerText).toHaveText('1:23');
  await p.press(page.locator('.play-header .share-btn'));
  expect((await p.lastShare()).text).toBe(shareText(baseURL, { time: '1:23' })); // (the log restarts on reload)
});

test('the timer only runs while the page is visible and focused; the pause overlay hides the grid', async ({ page, player: p }) => {
  await p.open();
  await p.freezeClock();
  await p.play();
  await p.tick(2_000);
  await expect(p.timerText).toHaveText('0:02');
  await expect(p.pauseOverlay).toBeHidden();

  // Hidden tab: paused, grid and clues covered, elapsed time saved.
  await p.setActivity({ visible: false, focused: false });
  await expect(p.pauseOverlay).toBeVisible();
  await expect(page.locator('.pause-text')).toHaveText('The timer stops while this page isn’t in front.');
  await expect(p.grid).toBeHidden();
  await expect(page.locator('.area-bar')).toBeHidden();
  expect((await p.progress(TODAY)).elapsedMs).toBe(2_000);
  await p.tick(10_000);
  await expect(p.timerText).toHaveText('0:02');

  // Visible but another window has focus: still paused.
  await p.setActivity({ visible: true, focused: false });
  await expect(p.pauseOverlay).toBeVisible();
  await p.tick(5_000);
  await expect(p.timerText).toHaveText('0:02');

  // Back in front: resumes by itself.
  await p.setActivity({ visible: true, focused: true });
  await expect(p.pauseOverlay).toBeHidden();
  await expect(p.grid).toBeVisible();
  await p.tick(3_000);
  await expect(p.timerText).toHaveText('0:05');

  // Manual pause needs Resume, even when the page goes away and comes back.
  await p.press(page.locator('.timer-btn'));
  await expect(p.pauseOverlay).toBeVisible();
  await expect(page.locator('.pause-text')).toHaveText('Your clock is stopped. Take a breather.');
  await expect(p.grid).toBeHidden();
  await p.setActivity({ visible: false, focused: false });
  await p.setActivity({ visible: true, focused: true });
  await p.tick(4_000);
  await expect(p.pauseOverlay).toBeVisible();
  await expect(p.timerText).toHaveText('0:05');
  await page.keyboard.type('GA'); // typing is ignored while paused
  expect((await p.progress(TODAY)).letters.filter(Boolean)).toEqual([]);
  await p.press(page.locator('.pause-card').getByRole('button', { name: 'Resume' }));
  await expect(p.pauseOverlay).toBeHidden();
  await p.type('GA');
  await p.tick(1_000);
  await expect(p.timerText).toHaveText('0:06');

  // Reload: the saved time comes back and time while the page was closed never counts.
  await p.setActivity({ visible: false, focused: false });
  expect((await p.progress(TODAY)).elapsedMs).toBe(6_000);
  await page.reload();
  await expect(p.playButton).toHaveText('Resume · 0:06');
  await p.tick(30_000); // sitting on the intro card is not solving time
  await p.play();
  await expect(p.timerText).toHaveText('0:06');
  await expect(p.letter(1)).toHaveText('G');
  await expect(p.letter(2)).toHaveText('A');
  await p.tick(1_000);
  await expect(p.timerText).toHaveText('0:07');
});

test('check and reveal mark squares and show up as 🟨/🟪 and a hint line in the share text', async ({ page, baseURL, player: p }) => {
  await p.open();
  await p.freezeClock();
  await p.play();
  await p.tick(61_000);

  await p.type('GXSP'); // X is wrong (the answer is GASP)
  await p.selectCell(2);
  await p.hint('Check', 'Word');
  await expect(p.cell(2)).toHaveClass(/is-wrong/);
  await expect(p.cell(1)).not.toHaveClass(/is-wrong/);
  await expect(toast(page, '1 square is wrong')).toBeVisible();
  await p.type('A'); // fixing the letter clears the slash
  await expect(p.cell(2)).not.toHaveClass(/is-wrong/);

  await p.selectCell(23);
  await p.hint('Reveal', 'Square');
  await expect(p.cell(23)).toHaveClass(/is-revealed/);
  await expect(p.letter(23)).toHaveText('M');

  await p.selectCell(5, 'across');
  await p.type('DELTAENTERBREAKTER'); // the revealed M is skipped
  await p.tick(1_000);
  await expect(p.solvedModal.locator('.solved-time')).toHaveText('1:01');
  await expect(p.solvedModal.locator('.solved-hints')).toHaveText('🔍 1 checked · 💡 1 revealed');
  await p.press(p.solvedModal.getByRole('button', { name: 'Share' }));
  const rows = ['⬛🟩🟨🟩🟩', ...CLEAN_ROWS.slice(1, 4), '🟩🟩🟩🟪⬛'];
  expect((await p.lastShare()).text).toBe(shareText(baseURL, { time: '1:01', hints: '🔍 1 checked · 💡 1 revealed', rows }));
  expect(await p.progress(TODAY)).toMatchObject({ solved: true, checks: 1, reveals: 1, everWrong: [2] });
});

test('a full grid with a wrong letter is not solved; revealing the whole puzzle asks first', async ({ page, player: p }) => {
  await p.open(`#/puzzle/${PAST}`);
  await expect(page.locator('.eyebrow')).toHaveText('From the archive · #1');
  await p.freezeClock();
  await p.play();
  await p.type('SPAOARBYX');
  await expect(toast(page, 'Almost — something’s not quite right')).toBeVisible();
  await p.tick(1_000);
  await expect(p.solvedModal).toHaveCount(0);
  await expect(p.timerText).toHaveText('0:01'); // still running

  await p.hint('Reveal', 'Puzzle');
  const confirm = page.locator('.modal-confirm');
  await expect(confirm).toContainText('Reveal the whole puzzle?');
  await p.press(confirm.getByRole('button', { name: 'Keep solving' }));
  await p.settle();
  await expect(page.locator('.grid .cell.is-revealed')).toHaveCount(0);

  await p.hint('Reveal', 'Puzzle');
  await p.press(page.locator('.modal-confirm').getByRole('button', { name: 'Reveal puzzle' }));
  await p.tick(1_000);
  await expect(p.solvedModal.locator('.modal-title')).toHaveText('Puzzle revealed');
  await expect(page.locator('.grid .cell.is-revealed')).toHaveCount(1); // only the wrong square needed revealing
  await expect(p.letter(8)).toHaveText('E');
  await p.press(p.solvedModal.getByRole('button', { name: 'Share' }));
  const text = (await p.lastShare()).text.split('\n');
  // 1 s + the time the menus and the confirm dialog were open (the clock keeps running behind overlays).
  expect(text.slice(0, 5)).toEqual(['🧩 Crossword Club #1 · Mon, Sep 28', '⏱️ 0:02 · 💡 1 revealed', '🟩🟩🟩', '🟩🟩🟩', '🟩🟩🟪']);
  expect(await p.progress(PAST)).toMatchObject({ solved: true, finish: 'revealed' });

  // Looking back, a given-up puzzle is "Revealed", not a record-fast solve.
  await page.goto('/site/#/archive');
  await p.settle(); // the dialog of the previous screen finishes closing
  const item = page.locator('.archive-item', { hasText: 'Tiny Three' });
  await expect(item.locator('.status-pill')).toHaveText('Revealed');
  await expect(page.locator('.archive-sub')).toHaveText('2 puzzles · 0 solved in this browser');
  await p.press(item);
  await expect(page.locator('.intro-status')).toHaveText('Puzzle revealed');
  await expect(p.playButton).toHaveText('View puzzle');
});

test('Reveal on a letter that is already right counts as a check (it is never a free check)', async ({ page, player: p }) => {
  await p.open(`#/puzzle/${PAST}`);
  await p.freezeClock();
  await p.play();
  await p.type('SP');
  await p.selectCell(1);
  await p.hint('Reveal', 'Square');
  await expect(toast(page, 'That square is already right ✓ (counts as a check)')).toBeVisible();
  await expect(p.cell(1)).not.toHaveClass(/is-revealed/);
  expect(await p.progress(PAST)).toMatchObject({ checks: 1, reveals: 0 });
});

test('two tabs of the same puzzle: a stale tab never undoes a finished solve; letters and time carry over', async ({ page, player: a }) => {
  // Tab A: start, type a letter, play 2 s, then the friend switches away.
  await a.open(`#/puzzle/${PAST}`);
  await a.freezeClock();
  await a.setActivity({ visible: true, focused: true });
  await a.play();
  await a.type('S');
  await a.tick(2_000);
  await a.setActivity({ visible: false, focused: false });

  // Later they tap the link in the group chat again: tab B picks up the letter and the time, and solves it.
  const b = await a.newTab();
  await b.open(`#/puzzle/${PAST}`);
  await b.setActivity({ visible: true, focused: true });
  await expect(b.playButton).toHaveText('Resume · 0:02');
  await b.play();
  await expect(b.letter(0)).toHaveText('S');
  await b.tick(3_000);
  await expect(b.timerText).toHaveText('0:05');
  await b.type(solutionLetters(PAST).slice(1));
  await b.tick(1_000);
  await expect(b.solvedModal.locator('.solved-time')).toHaveText('0:05');

  // Switching back to the old tab shows the finished solve — never its stale letters, time or "unsolved".
  await b.setActivity({ visible: false, focused: false });
  await a.setActivity({ visible: true, focused: true });
  await expect(page.locator('.screen-play')).toHaveClass(/is-solved/);
  await expect(page.locator('.grid .cell:not(.is-block) .letter')).toHaveText([...solutionLetters(PAST)]);
  await expect(a.timerText).toHaveText('0:05');
  await a.tick(3_000);
  await expect(a.timerText).toHaveText('0:05');

  // Closing it (its pagehide save) undoes nothing either.
  await page.close({ runBeforeUnload: true });
  expect(await b.progress(PAST)).toMatchObject({ solved: true, elapsedMs: 5_000, letters: [...solutionLetters(PAST)] });
  await b.page.goto('/site/#/archive');
  await expect(b.page.locator('.archive-item', { hasText: 'Tiny Three' }).locator('.status-pill')).toHaveText('✓ Solved 0:05');
  expect(b.errors).toEqual([]);
});

test('two tabs: time in each tab adds up and letters typed in one show up in the other', async ({ player: a }) => {
  await a.open(`#/puzzle/${PAST}`);
  await a.freezeClock();
  await a.setActivity({ visible: true, focused: true });
  await a.play();
  await a.type('S');
  await a.tick(2_000);
  await a.setActivity({ visible: false, focused: false });

  const b = await a.newTab();
  await b.open(`#/puzzle/${PAST}`);
  await b.setActivity({ visible: true, focused: true });
  await b.play();
  await b.type('PA');
  await b.tick(2_000);
  await b.setActivity({ visible: false, focused: false });

  await a.setActivity({ visible: true, focused: true });
  await expect(a.letter(1)).toHaveText('P');
  await expect(a.letter(2)).toHaveText('A');
  await expect(a.timerText).toHaveText('0:04');
  await a.type('O'); // continues at the next empty square, not over the P typed in the other tab
  await a.tick(2_000);
  await a.setActivity({ visible: false, focused: false });
  expect(await a.progress(PAST)).toMatchObject({ elapsedMs: 6_000, letters: ['S', 'P', 'A', 'O', '', '', '', '', ''] });

  // A tab sitting on the intro card keeps its Resume label current.
  await b.press(b.page.locator('.play-header .back-btn'));
  await expect(b.playButton).toHaveText('Resume · 0:06');
  expect(b.errors).toEqual([]);
});

test('after a re-published answer fix, a grid that is now full and correct finishes on Resume', async ({ page, player: p }) => {
  // The first version had a typo (BYA); the solver typed the intended BYE and a check flagged it.
  const draft = FIXTURES[PAST];
  const typo = draftToPuzzle({ ...draft, cells: [...'SPAOARBYA'], clues: { ...draft.clues, BYA: 'See you later! (typo)', ARA: 'Typo, down' } });
  expect(typo.errors).toEqual([]);
  await page.route(`**/site/puzzles/${PAST}.json`, (route) => route.fulfill({ json: typo.puzzle }));
  await p.open(`#/puzzle/${PAST}`);
  await p.freezeClock();
  await p.play();
  await p.tick(4_000);
  await p.type(solutionLetters(PAST));
  await expect(toast(page, 'Almost — something’s not quite right')).toBeVisible();
  await p.hint('Check', 'Puzzle');
  await expect(p.cell(8)).toHaveClass(/is-wrong/);

  // The creator re-publishes the fix; the friend comes back to the puzzle.
  await page.unroute(`**/site/puzzles/${PAST}.json`);
  await page.reload();
  await expect(p.playButton).toHaveText(/^Resume/);
  await p.play();
  await expect(page.locator('.grid .cell.is-wrong')).toHaveCount(0);
  await p.tick(1_000);
  await expect(p.solvedModal.locator('.modal-title')).toHaveText('Solved!');
  await expect(p.solvedModal.locator('.solved-time')).toHaveText('0:04');
  await expect(p.solvedModal.locator('.solved-hints')).toHaveText('🔍 1 checked');
  await p.tick(5_000);
  await expect(p.timerText).toHaveText('0:04'); // the clock stopped
  expect(await p.progress(PAST)).toMatchObject({ solved: true, finish: 'solved', checks: 1, everWrong: [8] });
});

test('the archive lists released puzzles newest first with this browser’s status', async ({ page, player: p }) => {
  // Solve the 3×3 archive puzzle in 30 s …
  await p.open(`#/puzzle/${PAST}`);
  await p.freezeClock();
  await p.play();
  await p.tick(30_000);
  await p.type(solutionLetters(PAST));
  await p.tick(1_000);
  await expect(p.solvedModal).toBeVisible();
  // … and start today's puzzle.
  await page.goto('/site/#/');
  await p.settle(); // the solved dialog of the previous puzzle closes
  await p.play();
  await p.type('G');
  await p.tick(7_000);

  // Back to the puzzle card, then the site navigation (the play header's archive icon is desktop-only).
  await p.press(page.locator('.play-header .back-btn'));
  await expect(page.locator('.intro-play')).toHaveText('Resume · 0:07');
  await p.press(page.locator('.site-nav').getByRole('link', { name: 'Archive' }));
  await expect(page.locator('.archive-heading')).toHaveText('Archive');
  const items = page.locator('.archive-item');
  await expect(items).toHaveCount(2); // the 2026-10-05 and 2099 puzzles are not out yet
  await expect(items.nth(0).locator('.archive-num')).toHaveText('#2');
  await expect(items.nth(0).locator('.archive-title')).toContainText('Warm-Up');
  await expect(items.nth(0).locator('.pill-today')).toHaveText('Today');
  await expect(items.nth(0).locator('.status-pill')).toHaveText('In progress 0:07');
  await expect(items.nth(1).locator('.archive-num')).toHaveText('#1');
  await expect(items.nth(1).locator('.archive-title')).toHaveText('Tiny Three');
  await expect(items.nth(1).locator('.archive-meta')).toHaveText('Sep 28, 2026 · 3×3 Mini · by E2E Bot');
  await expect(items.nth(1).locator('.status-pill')).toHaveText('✓ Solved 0:30');
  await expect(page.locator('.archive-sub')).toHaveText('2 puzzles · 1 solved in this browser');

  // Opening an archive entry goes to its intro; browser Back returns to the archive.
  await p.press(items.nth(1));
  await expect(page.locator('.intro-title')).toHaveText('Tiny Three');
  await expect(page.locator('.intro-status')).toHaveText('Solved in 0:30');
  await page.goBack();
  await expect(page.locator('.archive-heading')).toHaveText('Archive');
});

test('future puzzles are locked until their date', async ({ page, player: p }) => {
  await p.open(`#/puzzle/${FUTURE}`);
  await expect(page.locator('.message-title')).toHaveText('Unlocks on Monday, October 5, 2026');
  await expect(page.locator('.message-text')).toContainText('isn’t out yet');
  await expect(p.playButton).toHaveCount(0);
  await expect(p.grid).toHaveCount(0);

  await page.goto('/site/#/puzzle/2099-12-31');
  await expect(page.locator('.message-title')).toHaveText('Unlocks on Thursday, December 31, 2099');
  await expect(p.playButton).toHaveCount(0);

  // A future date without any puzzle does not pretend one is coming.
  await page.goto('/site/#/puzzle/2026-12-25');
  await expect(page.locator('.message-title')).toHaveText('No puzzle that day');

  // "Today" never picks a future puzzle.
  await page.goto('/site/#/');
  await expect(page.locator('.intro-title')).toHaveText('Warm-Up');
});

test('a scheduled puzzle opens on its release day', async ({ page, player: p }) => {
  await p.open('', { date: FUTURE });
  await expect(page.locator('.eyebrow')).toHaveText('Today’s puzzle · #3');
  await expect(page.locator('.intro-title')).toHaveText('From The Future');
  await p.play();
  await p.type(solutionLetters(FUTURE));
  await expect(p.solvedModal.locator('.modal-title')).toHaveText('Solved!');
});

test('“today” follows the calendar: latest puzzle on a day without one, and it flips at midnight', async ({ page, player: p }) => {
  await p.open('', { date: '2026-10-04' }); // nothing is published for Oct 4
  await expect(page.locator('.eyebrow')).toHaveText('Latest puzzle · #2');
  await expect(page.locator('.intro-title')).toHaveText('Warm-Up');

  // Midnight passes while the tab is in the background; coming back shows the new day's puzzle.
  await p.setActivity({ visible: false, focused: false });
  await page.clock.setSystemTime(new Date('2026-10-05T00:01:00Z'));
  await p.setActivity({ visible: true, focused: true });
  await expect(page.locator('.eyebrow')).toHaveText('Today’s puzzle · #3');
  await expect(page.locator('.intro-title')).toHaveText('From The Future');
});

test('the day flips while the page stays in front: an “Unlocks on” page opens and the Today link catches up', async ({ page, player: p }) => {
  // A scheduled puzzle opened a minute early, with the page in front the whole time.
  await p.open(`#/puzzle/${FUTURE}`, { at: new Date('2026-10-04T23:59:00Z') });
  await expect(page.locator('.message-title')).toHaveText('Unlocks on Monday, October 5, 2026');
  await p.tick(2 * 60_000);
  await expect(page.locator('.intro-title')).toHaveText('From The Future');
  await expect(page.locator('.eyebrow')).toHaveText('Today’s puzzle · #3');

  // Today's card: the day changes (no timers have run yet) and the friend taps “Today” — the link to the page
  // already showing, so no hashchange fires — and gets the new day's puzzle.
  await page.goto('/site/#/');
  await expect(page.locator('.eyebrow')).toHaveText('Today’s puzzle · #3');
  await page.clock.pauseAt(new Date('2026-10-05T23:59:30Z'));
  await page.clock.setSystemTime(new Date('2026-10-06T00:00:10Z'));
  await page.evaluate(() => { window.__sameCard = document.querySelector('.intro-card'); });
  await p.press(page.locator('.site-nav').getByRole('link', { name: 'Today' }));
  await expect(page.locator('.eyebrow')).toHaveText('Latest puzzle · #3'); // nothing is published for Oct 6
  expect(await page.evaluate(() => window.__sameCard === document.querySelector('.intro-card'))).toBe(false);
});

test('a puzzle deployed after midnight shows up on a page that stays open', async ({ page, player: p }) => {
  // Oct 5's puzzle (#3) is "not deployed yet": hide it from the index until the deploy lands.
  let deployed = false;
  await page.route('**/puzzles/index.json', async (route) => {
    const res = await route.fetch();
    const idx = await res.json();
    if (!deployed) idx.puzzles = idx.puzzles.filter((x) => x.date !== FUTURE);
    await route.fulfill({ response: res, json: idx });
  });
  await p.open('', { at: new Date('2026-10-05T00:30:00Z') });
  await expect(page.locator('.eyebrow')).toHaveText('Latest puzzle · #2');
  deployed = true;
  await p.tick(6 * 60_000); // the page re-checks the index every few minutes while today's puzzle is missing
  await expect(page.locator('.eyebrow')).toHaveText('Today’s puzzle · #3');
  await expect(page.locator('.intro-title')).toHaveText('From The Future');
});

test('site settings: the time zone decides the day; share text follows name, URL and grid settings', async ({ page, player: p }) => {
  const config = {
    ...SITE_CONFIG, siteName: 'Puzzle Pals', timeZone: 'Pacific/Kiritimati', shareUrl: 'https://friends.example/crossword/', shareGrid: false,
  };
  await page.route('**/site/config.json', (route) => route.fulfill({ json: config }));
  // Noon UTC on Oct 4 is already Oct 5 in Kiritimati (UTC+14).
  await p.open('', { date: '2026-10-04' });
  await expect(page.locator('.eyebrow')).toHaveText('Today’s puzzle · #3');
  await expect(page.locator('.brand-name')).toHaveText('Puzzle Pals');
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', 'Puzzle Pals');
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', 'Puzzle Pals');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', SITE_CONFIG.tagline);

  await page.goto(`/site/#/puzzle/${PAST}`);
  await p.freezeClock();
  await p.play();
  await p.tick(12_000);
  await p.type(solutionLetters(PAST));
  await p.tick(1_000);
  await p.press(p.solvedModal.getByRole('button', { name: 'Share' }));
  expect((await p.lastShare()).text).toBe(['🧩 Puzzle Pals #1 · Mon, Sep 28', '⏱️ 0:12 · ✨ no hints', 'https://friends.example/crossword/'].join('\n'));
});

test('a damaged puzzle file shows a friendly error instead of a broken grid', async ({ page, player: p }) => {
  await page.route(`**/site/puzzles/${TODAY}.json`, (route) => route.fulfill({ contentType: 'application/json', body: '{"format":"crossword/1",' }));
  await p.open();
  await expect(page.locator('.message-title')).toHaveText('This puzzle couldn’t be loaded');
  await expect(p.grid).toHaveCount(0);
  await page.unroute(`**/site/puzzles/${TODAY}.json`);
  await p.press(page.getByRole('button', { name: 'Try again' }));
  await expect(page.locator('.intro-title')).toHaveText('Warm-Up');
});

test('preview mode (?preview=1) plays the builder’s puzzle and never saves progress', async ({ page, player: p }) => {
  const draft = { ...fixturePuzzle('2099-12-31'), title: 'Preview Draft', preview: true };
  await p.open();
  await page.evaluate((json) => localStorage.setItem('xw:preview', json), JSON.stringify(draft));
  await page.goto('/site/?preview=1');
  await expect(page.locator('.eyebrow')).toHaveText(/^Preview/);
  await expect(page.locator('.intro-title')).toHaveText('Preview Draft'); // a future date is not locked in preview
  await p.freezeClock();
  await p.play();
  await p.type('OWL');
  await p.tick(5_000);
  await expect(p.timerText).toHaveText('0:05');
  await p.setActivity({ visible: false, focused: false }); // would normally save
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('xw:v1:')))).toEqual([]);

  // Reloading the preview starts over; the real site still has no progress and keeps the date lock.
  await page.reload();
  await expect(p.playButton).toHaveText('Play');
  await page.goto('/site/#/puzzle/2099-12-31');
  await expect(page.locator('.message-title')).toHaveText(/^Unlocks on/);
  await page.goto('/site/#/');
  await expect(p.playButton).toHaveText('Play');
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('xw:v1:')))).toEqual([]);
});

test('in the builder’s preview iframe the timer keeps running while the builder has focus', async ({ page, isMobile, player: p }) => {
  test.skip(isMobile, 'the builder (and its preview) is a desktop tool');
  // A stand-in for the builder: a text field plus the player in an iframe, same origin as the site.
  await page.route('**/site/e2e-host.html', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><title>host</title><input id="q" aria-label="Builder field">'
      + '<iframe id="f" src="index.html?preview=1" style="width:480px;height:720px"></iframe>',
  }));
  await p.open();
  await page.evaluate((json) => localStorage.setItem('xw:preview', json), JSON.stringify(fixturePuzzle(TODAY)));
  await page.goto('/site/e2e-host.html');
  const frame = page.frameLocator('#f');
  await expect(frame.locator('.eyebrow')).toHaveText(/^Preview/);
  await p.freezeClock();
  await frame.locator('.intro-play').click();
  await expect(frame.locator('.grid')).toBeVisible();
  await page.locator('#q').focus(); // focus moves to the builder's own UI
  expect(await page.frame({ url: /preview=1/ }).evaluate(() => document.hasFocus())).toBe(false);
  await p.tick(3_000);
  await expect(frame.locator('.pause-overlay')).toBeHidden();
  await expect(frame.locator('.timer-text')).toHaveText('0:03');
});

test.describe('desktop input', () => {
  test.skip(({ isMobile }) => isMobile, 'hardware keyboard and side clue lists are the desktop layout');

  test('keyboard navigation and clue lists', async ({ page, player: p }) => {
    await p.open();
    await p.play();
    await expect(page.locator('.keyboard')).toBeHidden();
    await expect(page.locator('.area-lists')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(p.clueNum).toHaveText('5A');
    await page.keyboard.press('Shift+Tab');
    await expect(p.clueNum).toHaveText('1A');
    await page.keyboard.press('Space');
    await expect(p.clueNum).toHaveText('1D');
    await page.keyboard.press('ArrowRight'); // perpendicular arrow switches direction first
    await expect(p.clueNum).toHaveText('1A');
    await expect(p.cell(1)).toHaveClass(/is-active/);
    await page.keyboard.press('ArrowRight');
    await expect(p.cell(2)).toHaveClass(/is-active/);
    await page.keyboard.type('L');
    await expect(p.letter(2)).toHaveText('L');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(p.cell(1)).toHaveClass(/is-active/);
    await p.cell(2).click();
    await page.keyboard.press('Delete');
    await expect(p.letter(2)).toHaveText('');
    await p.cell(2).click(); // clicking the active square toggles direction
    await expect(p.clueNum).toHaveText('2D');
    await page.locator('.area-lists .clue[data-id="7A"]').click();
    await expect(p.clueNum).toHaveText('7A');
    await expect(page.locator('.area-lists .clue[data-id="7A"]')).toHaveClass(/is-active/);
    await expect(page.locator('.cluebar-text')).toHaveText('Recess, at school');
  });
});

test.describe('touch input', () => {
  test.skip(({ isMobile }) => !isMobile, 'on-screen keyboard, clue bar and clue sheet are the phone layout');

  test('on-screen keyboard, clue bar and clue sheet; no sideways scrolling', async ({ page, player: p }) => {
    await p.open();
    await p.play();
    await expect(page.locator('.keyboard')).toBeVisible();
    await expect(page.locator('.area-lists')).toBeHidden();
    await page.locator('.clues-btn').tap();
    const sheet = page.locator('.sheet');
    await expect(sheet).toBeVisible();
    await sheet.locator('.clue[data-id="7A"]').tap();
    await expect(sheet).toHaveCount(0);
    await expect(p.clueNum).toHaveText('7A');
    await page.getByRole('button', { name: 'Next clue' }).tap();
    await expect(p.clueNum).toHaveText('8A');
    await page.locator('.cluebar-body').tap(); // tapping the clue bar switches direction
    await expect(p.clueNum).toHaveText(/D$/);
    await p.selectCell(1, 'across');
    await p.type('GAS');
    await page.locator('.kb-key[data-key="Backspace"]').tap();
    await expect(p.letter(1)).toHaveText('G');
    await expect(p.letter(2)).toHaveText('A');
    await expect(p.letter(3)).toHaveText('');
    const sizes = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
      grid: document.querySelector('.grid').getBoundingClientRect().right,
    }));
    expect(sizes.scroll).toBeLessThanOrEqual(sizes.client);
    expect(sizes.grid).toBeLessThanOrEqual(sizes.client);
  });
});

test('dark mode: the selected square of a solved grid stays readable', async ({ page, player: p }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await p.open(`#/puzzle/${PAST}`);
  await p.play();
  await p.type(solutionLetters(PAST));
  await p.tick(1_000);
  await p.press(p.solvedModal.getByRole('button', { name: 'View puzzle' }));
  await p.settle();
  await p.press(p.cell(4));
  await expect(p.cell(4)).toHaveClass(/is-active/);
  // --sel-word-ink on --sel-word (white on blue), not the yellow cell's near-black ink.
  await expect(p.letter(4)).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(p.cell(4)).toHaveCSS('background-color', 'rgb(46, 91, 133)');
});

test('archive rows line up once there are ten or more puzzles', async ({ page, player: p }) => {
  const puzzles = Array.from({ length: 12 }, (_, k) => {
    const date = `2026-09-${String(10 + k).padStart(2, '0')}`;
    return { id: date, date, title: `Puzzle ${k + 1}`, author: 'E2E Bot', width: 5, height: 5, number: k + 1 };
  });
  await page.route('**/site/puzzles/index.json', (route) => route.fulfill({ json: { format: 'crossword-index/1', puzzles } }));
  await p.open('#/archive');
  await expect(page.locator('.archive-item')).toHaveCount(12);
  const xs = await page.locator('.archive-title').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().x)));
  expect(new Set(xs).size).toBe(1);
});

test.describe('phone and tablet layouts', () => {
  test.skip(({ isMobile }) => !isMobile, 'touch layouts (on-screen keyboard, clue bar, clue sheet)');

  /** Today's puzzle where every other clue is long (~80 characters, ending in the important "(2 words)"). */
  function longClueRoute(page) {
    const draft = FIXTURES[TODAY];
    const tail = ' — the one we still talk about at every reunion (2 words)';
    const clues = Object.fromEntries(Object.entries(draft.clues).map(([answer, clue], k) => [answer, k % 2 ? `${clue}${tail}` : clue]));
    const { puzzle, errors } = draftToPuzzle({ ...draft, clues });
    expect(errors).toEqual([]);
    return page.route(`**/site/puzzles/${TODAY}.json`, (route) => route.fulfill({ json: puzzle }));
  }

  test('the clue bar shows every clue in full and the grid keeps its size between clues', async ({ page, player: p }) => {
    await longClueRoute(page);
    await p.open();
    await p.play();
    const seen = [];
    for (let k = 0; k < 10; k++) {
      seen.push(await page.evaluate(() => {
        const t = document.querySelector('.cluebar-text');
        const g = document.querySelector('.grid').getBoundingClientRect();
        return { clipped: t.scrollHeight > t.clientHeight + 1, len: t.textContent.length, grid: `${Math.round(g.width)}@${Math.round(g.y)}` };
      }));
      await page.getByRole('button', { name: 'Next clue' }).tap();
    }
    expect(seen.some((r) => r.len > 75)).toBe(true);
    expect(seen.filter((r) => r.clipped)).toEqual([]);
    expect(new Set(seen.map((r) => r.grid)).size).toBe(1);
  });

  test('phone in landscape: Play is on screen, the hints menu and the solved dialog fit, keys use the space', async ({ page, player: p }) => {
    await page.setViewportSize({ width: 750, height: 342 });
    // A notched phone: the side insets are padded once (around the play area), not again inside the keyboard.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 47, right: 47, bottom: 21 } });
    await p.open(`#/puzzle/${PAST}`);
    await expect(p.playButton).toBeInViewport({ ratio: 1 });
    await p.freezeClock();
    await p.play();
    const kb = await page.locator('.keyboard').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { left: cs.paddingLeft, right: cs.paddingRight, key: el.querySelector('.kb-key').getBoundingClientRect().width };
    });
    expect(kb).toMatchObject({ left: '4px', right: '4px' });
    expect(kb.key).toBeGreaterThan(24);

    await p.press(page.locator('.hints-btn'));
    await p.tick(50);
    await expect(page.locator('.menu')).toHaveClass(/menu-sheet/);
    await expect(page.locator('.menu')).toHaveCSS('transform', 'none'); // entrance transition done
    const bottoms = await page.locator('.menu .menu-item').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().bottom));
    expect(bottoms).toHaveLength(6);
    for (const b of bottoms) expect(b).toBeLessThanOrEqual(342);
    await page.keyboard.press('Escape');
    await p.settle();

    await p.type(solutionLetters(PAST));
    await p.tick(1_000);
    await expect(p.solvedModal).toHaveCSS('transform', 'none');
    const modal = await p.solvedModal.evaluate((el) => ({
      scrolls: el.scrollHeight > el.clientHeight + 1,
      share: el.querySelector('.btn-primary').getBoundingClientRect().bottom,
    }));
    expect(modal.scrolls).toBe(false);
    expect(modal.share).toBeLessThanOrEqual(342);
  });

  test('320 px phone: the title stays readable in the header and the dialog buttons don’t wrap', async ({ page, player: p }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await p.open(`#/puzzle/${PAST}`);
    await p.play();
    await expect(page.locator('.play-title-sub .sub-date')).toBeHidden();
    await expect(page.locator('.play-title-sub .sub-num')).toHaveText('#1');
    expect((await page.locator('.play-title-main').boundingBox()).width).toBeGreaterThan(80);
    expect((await page.locator('.timer-btn').boundingBox()).height).toBeGreaterThanOrEqual(40);
    await p.type(solutionLetters(PAST));
    await p.tick(1_000);
    const share = await p.solvedModal.getByRole('button', { name: 'Share' }).boundingBox();
    const view = await p.solvedModal.getByRole('button', { name: 'View puzzle' }).boundingBox();
    expect(share.y).toBeLessThan(view.y); // stacked, the main action first
    expect(view.height).toBeLessThanOrEqual(50); // one line
  });

  test('tablet in portrait: the clue lists sit right under a full-width grid', async ({ page, player: p }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await p.open();
    await p.play();
    await expect(page.locator('.area-lists')).toBeVisible();
    await expect(page.locator('.clues-btn')).toBeHidden();
    const grid = await p.grid.boundingBox();
    const lists = await page.locator('.area-lists').boundingBox();
    expect(lists.y).toBeGreaterThanOrEqual(grid.y + grid.height);
    expect(lists.y - (grid.y + grid.height)).toBeLessThan(40); // no empty band between them
    expect(lists.height).toBeGreaterThan(150);
    expect(grid.width).toBeGreaterThan(480);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// SPEC §8: a Mini, a Midi and a Daily on the same date (fixtures in support/multi.js; Oct 4 has all three).

test.describe('several puzzles a day (Mini / Midi / Daily)', () => {
  const cards = (page) => page.locator('.day-card');

  test('today’s cards in Mini, Midi, Daily order; Play opens the grid, Back returns, progress is per puzzle', async ({ page, baseURL, player: p }) => {
    await serveMultiKind(page);
    await p.open('', { date: MULTI_DATE });
    await expect(page.locator('.day-header .eyebrow')).toHaveText('Today’s puzzles');
    await expect(page.locator('.day-title')).toHaveText('Sunday, October 4, 2026');
    await expect(cards(page)).toHaveCount(3);
    await expect(cards(page).locator('.kind-badge')).toHaveText(['Mini', 'Midi', 'Daily']);
    await expect(cards(page).locator('.day-card-num')).toHaveText(['#1', '#2', '#3']);
    await expect(cards(page).locator('.day-card-title')).toHaveText(['Tiny Mini', 'Midi Mix', 'Sunday Best']);
    await expect(cards(page).locator('.day-card-meta')).toHaveText(['3×3', '3×3', '5×5']);
    await expect(cards(page).locator('.day-card-status')).toHaveText(['New', 'New', 'New']);
    await expect(p.intro).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // Play on the Mini goes straight to its grid.
    await p.freezeClock();
    await p.press(cards(page).nth(0).getByRole('button', { name: /^Play/ }));
    await expect(p.grid).toBeVisible();
    expect(page.url()).toContain('#/puzzle/2026-10-04-mini');
    await expect(page.locator('.play-title-main')).toHaveText('Tiny Mini');
    await expect(page.locator('.sub-num')).toHaveText('Mini #1');
    await p.tick(21_000);
    await p.type(multiSolution('2026-10-04-mini'));
    await p.tick(1_000);
    await expect(p.solvedModal).toBeVisible();
    await p.press(p.solvedModal.getByRole('button', { name: 'Share' }));
    expect((await p.lastShare()).text).toBe([
      '🧩 Crossword Club Mini #1 · Sun, Oct 4', '⏱️ 0:21 · ✨ no hints', '🟩🟩🟩', '🟩🟩🟩', '🟩🟩🟩', `${baseURL}/site/`,
    ].join('\n'));
    await p.press(p.solvedModal.getByRole('button', { name: 'View puzzle' }));
    await p.settle();

    // Back returns to the cards; the Mini is solved, the others untouched.
    await p.press(page.locator('.play-header .back-btn'));
    await expect(cards(page)).toHaveCount(3);
    expect(page.url()).not.toContain('#/puzzle/');
    await expect(cards(page).locator('.day-card-status')).toHaveText(['✓ Solved 0:21', 'New', 'New']);
    await expect(page.locator('.day-sub')).toHaveText('3 puzzles · 1 solved');

    // The Daily keeps its date-only id (and progress key); Resume shows on its card afterwards.
    await p.press(cards(page).nth(2).getByRole('button', { name: /^Play/ }));
    await expect(page.locator('.play-title-main')).toHaveText('Sunday Best');
    await expect(page.locator('.sub-num')).toHaveText('#3');
    await p.type('G');
    await p.tick(5_000);
    await p.press(page.locator('.play-header .back-btn'));
    await expect(cards(page).nth(2).getByRole('button', { name: /^Resume · 0:05/ })).toBeVisible();
    const keys = await page.evaluate(() => Object.keys(localStorage).sort());
    expect(keys).toEqual(['xw:v1:progress:2026-10-04', 'xw:v1:progress:2026-10-04-mini']);
  });

  test('a puzzle link shows its intro card with links to the rest of the day; ids and old date links resolve', async ({ page, player: p }) => {
    await serveMultiKind(page);
    await p.open('#/puzzle/2026-10-04-midi', { date: MULTI_DATE });
    await expect(page.locator('.eyebrow')).toHaveText('Today’s Midi · #2');
    await expect(page.locator('.intro-title')).toHaveText('Midi Mix');
    await expect(page.locator('.intro-meta')).toHaveText(/3×3$/);
    await expect(page.locator('.intro-siblings .kind-chip')).toHaveText(['MiniTiny Mini', 'DailySunday Best']);
    await p.press(page.locator('.intro-siblings .kind-chip').nth(1));
    await expect(page.locator('.intro-title')).toHaveText('Sunday Best');
    await expect(page.locator('.eyebrow')).toHaveText('Today’s puzzle · #3');

    // An archive puzzle of another kind: "From the archive · Midi #1". Oct 3 has only that midi, so the old
    // date-only link to Oct 3 opens it too.
    await page.goto('/site/#/puzzle/2026-10-03-midi');
    await expect(page.locator('.eyebrow')).toHaveText('From the archive · Midi #1');
    await page.goto('/site/#/puzzle/2026-10-03');
    await expect(page.locator('.intro-title')).toHaveText('Middle Ground');
    await p.play();
    await p.type(multiSolution('2026-10-03-midi'));
    await expect(p.solvedModal).toBeVisible();
    expect(await p.progress('2026-10-03-midi')).toMatchObject({ solved: true });

    // A kind that day doesn't have, a future kind, and a bad id.
    await page.goto('/site/#/puzzle/2026-10-02-mini');
    await expect(page.locator('.message-title')).toHaveText('No puzzle that day');
    await expect(page.locator('.message-text')).toHaveText('There’s no Mini for Friday, October 2, 2026.');
    await page.goto('/site/#/puzzle/2026-10-05-mini');
    await expect(page.locator('.message-title')).toHaveText('Unlocks on Monday, October 5, 2026');
    await page.goto('/site/#/puzzle/2026-10-04-maxi');
    await expect(cards(page)).toHaveCount(3);
  });

  test('archive groups a day’s puzzles under its date with kind badges', async ({ page, player: p }) => {
    await serveMultiKind(page);
    await p.open('#/archive', { date: MULTI_DATE });
    await expect(page.locator('.archive-sub')).toHaveText('6 puzzles · 0 solved in this browser');
    const day = page.locator('.archive-day');
    await expect(day).toHaveCount(1); // Oct 4; the other days have one puzzle each
    await expect(day.locator('.archive-day-heading')).toHaveText('Sunday, October 4, 2026Today');
    await expect(day.locator('.archive-item .kind-badge')).toHaveText(['Mini', 'Midi', 'Daily']);
    await expect(day.locator('.archive-num')).toHaveText(['#1', '#2', '#3']);
    await expect(day.locator('.archive-meta').first()).toHaveText('3×3 · by E2E Bot');
    // Single-puzzle days stay plain rows: the Oct 3 midi carries its badge, the old dailies none.
    const rows = page.locator('.archive-list > li > .archive-item');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0).locator('.archive-title')).toHaveText('MidiMiddle Ground');
    await expect(rows.nth(1).locator('.archive-title')).toHaveText('Warm-Up');
    await expect(rows.nth(1).locator('.kind-badge')).toHaveCount(0);
    // The rows of a group line up with the plain rows.
    const xs = await page.locator('.archive-num').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().x)));
    expect(new Set(xs).size).toBe(1);
    await p.press(day.locator('.archive-item').nth(0));
    await expect(page.locator('.intro-title')).toHaveText('Tiny Mini');
    expect(page.url()).toContain('#/puzzle/2026-10-04-mini');
  });

  test('a day with only a mini keeps the single intro card; “Latest” falls back to the last day with puzzles', async ({ page, player: p }) => {
    // Oct 5 with its daily held back (not deployed): only the Monday Mini.
    await serveMultiKind(page, { hidden: ['2026-10-05'] });
    await p.open('', { date: '2026-10-05' });
    await expect(p.intro).toBeVisible();
    await expect(page.locator('.eyebrow')).toHaveText('Today’s Mini · #2');
    await expect(page.locator('.intro-meta')).toHaveText(/3×3$/);
    await p.play();
    await p.type(multiSolution('2026-10-05-mini'));
    await expect(p.solvedModal).toBeVisible();

    // With Oct 5's puzzles all held back, Oct 5 shows the latest day that has puzzles: Oct 4's three.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await serveMultiKind(page, { hidden: ['2026-10-05', '2026-10-05-mini'] });
    await page.goto('/site/#/');
    await page.reload(); // the index is loaded when the page opens
    await expect(page.locator('.day-header .eyebrow')).toHaveText('Latest puzzles');
    await expect(cards(page)).toHaveCount(3);
  });

  test('another kind deployed later and the midnight roll-over both show up on an open page', async ({ page, player: p }) => {
    // Oct 5: the daily is out, the mini lands later.
    const state = await serveMultiKind(page, { hidden: ['2026-10-05-mini'] });
    await p.open('', { at: new Date('2026-10-05T00:30:00Z') });
    await expect(page.locator('.eyebrow')).toHaveText('Today’s puzzle · #4');
    state.hidden.clear();
    await p.tick(6 * 60_000); // the page re-checks the index every few minutes
    await expect(cards(page)).toHaveCount(2);
    await expect(cards(page).locator('.kind-badge')).toHaveText(['Mini', 'Daily']);
  });

  test('midnight flips the cards to the new day', async ({ page, player: p }) => {
    await serveMultiKind(page);
    await p.open('', { at: new Date('2026-10-03T23:59:00Z') });
    await expect(page.locator('.eyebrow')).toHaveText('Today’s Midi · #1');
    await p.tick(2 * 60_000);
    await expect(page.locator('.day-header .eyebrow')).toHaveText('Today’s puzzles');
    await expect(cards(page)).toHaveCount(3);
  });
});
