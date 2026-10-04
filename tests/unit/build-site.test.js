// scripts/build-site.mjs: copies site/ -> dist/, optionally holding back puzzles dated after "today".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  BUILD_MARKER, applyManifestMetadata, applySiteMetadata, buildSite, releasedThrough, shortName, siteFileUrl,
} from '../../scripts/build-site.mjs';
import { addDays, todayISO, validatePuzzle } from '../../site/shared/puzzle.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const run = promisify(execFile);

let root;
const fixture = JSON.parse(await fsp.readFile(path.join(REPO, 'tests', 'fixtures', 'sample-puzzle.json'), 'utf8'));

/** The sample puzzle re-dated (its solution is salted with the id, so re-encode via the shared helpers). */
async function puzzleFor(date) {
  const { draftToPuzzle } = await import('../../site/shared/puzzle.js');
  const draft = JSON.parse(await fsp.readFile(path.join(REPO, 'tests', 'fixtures', 'sample-draft.json'), 'utf8'));
  const { puzzle } = draftToPuzzle({ ...draft, date, title: `Puzzle ${date}` });
  return puzzle;
}

async function writeSite(dir, dates, config = {}) {
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(path.join(dir, 'site', 'puzzles'), { recursive: true });
  await fsp.cp(path.join(REPO, 'site', 'shared'), path.join(dir, 'site', 'shared'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'site', 'index.html'), '<!doctype html><title>x</title>');
  await fsp.writeFile(path.join(dir, 'site', 'config.json'), JSON.stringify({ siteName: 'T', timeZone: null, ...config }));
  for (const d of dates) {
    await fsp.writeFile(path.join(dir, 'site', 'puzzles', `${d}.json`), JSON.stringify(await puzzleFor(d)));
  }
  // A stale index that does not match the files: the build must regenerate it.
  await fsp.writeFile(path.join(dir, 'site', 'puzzles', 'index.json'), '{"format":"crossword-index/1","puzzles":[]}');
}

before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'xw-build-test-'));
  assert.equal(fixture.format, 'crossword/1');
});

after(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

test('copies everything and rebuilds the index when not --released-only', async () => {
  await writeSite(root, ['2026-10-01', '2026-10-03', '2030-01-01']);
  const result = await buildSite({ root });
  const dist = path.join(root, 'dist');
  assert.equal(result.out, dist);
  assert.deepEqual(result.dropped, []);
  for (const f of ['index.html', 'config.json', 'shared/grid.js', 'shared/puzzle.js', '.nojekyll', 'puzzles/2030-01-01.json']) {
    await fsp.access(path.join(dist, f));
  }
  const index = JSON.parse(await fsp.readFile(path.join(dist, 'puzzles', 'index.json'), 'utf8'));
  assert.deepEqual(index.puzzles.map((p) => [p.id, p.number]), [['2026-10-01', 1], ['2026-10-03', 2], ['2030-01-01', 3]]);
  // Sources untouched.
  const srcIndex = JSON.parse(await fsp.readFile(path.join(root, 'site', 'puzzles', 'index.json'), 'utf8'));
  assert.deepEqual(srcIndex.puzzles, []);
});

test('--released-only drops future puzzles and keeps numbering', async () => {
  await writeSite(root, ['2026-10-01', '2026-10-03', '2026-10-04', '2026-11-01']);
  const result = await buildSite({ root, releasedOnly: true, today: '2026-10-03', out: 'public' });
  const out = path.join(root, 'public');
  assert.deepEqual(result.kept, ['2026-10-01', '2026-10-03']);
  assert.deepEqual(result.dropped, ['2026-10-04', '2026-11-01']);
  const files = (await fsp.readdir(path.join(out, 'puzzles'))).sort();
  assert.deepEqual(files, ['2026-10-01.json', '2026-10-03.json', 'index.json']);
  const index = JSON.parse(await fsp.readFile(path.join(out, 'puzzles', 'index.json'), 'utf8'));
  assert.deepEqual(index.puzzles.map((p) => [p.id, p.number]), [['2026-10-01', 1], ['2026-10-03', 2]]);
  for (const f of files.filter((n) => n !== 'index.json')) {
    const p = JSON.parse(await fsp.readFile(path.join(out, 'puzzles', f), 'utf8'));
    assert.ok(validatePuzzle(p).ok);
  }
});

test('§8 --released-only goes by date for mini, midi and daily files; index numbers per kind', async () => {
  await writeSite(root, ['2026-10-02', '2026-10-03', '2026-10-04']);
  const puzzles = path.join(root, 'site', 'puzzles');
  for (const [date, kind] of [['2026-10-03', 'mini'], ['2026-10-03', 'midi'], ['2026-10-04', 'mini']]) {
    const draft = JSON.parse(await fsp.readFile(path.join(REPO, 'tests', 'fixtures', 'sample-draft.json'), 'utf8'));
    const { draftToPuzzle } = await import('../../site/shared/puzzle.js');
    const { puzzle } = draftToPuzzle({ ...draft, date, kind });
    await fsp.writeFile(path.join(puzzles, `${puzzle.id}.json`), JSON.stringify(puzzle));
  }
  // A stray, non-puzzle file dated in the future must not ship either.
  await fsp.writeFile(path.join(puzzles, '2026-10-04-copy.json'), '{}');
  const result = await buildSite({ root, releasedOnly: true, today: '2026-10-03', out: 'public' });
  assert.deepEqual(result.kept, ['2026-10-02', '2026-10-03-mini', '2026-10-03-midi', '2026-10-03']);
  assert.deepEqual(result.dropped, ['2026-10-04-mini', '2026-10-04']);
  const out = path.join(root, 'public', 'puzzles');
  assert.deepEqual((await fsp.readdir(out)).sort(),
    ['2026-10-02.json', '2026-10-03-midi.json', '2026-10-03-mini.json', '2026-10-03.json', 'index.json']);
  const index = JSON.parse(await fsp.readFile(path.join(out, 'index.json'), 'utf8'));
  assert.deepEqual(index.puzzles.map((p) => [p.id, p.kind, p.number]), [
    ['2026-10-02', 'daily', 1], ['2026-10-03-mini', 'mini', 1], ['2026-10-03-midi', 'midi', 1], ['2026-10-03', 'daily', 2],
  ]);
  for (const f of (await fsp.readdir(out)).filter((n) => n !== 'index.json')) {
    assert.ok(validatePuzzle(JSON.parse(await fsp.readFile(path.join(out, f), 'utf8'))).ok, f);
  }
});

test('--released-only uses config.timeZone for "today"', async () => {
  const tz = 'Pacific/Honolulu';
  const today = todayISO(tz);
  await writeSite(root, [addDays(today, -1), today, addDays(today, 1)], { timeZone: tz });
  const result = await buildSite({ root, releasedOnly: true });
  assert.equal(result.today, today);
  assert.deepEqual(result.kept, [addDays(today, -1), today]);
});

test('a previous build output is replaced, not merged', async () => {
  await writeSite(root, ['2026-10-01']);
  const dist = path.join(root, 'dist');
  await buildSite({ root });
  await fsp.access(path.join(dist, BUILD_MARKER)); // every build marks its output
  await fsp.writeFile(path.join(dist, 'stale.txt'), 'old');
  await buildSite({ root });
  await assert.rejects(fsp.access(path.join(dist, 'stale.txt')));
  await fsp.access(path.join(dist, BUILD_MARKER));
});

test('refuses to build into the source tree or any folder of the repository', async () => {
  await writeSite(root, ['2026-10-01']);
  await assert.rejects(buildSite({ root, out: 'site' }), /inside the repository's site\/ folder/);
  await assert.rejects(buildSite({ root, out: 'site/puzzles' }), /inside the repository's site\/ folder/);
  await assert.rejects(buildSite({ root, out: '.' }), /is \(or contains\) the repository/);
  await assert.rejects(buildSite({ root, out: '..' }), /is \(or contains\) the repository/);
  for (const dir of ['drafts', 'data', 'builder', 'engine', 'scripts', 'tests', '.git', 'node_modules', '.github']) {
    await fsp.mkdir(path.join(root, dir), { recursive: true });
    await fsp.writeFile(path.join(root, dir, 'keep.txt'), 'precious');
    // Refused even with --force, also below the folder, and even when it looks like an earlier build.
    await fsp.writeFile(path.join(root, dir, BUILD_MARKER), '');
    await assert.rejects(buildSite({ root, out: dir, force: true }), (err) => err.message.includes(`inside the repository's ${dir}/ folder`));
    await assert.rejects(buildSite({ root, out: `${dir}/dist` }), /inside the repository/);
    assert.equal(await fsp.readFile(path.join(root, dir, 'keep.txt'), 'utf8'), 'precious');
  }
  // The real repository's folders are protected too, whatever --root says.
  await assert.rejects(buildSite({ root, out: path.join(REPO, 'drafts') }), /inside the repository's drafts\/ folder/);
  await assert.rejects(buildSite({ root, out: REPO }), /is \(or contains\) the repository/);
  // A symlink does not get around it.
  await fsp.symlink(path.join(root, 'data'), path.join(root, 'data-link'));
  await assert.rejects(buildSite({ root, out: 'data-link/dist' }), /inside the repository's data\/ folder/);
  await fsp.rm(path.join(root, 'data-link'));
  // Bad options are reported before anything is deleted.
  await assert.rejects(buildSite({ root, releasedOnly: true, today: '2026-13-45' }), /YYYY-MM-DD/);
  await fsp.access(path.join(root, 'site', 'index.html'));
});

test('an existing folder that is not an earlier build is only replaced with force', async () => {
  await writeSite(root, ['2026-10-01']);
  const out = path.join(root, 'my-stuff');
  await fsp.mkdir(path.join(out, 'sub'), { recursive: true });
  await fsp.writeFile(path.join(out, 'sub', 'notes.txt'), 'mine');
  await assert.rejects(buildSite({ root, out: 'my-stuff' }), /not empty and was not made by this script/);
  assert.equal(await fsp.readFile(path.join(out, 'sub', 'notes.txt'), 'utf8'), 'mine');
  await buildSite({ root, out: 'my-stuff', force: true });
  await assert.rejects(fsp.access(path.join(out, 'sub', 'notes.txt')));
  await fsp.access(path.join(out, BUILD_MARKER));
  // A file in the way is refused too; an empty folder is fine.
  await fsp.writeFile(path.join(root, 'a-file'), 'x');
  await assert.rejects(buildSite({ root, out: 'a-file' }), /not a folder/);
  await fsp.mkdir(path.join(root, 'empty'));
  await buildSite({ root, out: 'empty' });
  await fsp.access(path.join(root, 'empty', 'index.html'));
});

test('CLI: npm-style flags', async () => {
  await writeSite(root, ['2026-10-01', '2099-01-01']);
  const { stdout } = await run(process.execPath, [
    path.join(REPO, 'scripts', 'build-site.mjs'), '--root', root, '--released-only', '--out', 'cli-out', '--today=2026-10-02',
  ]);
  assert.match(stdout, /1 puzzle\(s\), 1 unreleased held back/);
  const files = (await fsp.readdir(path.join(root, 'cli-out', 'puzzles'))).sort();
  assert.deepEqual(files, ['2026-10-01.json', 'index.json']);
  await assert.rejects(run(process.execPath, [path.join(REPO, 'scripts', 'build-site.mjs'), '--bogus']), /Unknown argument/);
});

// ---------------------------------------------------------------------------
// --lead-hours: which puzzles count as released (the deploy workflow builds hourly with --lead-hours 3)

test('releasedThrough: the date in the site zone at now + lead hours, across zones and DST changes', () => {
  const cases = [
    // [zone, now (UTC), lead hours, expected cutoff]
    ['America/Chicago', '2026-10-03T01:59:00Z', 3, '2026-10-02'], // 20:59 CDT: midnight is 3 h 1 min away
    ['America/Chicago', '2026-10-03T02:00:00Z', 3, '2026-10-03'], // 21:00 CDT
    ['America/Chicago', '2026-10-03T04:59:00Z', 0, '2026-10-02'], // lead 0: exactly midnight local
    ['America/Chicago', '2026-10-03T05:00:00Z', 0, '2026-10-03'],
    // DST starts 2026-03-08 02:00 CST (still CST at midnight): Mar 8 unlocks 06:00Z.
    ['America/Chicago', '2026-03-08T02:59:00Z', 3, '2026-03-07'],
    ['America/Chicago', '2026-03-08T03:00:00Z', 3, '2026-03-08'],
    // ...and Mar 9 (now CDT, UTC-5) unlocks at 05:00Z.
    ['America/Chicago', '2026-03-09T01:59:00Z', 3, '2026-03-08'],
    ['America/Chicago', '2026-03-09T02:00:00Z', 3, '2026-03-09'],
    // DST ends 2026-11-01 02:00 CDT: Nov 1 unlocks 05:00Z (CDT), Nov 2 at 06:00Z (CST).
    ['America/Chicago', '2026-11-01T01:59:00Z', 3, '2026-10-31'],
    ['America/Chicago', '2026-11-01T02:00:00Z', 3, '2026-11-01'],
    ['America/Chicago', '2026-11-02T02:59:00Z', 3, '2026-11-01'],
    ['America/Chicago', '2026-11-02T03:00:00Z', 3, '2026-11-02'],
    ['Asia/Kolkata', '2026-10-02T15:29:00Z', 3, '2026-10-02'], // UTC+5:30: 20:59 IST
    ['Asia/Kolkata', '2026-10-02T15:30:00Z', 3, '2026-10-03'], // 21:00 IST
    // Sydney: AEST (UTC+10) until DST starts on Oct 4 at 02:00, then AEDT (UTC+11).
    ['Australia/Sydney', '2026-10-03T10:59:00Z', 3, '2026-10-03'], // 20:59 AEST
    ['Australia/Sydney', '2026-10-03T11:00:00Z', 3, '2026-10-04'], // 21:00 AEST
    ['Australia/Sydney', '2026-10-04T09:59:00Z', 3, '2026-10-04'], // 20:59 AEDT (UTC+11)
    ['Australia/Sydney', '2026-10-04T10:00:00Z', 3, '2026-10-05'],
    ['UTC', '2026-12-31T21:00:00Z', 3, '2027-01-01'],
    // No zone (each solver's own date): the earliest zone on Earth, UTC+14.
    [null, '2026-10-02T06:59:00Z', 3, '2026-10-02'],
    [null, '2026-10-02T07:00:00Z', 3, '2026-10-03'],
    [null, '2026-10-02T10:00:00Z', 0, '2026-10-03'],
  ];
  for (const [timeZone, now, leadHours, want] of cases) {
    assert.equal(releasedThrough({ timeZone }, { now, leadHours }), want, `${timeZone} ${now} +${leadHours} h`);
  }
  // Defaults: lead 0, now.
  assert.equal(releasedThrough({ timeZone: 'Pacific/Honolulu' }), todayISO('Pacific/Honolulu'));
  assert.throws(() => releasedThrough({}, { now: 'not a time' }), /Invalid time/);
});

test('with the hourly schedule and --lead-hours 3, every puzzle ships 2–3 hours before its midnight', () => {
  // The workflow runs at minute 7 of every UTC hour (GitHub may delay or skip a run). For each zone and each day in
  // a range with DST changes, find the runs whose build includes that day's puzzle: the first must be at most 3 h
  // before local midnight, and at least two runs must happen before midnight (one spare for a skipped run).
  const zones = ['America/Chicago', 'America/Los_Angeles', 'Europe/London', 'Asia/Kolkata', 'Australia/Sydney', 'Pacific/Auckland', null];
  const start = Date.parse('2026-10-01T00:07:00Z');
  for (const timeZone of zones) {
    const zone = timeZone || 'Pacific/Kiritimati';
    const firstRun = new Map(); // date -> first run (ms) whose build includes it
    const runsBefore = new Map(); // date -> runs including it while it is still the day before, locally
    for (let t = start; t < start + 50 * 24 * 3_600_000; t += 3_600_000) {
      const cutoff = releasedThrough({ timeZone }, { now: t, leadHours: 3 });
      if (!firstRun.has(cutoff)) firstRun.set(cutoff, t);
      if (todayISO(zone, new Date(t)) < cutoff) runsBefore.set(cutoff, (runsBefore.get(cutoff) || 0) + 1);
    }
    for (const [date, t] of [...firstRun].slice(1, -1)) {
      const early = (localMidnight(zone, date) - t) / 3_600_000;
      assert.ok(early > 2 && early <= 3, `${zone} ${date}: first deployed ${early.toFixed(2)} h before midnight`);
      assert.ok(runsBefore.get(date) >= 2, `${zone} ${date}: only ${runsBefore.get(date)} run(s) before midnight`);
    }
  }
});

/** The instant (ms) a date starts in a zone. */
function localMidnight(zone, date) {
  let t = Date.parse(`${date}T00:00:00Z`) - 15 * 3_600_000;
  while (todayISO(zone, new Date(t)) < date) t += 60_000;
  return t;
}

test('--released-only --lead-hours uses the site zone, and the CLI checks the value', async () => {
  await writeSite(root, ['2026-10-02', '2026-10-03', '2026-10-04'], { timeZone: 'America/Chicago' });
  const at = '2026-10-03T02:30:00Z'; // 21:30 on Oct 2 in Chicago
  assert.deepEqual((await buildSite({ root, releasedOnly: true, now: at })).kept, ['2026-10-02']);
  const ahead = await buildSite({ root, releasedOnly: true, now: at, leadHours: 3 });
  assert.equal(ahead.today, '2026-10-03');
  assert.deepEqual(ahead.kept, ['2026-10-02', '2026-10-03']);
  assert.deepEqual(ahead.dropped, ['2026-10-04']);
  for (const bad of [-1, 49, NaN, '3']) {
    await assert.rejects(buildSite({ root, releasedOnly: true, leadHours: bad }), /--lead-hours must be/);
  }
  await assert.rejects(buildSite({ root, releasedOnly: true, today: '2026-10-03', leadHours: 3 }), /without --lead-hours/);

  const cli = (...args) => run(process.execPath, [path.join(REPO, 'scripts', 'build-site.mjs'), '--root', root, ...args]);
  const { stdout } = await cli('--released-only', '--lead-hours', '3');
  const expected = releasedThrough({ timeZone: 'America/Chicago' }, { leadHours: 3 });
  assert.match(stdout, new RegExp(`released through ${expected} in America/Chicago, 3 h ahead`));
  await assert.rejects(cli('--released-only', '--lead-hours', 'soon'), /--lead-hours must be a number/);
  await assert.rejects(cli('--released-only', '--lead-hours'), /--lead-hours needs a value/);
});

// ---------------------------------------------------------------------------
// Site name in the static metadata (link previews don't run JavaScript)

const HEAD = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Crossword Club</title>
  <meta name="description" content="A daily crossword for friends.">
  <meta property="og:type" content="website">
  <meta property="og:title" content="Crossword Club">
  <meta property="og:description" content="A daily crossword for friends.">
  <meta name="apple-mobile-web-app-title" content="Crossword">
</head>
<body></body>
</html>
`;

test('applySiteMetadata rewrites the title, description and og tags (escaped), og:image only with a URL', () => {
  const out = applySiteMetadata(HEAD, { siteName: 'Tom & Jerry’s <Club>', tagline: 'Fresh "grids" daily $& more' }, {
    imageUrl: 'https://me.github.io/xw/icons/icon-512.png',
  });
  assert.match(out, /<title>Tom &amp; Jerry’s &lt;Club&gt;<\/title>/);
  assert.match(out, /<meta name="description" content="Fresh &quot;grids&quot; daily \$&amp; more">/);
  assert.match(out, /<meta property="og:title" content="Tom &amp; Jerry’s &lt;Club&gt;">/);
  assert.match(out, /<meta property="og:description" content="Fresh &quot;grids&quot; daily \$&amp; more">\n {2}<meta property="og:image" content="https:\/\/me\.github\.io\/xw\/icons\/icon-512\.png">/);
  assert.match(out, /<meta name="apple-mobile-web-app-title" content="Tom &amp; Jerry’s &lt;Club&gt;">/);
  assert.match(out, /<meta property="og:type" content="website">/);
  assert.equal((out.match(/og:title/g) || []).length, 1);
  assert.doesNotMatch(out, /<Club>/);

  // Without a share URL there is no og:image; an empty config keeps the page's defaults.
  assert.doesNotMatch(applySiteMetadata(HEAD, { siteName: 'X' }), /og:image/);
  assert.equal(applySiteMetadata(HEAD, {}), HEAD);
  assert.equal(applySiteMetadata(HEAD, { siteName: '  ', tagline: null }), HEAD);
  // An existing og:image is updated, not duplicated; a missing tag is added to the head.
  const twice = applySiteMetadata(out, { siteName: 'Y' }, { imageUrl: 'https://y.example/i.png' });
  assert.equal((twice.match(/og:image/g) || []).length, 1);
  assert.match(twice, /og:image" content="https:\/\/y\.example\/i\.png"/);
  assert.match(applySiteMetadata('<head>\n<title>t</title>\n</head>', { tagline: 'T' }), /<meta property="og:description" content="T">\n<\/head>/);
});

test('siteFileUrl, shortName and applyManifestMetadata', () => {
  assert.equal(siteFileUrl('https://me.github.io/xw', 'icons/a.png'), 'https://me.github.io/xw/icons/a.png');
  assert.equal(siteFileUrl('https://me.github.io/xw/', 'icons/a.png'), 'https://me.github.io/xw/icons/a.png');
  assert.equal(siteFileUrl('https://me.github.io/xw/index.html?ref=1#/archive', 'icons/a.png'), 'https://me.github.io/xw/icons/a.png');
  assert.equal(siteFileUrl('https://friends.example', 'icons/a.png'), 'https://friends.example/icons/a.png');
  assert.equal(shortName('Crossword Club'), 'Crossword');
  assert.equal(shortName('Smith Family Crossword'), 'Smith Family');
  assert.equal(shortName('Grids'), 'Grids');
  assert.equal(shortName('Puzzle & Pals'), 'Puzzle');
  assert.equal(shortName('Supercalifragilistic Club'), 'Supercalifragilistic');
  const manifest = { name: 'Crossword Club', short_name: 'Crossword', description: 'Old', icons: [{ src: 'favicon.svg' }] };
  assert.deepEqual(applyManifestMetadata(manifest, { siteName: 'Puzzle Pals Daily', tagline: 'Our grid' }), {
    name: 'Puzzle Pals Daily', short_name: 'Puzzle Pals', description: 'Our grid', icons: [{ src: 'favicon.svg' }],
  });
  assert.deepEqual(applyManifestMetadata(manifest, {}), manifest);
});

test('the build writes the site name into dist/index.html and dist/manifest.webmanifest', async () => {
  await writeSite(root, ['2026-10-01'], { siteName: 'Puzzle <Pals>', tagline: 'Grids & giggles', shareUrl: 'https://pals.example/xw' });
  await fsp.writeFile(path.join(root, 'site', 'index.html'), HEAD);
  await fsp.writeFile(path.join(root, 'site', 'manifest.webmanifest'), JSON.stringify({ name: 'Crossword Club', short_name: 'Crossword', start_url: './' }));
  const logs = [];
  await buildSite({ root, log: (s) => logs.push(s) });
  const dist = path.join(root, 'dist');
  // No icon in this site: no og:image (with a warning).
  let html = await fsp.readFile(path.join(dist, 'index.html'), 'utf8');
  assert.match(html, /<title>Puzzle &lt;Pals&gt;<\/title>/);
  assert.match(html, /og:description" content="Grids &amp; giggles"/);
  assert.doesNotMatch(html, /og:image/);
  assert.ok(logs.some((l) => /no link-preview image/.test(l)), logs.join('\n'));
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(dist, 'manifest.webmanifest'), 'utf8')), {
    name: 'Puzzle <Pals>', short_name: 'Puzzle', description: 'Grids & giggles', start_url: './',
  });
  // With the icon: an absolute og:image under the share URL. The sources are never changed.
  await fsp.mkdir(path.join(root, 'site', 'icons'), { recursive: true });
  await fsp.writeFile(path.join(root, 'site', 'icons', 'icon-512.png'), 'png');
  await buildSite({ root });
  html = await fsp.readFile(path.join(dist, 'index.html'), 'utf8');
  assert.match(html, /<meta property="og:image" content="https:\/\/pals\.example\/xw\/icons\/icon-512\.png">/);
  assert.equal(await fsp.readFile(path.join(root, 'site', 'index.html'), 'utf8'), HEAD);
});

test('the real site/index.html has every tag the build rewrites', async () => {
  const html = await fsp.readFile(path.join(REPO, 'site', 'index.html'), 'utf8');
  const out = applySiteMetadata(html, { siteName: 'Zz Name', tagline: 'Zz tagline' }, { imageUrl: 'https://z.example/i.png' });
  for (const re of [/<title>Zz Name<\/title>/, /name="description" content="Zz tagline"/, /property="og:title" content="Zz Name"/,
    /property="og:description" content="Zz tagline"/, /name="apple-mobile-web-app-title" content="Zz Name"/, /property="og:image" content="https:\/\/z\.example\/i\.png"/]) {
    assert.match(out, re);
  }
  // Each tag was rewritten in place, not added a second time.
  assert.equal(out.split('\n').length, html.split('\n').length + 1); // + og:image
});

// ---------------------------------------------------------------------------
// SPEC §9: "Claude's way" lives in puzzles/claude/ with its own index, released by date the same way

async function writeClaude(dir, list) {
  const { draftToPuzzle } = await import('../../site/shared/puzzle.js');
  const draft = JSON.parse(await fsp.readFile(path.join(REPO, 'tests', 'fixtures', 'sample-draft.json'), 'utf8'));
  const folder = path.join(dir, 'site', 'puzzles', 'claude');
  await fsp.mkdir(folder, { recursive: true });
  for (const [date, kind] of list) {
    const { puzzle } = draftToPuzzle({ ...draft, date, kind, series: 'claude', title: `Claude ${date} ${kind}` });
    await fsp.writeFile(path.join(folder, `${puzzle.id}.json`), JSON.stringify(puzzle));
  }
  // A stale index: the build regenerates it from the files.
  await fsp.writeFile(path.join(folder, 'index.json'), '{"format":"crossword-index/1","puzzles":[]}');
  return folder;
}

test('§9 --released-only also goes by date in puzzles/claude/ and rewrites its index (numbers per kind)', async () => {
  await writeSite(root, ['2026-10-03', '2026-10-04']);
  const folder = await writeClaude(root, [
    ['2026-10-03', 'mini'], ['2026-10-03', 'midi'], ['2026-10-03', 'daily'],
    ['2026-10-04', 'mini'], ['2026-10-04', 'midi'], ['2026-10-04', 'daily'],
  ]);
  // Strays: a future-dated copy in the claude folder, a Claude file in the main folder (past and future), a dated subfolder.
  await fsp.writeFile(path.join(folder, 'claude-2026-10-04-copy.json'), '{}');
  await fsp.writeFile(path.join(root, 'site', 'puzzles', 'claude-2026-10-02.json'), '{}');
  await fsp.writeFile(path.join(root, 'site', 'puzzles', 'claude-2026-10-09.json'), '{}');
  await fsp.mkdir(path.join(folder, 'extra', '2026-10-05'), { recursive: true });
  await fsp.writeFile(path.join(folder, 'extra', '2026-10-05', 'x.json'), '{}');
  await fsp.writeFile(path.join(folder, 'extra', 'keep.txt'), 'ok');

  const result = await buildSite({ root, releasedOnly: true, today: '2026-10-03', out: 'public' });
  assert.deepEqual(result.kept, ['2026-10-03', 'claude-2026-10-03-mini', 'claude-2026-10-03-midi', 'claude-2026-10-03']);
  assert.deepEqual(result.dropped, ['2026-10-04', 'claude-2026-10-04-mini', 'claude-2026-10-04-midi', 'claude-2026-10-04']);
  const out = path.join(root, 'public', 'puzzles');
  assert.deepEqual((await fsp.readdir(out)).sort(), ['2026-10-03.json', 'claude', 'claude-2026-10-02.json', 'index.json']);
  assert.deepEqual((await fsp.readdir(path.join(out, 'claude'))).sort(),
    ['claude-2026-10-03-midi.json', 'claude-2026-10-03-mini.json', 'claude-2026-10-03.json', 'extra', 'index.json']);
  assert.deepEqual(await fsp.readdir(path.join(out, 'claude', 'extra')), ['keep.txt']);

  // The main index never lists Claude puzzles (not even one misplaced in the main folder).
  const main = JSON.parse(await fsp.readFile(path.join(out, 'index.json'), 'utf8'));
  assert.deepEqual(main.puzzles.map((p) => p.id), ['2026-10-03']);
  assert.deepEqual(result.index, main);
  const claude = JSON.parse(await fsp.readFile(path.join(out, 'claude', 'index.json'), 'utf8'));
  assert.deepEqual(claude.puzzles.map((p) => [p.id, p.kind, p.series, p.number]), [
    ['claude-2026-10-03-mini', 'mini', 'claude', 1],
    ['claude-2026-10-03-midi', 'midi', 'claude', 1],
    ['claude-2026-10-03', 'daily', 'claude', 1],
  ]);
  assert.deepEqual(result.indexes.claude, claude);
  for (const f of ['claude-2026-10-03-midi.json', 'claude-2026-10-03-mini.json', 'claude-2026-10-03.json']) {
    assert.ok(validatePuzzle(JSON.parse(await fsp.readFile(path.join(out, 'claude', f), 'utf8'))).ok, f);
  }
  // Sources untouched.
  assert.equal((await fsp.readdir(folder)).length, 9);

  // The next day everything ships, numbered per kind within the series.
  const next = await buildSite({ root, releasedOnly: true, today: '2026-10-04', out: 'public' });
  assert.deepEqual(next.indexes.claude.puzzles.map((p) => [p.id, p.number]), [
    ['claude-2026-10-03-mini', 1], ['claude-2026-10-03-midi', 1], ['claude-2026-10-03', 1],
    ['claude-2026-10-04-mini', 2], ['claude-2026-10-04-midi', 2], ['claude-2026-10-04', 2],
  ]);
  assert.deepEqual(next.index.puzzles.map((p) => [p.id, p.number]), [['2026-10-03', 1], ['2026-10-04', 2]]);
});

test('§9 without --released-only the claude index is rebuilt too; no claude folder is fine (and none is made)', async () => {
  await writeSite(root, ['2026-10-01']);
  await writeClaude(root, [['2030-01-01', 'mini'], ['2026-10-01', 'daily']]);
  const all = await buildSite({ root });
  assert.deepEqual(all.dropped, []);
  assert.deepEqual(all.indexes.claude.puzzles.map((p) => [p.id, p.number]), [['claude-2026-10-01', 1], ['claude-2030-01-01-mini', 1]]);
  const written = JSON.parse(await fsp.readFile(path.join(root, 'dist', 'puzzles', 'claude', 'index.json'), 'utf8'));
  assert.deepEqual(written, all.indexes.claude);

  // Before Claude's first puzzle there is no folder: the build works and does not invent one.
  await writeSite(root, ['2026-10-01', '2099-01-01']);
  const plain = await buildSite({ root, releasedOnly: true, today: '2026-10-02' });
  assert.deepEqual(plain.kept, ['2026-10-01']);
  assert.equal(plain.indexes.claude, undefined);
  assert.deepEqual((await fsp.readdir(path.join(root, 'dist', 'puzzles'))).sort(), ['2026-10-01.json', 'index.json']);

  // A claude folder that is only a symbolic link is never followed (its target must not lose files).
  const elsewhere = path.join(root, 'elsewhere');
  await fsp.mkdir(elsewhere, { recursive: true });
  await fsp.writeFile(path.join(elsewhere, 'claude-2099-01-01.json'), '{}');
  await fsp.symlink(elsewhere, path.join(root, 'site', 'puzzles', 'claude'));
  const linked = await buildSite({ root, releasedOnly: true, today: '2026-10-02' });
  assert.equal(linked.indexes.claude, undefined);
  await fsp.access(path.join(elsewhere, 'claude-2099-01-01.json'));
});
