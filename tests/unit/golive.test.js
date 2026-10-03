// "Put it online" (GET/POST /api/go-live, SPEC §4) against throwaway git repositories with a bare repository as
// "origin". Every repository lives in a fresh temp dir — never this project's own .git — and git runs with no global
// or system config (GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1), so the user's settings cannot leak in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createServer, classifyGitFailure, githubPagesUrl, goLiveCommitMessage, parseNameStatusZ, parseStatusZ, redactSecrets,
  runGit, GO_LIVE_PATHS,
} from '../../scripts/server.mjs';
import { buildIndex } from '../../site/shared/puzzle.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Isolation for every git call in this process (the server's included: it copies process.env).
process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_TERMINAL_PROMPT = '0';
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES']) {
  delete process.env[key];
}

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  hasGit = false;
}
const gitTest = hasGit ? test : test.skip;

let tmp;
const servers = [];

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'xw-golive-test-'));
  const rel = path.relative(REPO, tmp);
  // Never inside the project (git would otherwise find the project's own repository above a test folder).
  assert.ok(rel.startsWith('..') || path.isAbsolute(rel), `temp dir ${tmp} must not be inside ${REPO}`);
});

after(async () => {
  for (const s of servers) await new Promise((resolve) => s.close(resolve));
  if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
});

/** git in `cwd` (a test repository), never searching above it. Returns trimmed stdout. */
function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(cwd) },
  }).trim();
}
/** git against a bare repository. */
const bareGit = (bare, ...args) => git(path.dirname(bare), `--git-dir=${bare}`, ...args);

const samplePuzzle = JSON.parse(await fsp.readFile(path.join(REPO, 'tests', 'fixtures', 'sample-puzzle.json'), 'utf8'));
const sampleDraft = JSON.parse(await fsp.readFile(path.join(REPO, 'tests', 'fixtures', 'sample-draft.json'), 'utf8'));

let counter = 0;
/**
 * A project folder laid out like the real one (one published puzzle, site config, a draft) committed on `main`.
 * Options: remote (a bare "origin", pushed with upstream), gitignore (contents of .gitignore), commit (false: an
 * empty repository with no commits).
 */
async function makeProject({ remote = true, gitignore = 'drafts/\ndata/user-clues.json*\n*.tmp\n', commit = true, init = true } = {}) {
  const base = path.join(tmp, `p${++counter}`);
  const work = path.join(base, 'work');
  const bare = path.join(base, 'origin.git');
  await fsp.mkdir(path.join(work, 'site', 'puzzles'), { recursive: true });
  await fsp.mkdir(path.join(work, 'drafts'), { recursive: true });
  await fsp.mkdir(path.join(work, 'data'), { recursive: true });
  await fsp.writeFile(path.join(work, 'site', 'puzzles', `${samplePuzzle.id}.json`), `${JSON.stringify(samplePuzzle, null, 2)}\n`);
  await fsp.writeFile(path.join(work, 'site', 'puzzles', 'index.json'), `${JSON.stringify(buildIndex([samplePuzzle]), null, 2)}\n`);
  await fsp.writeFile(path.join(work, 'site', 'config.json'), `${JSON.stringify({ siteName: 'Test Club', timeZone: 'UTC', shareUrl: '', shareGrid: true }, null, 2)}\n`);
  await fsp.writeFile(path.join(work, 'drafts', 'sample-mini.json'), JSON.stringify(sampleDraft));
  await fsp.writeFile(path.join(work, 'README.md'), '# Test project\n');
  await fsp.writeFile(path.join(work, '.gitignore'), gitignore);
  if (!init) return { base, work, bare };
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'config', 'user.name', 'Test Builder');
  git(work, 'config', 'user.email', 'builder@example.test');
  git(work, 'config', 'commit.gpgsign', 'false');
  if (commit) {
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'Initial commit');
  }
  if (remote) {
    git(base, 'init', '-q', '--bare', '-b', 'main', bare);
    git(work, 'remote', 'add', 'origin', bare);
    if (commit) git(work, 'push', '-q', '-u', 'origin', 'main');
  }
  return { base, work, bare };
}

/** Start a dev server on `root`; returns an API helper. */
async function serve(root) {
  const server = createServer({ root });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (method, url, body, headers = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      if (typeof body !== 'string' && !init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(base + url, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text };
  };
}

const byPath = (list) => [...list].sort((a, b) => a.path.localeCompare(b.path));
const draftFor = (date) => ({ ...structuredClone(sampleDraft), id: `d-${date}`, date, title: `Puzzle ${date}` });

// ---------------------------------------------------------------------------- helpers

test('commit messages describe what changed', () => {
  const p = (date, change) => ({ path: `site/puzzles/${date}.json`, change });
  const index = { path: 'site/puzzles/index.json', change: 'modified' };
  assert.equal(goLiveCommitMessage([p('2026-10-05', 'added'), index]), 'Publish puzzle 2026-10-05');
  assert.equal(goLiveCommitMessage([p('2026-10-06', 'added'), p('2026-10-05', 'added'), index]), 'Publish puzzles 2026-10-05, 2026-10-06');
  assert.equal(goLiveCommitMessage([p('2026-10-04', 'deleted'), index]), 'Unpublish 2026-10-04');
  assert.equal(goLiveCommitMessage([{ path: 'site/config.json', change: 'modified' }]), 'Update site settings');
  assert.equal(goLiveCommitMessage([p('2026-10-05', 'modified')]), 'Update puzzle 2026-10-05');
  assert.equal(
    goLiveCommitMessage([p('2026-10-05', 'added'), p('2026-10-04', 'deleted'), { path: 'site/config.json', change: 'modified' }, { path: 'data/user-words.txt', change: 'added' }]),
    'Publish puzzle 2026-10-05; unpublish 2026-10-04; update site settings; update word list',
  );
  assert.equal(goLiveCommitMessage(['01', '02', '03', '04'].map((d) => p(`2026-11-${d}`, 'added'))), 'Publish puzzles 2026-11-01, 2026-11-02 and 2 more');
  assert.equal(goLiveCommitMessage([index]), 'Update published puzzles');
});

test('git output parsing, secret redaction, error classification, Pages address', () => {
  assert.deepEqual(parseStatusZ('?? site/puzzles/2026-10-05.json\0 M site/puzzles/index.json\0D  site/puzzles/2026-10-04.json\0'), [
    { path: 'site/puzzles/2026-10-05.json', change: 'added' },
    { path: 'site/puzzles/index.json', change: 'modified' },
    { path: 'site/puzzles/2026-10-04.json', change: 'deleted' },
  ]);
  assert.deepEqual(parseNameStatusZ('A\0site/puzzles/a b.json\0M\0site/config.json\0D\0data/user-words.txt\0'), [
    { path: 'site/puzzles/a b.json', change: 'added' },
    { path: 'site/config.json', change: 'modified' },
    { path: 'data/user-words.txt', change: 'deleted' },
  ]);
  const secret = 'fatal: unable to access https://me:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/me/xw.git/ (token github_pat_11AAAAAAAAAAAAAAAAAAAAAA)';
  const clean = redactSecrets(secret);
  assert.doesNotMatch(clean, /ghp_|github_pat_|me:/);
  assert.match(clean, /https:\/\/github\.com\/me\/xw\.git/);
  assert.equal(classifyGitFailure({ stderr: ' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs' }), 'rejected');
  assert.equal(classifyGitFailure({ stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled" }), 'auth');
  assert.equal(classifyGitFailure({ stderr: 'remote: Invalid username or password.\nfatal: Authentication failed for …' }), 'auth');
  assert.equal(classifyGitFailure({ stderr: 'fatal: unable to access …: Could not resolve host: github.com' }), 'network');
  assert.equal(classifyGitFailure({ stderr: 'remote: Repository not found.' }), 'repo-not-found');
  assert.equal(classifyGitFailure({ timedOut: true }), 'timeout');
  assert.equal(classifyGitFailure({ stderr: '*** Please tell me who you are.' }, 'commit'), 'identity');
  assert.equal(classifyGitFailure({ stderr: 'something odd' }, 'commit'), 'commit-failed');
  assert.equal(githubPagesUrl('https://github.com/armani/armani-crossword.git'), 'https://armani.github.io/armani-crossword/');
  assert.equal(githubPagesUrl('git@github.com:Armani/armani.github.io.git'), 'https://armani.github.io/');
  assert.equal(githubPagesUrl('/tmp/origin.git'), null);
  assert.deepEqual([...GO_LIVE_PATHS], ['site/puzzles/', 'site/config.json', 'data/user-words.txt']);
});

// ---------------------------------------------------------------------------- against real repositories

gitTest('a folder that is not a git repository (or sits inside another one) gets a friendly answer', async () => {
  const plain = await makeProject({ init: false });
  let api = await serve(plain.work);
  let st = (await api('GET', '/api/go-live')).json;
  assert.equal(st.git, false);
  assert.equal(st.ready, false);
  assert.equal(st.problem.code, 'not-git');
  assert.match(st.problem.hint, /README/);
  assert.deepEqual(st.pending, []);
  const res = await api('POST', '/api/go-live', {});
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'not-git');
  assert.ok(res.json.error && res.json.hint);

  // A root nested inside a repository is NOT that repository: git must never act on a folder above the root.
  const outer = await makeProject();
  const nested = path.join(outer.work, 'site');
  api = await serve(nested);
  st = (await api('GET', '/api/go-live')).json;
  assert.equal(st.git, false);
  assert.equal((await api('POST', '/api/go-live', {})).status, 409);
  assert.equal(git(outer.work, 'rev-list', '--count', 'HEAD'), '1');
});

gitTest('a repository without commits is not set up yet', async () => {
  const { work } = await makeProject({ commit: false });
  const api = await serve(work);
  const st = (await api('GET', '/api/go-live')).json;
  assert.equal(st.git, true);
  assert.equal(st.problem.code, 'no-commits');
  const res = await api('POST', '/api/go-live', {});
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'no-commits');
  assert.throws(() => git(work, 'rev-parse', '--verify', 'HEAD')); // still nothing committed
});

gitTest('publish → put it online: the remote gets exactly the allow-listed changes', async () => {
  // .gitignore without drafts/, user-clues or *.tmp: the allow-list alone must keep them out.
  const { work, bare } = await makeProject({ gitignore: 'node_modules/\n' });
  const api = await serve(work);

  let st = (await api('GET', '/api/go-live')).json;
  assert.deepEqual(
    { git: st.git, branch: st.branch, remote: st.remote, upstream: st.upstream, pending: st.pending, ahead: st.ahead, ready: st.ready, busy: st.busy, problem: st.problem },
    { git: true, branch: 'main', remote: bare, upstream: true, pending: [], ahead: 0, ready: true, busy: false, problem: null },
  );

  // Things that must NOT be committed: an un-ignored draft, an unrelated staged file, a temp file of an atomic write.
  await fsp.writeFile(path.join(work, 'drafts', 'secret-answers.json'), '{"answers":"PLAINTEXT"}');
  await fsp.writeFile(path.join(work, 'notes.txt'), 'staged by the user for their own commit\n');
  git(work, 'add', 'notes.txt');
  await fsp.writeFile(path.join(work, 'site', 'puzzles', '.2026-10-09.json.123.abcd.tmp'), '{"half":');

  // What the builder does: publish a puzzle, change a setting, add a word.
  assert.equal((await api('POST', '/api/publish', { draft: draftFor('2026-10-05') })).status, 200);
  assert.equal((await api('PUT', '/api/config', { shareUrl: 'https://friends.example/xw/' })).status, 200);
  assert.equal((await api('PATCH', '/api/user-words', { add: [['ZESTY', 70]] })).status, 200);
  assert.ok(await fsp.stat(path.join(work, 'data', 'user-clues.json'))); // written by publish, never committed

  st = (await api('GET', '/api/go-live')).json;
  const expected = [
    { path: 'data/user-words.txt', change: 'added' },
    { path: 'site/config.json', change: 'modified' },
    { path: 'site/puzzles/2026-10-05.json', change: 'added' },
    { path: 'site/puzzles/index.json', change: 'modified' },
  ];
  assert.deepEqual(byPath(st.pending), expected);
  assert.equal(st.siteUrl, 'https://friends.example/xw/');

  const res = await api('POST', '/api/go-live', {});
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.committed, true);
  assert.equal(res.json.pushed, true);
  assert.equal(res.json.upToDate, false);
  assert.equal(res.json.commit.message, 'Publish puzzle 2026-10-05; update site settings; update word list');
  assert.deepEqual(byPath(res.json.commit.files), expected);
  assert.equal(res.json.siteUrl, 'https://friends.example/xw/');

  // The remote: its HEAD is that commit, which changes exactly the four allow-listed files.
  assert.equal(bareGit(bare, 'rev-parse', 'main'), git(work, 'rev-parse', 'HEAD'));
  assert.equal(bareGit(bare, 'rev-parse', 'main'), res.json.commit.sha);
  assert.equal(bareGit(bare, 'log', '-1', '--format=%s', 'main'), res.json.commit.message);
  assert.equal(bareGit(bare, 'log', '-1', '--format=%an <%ae>', 'main'), 'Test Builder <builder@example.test>');
  const changed = bareGit(bare, 'diff', '--name-status', '--no-renames', 'main~1', 'main').split('\n').sort();
  assert.deepEqual(changed, ['A\tdata/user-words.txt', 'A\tsite/puzzles/2026-10-05.json', 'M\tsite/config.json', 'M\tsite/puzzles/index.json']);
  const tree = bareGit(bare, 'ls-tree', '-r', '--name-only', 'main').split('\n');
  for (const never of ['drafts/secret-answers.json', 'notes.txt', 'data/user-clues.json', 'site/puzzles/.2026-10-09.json.123.abcd.tmp']) {
    assert.ok(!tree.includes(never), `${never} must not be pushed`);
  }

  // Locally: the user's staged file is still staged (not swept into the commit), the draft still untracked.
  assert.equal(git(work, 'diff', '--cached', '--name-only'), 'notes.txt');
  assert.match(git(work, 'status', '--porcelain', '--untracked-files=all', '--', 'drafts'), /^\?\? drafts\/secret-answers\.json$/m);

  st = (await api('GET', '/api/go-live')).json;
  assert.deepEqual(st.pending, []);
  assert.equal(st.ahead, 0);

  // Nothing new: nothing is committed or pushed.
  const again = await api('POST', '/api/go-live', {});
  assert.equal(again.status, 200);
  assert.deepEqual(
    { ok: again.json.ok, upToDate: again.json.upToDate, committed: again.json.committed, pushed: again.json.pushed },
    { ok: true, upToDate: true, committed: false, pushed: false },
  );
  assert.equal(bareGit(bare, 'rev-parse', 'main'), res.json.commit.sha);

  // Unpublishing is put online the same way.
  assert.equal((await api('DELETE', '/api/published/2026-10-05')).status, 200);
  const un = await api('POST', '/api/go-live', {});
  assert.equal(un.status, 200, un.text);
  assert.equal(un.json.commit.message, 'Unpublish 2026-10-05');
  assert.deepEqual(bareGit(bare, 'diff', '--name-status', 'main~1', 'main').split('\n').sort(), ['D\tsite/puzzles/2026-10-05.json', 'M\tsite/puzzles/index.json']);

  // Writes are same-origin JSON only, like the rest of the API.
  assert.equal((await api('POST', '/api/go-live', {}, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await api('POST', '/api/go-live', '{}', { 'Content-Type': 'text/plain' })).status, 415);
});

gitTest('commits made outside the builder are pushed too (ahead only)', async () => {
  const { work, bare } = await makeProject();
  const api = await serve(work);
  await fsp.writeFile(path.join(work, 'README.md'), '# Changed by hand\n');
  git(work, 'commit', '-q', '-am', 'Edit README');
  const st = (await api('GET', '/api/go-live')).json;
  assert.deepEqual(st.pending, []);
  assert.equal(st.ahead, 1);
  const res = await api('POST', '/api/go-live', {});
  assert.equal(res.status, 200, res.text);
  assert.deepEqual({ committed: res.json.committed, pushed: res.json.pushed, upToDate: res.json.upToDate }, { committed: false, pushed: true, upToDate: false });
  assert.equal(bareGit(bare, 'rev-parse', 'main'), git(work, 'rev-parse', 'HEAD'));
  assert.equal((await api('GET', '/api/go-live')).json.ahead, 0);
});

gitTest('no "origin" remote: a friendly error and nothing committed; once connected, the first push sets the upstream', async () => {
  const { base, work } = await makeProject({ remote: false });
  const api = await serve(work);
  assert.equal((await api('POST', '/api/publish', { draft: draftFor('2026-10-06') })).status, 200);
  let st = (await api('GET', '/api/go-live')).json;
  assert.equal(st.remote, null);
  assert.equal(st.problem.code, 'no-remote');
  assert.equal(st.pending.length, 2);
  const res = await api('POST', '/api/go-live', {});
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'no-remote');
  assert.match(res.json.error, /origin/);
  assert.match(res.json.hint, /README/);
  assert.equal(git(work, 'rev-list', '--count', 'HEAD'), '1');

  const bare = path.join(base, 'later.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  git(work, 'remote', 'add', 'origin', bare);
  st = (await api('GET', '/api/go-live')).json;
  assert.equal(st.upstream, false);
  assert.equal(st.ahead, 1); // nothing is on the remote yet
  const ok = await api('POST', '/api/go-live', {});
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.commit.message, 'Publish puzzle 2026-10-06');
  assert.equal(bareGit(bare, 'rev-parse', 'main'), git(work, 'rev-parse', 'HEAD'));
  st = (await api('GET', '/api/go-live')).json;
  assert.equal(st.upstream, true);
  assert.equal(st.ahead, 0);
});

gitTest('GitHub has commits this computer lacks: the push is refused with a hint, the commit is kept', async () => {
  const { base, work, bare } = await makeProject();
  // Someone else pushes first.
  const other = path.join(base, 'other');
  git(base, 'clone', '-q', bare, other);
  git(other, 'config', 'user.name', 'Someone Else');
  git(other, 'config', 'user.email', 'else@example.test');
  await fsp.writeFile(path.join(other, 'README.md'), '# Edited on GitHub\n');
  git(other, 'commit', '-q', '-am', 'Edit on GitHub');
  git(other, 'push', '-q');
  const theirs = git(other, 'rev-parse', 'HEAD');

  const api = await serve(work);
  assert.equal((await api('POST', '/api/publish', { draft: draftFor('2026-10-07') })).status, 200);
  const res = await api('POST', '/api/go-live', {});
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.code, 'rejected');
  assert.match(res.json.hint, /git pull --rebase/);
  assert.match(res.json.error, /GitHub has changes/);
  assert.equal(res.json.committed, true);
  assert.equal(res.json.commit.message, 'Publish puzzle 2026-10-07');
  assert.equal(git(work, 'rev-parse', 'HEAD'), res.json.commit.sha); // kept locally
  assert.equal(bareGit(bare, 'rev-parse', 'main'), theirs); // remote unchanged

  const st = (await api('GET', '/api/go-live')).json;
  assert.deepEqual(st.pending, []);
  assert.equal(st.ahead, 1);
  const again = await api('POST', '/api/go-live', {});
  assert.equal(again.status, 409);
  assert.equal(again.json.code, 'rejected');
  assert.equal(again.json.committed, false);
});

gitTest('one go-live at a time: a second request gets 409 busy', async () => {
  const { work, bare } = await makeProject();
  // A slow push (pre-push hook) keeps the first request busy.
  const hook = path.join(work, '.git', 'hooks', 'pre-push');
  await fsp.writeFile(hook, '#!/bin/sh\nsleep 1\n', { mode: 0o755 });
  const api = await serve(work);
  assert.equal((await api('POST', '/api/publish', { draft: draftFor('2026-10-08') })).status, 200);
  const first = api('POST', '/api/go-live', {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  const [second, status] = await Promise.all([api('POST', '/api/go-live', {}), api('GET', '/api/go-live')]);
  assert.equal(second.status, 409);
  assert.equal(second.json.busy, true);
  assert.ok(second.json.error);
  assert.equal(status.json.busy, true);
  const done = await first;
  assert.equal(done.status, 200, done.text);
  assert.equal(bareGit(bare, 'log', '-1', '--format=%s', 'main'), 'Publish puzzle 2026-10-08');
  assert.equal((await api('GET', '/api/go-live')).json.busy, false);
});

gitTest('a login GitHub refuses: friendly "gh auth login" hint, and credentials never reach a response', async () => {
  // A stand-in for GitHub that refuses every login (git sends the user:token embedded in the address).
  const fake = http.createServer((req, res) => {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitHub"' });
    res.end('Unauthorized');
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  servers.push(fake);
  const { work } = await makeProject({ remote: false });
  const token = 'ghp_TESTtokenTESTtokenTESTtoken123456';
  git(work, 'remote', 'add', 'origin', `http://armani:${token}@127.0.0.1:${fake.address().port}/armani/xw.git`);
  const api = await serve(work);
  const st = await api('GET', '/api/go-live');
  assert.doesNotMatch(st.text, /ghp_|TESTtoken|armani:/);
  assert.equal(st.json.remote, `http://127.0.0.1:${fake.address().port}/armani/xw.git`);
  assert.equal((await api('POST', '/api/publish', { draft: draftFor('2026-10-09') })).status, 200);
  const res = await api('POST', '/api/go-live', {});
  assert.equal(res.status, 502, res.text);
  assert.equal(res.json.code, 'auth');
  assert.match(res.json.hint, /gh auth login/);
  assert.equal(res.json.committed, true);
  assert.doesNotMatch(res.text, /ghp_|TESTtoken|armani:/);
});

gitTest('git can never hang: a remote that does not answer is stopped at the timeout', async () => {
  const silent = http.createServer(() => { /* never answers */ });
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  servers.push(silent);
  const started = Date.now();
  const r = await runGit(tmp, ['ls-remote', `http://127.0.0.1:${silent.address().port}/x.git`], { timeoutMs: 600 });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.code, 0);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  assert.equal(classifyGitFailure(r), 'timeout');
  silent.closeAllConnections();
});
