// Thin client for the dev server's builder API (SPEC §4) and for static data files.

export class ApiError extends Error {
  constructor(status, message, body = null) {
    super(message);
    this.status = status;
    this.body = body; // parsed JSON error body, e.g. { error, errors, warnings, existing }
  }
}

async function request(method, url, { json, text, keepalive = false, headers = {} } = {}) {
  const init = { method, headers: { ...headers }, cache: 'no-store', keepalive };
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (text !== undefined) {
    init.headers['Content-Type'] = 'text/plain; charset=utf-8';
    init.body = text;
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new ApiError(0, 'Cannot reach the dev server. Is `npm run dev` still running?');
  }
  const type = res.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const message = (body && typeof body === 'object' && body.error) || `${method} ${url} failed (${res.status})`;
    throw new ApiError(res.status, message, body && typeof body === 'object' ? body : null);
  }
  return body;
}

const enc = encodeURIComponent;

export const api = {
  listDrafts: () => request('GET', '/api/drafts'),
  getDraft: (id) => request('GET', `/api/drafts/${enc(id)}`),
  /**
   * Save a draft. Options: ifMatch (the updatedAt this copy is based on: the server answers 409
   * { conflict: 'changed' | 'deleted' } instead of overwriting newer work), create (only if no such draft exists),
   * keepalive (page is closing).
   */
  saveDraft: (draft, { ifMatch = null, create = false, keepalive = false } = {}) => {
    const headers = {};
    if (ifMatch) headers['If-Match'] = JSON.stringify(String(ifMatch));
    if (create) headers['If-None-Match'] = '*';
    return request('PUT', `/api/drafts/${enc(draft.id)}`, { json: draft, keepalive, headers });
  },
  deleteDraft: (id) => request('DELETE', `/api/drafts/${enc(id)}`),

  /** Resolves to { ok, puzzle, number, warnings, url }; rejects with ApiError 422 { errors, warnings } / 409 { existing }. */
  publish: (draft, overwrite = false) => request('POST', '/api/publish', { json: { draft, overwrite } }),
  listPublished: () => request('GET', '/api/published'),
  unpublish: (date) => request('DELETE', `/api/published/${enc(date)}`),

  getConfig: () => request('GET', '/api/config'),
  saveConfig: (config) => request('PUT', '/api/config', { json: config }),

  getUserWords: () => request('GET', '/api/user-words'),
  saveUserWords: (text) => request('PUT', '/api/user-words', { text }),
  /** Structured edit: { add: [[word, score]], ban: [word], unban: [word], remove: [word] } -> { ok, text }. */
  patchUserWords: (ops) => request('PATCH', '/api/user-words', { json: ops }),

  getUserClues: () => request('GET', '/api/user-clues'),
  /** Answers of puzzles published within `days` days before/after `date` (not on it): { date, days, answers: { WORD: [dates] } }. */
  recentAnswers: (date, days) => request('GET', `/api/recent-answers?date=${enc(date)}&days=${enc(days)}`),

  /** "Put it online" status: { git, branch, remote, upstream, pending: [{ path, change }], ahead, siteUrl, pagesUrl, busy, ready, problem }. */
  goLiveStatus: () => request('GET', '/api/go-live'),
  /**
   * Commit the published puzzles / site settings / word list and push them: resolves { ok, upToDate, committed,
   * pushed, commit, siteUrl, pagesUrl }; rejects with ApiError { error, hint, code, committed? } or 409 { busy }.
   */
  goLive: () => request('POST', '/api/go-live', { json: {} }),
};

/**
 * Fetch a static file relative to this module (so it works whatever the builder's URL is).
 * Returns null on 404 (optional, possibly not-yet-generated data files).
 */
export async function fetchStatic(relativeToBuilderRoot, as = 'text') {
  const url = new URL(`../../${relativeToBuilderRoot}`, import.meta.url);
  const res = await fetch(url, { cache: 'no-cache' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not load ${relativeToBuilderRoot} (${res.status})`);
  return as === 'json' ? res.json() : res.text();
}
