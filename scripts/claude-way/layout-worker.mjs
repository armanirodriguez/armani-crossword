// Worker thread for scripts/claude-way/build.mjs: one generateLayouts run (one seed) with its own copy of the word
// list, so several seeds can search in parallel. workerData: { root, avoid: [WORD], params } -> posts
// { layouts, attempts, ms } or { error }.
import { parentPort, workerData } from 'node:worker_threads';

import { generateLayouts } from '../../engine/layout.js';
import { loadWordList, paths } from './common.mjs';

try {
  const { root, avoid = [], params } = workerData;
  const wordlist = loadWordList(paths(root));
  for (const w of avoid) wordlist.ban(w);
  const { layouts, attempts, ms } = await generateLayouts({ ...params, wordlist });
  parentPort.postMessage({ layouts, attempts, ms });
} catch (err) {
  parentPort.postMessage({ error: String(err && err.message ? err.message : err) });
}
