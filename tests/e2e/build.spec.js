// `npm run build` (SPEC §4): copies site/ to an output folder; --released-only holds back future puzzles.
// Runs against its own copy of site/ with the fixture puzzles, so other tests publishing meanwhile cannot interfere.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { todayISO } from '../../site/shared/puzzle.js';
import { createServer } from '../../scripts/server.mjs';
import { Player, captureShares } from './support/player.js';
import { FIXTURES, REPO, TODAY, prepareRoot, solutionLetters } from './support/root.js';

/** Run `npm run build -- <args>` with the given root; returns { status, output }. */
function npmBuild(root, args) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['run', 'build', '--', ...args], {
    cwd: REPO,
    env: { ...process.env, XW_ROOT: root },
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 60_000,
  });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

const puzzleFiles = (dir) => readdirSync(path.join(dir, 'puzzles')).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('npm run build -- --released-only leaves out puzzles dated after today', async ({}, testInfo) => {
  const root = prepareRoot(testInfo.outputPath('root'), { dirs: ['site'] });
  const out = testInfo.outputPath('dist');
  const { status, output } = npmBuild(root, ['--released-only', '--out', out]);
  expect(status, output).toBe(0);

  // config.timeZone is null (each solver's own date), so the build uses the earliest date on Earth (UTC+14).
  const today = todayISO('Pacific/Kiritimati');
  const released = Object.keys(FIXTURES).filter((d) => d <= today).sort();
  expect(released).toEqual(expect.arrayContaining(['2026-09-28', '2026-10-02']));
  expect(output).toContain(`released through ${today} in Pacific/Kiritimati, the earliest zone`);

  expect(puzzleFiles(out)).toEqual(released.map((d) => `${d}.json`));
  expect(existsSync(path.join(out, 'puzzles', '2099-12-31.json'))).toBe(false);
  const index = readJson(path.join(out, 'puzzles', 'index.json'));
  expect(index.puzzles.map((p) => p.date)).toEqual(released);
  expect(index.puzzles.map((p) => p.number)).toEqual(released.map((_, i) => i + 1));

  // The rest of the site is copied as-is, ready for GitHub Pages.
  for (const f of ['index.html', 'app.js', 'styles.css', 'config.json', 'manifest.webmanifest', 'shared/puzzle.js', '.nojekyll']) {
    expect(existsSync(path.join(out, f)), f).toBe(true);
  }
  // The source copy is untouched.
  expect(puzzleFiles(path.join(root, 'site'))).toHaveLength(Object.keys(FIXTURES).length);
});

test('npm run build without --released-only keeps every puzzle', async ({}, testInfo) => {
  const root = prepareRoot(testInfo.outputPath('root'), { dirs: ['site'] });
  const out = testInfo.outputPath('dist');
  const { status, output } = npmBuild(root, ['--out', out]);
  expect(status, output).toBe(0);
  const all = Object.keys(FIXTURES).sort();
  expect(puzzleFiles(out)).toEqual(all.map((d) => `${d}.json`));
  expect(readJson(path.join(out, 'puzzles', 'index.json')).puzzles.map((p) => p.date)).toEqual(all);
});

test('the built site works when hosted at a sub-path (like GitHub Pages)', async ({ page, context }, testInfo) => {
  const root = prepareRoot(testInfo.outputPath('root'), { dirs: ['site'] });
  // Serve the build from /site/club/ of another temp root (the dev server only serves its root's site/ folder).
  const host = testInfo.outputPath('host');
  const { status, output } = npmBuild(root, ['--released-only', '--out', path.join(host, 'site', 'club')]);
  expect(status, output).toBe(0);
  const server = createServer({ root: host });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/site/club/`;
  try {
    await captureShares(context);
    const p = new Player(page, { mobile: false, base });
    await p.open();
    await expect(page.locator('.intro-title')).toHaveText('Warm-Up');
    await p.freezeClock();
    await p.play();
    await p.tick(9_000);
    await p.type(solutionLetters(TODAY));
    await p.tick(1_000);
    await p.press(p.solvedModal.getByRole('button', { name: 'Share' }));
    expect((await p.lastShare()).text.split('\n').at(-1)).toBe(base); // the share link points at the sub-path
    // Puzzles held back by --released-only are simply not there.
    await page.goto(`${base}#/puzzle/2099-12-31`);
    await expect(page.locator('.message-title')).toHaveText('No puzzle that day');
    expect(p.errors).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the deploy workflow’s build: --lead-hours, site name in the static metadata, a protected output folder', async ({}, testInfo) => {
  const root = prepareRoot(testInfo.outputPath('root'), { dirs: ['site'] });
  writeFileSync(path.join(root, 'site', 'config.json'), JSON.stringify({
    siteName: 'Puzzle & Pals', tagline: 'Grids for "friends"', timeZone: 'America/Chicago', shareUrl: 'https://friends.example/xw', shareGrid: true,
  }));
  const out = testInfo.outputPath('dist');
  const { status, output } = npmBuild(root, ['--released-only', '--lead-hours', '3', '--out', out]);
  expect(status, output).toBe(0);
  expect(output).toMatch(/released through \d{4}-\d{2}-\d{2} in America\/Chicago, 3 h ahead/);
  expect(existsSync(path.join(out, '.xw-build'))).toBe(true);

  const html = readFileSync(path.join(out, 'index.html'), 'utf8');
  expect(html).toContain('<title>Puzzle &amp; Pals</title>');
  expect(html).toContain('<meta property="og:title" content="Puzzle &amp; Pals">');
  expect(html).toContain('<meta name="description" content="Grids for &quot;friends&quot;">');
  expect(html).toContain('<meta property="og:image" content="https://friends.example/xw/icons/icon-512.png">');
  expect(readJson(path.join(out, 'manifest.webmanifest'))).toMatchObject({ name: 'Puzzle & Pals', short_name: 'Puzzle', description: 'Grids for "friends"' });

  // Building again replaces the earlier build; a folder that is not a build is refused (nothing deleted).
  expect(npmBuild(root, ['--out', out]).status).toBe(0);
  const mine = testInfo.outputPath('not-a-build');
  mkdirSync(mine, { recursive: true });
  writeFileSync(path.join(mine, 'notes.txt'), 'keep me');
  const refused = npmBuild(root, ['--out', mine]);
  expect(refused.status).toBe(1);
  expect(refused.output).toContain('was not made by this script');
  expect(readFileSync(path.join(mine, 'notes.txt'), 'utf8')).toBe('keep me');
  const repoDir = npmBuild(root, ['--out', path.join(root, 'site', 'puzzles'), '--force']);
  expect(repoDir.status).toBe(1);
  expect(repoDir.output).toContain("inside the repository's site/ folder");
});
