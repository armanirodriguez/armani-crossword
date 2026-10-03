// Changes to data/user-words.txt go through here so the server file, the main-thread word index, the cached
// text (used when the engine restarts) and the running engine worker all stay in sync.

import { normalizeAnswer } from '../../site/shared/puzzle.js';
import { api } from './api.js';
import { setUserWordsText } from './word-index.js';

/**
 * Structured edit: { add: [[word, score]], ban: [word], unban: [word], remove: [word] } (see PATCH /api/user-words).
 * Returns the new user-words text.
 */
export async function applyUserWordOps(app, ops) {
  const res = await api.patchUserWords(ops);
  sync(app, res.text);
  // Translate to the engine's vocabulary ({ add, ban, unban }).
  const norm = (list) => (list || []).map((w) => normalizeAnswer(w)).filter(Boolean);
  const engineOps = { add: [], ban: norm(ops.ban), unban: norm(ops.unban) };
  for (const [w, score] of ops.add || []) {
    const word = normalizeAnswer(w);
    if (!word) continue;
    engineOps.unban.push(word);
    engineOps.add.push([word, score]);
  }
  for (const word of norm(ops.remove)) {
    // Back to the base list: restore its base score, or make it unusable if it was only a user word.
    const base = app.wordIndex?.base.get(word);
    if (base !== undefined) {
      engineOps.unban.push(word);
      engineOps.add.push([word, base]);
    } else {
      engineOps.ban.push(word);
    }
  }
  await app.engine.updateWords(engineOps);
  return res.text;
}

/** Replace the whole file. The engine is restarted so it sees exactly the new list. */
export async function saveUserWordsText(app, text) {
  await api.saveUserWords(text);
  const normalized = text.replace(/\r\n/g, '\n');
  sync(app, normalized && !normalized.endsWith('\n') ? `${normalized}\n` : normalized);
  if (app.engine.status !== 'unavailable') app.engine.restart();
}

function sync(app, text) {
  app.wordIndex?.setUserWords(text);
  setUserWordsText(text);
  app.emit('userwords', { text });
}
