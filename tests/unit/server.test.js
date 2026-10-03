// Dev server + builder API tests. Each run uses a temporary copy of the parts of the repo the server touches,
// so the real drafts/ and site/puzzles/ are never modified.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createServer, editUserWords, isAllowedHost, isLoopbackAddress, mergeUserClues, puzzleAnswers,
} from '../../scripts/server.mjs';
import { buildIndex, draftEntries, makeDraft, validatePuzzle, decodeSolution } from '../../site/shared/puzzle.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let root;
let server;
let base;
let port;

before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'xw-server-test-'));
  await fsp.cp(path.join(REPO, 'site', 'shared'), path.join(root, 'site', 'shared'), { recursive: true });
  // One published puzzle (the sample, 2026-10-02) — never the real site/puzzles, whose contents change.
  const samplePuzzle = JSON.parse(await fsp.readFile(path.join(REPO, 'tests', 'fixtures', 'sample-puzzle.json'), 'utf8'));
  await fsp.mkdir(path.join(root, 'site', 'puzzles'), { recursive: true });
  await fsp.writeFile(path.join(root, 'site', 'puzzles', `${samplePuzzle.id}.json`), JSON.stringify(samplePuzzle));
  await fsp.writeFile(path.join(root, 'site', 'puzzles', 'index.json'), JSON.stringify(buildIndex([samplePuzzle])));
  await fsp.mkdir(path.join(root, 'drafts'), { recursive: true });
  await fsp.copyFile(path.join(REPO, 'tests', 'fixtures', 'sample-draft.json'), path.join(root, 'drafts', 'sample-mini.json'));
  await fsp.mkdir(path.join(root, 'data'), { recursive: true });
  await fsp.mkdir(path.join(root, 'builder'), { recursive: true });
  await fsp.mkdir(path.join(root, 'engine'), { recursive: true });
  await fsp.mkdir(path.join(root, 'scripts'), { recursive: true });
  // Files for MIME / static tests.
  await fsp.writeFile(path.join(root, 'builder', 'index.html'), '<!doctype html><title>b</title>');
  await fsp.writeFile(path.join(root, 'builder', 'app.css'), 'body{}');
  await fsp.writeFile(path.join(root, 'engine', 'mod.mjs'), 'export {}');
  await fsp.writeFile(path.join(root, 'engine', 'mod.js'), 'export {}');
  await fsp.writeFile(path.join(root, 'site', 'index.html'), '<!doctype html><title>s</title>');
  await fsp.writeFile(path.join(root, 'site', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await fsp.writeFile(path.join(root, 'site', 'manifest.webmanifest'), '{}');
  await fsp.writeFile(path.join(root, 'site', '.secret'), 'hidden');
  await fsp.writeFile(path.join(root, 'data', 'wordlist.txt'), 'CAT;50\n');
  await fsp.writeFile(path.join(root, 'scripts', 'private.mjs'), 'secret');
  await fsp.writeFile(path.join(root, 'package.json'), '{"secret":true}');
  // A symlink inside a served dir that points outside of it must not be followed.
  await fsp.symlink(path.join(root, 'drafts'), path.join(root, 'site', 'escape'));
  await fsp.symlink(os.tmpdir(), path.join(root, 'data', 'tmplink'));

  server = createServer({ root });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fsp.rm(root, { recursive: true, force: true });
});

const api = async (method, url, body, headers = {}) => {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (typeof body !== 'string') init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(base + url, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
};

/** Raw request so the path is sent exactly as written (fetch would normalise "..", "%2e%2e" is kept). */
const raw = (rawPath, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: rawPath, method }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
  });
  req.on('error', reject);
  req.end();
});

const readJson = async (rel) => JSON.parse(await fsp.readFile(path.join(root, rel), 'utf8'));
const exists = (rel) => fsp.access(path.join(root, rel)).then(() => true, () => false);

/** A complete, publishable 5x5 draft (the sample) with a different date / id. */
async function sampleDraft(overrides = {}) {
  const d = JSON.parse(await fsp.readFile(path.join(REPO, 'tests', 'fixtures', 'sample-draft.json'), 'utf8'));
  return { ...d, ...overrides };
}

// ---------------------------------------------------------------------------

test('root redirects to the builder; directories serve index.html', async () => {
  const r = await raw('/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/builder/');
  const b = await raw('/builder');
  assert.equal(b.status, 301);
  assert.equal(b.headers.location, '/builder/');
  const page = await raw('/builder/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.equal(page.headers['cache-control'], 'no-store');
  const site = await raw('/site/index.html?preview=1');
  assert.equal(site.status, 200);
});

test('static files get correct MIME types', async () => {
  const cases = {
    '/builder/app.css': /^text\/css/,
    '/engine/mod.mjs': /^text\/javascript/,
    '/engine/mod.js': /^text\/javascript/,
    '/site/shared/grid.js': /^text\/javascript/,
    '/site/puzzles/index.json': /^application\/json/,
    '/site/icon.svg': /^image\/svg\+xml/,
    '/site/manifest.webmanifest': /^application\/manifest\+json/,
    '/data/wordlist.txt': /^text\/plain/,
  };
  for (const [url, re] of Object.entries(cases)) {
    const r = await raw(url);
    assert.equal(r.status, 200, url);
    assert.match(r.headers['content-type'], re, url);
  }
  const head = await raw('/builder/app.css', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], '6');
});

test('path traversal and private directories are refused', async () => {
  const attempts = [
    '/site/../package.json',
    '/site/%2e%2e/package.json',
    '/site/%2E%2E/%2E%2E/package.json',
    '/site/..%2fpackage.json',
    '/site/..%2f..%2fpackage.json',
    '/data/..%5cpackage.json',
    '/site/shared/../../scripts/private.mjs',
    '/builder/%00index.html',
    '/package.json',
    '/drafts/sample-mini.json',
    '/scripts/private.mjs',
    '/node_modules/',
    '/.git/config',
    '/site/.secret',
    '/site/escape/sample-mini.json',
    '/data/tmplink/',
    '/site/%ZZ',
    '//etc/passwd',
    '/site//../../package.json',
  ];
  for (const p of attempts) {
    const r = await raw(p);
    assert.ok(r.status === 404 || r.status === 400 || r.status === 301, `${p} -> ${r.status}`);
    assert.doesNotMatch(r.body, /secret/, p);
  }
});

test('drafts CRUD', async () => {
  const list0 = await api('GET', '/api/drafts');
  assert.equal(list0.status, 200);
  assert.ok(list0.json.some((d) => d.id === 'sample-mini' && d.width === 5 && d.date === '2026-10-02'));

  const draft = makeDraft({ id: 'test-draft', width: 7, title: 'Test', author: 'Me' });
  draft.cells[0] = '#';
  draft.cells[1] = 'A';
  const put = await api('PUT', '/api/drafts/test-draft', draft);
  assert.equal(put.status, 200);
  assert.equal(put.json.ok, true);
  assert.ok(put.json.updatedAt);

  const got = await api('GET', '/api/drafts/test-draft');
  assert.equal(got.status, 200);
  assert.equal(got.json.title, 'Test');
  assert.equal(got.json.cells[1], 'A');
  assert.equal(got.json.updatedAt, put.json.updatedAt);
  assert.equal(got.json.createdAt, draft.createdAt);

  // Saving again keeps createdAt and bumps updatedAt; the newest draft is listed first.
  await new Promise((r) => setTimeout(r, 5));
  const put2 = await api('PUT', '/api/drafts/test-draft', { ...got.json, title: 'Renamed', createdAt: undefined });
  assert.equal(put2.status, 200);
  assert.ok(put2.json.updatedAt > put.json.updatedAt);
  const saved = await readJson('drafts/test-draft.json');
  assert.equal(saved.createdAt, draft.createdAt);
  const list = await api('GET', '/api/drafts');
  assert.equal(list.json[0].id, 'test-draft');
  assert.equal(list.json[0].title, 'Renamed');

  // No temp files left behind by atomic writes.
  const names = await fsp.readdir(path.join(root, 'drafts'));
  assert.ok(names.every((n) => !n.endsWith('.tmp')), names.join(','));

  // The list also reports what the builder recorded about publishing (publishedAt / publishedDate).
  await api('PUT', '/api/drafts/test-draft', { ...got.json, publishedAt: '2026-10-01T10:00:00.000Z', publishedDate: '2026-10-03' });
  const listed = (await api('GET', '/api/drafts')).json.find((d) => d.id === 'test-draft');
  assert.equal(listed.publishedAt, '2026-10-01T10:00:00.000Z');
  assert.equal(listed.publishedDate, '2026-10-03');

  const del = await api('DELETE', '/api/drafts/test-draft');
  assert.equal(del.status, 200);
  assert.equal((await api('GET', '/api/drafts/test-draft')).status, 404);
  assert.equal((await api('DELETE', '/api/drafts/test-draft')).status, 404);
});

test('draft validation errors', async () => {
  const good = makeDraft({ id: 'shape', width: 5 });
  const cases = [
    ['/api/drafts/Bad_ID', good],
    ['/api/drafts/shape', { ...good, id: 'other' }],
    ['/api/drafts/shape', { ...good, cells: ['A'] }],
    ['/api/drafts/shape', { ...good, cells: good.cells.map(() => 'ab') }],
    ['/api/drafts/shape', { ...good, width: 99, height: 99 }],
    ['/api/drafts/shape', { ...good, locked: [999] }],
    ['/api/drafts/shape', { ...good, date: '2026-02-30' }],
    ['/api/drafts/shape', { ...good, symmetry: 'diagonal' }],
    ['/api/drafts/shape', { ...good, clues: { CAT: 5 } }],
    ['/api/drafts/shape', [1, 2, 3]],
  ];
  for (const [url, body] of cases) {
    const r = await api('PUT', url, body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.ok(r.json.error);
  }
  const badJson = await api('PUT', '/api/drafts/shape', '{not json', { 'Content-Type': 'application/json' });
  assert.equal(badJson.status, 400);
  assert.equal((await api('GET', '/api/drafts/..%2Fpackage')).status, 400);
  assert.equal(await exists('drafts/shape.json'), false);
});

test('JSON body size limit returns 413', async () => {
  const big = makeDraft({ id: 'big', width: 5 });
  big.note = 'x'.repeat(1.5 * 1024 * 1024);
  const r = await api('PUT', '/api/drafts/big', big);
  assert.equal(r.status, 413);
  assert.equal(await exists('drafts/big.json'), false);
});

test('unknown endpoints and wrong methods', async () => {
  assert.equal((await api('GET', '/api/nope')).status, 404);
  const r = await api('POST', '/api/drafts');
  assert.equal(r.status, 405);
  assert.match(r.headers.get('allow'), /GET/);
  assert.equal((await raw('/site/index.html', 'POST')).status, 405);
});

test('publish: validation errors are 422 with errors and warnings', async () => {
  const noClues = await sampleDraft({ date: '2026-12-01', clues: {} });
  const r = await api('POST', '/api/publish', { draft: noClues });
  assert.equal(r.status, 422);
  assert.ok(Array.isArray(r.json.errors) && r.json.errors.some((e) => /needs a clue/.test(e)));
  assert.ok(Array.isArray(r.json.warnings));

  const noDate = await sampleDraft({ date: '' });
  const r2 = await api('POST', '/api/publish', { draft: noDate });
  assert.equal(r2.status, 422);
  assert.ok(r2.json.errors.some((e) => /release date/.test(e)));

  const unfilled = await sampleDraft({ date: '2026-12-01' });
  unfilled.cells = unfilled.cells.map((c, i) => (i === 3 ? '' : c));
  const r3 = await api('POST', '/api/publish', { draft: unfilled });
  assert.equal(r3.status, 422);

  assert.equal((await api('POST', '/api/publish', { nope: 1 })).status, 400);
  assert.equal(await exists('site/puzzles/2026-12-01.json'), false);
});

test('publish writes the puzzle, rebuilds the numbered index, 409s on taken dates', async () => {
  const d1 = await sampleDraft({ date: '2026-11-01', title: 'November' });
  const r1 = await api('POST', '/api/publish', { draft: d1 });
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  assert.equal(r1.json.ok, true);
  assert.equal(r1.json.url, '/site/#/puzzle/2026-11-01');
  assert.equal(r1.json.puzzle.id, '2026-11-01');
  assert.ok(r1.json.puzzle.publishedAt);

  const file = await readJson('site/puzzles/2026-11-01.json');
  assert.ok(validatePuzzle(file).ok, validatePuzzle(file).errors.join('; '));
  assert.ok(file.publishedAt);
  assert.equal(decodeSolution(file.solution, file.id), d1.cells.join(''));

  // Publish an earlier date: numbering follows date order.
  const r2 = await api('POST', '/api/publish', { draft: await sampleDraft({ date: '2026-10-15', title: 'Mid October' }) });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.number, 2);
  const index = await readJson('site/puzzles/index.json');
  assert.deepEqual(index.puzzles.map((p) => [p.date, p.number]), [['2026-10-02', 1], ['2026-10-15', 2], ['2026-11-01', 3]]);
  assert.deepEqual((await api('GET', '/api/published')).json, index);

  // Date already taken.
  const again = await api('POST', '/api/publish', { draft: await sampleDraft({ date: '2026-11-01', title: 'Replacement' }) });
  assert.equal(again.status, 409);
  assert.equal(again.json.existing.title, 'November');
  assert.equal((await readJson('site/puzzles/2026-11-01.json')).title, 'November');

  const over = await api('POST', '/api/publish', { draft: await sampleDraft({ date: '2026-11-01', title: 'Replacement' }), overwrite: true });
  assert.equal(over.status, 200);
  assert.equal(over.json.replaced, true);
  assert.equal((await readJson('site/puzzles/2026-11-01.json')).title, 'Replacement');
  assert.equal((await readJson('site/puzzles/index.json')).puzzles.length, 3);
});

test('unpublish removes the file and renumbers the index', async () => {
  await api('POST', '/api/publish', { draft: await sampleDraft({ date: '2027-01-05' }) });
  await api('POST', '/api/publish', { draft: await sampleDraft({ date: '2027-01-06' }) });
  const before = (await api('GET', '/api/published')).json.puzzles;
  const n5 = before.find((p) => p.date === '2027-01-05').number;

  const del = await api('DELETE', '/api/published/2027-01-05');
  assert.equal(del.status, 200);
  assert.equal(await exists('site/puzzles/2027-01-05.json'), false);
  const after = (await api('GET', '/api/published')).json.puzzles;
  assert.equal(after.length, before.length - 1);
  assert.equal(after.find((p) => p.date === '2027-01-06').number, n5);
  assert.deepEqual(del.json.index.puzzles, after);

  assert.equal((await api('DELETE', '/api/published/2027-01-05')).status, 404);
  assert.equal((await api('DELETE', '/api/published/not-a-date')).status, 400);
  assert.equal((await api('DELETE', '/api/published/..%2F..%2Fpackage')).status, 400);
});

test('publishing merges clues into user-clues (most recent first, deduped)', async () => {
  const before = (await api('GET', '/api/user-clues')).json;
  assert.equal(typeof before, 'object');
  const d = await sampleDraft({ date: '2027-02-01' });
  d.clues = { ...d.clues, GASP: 'Brand new gasp clue' };
  assert.equal((await api('POST', '/api/publish', { draft: d })).status, 200);
  const d2 = await sampleDraft({ date: '2027-02-02' });
  d2.clues = { ...d2.clues, GASP: 'Even newer gasp clue' };
  assert.equal((await api('POST', '/api/publish', { draft: d2 })).status, 200);

  const clues = (await api('GET', '/api/user-clues')).json;
  assert.equal(clues.GASP[0], 'Even newer gasp clue');
  assert.equal(clues.GASP[1], 'Brand new gasp clue');
  assert.equal(clues.GASP.filter((c) => c === 'Sharp intake of breath').length, 1);
  assert.equal(clues.DELTA[0], "River's mouth, often");
  // Republishing a clue moves it to the front instead of duplicating it.
  const d3 = await sampleDraft({ date: '2027-02-03' });
  d3.clues = { ...d3.clues, GASP: '  brand NEW gasp clue ' };
  await api('POST', '/api/publish', { draft: d3 });
  const c3 = (await api('GET', '/api/user-clues')).json.GASP;
  assert.equal(c3[0], 'brand NEW gasp clue');
  assert.equal(c3.filter((c) => c.toLowerCase() === 'brand new gasp clue').length, 1);
});

test('mergeUserClues ignores incomplete entries and caps history', () => {
  const draft = makeDraft({ id: 'x', width: 3 });
  draft.cells = ['C', 'A', 'T', 'A', 'R', 'E', 'T', 'E', 'N'];
  draft.clues = { CAT: 'Feline', ARE: 'Exist', TEN: 'Decade', ATE: 'Dined', TEE: '' };
  let existing = { CAT: Array.from({ length: 30 }, (_, i) => `old ${i}`) };
  existing = mergeUserClues(existing, draft);
  assert.equal(existing.CAT[0], 'Feline');
  assert.equal(existing.CAT.length, 20);
  assert.equal(existing.TEE, undefined);
  assert.deepEqual(Object.keys(existing), [...Object.keys(existing)].sort());
});

test('config: defaults, partial updates, validation', async () => {
  const g = await api('GET', '/api/config');
  assert.equal(g.status, 200);
  assert.equal(g.json.siteName, 'Armani Crossword');
  assert.equal(g.json.shareGrid, true);
  assert.equal(g.json.timeZone, null);

  // Preserve keys the builder does not know about; drop the legacy passcode key (the site has no login).
  await fsp.writeFile(path.join(root, 'site', 'config.json'), JSON.stringify({ siteName: 'Old', extraKey: 42, accessCodeHash: 'abc' }));
  assert.equal((await api('GET', '/api/config')).json.accessCodeHash, undefined);
  const p = await api('PUT', '/api/config', { siteName: '  Friends XW ', timeZone: 'America/New_York', shareGrid: false });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const file = await readJson('site/config.json');
  assert.equal(file.siteName, 'Friends XW');
  assert.equal(file.tagline, '');
  assert.equal(file.timeZone, 'America/New_York');
  assert.equal(file.shareGrid, false);
  assert.equal(file.extraKey, 42);
  assert.equal('accessCodeHash' in file, false);
  assert.deepEqual(p.json, file);

  // Partial updates leave the rest alone; '' / null time zone = each solver's local date.
  await api('PUT', '/api/config', { tagline: 'Hi' });
  assert.equal((await readJson('site/config.json')).siteName, 'Friends XW');
  await api('PUT', '/api/config', { timeZone: '' });
  assert.equal((await readJson('site/config.json')).timeZone, null);
  await api('PUT', '/api/config', { timeZone: 'Europe/Paris' });
  await api('PUT', '/api/config', { timeZone: null });
  assert.equal((await readJson('site/config.json')).timeZone, null);

  assert.equal((await api('PUT', '/api/config', { timeZone: 'Mars/Olympus' })).status, 400);
  assert.equal((await api('PUT', '/api/config', { shareGrid: 'yes' })).status, 400);
  assert.equal((await api('PUT', '/api/config', { shareUrl: 'javascript:alert(1)' })).status, 400);
  assert.equal((await api('PUT', '/api/config', { siteName: 'x'.repeat(500) })).status, 400);
  assert.equal((await api('PUT', '/api/config', [1])).status, 400);
  const ok = await api('PUT', '/api/config', { shareUrl: 'https://example.com/xw/' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.shareUrl, 'https://example.com/xw/');
  assert.equal((await api('PUT', '/api/config', { shareUrl: '' })).json.shareUrl, '');
});

test('user-words: GET/PUT text and PATCH edits', async () => {
  const g = await api('GET', '/api/user-words');
  assert.equal(g.status, 200);
  assert.equal(g.text, '');
  assert.match(g.headers.get('content-type'), /^text\/plain/);

  const put = await api('PUT', '/api/user-words', '# mine\r\nPUMPKIN;80\n-ETUI', { 'Content-Type': 'text/plain' });
  assert.equal(put.status, 200);
  assert.equal((await api('GET', '/api/user-words')).text, '# mine\nPUMPKIN;80\n-ETUI\n');

  const patch = await api('PATCH', '/api/user-words', { ban: ['oreo'], add: [['spooky', 77], ['pumpkin', 90]], unban: ['etui'] });
  assert.equal(patch.status, 200);
  assert.equal(patch.json.text, '# mine\n-OREO\nSPOOKY;77\nPUMPKIN;90\n');
  assert.equal(await fsp.readFile(path.join(root, 'data', 'user-words.txt'), 'utf8'), patch.json.text);

  const json = await api('PUT', '/api/user-words', { text: 'A;1' });
  assert.equal(json.status, 200);
  assert.equal((await api('GET', '/api/user-words')).text, 'A;1\n');
});

test('editUserWords keeps comments and replaces lines for the same word', () => {
  const text = '# header\nCAT;10\n\n-DOG\n';
  assert.equal(editUserWords(text, { add: [['cat', 60]] }), '# header\n\n-DOG\nCAT;60\n');
  assert.equal(editUserWords(text, { ban: ['cat'] }), '# header\n\n-DOG\n-CAT\n');
  assert.equal(editUserWords(text, { unban: ['dog'] }), '# header\nCAT;10\n\n');
  assert.equal(editUserWords(text, { remove: ['cat', 'dog'] }), '# header\n\n');
  assert.equal(editUserWords('', { add: [['x y z', 150]] }), 'XYZ;100\n');
});

test('API writes are atomic and leave no temp files', async () => {
  // Many concurrent saves of the same draft: the file must always be complete JSON.
  const d = makeDraft({ id: 'race', width: 9 });
  await Promise.all(Array.from({ length: 20 }, (_, i) => api('PUT', '/api/drafts/race', { ...d, title: `T${i}` })));
  const saved = await readJson('drafts/race.json');
  assert.match(saved.title, /^T\d+$/);
  for (const dir of ['drafts', 'site/puzzles', 'data', 'site']) {
    const names = await fsp.readdir(path.join(root, dir));
    assert.ok(names.every((n) => !n.endsWith('.tmp')), `${dir}: ${names.join(',')}`);
  }
});

// ---------------------------------------------------------------------------
// Several builder tabs on one draft: optimistic concurrency with If-Match (review finding: silent overwrites)

test('PUT /api/drafts with If-Match refuses to overwrite a newer save or to recreate a deleted draft', async () => {
  const d = makeDraft({ id: 'two-tabs', width: 5, title: 'Original' });
  const created = await api('PUT', '/api/drafts/two-tabs', d, { 'If-None-Match': '*' });
  assert.equal(created.status, 200);
  const v1 = created.json.updatedAt;
  // Create-only fails once it exists.
  const again = await api('PUT', '/api/drafts/two-tabs', d, { 'If-None-Match': '*' });
  assert.equal(again.status, 409);
  assert.equal(again.json.conflict, 'exists');

  const got = await api('GET', '/api/drafts/two-tabs');
  assert.equal(got.headers.get('etag'), JSON.stringify(v1));

  // Tab A saves on top of v1: fine, and the version always moves forward.
  const a = await api('PUT', '/api/drafts/two-tabs', { ...d, note: 'from tab A' }, { 'If-Match': JSON.stringify(v1) });
  assert.equal(a.status, 200);
  const v2 = a.json.updatedAt;
  assert.ok(v2 > v1, `${v2} > ${v1}`);
  // Tab B still thinks the draft is at v1: refused, nothing overwritten.
  const b = await api('PUT', '/api/drafts/two-tabs', { ...d, title: 'from tab B' }, { 'If-Match': JSON.stringify(v1) });
  assert.equal(b.status, 409);
  assert.equal(b.json.conflict, 'changed');
  assert.equal(b.json.updatedAt, v2);
  let disk = await readJson('drafts/two-tabs.json');
  assert.equal(disk.note, 'from tab A');
  assert.equal(disk.title, 'Original');
  // Unquoted and weak forms of the version are accepted too.
  assert.equal((await api('PUT', '/api/drafts/two-tabs', { ...disk, title: 'B2' }, { 'If-Match': `W/"${v2}"` })).status, 200);
  disk = await readJson('drafts/two-tabs.json');

  // Deleted in one tab: a stale tab's save does not bring it back...
  const v3 = (await api('GET', '/api/drafts/two-tabs')).json.updatedAt;
  assert.equal((await api('DELETE', '/api/drafts/two-tabs')).status, 200);
  const stale = await api('PUT', '/api/drafts/two-tabs', disk, { 'If-Match': JSON.stringify(v3) });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.conflict, 'deleted');
  assert.equal(await exists('drafts/two-tabs.json'), false);
  // ...unless the user explicitly chooses to keep their version (no If-Match = overwrite / recreate).
  assert.equal((await api('PUT', '/api/drafts/two-tabs', disk)).status, 200);
  disk = await readJson('drafts/two-tabs.json');
  assert.equal(disk.title, 'B2');
  await api('DELETE', '/api/drafts/two-tabs');
});

test('draft versions are unique even for saves in the same millisecond', async () => {
  const d = makeDraft({ id: 'fast-saves', width: 5 });
  const stamps = [];
  for (let i = 0; i < 15; i++) stamps.push((await api('PUT', '/api/drafts/fast-saves', { ...d, title: `T${i}` })).json.updatedAt);
  assert.equal(new Set(stamps).size, stamps.length);
  assert.deepEqual([...stamps].sort(), stamps);
  await api('DELETE', '/api/drafts/fast-saves');
});

// ---------------------------------------------------------------------------
// Security (review findings: LAN exposure, CSRF via text/plain, DNS rebinding)

test('API writes need application/json and the same origin; foreign Host headers are refused', async () => {
  const draft = await sampleDraft({ date: '2027-05-05', title: 'CSRF' });
  // A cross-origin "simple request" (text/plain, no preflight) cannot publish.
  const plain = await api('POST', '/api/publish', JSON.stringify({ draft, overwrite: true }), { 'Content-Type': 'text/plain' });
  assert.equal(plain.status, 415);
  const form = await api('POST', '/api/publish', 'draft=1', { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(form.status, 415);
  assert.equal(await exists('site/puzzles/2027-05-05.json'), false);

  // Another website (Origin / Sec-Fetch-Site) is refused even with a JSON body.
  const evil = await api('POST', '/api/publish', { draft }, { Origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.equal((await api('POST', '/api/publish', { draft }, { Origin: 'null' })).status, 403);
  assert.equal((await api('DELETE', '/api/drafts/sample-mini', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await api('PUT', '/api/config', { siteName: 'x' }, { Origin: `http://localhost:${port + 1}` })).status, 403);
  assert.equal(await exists('site/puzzles/2027-05-05.json'), false);
  assert.equal(await exists('drafts/sample-mini.json'), true);

  // The builder itself (same origin) works.
  const ok = await api('POST', '/api/publish', { draft }, { Origin: base, 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal((await api('DELETE', '/api/published/2027-05-05', undefined, { Origin: base })).status, 200);
  // PUT user-words keeps accepting text/plain (PUT always needs a CORS preflight, which is refused).
  const before = (await api('GET', '/api/user-words')).text;
  assert.equal((await api('PUT', '/api/user-words', before, { 'Content-Type': 'text/plain', Origin: base })).status, 200);

  // DNS rebinding: a page on attacker.example resolving to 127.0.0.1 sends its own Host header.
  for (const host of ['attacker.example', `attacker.example:${port}`, 'evil.localhost.example.com']) {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/drafts', headers: { Host: host } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(r, 403, host);
  }
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `${os.hostname()}:${port}`, 'app.localhost']) {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/config', headers: { Host: host } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(r, 200, host);
  }
});

test('isLoopbackAddress / isAllowedHost', () => {
  for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(a), true, a);
  for (const a of ['192.168.1.75', '::ffff:192.168.1.75', '10.0.0.1', 'fe80::1', '', undefined]) assert.equal(isLoopbackAddress(a), false, String(a));
  assert.equal(isAllowedHost('localhost:5173'), true);
  assert.equal(isAllowedHost('LOCALHOST.'), true);
  assert.equal(isAllowedHost('127.0.0.1'), true);
  assert.equal(isAllowedHost('[::1]:5173'), true);
  assert.equal(isAllowedHost('attacker.example'), false);
  assert.equal(isAllowedHost('localhost.attacker.example'), false);
  assert.equal(isAllowedHost(''), false);
  assert.equal(isAllowedHost('crossword.example:5173', ['crossword.example']), true);
  assert.equal(isAllowedHost(undefined), true); // not a browser
});

/** First non-internal IPv4 address of this machine (a connection to it is not from loopback). */
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

test('other devices on the network only get the player site, without unreleased puzzles', { skip: !lanAddress() && 'no network interface' }, async () => {
  const ip = lanAddress();
  // A separate server bound to the LAN address only, so requests to it arrive from a non-loopback address.
  const lanServer = createServer({ root });
  await new Promise((resolve) => lanServer.listen(0, ip, resolve));
  const lanBase = `http://${ip}:${lanServer.address().port}`;
  const get = async (url, init) => {
    const res = await fetch(lanBase + url, { redirect: 'manual', ...init });
    return { status: res.status, text: await res.text(), headers: res.headers };
  };
  try {
    // Publish one released and one future puzzle (through the loopback server).
    const released = '2026-09-30';
    const future = '2099-06-01';
    for (const date of [released, future]) {
      const r = await api('POST', '/api/publish', { draft: await sampleDraft({ date, title: `LAN ${date}` }), overwrite: true });
      assert.equal(r.status, 200, JSON.stringify(r.json));
    }
    // The player site works...
    assert.equal((await get('/site/index.html')).status, 200);
    assert.equal((await get('/site/shared/puzzle.js')).status, 200);
    const root302 = await get('/');
    assert.equal(root302.status, 302);
    assert.equal(root302.headers.get('location'), '/site/');
    assert.equal((await get(`/site/puzzles/${released}.json`)).status, 200);
    // ...but scheduled puzzles are held back, exactly like the deployed site.
    assert.equal((await get(`/site/puzzles/${future}.json`)).status, 404);
    assert.equal((await get(`/site//puzzles/${future}.json`)).status, 404);
    assert.equal((await get(`/site/puzzles/%32099-06-01.json`)).status, 404);
    const index = JSON.parse((await get('/site/puzzles/index.json')).text);
    assert.ok(index.puzzles.some((p) => p.date === released));
    assert.ok(!index.puzzles.some((p) => p.date === future));
    const fullIndex = (await api('GET', '/api/published')).json;
    assert.equal(index.puzzles.find((p) => p.date === released).number, fullIndex.puzzles.find((p) => p.date === released).number);

    // The builder, the API (reads and writes), the engine and the raw data are this computer's only.
    for (const url of ['/builder/', '/api/drafts', '/api/drafts/sample-mini', '/api/config', '/engine/mod.js', '/data/wordlist.txt']) {
      assert.equal((await get(url)).status, 403, url);
    }
    assert.equal((await get('/api/drafts/sample-mini', { method: 'DELETE' })).status, 403);
    assert.equal((await get(`/api/published/${released}`, { method: 'DELETE' })).status, 403);
    assert.equal((await get('/api/user-words', { method: 'PUT', body: '-THE\n' })).status, 403);
    assert.equal((await get('/site/index.html', { method: 'POST', body: 'x' })).status, 405);
    assert.equal(await exists('drafts/sample-mini.json'), true);
    assert.equal(await exists(`site/puzzles/${released}.json`), true);

    for (const date of [released, future]) await api('DELETE', `/api/published/${date}`);
  } finally {
    lanServer.closeAllConnections?.();
    await new Promise((resolve) => lanServer.close(resolve));
  }
});

test('malformed percent-encoding in API paths is a 400, not a 500', async () => {
  for (const [method, url] of [['GET', '/api/drafts/%E0%A4%A'], ['PUT', '/api/drafts/%E0%A4%A'], ['DELETE', '/api/published/%ZZ']]) {
    const r = await api(method, url, method === 'PUT' ? makeDraft({ id: 'x', width: 3 }) : undefined);
    assert.equal(r.status, 400, `${method} ${url}`);
    assert.equal(r.json.error, 'Malformed URL');
  }
});

test('a damaged user-clues.json never half-fails a publish', async () => {
  const file = path.join(root, 'data', 'user-clues.json');
  const good = await fsp.readFile(file, 'utf8').catch(() => null);
  await fsp.writeFile(file, '{"GASP": ["old clue"],\n');
  try {
    // Reading it degrades to "no remembered clues" with a warning instead of a 500.
    const g = await api('GET', '/api/user-clues');
    assert.equal(g.status, 200);
    assert.deepEqual(g.json, {});
    assert.match(decodeURIComponent(g.headers.get('x-xw-warning')), /damaged/);

    const d = await sampleDraft({ date: '2027-03-03' });
    const r = await api('POST', '/api/publish', { draft: d });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.json.serverWarnings.some((w) => /user-clues\.json was damaged/.test(w)), r.json.serverWarnings.join('; '));
    assert.equal(await exists('site/puzzles/2027-03-03.json'), true);
    // The damaged file was kept aside and a fresh one holds this puzzle's clues.
    const names = await fsp.readdir(path.join(root, 'data'));
    const aside = names.find((n) => n.startsWith('user-clues.json.bad-'));
    assert.ok(aside, names.join(','));
    assert.equal(await fsp.readFile(path.join(root, 'data', aside), 'utf8'), '{"GASP": ["old clue"],\n');
    assert.equal((await readJson('data/user-clues.json')).GASP[0], d.clues.GASP);
    // A retry is a normal "already published" 409, not a mystery.
    assert.equal((await api('POST', '/api/publish', { draft: d })).status, 409);
    await fsp.rm(path.join(root, 'data', aside));
    await api('DELETE', '/api/published/2027-03-03');
  } finally {
    if (good === null) await fsp.rm(file, { force: true });
    else await fsp.writeFile(file, good);
  }
});

test('GET /api/recent-answers lists the answers of puzzles published within N days before or after a date', async () => {
  const sample = await sampleDraft();
  const sampleAnswers = [...new Set(draftEntries(sample).all.map((e) => e.answer))].sort();
  // The sample puzzle published on three dates (every published puzzle has the same answers).
  const dates = ['2028-01-10', '2028-01-20', '2028-02-15'];
  for (const date of dates) {
    const r = await api('POST', '/api/publish', { draft: await sampleDraft({ date, title: `Recent ${date}` }) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  try {
    // puzzleAnswers decodes a published file back to its answers.
    assert.deepEqual([...new Set(puzzleAnswers(await readJson(`site/puzzles/${dates[0]}.json`)))].sort(), sampleAnswers);

    // 30 days around Jan 15 (the default window): Jan 10 and Jan 20, not Feb 15. Dates are sorted.
    let r = await api('GET', '/api/recent-answers?date=2028-01-15');
    assert.equal(r.status, 200);
    assert.equal(r.json.days, 30);
    assert.deepEqual(Object.keys(r.json.answers).sort(), sampleAnswers);
    for (const list of Object.values(r.json.answers)) assert.deepEqual(list, ['2028-01-10', '2028-01-20']);

    // Puzzles scheduled AFTER the date count too; the date itself never does (that is the draft's own puzzle).
    r = await api('GET', '/api/recent-answers?date=2028-01-20&days=30');
    assert.deepEqual(r.json.answers[sampleAnswers[0]], ['2028-01-10', '2028-02-15']);
    r = await api('GET', '/api/recent-answers?date=2028-01-20&days=5');
    assert.deepEqual(r.json.answers, {});
    r = await api('GET', '/api/recent-answers?date=2028-01-25&days=5');
    assert.deepEqual(r.json.answers[sampleAnswers[0]], ['2028-01-20']);

    // The cache follows the index: unpublishing (or publishing) is seen at once.
    await api('DELETE', '/api/published/2028-01-10');
    r = await api('GET', '/api/recent-answers?date=2028-01-15&days=30');
    assert.deepEqual(r.json.answers[sampleAnswers[0]], ['2028-01-20']);
    await api('POST', '/api/publish', { draft: await sampleDraft({ date: '2028-01-10' }) });
    r = await api('GET', '/api/recent-answers?date=2028-01-15&days=30');
    assert.deepEqual(r.json.answers[sampleAnswers[0]], ['2028-01-10', '2028-01-20']);

    // A damaged puzzle file is skipped, not a 500.
    await fsp.writeFile(path.join(root, 'site', 'puzzles', '2028-01-12.json'), '{"broken": ');
    r = await api('GET', '/api/recent-answers?date=2028-01-15&days=30');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.answers[sampleAnswers[0]], ['2028-01-10', '2028-01-20']);
    await fsp.rm(path.join(root, 'site', 'puzzles', '2028-01-12.json'));

    for (const bad of ['', '?date=2028-02-30', '?date=2028-01-15&days=-1', '?date=2028-01-15&days=1.5', '?date=2028-01-15&days=999', '?date=2028-01-15&days=x']) {
      const b = await api('GET', `/api/recent-answers${bad}`);
      assert.equal(b.status, 400, bad);
      assert.match(b.json.error, /date must be|days must be/);
    }
  } finally {
    for (const date of dates) await api('DELETE', `/api/published/${date}`);
  }
});
