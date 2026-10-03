// Helpers for driving the player site (site/) in the e2e tests.
//
// Time: every player test fakes the browser clock (Playwright's page.clock), so "today" is fixed and the solve
// timer is fully deterministic. `open()` installs the clock at noon UTC on the chosen date; `freezeClock()` stops
// it (call it on the intro card, before Play) and from then on time only moves with `tick(ms)`, which advances
// the fake clock and fires the app's timers (its 250 ms timer interval, animation frames, toasts, …) on the way.

import { expect, test as base } from '@playwright/test';
import { TODAY } from './root.js';

export const noonUTC = (date) => new Date(`${date}T12:00:00Z`);

/** Player URL for a hash route, e.g. sitePath('#/archive'). `base` is where the site is hosted. */
export const sitePath = (route = '', { preview = false, base = '/site/' } = {}) => `${base}${preview ? '?preview=1' : ''}${route}`;

/**
 * Record share-sheet and clipboard output in window.__shareLog = [{ via: 'share' | 'clipboard', text }].
 * navigator.share exists here only because we stub it; the app uses it on touch devices only.
 */
export async function captureShares(context) {
  await context.addInitScript(() => {
    window.__shareLog = [];
    const record = (via, text) => { window.__shareLog.push({ via, text }); };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => record('clipboard', text), readText: async () => '' },
    });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data) => record('share', data?.text) });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
  });
}

export class Player {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {{ mobile: boolean, base?: string }} opts
   *   mobile: drive the on-screen keyboard with taps instead of the hardware keyboard
   *   base:   where the site is hosted (default: the dev server's /site/)
   */
  constructor(page, { mobile, base = '/site/' }) {
    this.page = page;
    this.mobile = Boolean(mobile);
    this.base = base;
    this.clockInstalled = false;
    this.errors = [];
    page.on('pageerror', (err) => this.errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => { if (msg.type() === 'error') this.errors.push(`console: ${msg.text()}`); });
  }

  /**
   * Open a player route. The first call installs the fake clock at noon UTC on `date` (or at `at`); later calls
   * keep that clock (use page.clock.setSystemTime to change the day).
   */
  async open(route = '', { date = TODAY, at = null, preview = false } = {}) {
    if (!this.clockInstalled) {
      await this.page.clock.install({ time: at ?? noonUTC(date) });
      this.clockInstalled = true;
    }
    await this.page.goto(sitePath(route, { preview, base: this.base }));
  }

  /**
   * Another tab of the same browser: same storage, same fake clock (Playwright's clock belongs to the context).
   * Its console errors are collected in its own `errors`.
   */
  async newTab() {
    const tab = new Player(await this.page.context().newPage(), { mobile: this.mobile, base: this.base });
    tab.clockInstalled = this.clockInstalled;
    return tab;
  }

  /** Stop the fake clock (from now on only tick() moves time). Jumps ahead an hour so the target is always ahead. */
  async freezeClock() {
    const now = await this.page.evaluate(() => Date.now());
    await this.page.clock.pauseAt(new Date(now + 3_600_000));
  }

  /** Let `ms` of fake time pass, firing timers and animation frames along the way. */
  async tick(ms) {
    await this.page.clock.runFor(ms);
  }

  /** Let overlay enter/leave animations finish (their timers run on the fake clock too). */
  async settle() {
    await this.tick(300);
  }

  // ---- locators ----
  get intro() { return this.page.locator('.intro-card'); }
  get playButton() { return this.page.locator('.intro-play'); }
  get grid() { return this.page.locator('.grid'); }
  get timerText() { return this.page.locator('.timer-text'); }
  get pauseOverlay() { return this.page.locator('.pause-overlay'); }
  get clueNum() { return this.page.locator('.cluebar-num'); }
  get solvedModal() { return this.page.locator('.modal-solved'); }
  cell(i) { return this.page.locator(`.grid .cell[data-i="${i}"]`); }
  letter(i) { return this.cell(i).locator('.letter'); }

  /** Click on desktop, tap on touch devices. */
  async press(locator) {
    if (this.mobile) await locator.tap();
    else await locator.click();
  }

  async play() {
    await this.press(this.playButton);
    await expect(this.grid).toBeVisible();
  }

  /** Type letters: hardware keyboard on desktop, on-screen keyboard taps on phones. */
  async type(letters) {
    if (!this.mobile) {
      await this.page.keyboard.type(letters);
      return;
    }
    for (const ch of letters.toUpperCase()) await this.page.locator(`.keyboard .kb-key[data-key="${ch}"]`).tap();
  }

  /** Select a square (and its across entry when `dir` is given: tapping the active square toggles direction). */
  async selectCell(i, dir = null) {
    await this.press(this.cell(i));
    if (dir && !(await this.clueNum.textContent()).endsWith(dir === 'across' ? 'A' : 'D')) await this.press(this.cell(i));
    if (dir) await expect(this.clueNum).toHaveText(new RegExp(`${dir === 'across' ? 'A' : 'D'}$`));
  }

  /** Hints menu: kind 'Check' | 'Reveal', scope 'Square' | 'Word' | 'Puzzle'. */
  async hint(kind, scope) {
    await this.press(this.page.locator('.hints-btn'));
    await this.tick(50);
    const section = this.page.locator('.menu .menu-section', { has: this.page.locator('.menu-heading', { hasText: kind }) });
    await this.press(section.getByRole('menuitem', { name: new RegExp(`^${scope}`) }));
    await this.settle(); // the menu closes (and a confirm dialog may open)
  }

  /**
   * Simulate the page being hidden / shown and the window losing / gaining focus, the way the browser reports
   * it: document.visibilityState + visibilitychange, document.hasFocus() + window blur/focus events.
   */
  async setActivity({ visible = true, focused = true }) {
    await this.page.evaluate(({ visible: v, focused: f }) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (v ? 'visible' : 'hidden') });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => !v });
      document.hasFocus = () => f;
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event(f ? 'focus' : 'blur'));
    }, { visible, focused });
  }

  /** The stored progress record for a puzzle (null when none). */
  progress(id) {
    return this.page.evaluate((key) => JSON.parse(localStorage.getItem(key) || 'null'), `xw:v1:progress:${id}`);
  }

  /** Everything recorded by captureShares(). */
  shareLog() {
    return this.page.evaluate(() => window.__shareLog || []);
  }

  /** Wait for exactly `n` shares and return the last one. */
  async lastShare(n = 1) {
    await expect.poll(async () => (await this.shareLog()).length).toBe(n);
    return (await this.shareLog())[n - 1];
  }

  /** The channel the app should use: the native share sheet on touch devices, the clipboard on desktop. */
  get shareChannel() { return this.mobile ? 'share' : 'clipboard'; }
}

/**
 * `test` with a `player` fixture: a Player for the test's page (on-screen keyboard on phones), with share output
 * captured, that fails the test if the page logged any error.
 */
export const test = base.extend({
  player: async ({ page, context, isMobile }, use) => {
    await captureShares(context);
    const player = new Player(page, { mobile: isMobile });
    await use(player);
    expect(player.errors, 'no errors in the browser console').toEqual([]);
  },
});
export { expect };
