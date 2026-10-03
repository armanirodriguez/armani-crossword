// Engine Web Worker (module worker). Holds one WordList and runs fills, layout generation and candidate ranking
// off the main thread. Protocol (SPEC §3.5):
//
//   → { type:'init', wordlistText, userWordsText }           ← { type:'ready', size }
//   → { type:'fill', id, grid, options }                     ← { type:'progress', id, stats }* then { type:'result', id, result }
//   → { type:'layouts', id, params }                         ← { type:'progress', id, stats }* then { type:'result', id, result }
//   → { type:'candidates', id, grid, entryId, options }      ← { type:'result', id, result }
//   → { type:'fitWords', id, grid, options }                 ← { type:'result', id, result }   (addition, see theme-fit.js)
//   → { type:'cancel', id }                                  (the running job resolves with reason 'aborted')
//   → { type:'words', add:[[word, score]], ban:[word], unban:[word] }   ← { type:'ok' }
//   ← { type:'error', id, message }
//
// Additions: 'init' and 'words' may carry an `id`, which is echoed on 'ready' / 'ok' / 'error'. Options and params
// are passed through unchanged, so e.g. `penalize` (answer freshness, see fillGrid) works for fill, layouts, fitWords
// and candidates.
// Jobs are cooperative (they yield every ~30 ms), so several can run concurrently and 'cancel' is honoured quickly.

import { WordList } from './wordlist.js';
import { fillGrid } from './fill.js';
import { generateLayouts } from './layout.js';
import { rankCandidates } from './candidates.js';
import { fitWords } from './theme-fit.js';

let wordlist = null;
/** Running jobs: id → abort signal. */
const jobs = new Map();

const post = (msg) => self.postMessage(msg);

function requireWordlist() {
  if (!wordlist) throw new Error('Engine not initialised: send an init message with the word list first');
  return wordlist;
}

/** Run an async job with a cancellable signal and throttled-at-source progress messages. */
async function runJob(id, fn) {
  const signal = { aborted: false };
  jobs.set(id, signal);
  try {
    const result = await fn(signal, (stats) => post({ type: 'progress', id, stats }));
    post({ type: 'result', id, result });
  } catch (err) {
    post({ type: 'error', id, message: err?.message || String(err) });
  } finally {
    jobs.delete(id);
  }
}

self.onmessage = (event) => {
  const msg = event.data || {};
  const { type, id } = msg;
  try {
    switch (type) {
      case 'init': {
        const wl = WordList.fromText(msg.wordlistText || '');
        if (msg.userWordsText) wl.applyUserWords(msg.userWordsText);
        wordlist = wl;
        post({ type: 'ready', id, size: wl.size });
        break;
      }
      case 'fill': {
        const wl = requireWordlist();
        runJob(id, (signal, onProgress) => fillGrid(msg.grid, wl, { ...(msg.options || {}), signal, onProgress }));
        break;
      }
      case 'layouts': {
        const wl = requireWordlist();
        runJob(id, (signal, onProgress) => generateLayouts({ ...(msg.params || {}), wordlist: wl, signal, onProgress }));
        break;
      }
      case 'fitWords': {
        // options: { words, filled?, minScore?, timeLimitMs?, tryMs?, maxSlots?, seed?, penalize? } — see fitWords().
        const wl = requireWordlist();
        runJob(id, (signal) => fitWords({ ...(msg.options || {}), grid: msg.grid, wordlist: wl, signal }));
        break;
      }
      case 'candidates': {
        const wl = requireWordlist();
        const result = rankCandidates(msg.grid, msg.entryId, wl, msg.options || {});
        post({ type: 'result', id, result });
        break;
      }
      case 'cancel': {
        const signal = jobs.get(id);
        if (signal) signal.aborted = true;
        break;
      }
      case 'words': {
        const wl = requireWordlist();
        for (const [word, score] of msg.add || []) wl.add(word, score);
        for (const word of msg.ban || []) wl.ban(word);
        for (const word of msg.unban || []) wl.unban(word);
        post({ type: 'ok', id, size: wl.size });
        break;
      }
      default:
        throw new Error(`Unknown message type ${type}`);
    }
  } catch (err) {
    post({ type: 'error', id, message: err?.message || String(err) });
  }
};
