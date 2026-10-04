// Loading config.json, puzzles/index.json and puzzle files (relative URLs only, SPEC §0/§6).
// Failures are classified so the UI can show a helpful message:
//   'offline'    network error (no connection / server unreachable)
//   'not-found'  HTTP 404
//   'http'       other HTTP error
//   'bad-json'   the response is not valid JSON
//   'invalid'    valid JSON that is not a valid puzzle (validatePuzzle errors in .details)

import { validatePuzzle } from '../shared/puzzle.js';

export const DEFAULT_CONFIG = Object.freeze({
  siteName: 'Armani Crossword',
  tagline: '',
  timeZone: null,
  shareUrl: '',
  shareGrid: true,
});

export class LoadError extends Error {
  constructor(kind, message, details = []) {
    super(message);
    this.name = 'LoadError';
    this.kind = kind;
    this.details = details;
  }
}

async function fetchJSON(url) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-cache' });
  } catch (err) {
    throw new LoadError('offline', `Could not reach ${url}`, [String(err?.message || err)]);
  }
  if (res.status === 404) throw new LoadError('not-found', `${url} was not found`);
  if (!res.ok) throw new LoadError('http', `${url}: HTTP ${res.status}`);
  let text;
  try {
    text = await res.text();
  } catch (err) {
    throw new LoadError('offline', `Connection lost while loading ${url}`, [String(err?.message || err)]);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new LoadError('bad-json', `${url} is not valid JSON`);
  }
}

/** Site config merged over defaults. Never throws (a missing/broken config just means defaults). */
export async function loadConfig() {
  try {
    const raw = await fetchJSON('config.json');
    return sanitizeConfig(raw);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function sanitizeConfig(raw) {
  const c = { ...DEFAULT_CONFIG };
  if (!raw || typeof raw !== 'object') return c;
  if (typeof raw.siteName === 'string' && raw.siteName.trim()) c.siteName = raw.siteName.trim();
  if (typeof raw.tagline === 'string') c.tagline = raw.tagline.trim();
  if (typeof raw.timeZone === 'string' && raw.timeZone.trim()) c.timeZone = raw.timeZone.trim();
  if (typeof raw.shareUrl === 'string') c.shareUrl = raw.shareUrl.trim();
  if (typeof raw.shareGrid === 'boolean') c.shareGrid = raw.shareGrid;
  return c;
}

/** The puzzle index. A missing index (404) is treated as "no puzzles yet". */
export async function loadIndex() {
  try {
    const idx = await fetchJSON('puzzles/index.json');
    if (!idx || typeof idx !== 'object' || !Array.isArray(idx.puzzles)) {
      throw new LoadError('bad-json', 'puzzles/index.json has an unexpected shape');
    }
    return idx;
  } catch (err) {
    if (err.kind === 'not-found') return { format: 'crossword-index/1', puzzles: [] };
    throw err;
  }
}

const cache = new Map();

/**
 * A published puzzle by id ("2026-10-04" daily, "2026-10-04-mini", …), validated. Successful loads are cached for
 * the session. A file whose id is not the one asked for (e.g. a daily saved as a mini's file) is 'invalid'.
 */
export async function loadPuzzleFile(id) {
  if (cache.has(id)) return cache.get(id);
  const raw = await fetchJSON(`puzzles/${id}.json`);
  checkPuzzle(raw);
  if (raw.id !== id) throw new LoadError('invalid', 'This puzzle file is damaged', [`puzzles/${id}.json holds puzzle ${raw.id}`]);
  cache.set(id, raw);
  return raw;
}

/** Throw a LoadError('invalid') unless `raw` is a valid published puzzle. */
export function checkPuzzle(raw) {
  let result;
  try {
    result = validatePuzzle(raw);
  } catch (err) {
    result = { ok: false, errors: [String(err?.message || err)] };
  }
  if (!result.ok) throw new LoadError('invalid', 'This puzzle file is damaged', result.errors);
  return raw;
}
