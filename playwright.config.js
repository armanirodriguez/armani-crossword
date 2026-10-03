// End-to-end tests (SPEC §7): `npm run test:e2e`.
//
// The dev server runs against a temporary copy of the repo (see tests/e2e/support/root.js), so the real
// site/puzzles, site/config.json, drafts/ and data/user-* files are never written. Projects:
//   desktop    Chromium 1280×800 — player, builder, API and build tests
//   iphone-13  iPhone 13 emulated in Chromium (WebKit is not installed) — player tests
//   pixel-7    Pixel 7 emulation — player tests
//
// Env: XW_E2E_PORT (default 5204), XW_E2E_KEEP=1 keeps the temp root after the run.
// Linux note: Chromium needs its system libraries (`npx playwright install-deps chromium`).

import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.XW_E2E_PORT || 5204);

// One temp root per run. This file is evaluated by the runner and again by every worker process; workers inherit
// the runner's environment, so they all agree on the path. global-setup.js creates and fills the directory.
if (!process.env.XW_E2E_ROOT) {
  process.env.XW_E2E_ROOT = path.join(os.tmpdir(), `xw-e2e-${process.pid}-${Date.now().toString(36)}`);
}

const PLAYER_ONLY = /player\.spec\.js$/;

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/support/global-setup.js',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.env.CI ? 2 : 4,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: 'test-results',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // Dates in the player are computed from the (faked) clock in this zone, so tests are independent of the machine.
    timezoneId: 'UTC',
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'iphone-13', testMatch: PLAYER_ONLY, use: { ...devices['iPhone 13'], browserName: 'chromium' } },
    { name: 'pixel-7', testMatch: PLAYER_ONLY, use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'node scripts/server.mjs --quiet',
    url: `http://127.0.0.1:${PORT}/api/config`,
    env: { XW_ROOT: process.env.XW_E2E_ROOT, PORT: String(PORT), HOST: '127.0.0.1' },
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
