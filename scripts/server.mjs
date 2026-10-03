#!/usr/bin/env node
// Armani Crossword dev server: serves the builder, engine, player site and data files, plus the builder's JSON API.
// Zero dependencies (Node built-ins only). See SPEC.md §4.
//
// Usage:
//   npm run dev                                   # port 5173, repo root, this computer only
//   npm run dev -- --lan                          # also let phones on the same Wi-Fi open the player site
//   PORT=5202 node scripts/server.mjs
//   node scripts/server.mjs --port 5202 --root /tmp/copy-of-repo
//   XW_ROOT=/tmp/copy-of-repo node scripts/server.mjs
//
// Security model (drafts hold the answers to unreleased puzzles, and the API can publish / delete):
//   - By default the server listens on 127.0.0.1 only. `--lan` (or HOST=0.0.0.0) also listens on the network.
//   - Requests from other devices (any non-loopback address) only get read-only access to the player site
//     (/site/), with puzzles dated after "today" held back exactly like the deployed site
//     (`npm run build -- --released-only`). The builder, the API, the engine and data/ answer 403.
//   - The Host header must name this computer (localhost, a loopback IP, its own IPs or hostname), which defeats
//     DNS-rebinding pages. Extra names: XW_ALLOWED_HOSTS=a.example,b.example or createServer({ allowedHosts }).
//   - API writes must be same-origin (Origin / Sec-Fetch-Site checked) and JSON bodies must be sent as
//     application/json, so another website open in the browser cannot publish or delete through a "simple"
//     cross-origin request.
//
// The root directory is used for BOTH static files and state (drafts/, site/puzzles/, site/config.json,
// data/user-words.txt, data/user-clues.json), so tests can run against a temporary copy of the repo.
//
// Importing this module does not start a server: use `createServer({ root })` and call `.listen()` yourself.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  addDays, draftToPuzzle, draftEntries, buildIndex, isValidDraftId, isValidDateId, loadPuzzle, normalizeClue,
  normalizeAnswer, MAX_SIZE,
} from '../site/shared/puzzle.js';
import { releasedThrough } from './build-site.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Top-level directories that may be served statically. Everything else (drafts/, scripts/, .git, …) is private. */
const STATIC_DIRS = new Set(['builder', 'engine', 'site', 'data']);

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

/** Max JSON request body (a 25×25 draft is ~10 KB; this leaves lots of room). */
const JSON_BODY_LIMIT = 1024 * 1024;
/** Max text body for PUT /api/user-words. */
const TEXT_BODY_LIMIT = 2 * 1024 * 1024;
/** How many remembered clues to keep per word in data/user-clues.json. */
const USER_CLUES_PER_WORD = 20;
/** GET /api/recent-answers: default and largest window (days before and after the date). */
const RECENT_DAYS_DEFAULT = 30;
const RECENT_DAYS_MAX = 366;

export const DEFAULT_CONFIG = Object.freeze({
  siteName: 'Armani Crossword',
  tagline: '',
  timeZone: null,
  shareUrl: '',
  shareGrid: true,
});

/**
 * Keys left over from an abandoned design (a site-wide passcode). The site has no login of any kind, so these are
 * dropped whenever the config is read through the API and never written back.
 */
const LEGACY_CONFIG_KEYS = ['accessCodeHash', 'accessCode'];

// ---------------------------------------------------------------------------
// Small helpers

/** `"2026-10-02T10:00:00.000Z"` (an ETag / If-Match value) -> the bare version string. */
const unquoteEtag = (value) => String(value).trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');

const isJsonType = (type) => /^application\/([\w.+-]+\+)?json\s*(;|$)/i.test(String(type || '').trim());

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Write a file atomically: write a temp file in the same directory, then rename over the target. */
export async function writeFileAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

const writeJsonAtomic = (file, value) => writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);

async function readJsonIfExists(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function readTextIfExists(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

/** Serialises async critical sections (index/user-clues/user-words read-modify-write). */
function createMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

/** True for connections from this computer (127.0.0.0/8, ::1, and their IPv4-mapped IPv6 forms). */
export function isLoopbackAddress(addr) {
  if (!addr) return false;
  const a = String(addr).toLowerCase().replace(/^::ffff:/, '');
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** The host name of a Host header ("localhost:5173" -> "localhost", "[::1]:80" -> "::1"), lowercased. */
function hostnameOf(hostHeader) {
  const value = String(hostHeader || '').trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : '';
  }
  const colon = value.lastIndexOf(':');
  return (colon >= 0 ? value.slice(0, colon) : value).replace(/\.$/, '');
}

let ownNamesCache = { at: 0, names: null };
/** Names and addresses of this computer (refreshed every few seconds: Wi-Fi addresses change). */
function ownHostnames() {
  const now = Date.now();
  if (ownNamesCache.names && now - ownNamesCache.at < 5000) return ownNamesCache.names;
  const names = new Set(['localhost', '::1']);
  const host = os.hostname().toLowerCase();
  if (host) { names.add(host); names.add(`${host}.local`); }
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) names.add(String(a.address).toLowerCase().replace(/%.*$/, ''));
  }
  ownNamesCache = { at: now, names };
  return names;
}

/**
 * Is this Host header one of ours? Anything else is refused: a DNS-rebinding page (attacker.example resolving to
 * 127.0.0.1) would otherwise be "same-origin" with the API. A request without a Host header (not a browser) passes.
 */
export function isAllowedHost(hostHeader, extra = []) {
  if (hostHeader === undefined) return true;
  const name = hostnameOf(hostHeader);
  if (!name) return false;
  if (name === 'localhost' || name.endsWith('.localhost') || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return true;
  if (extra.some((x) => String(x).toLowerCase() === name)) return true;
  return ownHostnames().has(name);
}

// ---------------------------------------------------------------------------
// Validation of drafts sent by the builder ("basic shape" — the full checks happen at publish time)

const CELL_RE = /^(#|[A-Z]?)$/;

function validateDraftShape(d, id) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'Draft must be a JSON object';
  if (d.id !== undefined && d.id !== id) return `Draft id "${d.id}" does not match URL id "${id}"`;
  const { width, height } = d;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > MAX_SIZE || height > MAX_SIZE) {
    return `Invalid grid size ${width}x${height}`;
  }
  if (!Array.isArray(d.cells) || d.cells.length !== width * height) return 'cells must be an array of width*height entries';
  if (!d.cells.every((c) => typeof c === 'string' && CELL_RE.test(c))) return "cells may only contain '#', '' or A-Z";
  for (const key of ['locked', 'circles', 'shaded']) {
    const v = d[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.every((i) => Number.isInteger(i) && i >= 0 && i < d.cells.length)) return `${key} must be an array of cell indices`;
  }
  for (const key of ['title', 'author', 'note', 'date']) {
    if (d[key] !== undefined && typeof d[key] !== 'string') return `${key} must be a string`;
  }
  if (d.date && !isValidDateId(d.date)) return 'date must be YYYY-MM-DD or empty';
  if (d.symmetry !== undefined && !['rotational', 'mirror', 'none'].includes(d.symmetry)) return 'symmetry must be rotational, mirror or none';
  if (d.theme !== undefined && (!Array.isArray(d.theme) || !d.theme.every((t) => t && typeof t === 'object' && typeof t.answer === 'string'))) {
    return 'theme must be an array of { answer, clue?, raw? }';
  }
  for (const key of ['clues', 'clueSources']) {
    const v = d[key];
    if (v === undefined) continue;
    if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.values(v).every((s) => typeof s === 'string')) {
      return `${key} must be an object of strings`;
    }
  }
  return null;
}

/** Merge the clues of a just-published draft into user-clues ({ WORD: [clue, ...] }, most recent first, deduped). */
export function mergeUserClues(existing, draft) {
  const out = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
  for (const e of draftEntries(draft).all) {
    if (!e.answer || !e.clue) continue;
    const key = e.clue.toLowerCase();
    const prev = Array.isArray(out[e.answer]) ? out[e.answer] : [];
    out[e.answer] = [e.clue, ...prev.filter((c) => typeof c === 'string' && normalizeClue(c).toLowerCase() !== key)]
      .slice(0, USER_CLUES_PER_WORD);
  }
  // Stable, alphabetical key order keeps the file diff-friendly.
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}

/**
 * Apply an edit to user-words.txt text (SPEC §2.7) without disturbing comments or unrelated lines.
 * ops: { add: [[word, score]], ban: [word], unban: [word], remove: [word] }
 *   add    -> replaces any line for the word with "WORD;SCORE"
 *   ban    -> replaces any line for the word with "-WORD"
 *   unban  -> removes "-WORD" lines
 *   remove -> removes every line for the word (back to the base word list)
 */
export function editUserWords(text, ops = {}) {
  const lines = String(text || '').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const wordOf = (line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return null;
    if (t.startsWith('-')) return { word: normalizeAnswer(t.slice(1)), ban: true };
    return { word: normalizeAnswer(t.split(';')[0]), ban: false };
  };
  const drop = (word, onlyBans = false) => {
    for (let i = lines.length - 1; i >= 0; i--) {
      const w = wordOf(lines[i]);
      if (w && w.word === word && (!onlyBans || w.ban)) lines.splice(i, 1);
    }
  };
  const words = (list) => (Array.isArray(list) ? list : []).map((w) => normalizeAnswer(w)).filter(Boolean);
  for (const w of words(ops.remove)) drop(w);
  for (const w of words(ops.unban)) drop(w, true);
  for (const w of words(ops.ban)) { drop(w); lines.push(`-${w}`); }
  for (const pair of Array.isArray(ops.add) ? ops.add : []) {
    const [raw, rawScore] = Array.isArray(pair) ? pair : [pair, 50];
    const w = normalizeAnswer(raw);
    if (!w) continue;
    const score = Math.max(0, Math.min(100, Math.round(Number(rawScore ?? 50)) || 0));
    drop(w);
    lines.push(`${w};${score}`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/** The answers (complete entries) of a published puzzle, decoded from its obfuscated solution. */
export function puzzleAnswers(puzzle) {
  const { all, solution } = loadPuzzle(puzzle);
  return all.map((e) => e.cells.map((i) => solution[i]).join('')).filter((a) => /^[A-Z]{2,}$/.test(a));
}

// ---------------------------------------------------------------------------
// Server

/**
 * Create (but do not start) the dev server.
 * @param {{ root?: string, log?: (line: string) => void, allowedHosts?: string[] }} [opts]
 *   allowedHosts: extra Host names to accept besides localhost / loopback IPs / this computer's own names and IPs.
 * @returns {http.Server}
 */
export function createServer({ root = REPO_ROOT, log = () => {}, allowedHosts = [] } = {}) {
  root = path.resolve(root);
  const extraHosts = [...allowedHosts, ...String(process.env.XW_ALLOWED_HOSTS || '').split(',')]
    .map((x) => x.trim().toLowerCase()).filter(Boolean);
  const paths = {
    drafts: path.join(root, 'drafts'),
    puzzles: path.join(root, 'site', 'puzzles'),
    index: path.join(root, 'site', 'puzzles', 'index.json'),
    config: path.join(root, 'site', 'config.json'),
    userWords: path.join(root, 'data', 'user-words.txt'),
    userClues: path.join(root, 'data', 'user-clues.json'),
  };
  const withLock = createMutex();

  // ---- request body ----
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length']);
      if (declared > limit) {
        reject(new HttpError(413, `Request body too large (limit ${limit} bytes)`));
        req.resume();
        return;
      }
      const chunks = [];
      let size = 0;
      let failed = false;
      req.on('data', (chunk) => {
        if (failed) return;
        size += chunk.length;
        if (size > limit) {
          failed = true;
          reject(new HttpError(413, `Request body too large (limit ${limit} bytes)`));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks).toString('utf8')); });
      req.on('error', reject);
    });
  }

  async function readJsonBody(req) {
    // Only application/json: a cross-origin page can send text/plain or form bodies without a CORS preflight.
    if (!isJsonType(req.headers['content-type'])) {
      req.resume();
      throw new HttpError(415, 'Content-Type must be application/json');
    }
    const text = await readBody(req, JSON_BODY_LIMIT);
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, 'Request body must be valid JSON');
    }
  }

  // ---- responses ----
  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  }
  function sendJson(res, status, value) {
    send(res, status, JSON.stringify(value), { 'Content-Type': MIME_TYPES['.json'] });
  }

  // ---- puzzles / index ----
  async function listPuzzleFiles() {
    let names;
    try {
      names = await fsp.readdir(paths.puzzles);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    return names.filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n) && isValidDateId(n.slice(0, 10)));
  }

  async function rebuildIndex() {
    const puzzles = [];
    for (const name of await listPuzzleFiles()) {
      try {
        puzzles.push(JSON.parse(await fsp.readFile(path.join(paths.puzzles, name), 'utf8')));
      } catch (err) {
        log(`warning: skipping unreadable puzzle ${name}: ${err.message}`);
      }
    }
    const index = buildIndex(puzzles);
    await writeJsonAtomic(paths.index, index);
    return index;
  }

  async function readConfig() {
    const stored = await readJsonIfExists(paths.config, {});
    // Unknown keys are preserved (the player may add its own); legacy passcode keys are dropped.
    const cfg = { ...DEFAULT_CONFIG, ...(stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}) };
    for (const key of LEGACY_CONFIG_KEYS) delete cfg[key];
    return cfg;
  }

  // ---- API handlers ----
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  route('GET', /^\/api\/drafts$/, async (req, res) => {
    let names = [];
    try {
      names = (await fsp.readdir(paths.drafts)).filter((n) => n.endsWith('.json') && isValidDraftId(n.slice(0, -5)));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const list = [];
    for (const name of names) {
      try {
        const d = JSON.parse(await fsp.readFile(path.join(paths.drafts, name), 'utf8'));
        list.push({
          id: name.slice(0, -5), title: d.title || '', date: d.date || '', width: d.width, height: d.height,
          updatedAt: d.updatedAt || '', publishedAt: d.publishedAt || '', publishedDate: d.publishedDate || '',
        });
      } catch (err) {
        log(`warning: skipping unreadable draft ${name}: ${err.message}`);
      }
    }
    list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id.localeCompare(b.id)));
    sendJson(res, 200, list);
  });

  route('GET', /^\/api\/drafts\/([^/]+)$/, async (req, res, [id]) => {
    if (!isValidDraftId(id)) throw new HttpError(400, 'Invalid draft id');
    const draft = await readJsonIfExists(path.join(paths.drafts, `${id}.json`), null);
    if (!draft) throw new HttpError(404, `No draft "${id}"`);
    // The draft's updatedAt is its version: send it back as If-Match when saving (see PUT).
    res.setHeader('ETag', JSON.stringify(String(draft.updatedAt || '')));
    sendJson(res, 200, draft);
  });

  // Optimistic concurrency (addition to SPEC): the builder sends `If-Match: "<updatedAt it last loaded/saved>"`.
  // If the file has been saved since (another tab) or deleted, the save is refused with 409
  // { conflict: 'changed' | 'deleted', updatedAt } instead of silently overwriting. `If-Match: *` = must exist;
  // `If-None-Match: *` = create only (409 { conflict: 'exists' }). Without these headers it is last-write-wins.
  route('PUT', /^\/api\/drafts\/([^/]+)$/, async (req, res, [id]) => {
    if (!isValidDraftId(id)) throw new HttpError(400, 'Invalid draft id (lowercase letters, digits and dashes, max 64)');
    const body = await readJsonBody(req);
    const problem = validateDraftShape(body, id);
    if (problem) throw new HttpError(400, problem);
    const file = path.join(paths.drafts, `${id}.json`);
    const ifMatch = req.headers['if-match'];
    const ifNoneMatch = req.headers['if-none-match'];
    const updatedAt = await withLock(async () => {
      const prev = await readJsonIfExists(file, null);
      if (ifMatch !== undefined) {
        const wanted = ifMatch.trim() === '*' ? '*' : unquoteEtag(ifMatch);
        if (!prev) throw new HttpError(409, 'This draft was deleted', { conflict: 'deleted' });
        if (wanted !== '*' && wanted !== String(prev.updatedAt || '')) {
          throw new HttpError(409, 'This draft was changed somewhere else since you opened it', {
            conflict: 'changed', updatedAt: prev.updatedAt || '',
          });
        }
      }
      if (ifNoneMatch !== undefined && ifNoneMatch.trim() === '*' && prev) {
        throw new HttpError(409, `A draft called "${id}" already exists`, { conflict: 'exists', updatedAt: prev.updatedAt || '' });
      }
      // Versions must change on every save, even two saves in the same millisecond.
      let stamp = new Date().toISOString();
      if (prev?.updatedAt && typeof prev.updatedAt === 'string' && stamp <= prev.updatedAt) {
        const next = Date.parse(prev.updatedAt) + 1;
        if (Number.isFinite(next)) stamp = new Date(next).toISOString();
      }
      const draft = {
        ...body,
        format: 'crossword-draft/1',
        id,
        createdAt: prev?.createdAt || body.createdAt || stamp,
        updatedAt: stamp,
      };
      await writeJsonAtomic(file, draft);
      return stamp;
    });
    res.setHeader('ETag', JSON.stringify(updatedAt));
    sendJson(res, 200, { ok: true, updatedAt });
  });

  route('DELETE', /^\/api\/drafts\/([^/]+)$/, async (req, res, [id]) => {
    if (!isValidDraftId(id)) throw new HttpError(400, 'Invalid draft id');
    try {
      await fsp.unlink(path.join(paths.drafts, `${id}.json`));
    } catch (err) {
      if (err.code === 'ENOENT') throw new HttpError(404, `No draft "${id}"`);
      throw err;
    }
    sendJson(res, 200, { ok: true });
  });

  route('POST', /^\/api\/publish$/, async (req, res) => {
    const body = await readJsonBody(req);
    const draft = body?.draft;
    if (!draft || typeof draft !== 'object') throw new HttpError(400, 'Body must be { draft, overwrite? }');
    let result;
    try {
      result = draftToPuzzle(draft);
    } catch (err) {
      throw new HttpError(422, 'Draft could not be converted', { errors: [err.message], warnings: [] });
    }
    const { puzzle, errors, warnings } = result;
    if (!puzzle) throw new HttpError(422, 'The puzzle is not ready to publish', { errors, warnings });
    const file = path.join(paths.puzzles, `${puzzle.id}.json`);
    const out = await withLock(async () => {
      const existing = await readJsonIfExists(file, null);
      if (existing && body.overwrite !== true) {
        throw new HttpError(409, `A puzzle is already published for ${puzzle.date}`, {
          existing: { id: existing.id, date: existing.date, title: existing.title, author: existing.author, publishedAt: existing.publishedAt || '' },
        });
      }
      // Remembering clues is a convenience: read it BEFORE publishing, and never let a broken user-clues.json
      // fail (or half-complete) the publish itself.
      const serverWarnings = [];
      const userClues = await readUserClues(serverWarnings);
      const published = { ...puzzle, publishedAt: new Date().toISOString() };
      await writeJsonAtomic(file, published);
      const index = await rebuildIndex();
      if (userClues) {
        try {
          await writeJsonAtomic(paths.userClues, mergeUserClues(userClues, draft));
        } catch (err) {
          log(`warning: could not update ${paths.userClues}: ${err.message}`);
          serverWarnings.push(`Published, but your clues could not be remembered for suggestions (${err.message}).`);
        }
      }
      const entry = index.puzzles.find((p) => p.id === puzzle.id);
      return { published, number: entry?.number ?? null, replaced: Boolean(existing), serverWarnings };
    });
    sendJson(res, 200, {
      ok: true, puzzle: out.published, number: out.number, replaced: out.replaced, warnings,
      serverWarnings: out.serverWarnings, url: `/site/#/puzzle/${puzzle.id}`,
    });
  });

  route('GET', /^\/api\/published$/, async (req, res) => {
    const index = await readJsonIfExists(paths.index, null);
    if (index) return sendJson(res, 200, index);
    // No index yet: build one in memory from whatever puzzle files exist.
    const puzzles = [];
    for (const name of await listPuzzleFiles()) {
      try { puzzles.push(JSON.parse(await fsp.readFile(path.join(paths.puzzles, name), 'utf8'))); } catch { /* skip */ }
    }
    sendJson(res, 200, buildIndex(puzzles));
  });

  // Addition to SPEC: answers of the puzzles published within `days` days before or after `date` (scheduling ahead
  // is normal), not counting `date` itself -> { date, days, answers: { WORD: [dates, ascending] } }. The builder uses
  // it to avoid (and flag) answers that repeat a recent puzzle.
  route('GET', /^\/api\/recent-answers$/, async (req, res) => {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const date = params.get('date') || '';
    if (!isValidDateId(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
    const daysText = params.get('days');
    const days = daysText === null ? RECENT_DAYS_DEFAULT : Number(daysText);
    if (!Number.isInteger(days) || days < 0 || days > RECENT_DAYS_MAX) {
      throw new HttpError(400, `days must be a whole number from 0 to ${RECENT_DAYS_MAX}`);
    }
    const from = addDays(date, -days);
    const to = addDays(date, days);
    const answers = {};
    for (const [d, words] of await answersByDate(from, to)) {
      if (d === date) continue;
      for (const w of new Set(words)) (answers[w] ||= []).push(d);
    }
    for (const list of Object.values(answers)) list.sort();
    sendJson(res, 200, { date, days, answers });
  });

  /**
   * date -> answers of the published puzzles dated `from`..`to`. Decoded puzzles are cached until the index changes
   * (every publish and unpublish rewrites it atomically, so its inode and mtime change); without an index nothing is
   * cached.
   */
  let answerCache = { version: null, byDate: new Map() };
  async function answersByDate(from, to) {
    const version = await fsp.stat(paths.index).then((st) => `${st.ino}:${st.mtimeMs}:${st.size}`, () => null);
    if (version === null || version !== answerCache.version) answerCache = { version, byDate: new Map() };
    const { byDate } = answerCache;
    const out = new Map();
    for (const name of await listPuzzleFiles()) {
      const date = name.slice(0, 10);
      if (date < from || date > to) continue;
      if (!byDate.has(date)) {
        let words = [];
        try {
          words = puzzleAnswers(JSON.parse(await fsp.readFile(path.join(paths.puzzles, name), 'utf8')));
        } catch (err) {
          log(`warning: skipping unreadable puzzle ${name}: ${err.message}`);
        }
        byDate.set(date, words);
      }
      out.set(date, byDate.get(date));
    }
    return out;
  }

  route('DELETE', /^\/api\/published\/([^/]+)$/, async (req, res, [date]) => {
    if (!isValidDateId(date)) throw new HttpError(400, 'Date must be YYYY-MM-DD');
    const index = await withLock(async () => {
      try {
        await fsp.unlink(path.join(paths.puzzles, `${date}.json`));
      } catch (err) {
        if (err.code === 'ENOENT') throw new HttpError(404, `Nothing is published for ${date}`);
        throw err;
      }
      return rebuildIndex();
    });
    sendJson(res, 200, { ok: true, index });
  });

  route('GET', /^\/api\/config$/, async (req, res) => {
    sendJson(res, 200, await readConfig());
  });

  route('PUT', /^\/api\/config$/, async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Body must be a JSON object');
    const config = await withLock(async () => {
      const cfg = await readConfig();
      const str = (key, max) => {
        if (body[key] === undefined) return;
        if (typeof body[key] !== 'string') throw new HttpError(400, `${key} must be a string`);
        const v = body[key].trim();
        if (v.length > max) throw new HttpError(400, `${key} is too long (max ${max} characters)`);
        cfg[key] = v;
      };
      str('siteName', 80);
      str('tagline', 160);
      str('shareUrl', 500);
      if (cfg.shareUrl && !/^https?:\/\/\S+$/i.test(cfg.shareUrl)) throw new HttpError(400, 'shareUrl must start with http:// or https://');
      if (body.timeZone !== undefined) {
        const tz = body.timeZone === '' ? null : body.timeZone;
        if (tz !== null && (typeof tz !== 'string' || !isValidTimeZone(tz))) throw new HttpError(400, `Unknown time zone "${tz}"`);
        cfg.timeZone = tz;
      }
      if (body.shareGrid !== undefined) {
        if (typeof body.shareGrid !== 'boolean') throw new HttpError(400, 'shareGrid must be true or false');
        cfg.shareGrid = body.shareGrid;
      }
      await writeJsonAtomic(paths.config, cfg);
      return cfg;
    });
    sendJson(res, 200, config);
  });

  route('GET', /^\/api\/user-words$/, async (req, res) => {
    send(res, 200, await readTextIfExists(paths.userWords), { 'Content-Type': MIME_TYPES['.txt'] });
  });

  route('PUT', /^\/api\/user-words$/, async (req, res) => {
    let text = await readBody(req, TEXT_BODY_LIMIT);
    // Be forgiving: accept { text } JSON too.
    if (/application\/json/i.test(req.headers['content-type'] || '')) {
      try { text = String(JSON.parse(text).text ?? ''); } catch { throw new HttpError(400, 'Expected text/plain or { text }'); }
    }
    text = text.replace(/\r\n/g, '\n');
    if (text && !text.endsWith('\n')) text += '\n';
    await withLock(() => writeFileAtomic(paths.userWords, text));
    sendJson(res, 200, { ok: true, bytes: Buffer.byteLength(text) });
  });

  // Addition to SPEC: structured edits so the builder can ban/add single words without rewriting the file itself.
  route('PATCH', /^\/api\/user-words$/, async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') throw new HttpError(400, 'Body must be { add?, ban?, unban?, remove? }');
    const text = await withLock(async () => {
      const next = editUserWords(await readTextIfExists(paths.userWords), body);
      await writeFileAtomic(paths.userWords, next);
      return next;
    });
    sendJson(res, 200, { ok: true, text });
  });

  route('GET', /^\/api\/user-clues$/, async (req, res) => {
    const warnings = [];
    const clues = await readUserClues(warnings, { repair: false });
    if (warnings.length) res.setHeader('X-XW-Warning', encodeURIComponent(warnings.join(' ')));
    sendJson(res, 200, clues || {});
  });

  /**
   * data/user-clues.json as an object. A file that is not a JSON object (e.g. after a bad hand edit) is reported in
   * `warnings`; with `repair` it is moved aside to user-clues.json.bad-<time> and {} is returned so it can be
   * rebuilt. Returns null when the file cannot be used and was not moved (then it must not be overwritten).
   */
  async function readUserClues(warnings, { repair = true } = {}) {
    let text;
    try {
      text = await fsp.readFile(paths.userClues, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      log(`warning: cannot read ${paths.userClues}: ${err.message}`);
      warnings.push(`data/user-clues.json could not be read (${err.code || err.message}); your clues were not remembered.`);
      return null;
    }
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      throw new Error('it is not a JSON object');
    } catch (err) {
      log(`warning: ${paths.userClues} is damaged: ${err.message}`);
      if (!repair) {
        warnings.push(`data/user-clues.json is damaged (${err.message}); clue memory is ignored until it is fixed.`);
        return null;
      }
      const aside = `${paths.userClues}.bad-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try {
        await fsp.rename(paths.userClues, aside);
      } catch (renameErr) {
        warnings.push(`data/user-clues.json is damaged and could not be moved aside (${renameErr.message}); your clues were not remembered.`);
        return null;
      }
      warnings.push(`data/user-clues.json was damaged (${err.message}). It was moved to ${path.basename(aside)} and a new one was started.`);
      return {};
    }
  }

  async function handleApi(req, res, pathname) {
    const matching = routes.filter((r) => r.pattern.test(pathname));
    if (!matching.length) throw new HttpError(404, `Unknown API endpoint ${pathname}`);
    const r = matching.find((x) => x.method === req.method);
    if (!r) {
      res.setHeader('Allow', matching.map((x) => x.method).join(', '));
      throw new HttpError(405, `${req.method} not allowed on ${pathname}`);
    }
    let params;
    try {
      params = r.pattern.exec(pathname).slice(1).map((p) => decodeURIComponent(p));
    } catch {
      throw new HttpError(400, 'Malformed URL');
    }
    await r.handler(req, res, params);
  }

  // ---- static files ----
  async function resolveStatic(pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes('\0') || decoded.includes('\\')) return null;
    const segments = decoded.split('/').filter(Boolean);
    if (!segments.length || !STATIC_DIRS.has(segments[0])) return null;
    // No dot-segments and no hidden files (also blocks our own .tmp files).
    if (segments.some((s) => s.startsWith('.'))) return null;
    const base = path.join(root, segments[0]);
    const full = path.resolve(root, ...segments);
    if (full !== base && !full.startsWith(base + path.sep)) return null;
    // Symlinks inside a served directory must not lead out of it (e.g. site/x -> ../drafts).
    try {
      const realBase = await fsp.realpath(base);
      const real = await fsp.realpath(full);
      if (real !== realBase && !real.startsWith(realBase + path.sep)) return null;
      return real;
    } catch {
      return null; // does not exist
    }
  }

  /** Puzzles dated after this are not released yet (same rule as `npm run build -- --released-only`). */
  async function releasedDate() {
    return releasedThrough(await readConfig().catch(() => ({})));
  }

  /**
   * For devices on the network: hide unreleased puzzle files and drop them from the index, so the dev server
   * shows a phone exactly what the deployed site would. Returns true when it answered the request itself.
   */
  async function serveRemotePuzzles(req, res, file) {
    const puzzlesDir = await fsp.realpath(paths.puzzles).catch(() => null);
    if (!puzzlesDir || path.dirname(file) !== puzzlesDir) return false;
    const name = path.basename(file);
    const released = await releasedDate();
    if (/^\d{4}-\d{2}-\d{2}\.json$/.test(name) && name.slice(0, 10) > released) throw new HttpError(404, 'Not found');
    if (name !== 'index.json') return false;
    const index = await readJsonIfExists(file, null);
    if (!index || !Array.isArray(index.puzzles)) return false;
    const body = JSON.stringify({ ...index, puzzles: index.puzzles.filter((p) => !(p && typeof p.date === 'string' && p.date > released)) });
    const headers = { 'Content-Type': MIME_TYPES['.json'], 'Content-Length': Buffer.byteLength(body), 'X-Content-Type-Options': 'nosniff' };
    send(res, 200, req.method === 'HEAD' ? undefined : body, headers);
    return true;
  }

  async function handleStatic(req, res, url, { remote = false } = {}) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      throw new HttpError(405, 'Method not allowed');
    }
    let file = await resolveStatic(url.pathname);
    if (!file) throw new HttpError(404, 'Not found');
    if (remote && await serveRemotePuzzles(req, res, file)) return undefined;
    let stat = await fsp.stat(file);
    if (stat.isDirectory()) {
      if (!url.pathname.endsWith('/')) {
        return send(res, 301, '', { Location: `${url.pathname}/${url.search}` });
      }
      file = path.join(file, 'index.html');
      try {
        stat = await fsp.stat(file);
      } catch {
        throw new HttpError(404, 'Not found');
      }
    }
    const type = MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Content-Length': stat.size, 'X-Content-Type-Options': 'nosniff' };
    if (req.method === 'HEAD') return send(res, 200, undefined, headers);
    const data = await fsp.readFile(file);
    return send(res, 200, data, headers);
  }

  /** API writes must come from the builder's own pages, not from another website open in the same browser. */
  function checkSameOrigin(req) {
    const { origin } = req.headers;
    if (origin !== undefined) {
      let sameHost = false;
      try {
        sameHost = new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase();
      } catch { /* "null" or garbage */ }
      if (!sameHost) throw new HttpError(403, 'Cross-origin request refused');
    }
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Cross-site request refused');
  }

  // ---- dispatcher ----
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'Bad request URL' });
    }
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    // Another device on the network (only possible with --lan / HOST=0.0.0.0): player site only, read-only.
    const remote = !isLoopbackAddress(req.socket.remoteAddress);
    try {
      if (!isAllowedHost(req.headers.host, extraHosts)) {
        throw new HttpError(403, 'Unknown Host header: open the dev server via localhost or this computer\'s address');
      }
      if (remote && !(url.pathname === '/' || url.pathname === '/site' || url.pathname.startsWith('/site/'))) {
        throw new HttpError(403, 'Only the player site (/site/) is available to other devices. Open the builder on the computer running `npm run dev`, at http://localhost:<port>/builder/.');
      }
      if (remote && req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        throw new HttpError(405, 'Method not allowed');
      }
      if (url.pathname === '/' || url.pathname === '') {
        send(res, 302, '', { Location: remote ? '/site/' : '/builder/' });
      } else if (isApi) {
        if (req.method !== 'GET' && req.method !== 'HEAD') checkSameOrigin(req);
        await handleApi(req, res, url.pathname);
      } else {
        await handleStatic(req, res, url, { remote });
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) log(`error: ${req.method} ${url.pathname}: ${err.stack || err.message}`);
      if (!res.headersSent) {
        if (isApi || status !== 404) sendJson(res, status, { error: err.message, ...(err.extra || {}) });
        else send(res, 404, 'Not found', { 'Content-Type': MIME_TYPES['.txt'] });
      } else {
        res.end();
      }
    }
    if (isApi) log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
  });
  server.root = root;
  return server;
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const value = () => inline ?? argv[++i];
    if (flag === '--root') out.root = value();
    else if (flag === '--port' || flag === '-p') out.port = value();
    else if (flag === '--host') out.host = value();
    else if (flag === '--lan') out.lan = true;
    else if (flag === '--quiet' || flag === '-q') out.quiet = true;
    else if (flag === '--help' || flag === '-h') out.help = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  return out;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (args.help) {
    console.log('Usage: node scripts/server.mjs [--port 5173] [--root <dir>] [--lan | --host <addr>] [--quiet]\n'
      + '  --lan   also listen on the network so phones on the same Wi-Fi can open the player site\n'
      + '          (other devices only get /site/, without unreleased puzzles; the builder stays local)\n'
      + 'Env: PORT, XW_ROOT, HOST, XW_ALLOWED_HOSTS');
    return;
  }
  const root = path.resolve(args.root || process.env.XW_ROOT || REPO_ROOT);
  const port = Number(args.port || process.env.PORT || 5173);
  // This computer only, unless asked: drafts contain the answers to puzzles that are not out yet.
  const host = args.host || process.env.HOST || (args.lan ? '0.0.0.0' : '127.0.0.1');
  const server = createServer({ root, log: args.quiet ? () => {} : (line) => console.log(line) });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Try: PORT=${port + 1} npm run dev`);
    else console.error(err);
    process.exit(1);
  });
  server.listen(port, host, () => {
    const actual = server.address().port;
    const lines = [
      '',
      '  Armani Crossword dev server',
      '',
      `  Builder   http://localhost:${actual}/builder/`,
      `  Site      http://localhost:${actual}/site/`,
    ];
    if (host === '0.0.0.0' || host === '::') {
      for (const ip of lanAddresses()) lines.push(`  Network   http://${ip}:${actual}/site/   (open on your phone; same Wi-Fi)`);
      lines.push('            Other devices only get the player site (released puzzles); the builder stays on this computer.');
    } else if (isLoopbackAddress(host) || host === 'localhost') {
      lines.push('', '  Test on your phone: npm run dev -- --lan');
    }
    lines.push('', `  Root      ${root}`, '  Press Ctrl+C to stop.', '');
    console.log(lines.join('\n'));
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
