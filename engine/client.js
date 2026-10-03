// EngineClient: promise-based wrapper around the engine worker (SPEC §3.5). Browser only (main thread).
//
//   const engine = new EngineClient();
//   await engine.init(wordlistText, userWordsText);          // → { size }
//   const job = engine.fill(grid, { minScore: 30 }, (stats) => …);
//   job.cancel();                                            // job.promise resolves with { ok:false, reason:'aborted' }
//   const { layouts } = await engine.layouts(params, onProgress).promise;
//   const list = await engine.candidates(grid, '12A', { minScore: 0, limit: 200, filter: '' });
//   const fit = await engine.fitWords(grid, { words: ['GHOST'], timeLimitMs: 5000 }).promise;  // → { added, filled, … }
//   await engine.updateWords({ add: [['WORD', 60]], ban: ['UGLY'], unban: [] });
//   engine.terminate();
//
// Option objects are sent with postMessage, so functions inside them (onProgress, signal) are stripped — pass the
// progress callback as the separate argument instead. Everything else must be structured-clone friendly; e.g. the
// answer-freshness option `penalize` (fill, layouts, fitWords, candidates) may be a plain object { WORD: points }, a
// Map or an array of [word, points] pairs.
//   const job = engine.fill(grid, { penalize: { ACE: 30, ARENA: 30 } });

let nextId = 1;

export class EngineClient {
  /** @param {string|URL} [workerUrl] defaults to ./worker.js next to this module */
  constructor(workerUrl) {
    const url = workerUrl || new URL('./worker.js', import.meta.url);
    this.worker = new Worker(url, { type: 'module' });
    /** id → { resolve, reject, onProgress } */
    this._pending = new Map();
    this._terminated = false;
    this.worker.onmessage = (e) => this._onMessage(e.data || {});
    this.worker.onerror = (e) => {
      e.preventDefault?.();
      this._failAll(new Error(`Engine worker error: ${e.message || 'failed to load'}`));
    };
    this.worker.onmessageerror = () => this._failAll(new Error('Engine worker sent an unreadable message'));
  }

  /** Load the word list (and optional user-words.txt text). Resolves with { size }. */
  init(wordlistText, userWordsText = '') {
    return this._request({ type: 'init', wordlistText, userWordsText }).promise;
  }

  /** Fill a grid. Returns { id, promise, cancel }; the promise resolves with a FillResult. */
  fill(grid, options = {}, onProgress = null) {
    return this._request({ type: 'fill', grid: plainGrid(grid), options: cloneable(options) }, onProgress);
  }

  /** Generate theme layouts. Returns { id, promise, cancel }; resolves with { layouts, attempts, ms }. */
  layouts(params = {}, onProgress = null) {
    const { wordlist, ...rest } = params; // the worker uses its own word list
    return this._request({ type: 'layouts', params: cloneable(rest) }, onProgress);
  }

  /**
   * Fit extra theme words into the grid's slots, refilling around them (engine/theme-fit.js). Non-empty cells are
   * kept. Returns { id, promise, cancel }; resolves with { cells, filled, stats, added, left, tries, ms, aborted }.
   */
  fitWords(grid, options = {}) {
    return this._request({ type: 'fitWords', grid: plainGrid(grid), options: cloneable(options) });
  }

  /** Ranked candidates for one entry. Resolves with [{ word, score, viability }]. */
  candidates(grid, entryId, options = {}) {
    return this._request({ type: 'candidates', grid: plainGrid(grid), entryId, options: cloneable(options) }).promise;
  }

  /** Add / ban / unban words in the worker's list. Resolves when applied. */
  updateWords({ add = [], ban = [], unban = [] } = {}) {
    return this._request({ type: 'words', add, ban, unban }).promise;
  }

  terminate() {
    if (this._terminated) return;
    this._terminated = true;
    this.worker.terminate();
    this._failAll(new Error('Engine terminated'));
  }

  // -------------------------------------------------------------------------

  _request(msg, onProgress = null) {
    const id = nextId++;
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    if (this._terminated) {
      reject(new Error('Engine terminated'));
    } else {
      this._pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ ...msg, id });
    }
    const cancel = () => {
      if (this._pending.has(id)) this.worker.postMessage({ type: 'cancel', id });
    };
    return { id, promise, cancel };
  }

  _onMessage(msg) {
    const p = this._pending.get(msg.id);
    if (!p) return;
    switch (msg.type) {
      case 'progress':
        if (p.onProgress) {
          try {
            p.onProgress(msg.stats);
          } catch (err) {
            console.error(err);
          }
        }
        break;
      case 'result':
        this._pending.delete(msg.id);
        p.resolve(msg.result);
        break;
      case 'ready':
        this._pending.delete(msg.id);
        p.resolve({ size: msg.size });
        break;
      case 'ok':
        this._pending.delete(msg.id);
        p.resolve({ size: msg.size });
        break;
      case 'error':
        this._pending.delete(msg.id);
        p.reject(new Error(msg.message));
        break;
      default:
        break;
    }
  }

  _failAll(err) {
    for (const p of this._pending.values()) p.reject(err);
    this._pending.clear();
  }
}

function plainGrid(grid) {
  return { width: grid.width, height: grid.height, cells: Array.from(grid.cells) };
}

/** Drop functions and signal objects that cannot be structured-cloned. */
function cloneable(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (typeof v === 'function' || k === 'signal' || k === 'onProgress') continue;
    out[k] = v;
  }
  return out;
}
