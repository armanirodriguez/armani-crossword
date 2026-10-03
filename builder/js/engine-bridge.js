// Connects the builder to the fill engine (engine/client.js, SPEC §3.5) and degrades gracefully when the engine
// is missing or broken: manual editing must keep working, and features that need the engine show a status message.
//
// Status: 'idle' -> 'loading' -> 'ready' | 'unavailable'. Listen with engine.addEventListener('status', …).

import { loadWordData } from './word-index.js';

class EngineBridge extends EventTarget {
  status = 'idle';
  message = '';
  size = 0;
  client = null;
  #starting = null;

  get ready() { return this.status === 'ready'; }

  /** Load the engine module, start its worker and send it the word list. Safe to call repeatedly. */
  start() {
    if (this.status === 'ready') return Promise.resolve(true);
    if (this.#starting) return this.#starting;
    this.#set('loading', 'Loading word list…');
    this.#starting = (async () => {
      let mod;
      try {
        mod = await import(new URL('../../engine/client.js', import.meta.url).href);
      } catch (err) {
        console.warn('Engine module could not be loaded:', err);
        this.#set('unavailable', 'The fill engine (engine/client.js) could not be loaded.');
        return false;
      }
      try {
        const { wordlistText, userWordsText } = await loadWordData();
        if (!wordlistText) throw new Error('data/wordlist.txt is missing or empty');
        this.#set('loading', 'Starting fill engine…');
        const client = new mod.EngineClient();
        const ready = await withTimeout(client.init(wordlistText, userWordsText), 60000, 'The engine did not start within 60 s');
        this.client = client;
        // init() resolves with the worker's { type: 'ready', size } message (or just the size).
        this.size = Number(typeof ready === 'number' ? ready : ready?.size) || 0;
        this.#set('ready', this.size ? `${this.size.toLocaleString()} words` : 'Ready');
        return true;
      } catch (err) {
        console.warn('Engine failed to start:', err);
        this.#set('unavailable', `Fill engine failed to start: ${err?.message || err}`);
        return false;
      }
    })().finally(() => { this.#starting = null; });
    return this.#starting;
  }

  /** Restart from scratch (e.g. after the user edited their word list wholesale). */
  async restart() {
    try { this.client?.terminate(); } catch { /* ignore */ }
    this.client = null;
    this.status = 'idle';
    return this.start();
  }

  #require() {
    if (!this.ready || !this.client) {
      throw new Error(this.status === 'loading' ? 'The fill engine is still loading…' : (this.message || 'The fill engine is not available'));
    }
    return this.client;
  }

  /** -> { promise, cancel } (SPEC §3.5). */
  fill(grid, options, onProgress) { return this.#require().fill(grid, options, onProgress); }

  /** -> { promise, cancel } */
  layouts(params, onProgress) { return this.#require().layouts(params, onProgress); }

  /** -> { promise, cancel }; fits extra theme words into the grid (engine/theme-fit.js via the worker). */
  fitWords(grid, options) {
    const client = this.#require();
    if (typeof client.fitWords !== 'function') throw new Error('This version of the fill engine cannot fit theme words');
    return client.fitWords(grid, options);
  }

  /** -> Promise<[{ word, score, viability }]> */
  candidates(grid, entryId, options) { return this.#require().candidates(grid, entryId, options); }

  /** Push word-list edits to the worker. Silently skipped when the engine is not running (it reads user-words on start). */
  async updateWords(ops) {
    if (!this.ready || !this.client) return;
    try {
      // Never let a silent worker hold up the UI (the word is already saved on disk either way).
      await withTimeout(Promise.resolve(this.client.updateWords(ops)), 5000, 'updateWords timed out');
    } catch (err) {
      console.warn('updateWords failed', err);
    }
  }

  #set(status, message) {
    this.status = status;
    this.message = message;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, message } }));
  }
}

function withTimeout(promise, ms, message) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(message)), ms); }),
  ]);
}

export const engine = new EngineBridge();
