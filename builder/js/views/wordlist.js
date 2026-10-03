// Word list: look up words or patterns, change a word's score, ban / unban, add many words at once, and edit
// data/user-words.txt directly. Scores: 70–100 great · 50–69 solid · 35–49 acceptable · 1–34 obscure · 0 never.

import { normalizeAnswer } from '../../../site/shared/puzzle.js';
import { h, icon, debounce, plural } from '../dom.js';
import { confirmDialog, toast, toastError } from '../dialogs.js';
import { api } from '../api.js';
import { parseWordText } from '../word-index.js';
import { applyUserWordOps, saveUserWordsText } from '../user-words.js';

/** A whole score 0–100 from a text box, or null when it is empty / not a number / out of range. */
export function parseScore(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n);
}

function band(score) {
  if (score === undefined) return { label: '—', cls: 'muted' };
  if (score >= 70) return { label: 'great', cls: 'ok' };
  if (score >= 50) return { label: 'solid', cls: 'ok' };
  if (score >= 35) return { label: 'acceptable', cls: 'info' };
  if (score >= 1) return { label: 'obscure', cls: 'warn' };
  return { label: 'never', cls: 'error' };
}

export function mountWordList(container, app) {
  const search = h('input', {
    type: 'search', class: 'grow', placeholder: 'A word (PUMPKIN) or a pattern with ? for unknown letters (P?MPK?N)',
    'aria-label': 'Search the word list', autocomplete: 'off', spellcheck: false,
    oninput: debounce(() => renderLookup(), 150),
  });
  const lookup = h('div', { class: 'lookup' });
  const addText = h('textarea', { rows: 5, spellcheck: false, placeholder: 'One per line: WORD or WORD;SCORE\nGHOSTLY;75\nboo-hoo' });
  const addScore = h('input', { type: 'number', class: 'num', min: 0, max: 100, value: 60, 'aria-label': 'Default score' });
  const raw = h('textarea', { class: 'raw-words mono', rows: 14, spellcheck: false, 'aria-label': 'data/user-words.txt' });
  const rawInfo = h('span', { class: 'muted small' });
  const rawSave = h('button', { class: 'btn primary sm', type: 'button', disabled: true, onclick: saveRaw }, 'Save file');
  const rawRevert = h('button', { class: 'btn sm', type: 'button', disabled: true, onclick: () => loadRaw() }, 'Revert');
  let rawLoaded = '';

  container.append(h('div', { class: 'page' },
    h('header', { class: 'page-head' },
      h('h1', null, 'Word list'),
      h('p', { class: 'muted' }, 'The fill engine uses data/wordlist.txt plus your own changes in data/user-words.txt. ',
        'Scores: 70+ great · 50–69 solid · 35–49 acceptable · below 35 only when needed.')),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, 'Look up'),
      h('div', { class: 'row gap-sm' }, icon('search'), search),
      lookup),
    h('div', { class: 'two-col' },
      h('section', { class: 'card' },
        h('h2', { class: 'card-title' }, 'Add words'),
        h('p', { class: 'card-help' }, 'Names, slang, inside jokes — anything you want the engine to be able to use.'),
        addText,
        h('div', { class: 'row gap-sm' },
          h('label', { class: 'row gap-xs small' }, 'Score for lines without one', addScore),
          h('button', { class: 'btn primary sm', type: 'button', onclick: addWords }, icon('plus', { size: 14 }), 'Add'))),
      h('section', { class: 'card' },
        h('h2', { class: 'card-title' }, 'Your changes (data/user-words.txt)'),
        h('p', { class: 'card-help' }, '“WORD;SCORE” adds or re-scores a word, “-WORD” bans it, “#” starts a comment.'),
        raw,
        h('div', { class: 'row gap-sm' }, rawSave, rawRevert, rawInfo)))));

  // ---- lookup ----
  function renderLookup() {
    const idx = app.wordIndex;
    const q = search.value.trim();
    lookup.replaceChildren();
    if (!idx) { lookup.append(h('p', { class: 'muted small' }, h('span', { class: 'spinner' }), ' Loading the word list…')); return; }
    if (!q) { lookup.append(h('p', { class: 'muted small' }, `${idx.size.toLocaleString()} words in the base list.`)); return; }
    if (/[?.*_]/.test(q)) {
      const pattern = q.replace(/[*_]/g, '?');
      const matches = idx.match(pattern, { limit: 120, minScore: 0 });
      lookup.append(h('p', { class: 'muted small' }, matches.length >= 120 ? 'First 120 matches:' : `${plural(matches.length, 'match', 'matches')}`));
      if (matches.length) {
        lookup.append(h('div', { class: 'match-grid' }, matches.map((m) => h('button', {
          class: 'match', type: 'button', onclick: () => { search.value = m.word; renderLookup(); },
        }, h('span', { class: 'cand-word', text: m.word }), h('span', { class: ['score', band(m.score).cls] }, String(m.score))))));
      }
      return;
    }
    const word = normalizeAnswer(q);
    if (!word) return;
    lookup.append(wordCard(idx.info(word)));
  }

  function wordCard(info) {
    const { word, base, user, banned, score } = info;
    const scoreInput = h('input', { type: 'number', class: 'num', min: 0, max: 100, value: user ?? base ?? 60, 'aria-label': `Score for ${word}` });
    let status;
    if (banned) status = h('span', { class: 'pill error' }, 'Banned by you');
    else if (score === undefined) status = h('span', { class: 'pill muted' }, base === 0 ? 'Never used (score 0)' : 'Not in the word list');
    else status = h('span', { class: ['pill', band(score).cls] }, `${score} · ${band(score).label}`);
    const act = (label, fn, cls = 'btn sm') => h('button', { class: cls, type: 'button', onclick: fn }, label);
    return h('div', { class: 'word-card' },
      h('div', { class: 'wc-head' }, h('span', { class: 'wc-word', text: word }), status),
      h('dl', { class: 'wc-facts' },
        h('dt', null, 'Base list'), h('dd', null, base === undefined ? 'not included' : `score ${base}`),
        h('dt', null, 'Your list'), h('dd', null, banned ? 'banned' : user === undefined ? 'no change' : `score ${user}`)),
      h('div', { class: 'row gap-sm wrap' },
        h('label', { class: 'row gap-xs small' }, 'Score', scoreInput),
        act(user === undefined && base === undefined ? 'Add word' : 'Set score', () => setScore(word, scoreInput), 'btn primary sm'),
        banned ? act('Unban', () => run({ unban: [word] }, `${word} unbanned`))
          : act('Ban', () => run({ ban: [word] }, `${word} banned`), 'btn sm danger-ghost'),
        user !== undefined || banned ? act('Reset to base list', () => run({ remove: [word] }, `${word} reset`)) : null));
  }

  /** "Set score": 0 means "never use" (SPEC §2.6), which is what Ban does; an empty or invalid box is an error. */
  function setScore(word, input) {
    const n = parseScore(input.value);
    if (n === null) {
      toast('Enter a score from 0 to 100 (0 = never use).', { type: 'warn' });
      input.focus();
      return undefined;
    }
    if (n === 0) return run({ ban: [word] }, `${word} banned (score 0 = never use)`);
    return run({ add: [[word, n]] }, `${word} saved with score ${n}`);
  }

  async function run(ops, message) {
    if (rawDirty() && !(await confirmDiscard())) return;
    try {
      const text = await applyUserWordOps(app, ops);
      setRaw(text);
      toast(message, { type: 'success' });
      renderLookup();
    } catch (err) {
      toastError(err);
    }
  }

  // ---- add many ----
  async function addWords() {
    const def = parseScore(addScore.value);
    if (def === null) {
      toast('Enter a default score from 0 to 100.', { type: 'warn' });
      addScore.focus();
      return;
    }
    const add = [];
    const bad = [];
    for (const line of addText.value.split('\n')) {
      if (!line.trim()) continue;
      const [w, s] = line.split(';');
      const word = normalizeAnswer(w);
      if (word.length < 3) { bad.push(line.trim()); continue; }
      const n = Number(s);
      add.push([word, s !== undefined && Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : def]);
    }
    if (!add.length) {
      toast(bad.length ? 'Words need at least 3 letters.' : 'Type some words first.', { type: 'warn' });
      return;
    }
    if (rawDirty() && !(await confirmDiscard())) return;
    try {
      const text = await applyUserWordOps(app, { add });
      setRaw(text);
      addText.value = '';
      toast(`Added ${plural(add.length, 'word')}${bad.length ? ` (skipped ${bad.length} too short)` : ''}`, { type: 'success' });
      renderLookup();
    } catch (err) {
      toastError(err);
    }
  }

  // ---- raw file ----
  const rawDirty = () => raw.value !== rawLoaded;
  function setRaw(text) {
    rawLoaded = text;
    raw.value = text;
    renderRawInfo();
  }
  function renderRawInfo() {
    const { scores, bans } = parseWordText(raw.value, { allowBans: true });
    rawInfo.textContent = `${plural(scores.size, 'word')} added or re-scored · ${bans.size} banned${rawDirty() ? ' · unsaved changes' : ''}`;
    rawSave.disabled = !rawDirty();
    rawRevert.disabled = !rawDirty();
  }
  raw.addEventListener('input', renderRawInfo);

  async function loadRaw() {
    try {
      setRaw(await api.getUserWords());
    } catch (err) {
      toastError(err);
    }
  }

  async function saveRaw() {
    try {
      await saveUserWordsText(app, raw.value);
      setRaw(raw.value.replace(/\r\n/g, '\n').replace(/([^\n])$/, '$1\n'));
      toast('Word list saved. The fill engine is reloading it.', { type: 'success' });
      renderLookup();
    } catch (err) {
      toastError(err);
    }
  }

  function confirmDiscard() {
    return confirmDialog({
      title: 'Discard unsaved file edits?',
      message: 'You have unsaved changes in the user-words file box. This action reloads the file from disk.',
      confirmLabel: 'Discard and continue',
      danger: true,
    });
  }

  loadRaw();
  renderLookup();
  const onIndex = () => renderLookup();
  app.addEventListener('wordindex', onIndex);
  search.focus();
  return {
    destroy() { app.removeEventListener('wordindex', onIndex); },
    // Unsaved edits in the raw user-words box: ask before leaving the page (main.js router / beforeunload).
    canLeave: async () => !rawDirty() || confirmDialog({
      title: 'Discard unsaved file edits?',
      message: 'You changed data/user-words.txt in the box below but did not save it.',
      confirmLabel: 'Discard changes',
      danger: true,
    }),
    isDirty: rawDirty,
  };
}
