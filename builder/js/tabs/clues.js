// Clues tab: Across / Down lists with a clue input per entry, suggestions (theme → yours → curated → dictionary),
// status (missing / contains answer / auto-suggested needs review), "Suggest all missing", and a small grid that
// highlights the entry being clued.
//
// Clue text is stored exactly as typed (draft.clues[ANSWER]); it is normalised only when publishing.

import { normalizeAnswer, normalizeClue } from '../../../site/shared/puzzle.js';
import { h, icon, plural, replaceChildren } from '../dom.js';
import { toast } from '../dialogs.js';
import { SOURCE_LABELS } from '../clue-bank.js';
import {
  LONG_CLUE_CHARS, analyze, entryPattern, fillMissingClues, gridOf, themeAnswers, themeClues, undoFilledClues,
} from '../draft-utils.js';
import { miniGrid } from '../mini-grid.js';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'missing', label: 'Missing' },
  { id: 'review', label: 'To review' },
];

export function mountClues(container, ctx) {
  const { store, app, session } = ctx;
  const { clueBank } = app;
  const d = () => store.draft;
  let entries = null;          // analyze(draft)
  let rows = new Map();        // entry id -> { entry, li, input, statusEl, lenEl, suggBtn }
  let order = [];              // entry ids in Enter order
  let activeId = session.clueEntry || null;
  let filter = 'all';
  let popover = null;          // { el, entryId, items, index }

  const summary = h('div', { class: 'clue-summary' });
  const filterSeg = h('div', { class: 'seg sm', role: 'radiogroup', 'aria-label': 'Show' },
    FILTERS.map((f) => h('label', { class: 'seg-item' },
      h('input', { type: 'radio', name: 'clue-filter', value: f.id, checked: f.id === filter, onchange: () => { filter = f.id; applyFilter(); } }),
      h('span', null, f.label))));
  const suggestAllBtn = h('button', { class: 'btn sm', type: 'button', onclick: suggestAllMissing }, icon('sparkle', { size: 14 }), 'Suggest all missing');
  const acrossList = h('ol', { class: 'clue-list', 'aria-label': 'Across clues' });
  const downList = h('ol', { class: 'clue-list', 'aria-label': 'Down clues' });
  const gridBox = h('div', { class: 'clue-grid' });
  const bankNote = h('p', { class: 'muted small' });
  const activeInfo = h('div', { class: 'clue-active small' });

  container.append(h('div', { class: 'clues-layout' },
    h('div', { class: 'clues-toolbar' }, summary, h('div', { class: 'row gap-sm' }, filterSeg, suggestAllBtn)),
    h('div', { class: 'clues-cols' },
      h('section', { class: 'clue-col' }, h('h2', { class: 'col-title' }, 'Across'), acrossList),
      h('section', { class: 'clue-col' }, h('h2', { class: 'col-title' }, 'Down'), downList)),
    h('aside', { class: 'clue-side' },
      h('div', { class: 'card' }, gridBox, activeInfo,
        h('p', { class: 'muted small' }, 'Enter = next clue · ↓ = suggestions · click the grid to jump'),
        bankNote))));

  // ---- building rows ----
  function build() {
    const cur = d();
    entries = analyze(cur);
    rows = new Map();
    order = [];
    acrossList.replaceChildren();
    downList.replaceChildren();
    const theme = themeAnswers(cur);
    for (const e of entries.all) {
      const row = buildRow(e, theme.has(e.answer));
      rows.set(e.id, row);
      (e.dir === 'across' ? acrossList : downList).append(row.li);
      if (e.answer) order.push(e.id);
    }
    if (!entries.all.length) {
      acrossList.append(h('li', { class: 'empty-hint' }, h('strong', null, 'No words yet'),
        h('span', null, 'Build the grid first (Theme & Layout or Grid & Fill).')));
    }
    if (activeId && !rows.has(activeId)) activeId = null;
    refreshAll();
  }

  function buildRow(e, isTheme) {
    const cur = d();
    const answerText = e.answer || entryPattern(gridOf(cur), e).replace(/\./g, '·');
    const input = h('input', {
      type: 'text', class: 'clue-input', maxLength: 300, spellcheck: true, autocomplete: 'off',
      disabled: !e.answer,
      placeholder: e.answer ? 'Write a clue…' : 'Finish this word in the grid first',
      'aria-label': `Clue for ${e.num} ${e.dir}${e.answer ? `, ${e.answer}` : ''}`,
      value: e.answer ? (cur.clues[e.answer] ?? '') : '',
      onfocus: () => setActive(e.id),
      oninput: () => setClue(e.answer, input.value, 'user'),
      onkeydown: (ev) => onInputKey(ev, e),
    });
    const statusEl = h('span', { class: 'cr-status' });
    const lenEl = h('span', { class: 'cr-len muted' });
    const suggBtn = h('button', {
      class: 'sugg-btn', type: 'button', disabled: !e.answer, tabIndex: -1,
      'aria-label': `Suggestions for ${e.answer || e.id}`,
      onclick: () => (popover?.entryId === e.id ? closePopover() : openPopover(e)),
    }, icon('chevronDown', { size: 14 }));
    const li = h('li', { class: 'clue-row', dataset: { id: e.id } },
      h('div', { class: 'cr-head', onclick: () => input.focus() },
        h('span', { class: 'cr-num', text: String(e.num) }),
        h('span', { class: ['cr-answer', !e.answer && 'incomplete'], text: answerText }),
        isTheme ? h('span', { class: 'badge theme' }, 'Theme') : null,
        statusEl,
        lenEl),
      h('div', { class: 'cr-input' }, input, suggBtn));
    return { entry: e, li, input, statusEl, lenEl, suggBtn };
  }

  // ---- state → DOM ----
  function statusOf(e) {
    const cur = d();
    if (!e.answer) return { id: 'incomplete', text: 'Unfinished', cls: 'muted' };
    const raw = cur.clues[e.answer] ?? '';
    const clue = normalizeClue(raw);
    if (!clue) return { id: 'missing', text: 'Missing', cls: 'warn' };
    if (e.answer.length >= 3 && normalizeAnswer(clue).includes(e.answer)) return { id: 'contains', text: 'Contains answer', cls: 'error' };
    if (cur.clueSources?.[e.answer] === 'auto') return { id: 'auto', text: 'Review', cls: 'info' };
    return { id: 'ok', text: '', cls: 'ok' };
  }

  function refreshRow(row) {
    const cur = d();
    const { entry: e, input, statusEl, lenEl, suggBtn, li } = row;
    if (e.answer && document.activeElement !== input) {
      const v = cur.clues[e.answer] ?? '';
      if (input.value !== v) input.value = v;
    }
    const st = statusOf(e);
    li.dataset.status = st.id;
    li.classList.toggle('active', e.id === activeId);
    statusEl.replaceChildren();
    if (st.id === 'auto') {
      statusEl.append(h('button', {
        class: 'pill info', type: 'button', title: 'Suggested automatically — click to mark as reviewed',
        onclick: (ev) => { ev.stopPropagation(); markReviewed(e.answer); },
      }, 'Review', icon('check', { size: 11 })));
    } else if (st.text) {
      statusEl.append(h('span', { class: ['pill', st.cls] }, st.text));
    }
    const len = normalizeClue(cur.clues[e.answer] ?? '').length;
    const long = len > LONG_CLUE_CHARS;
    lenEl.textContent = e.answer && len ? (long ? `${len} · long — may wrap on small phones` : String(len)) : '';
    lenEl.classList.toggle('warn', long);
    lenEl.title = long
      ? `Over ${LONG_CLUE_CHARS} characters: on small phones the clue bar may need a second line. Shorter clues read better.`
      : 'Characters';
    if (e.answer) {
      const n = clueBank.loaded ? suggestionsFor(e).length : 0;
      suggBtn.dataset.count = n ? String(n) : '';
      suggBtn.title = clueBank.loaded ? (n ? `${n} suggestion${n === 1 ? '' : 's'} (↓)` : 'No suggestions') : 'Loading suggestions…';
      suggBtn.classList.toggle('has', n > 0);
    }
  }

  function refreshAll() {
    for (const row of rows.values()) refreshRow(row);
    renderSummary();
    renderGrid();
    applyFilter();
    renderBankNote();
  }

  function renderSummary() {
    const all = entries.all;
    const counts = { missing: 0, auto: 0, contains: 0, incomplete: 0, ok: 0 };
    for (const e of all) counts[statusOf(e).id]++;
    const clued = counts.ok + counts.auto + counts.contains;
    replaceChildren(summary,
      h('strong', null, `${clued} of ${all.length} clued`),
      counts.auto ? h('span', { class: 'pill info' }, `${counts.auto} to review`) : null,
      counts.contains ? h('span', { class: 'pill error' }, `${counts.contains} contain${counts.contains === 1 ? 's' : ''} the answer`) : null,
      counts.incomplete ? h('span', { class: 'pill muted' }, `${plural(counts.incomplete, 'unfinished word')}`) : null,
    );
    suggestAllBtn.disabled = !counts.missing;
  }

  function renderGrid() {
    const cur = d();
    const active = activeId ? rows.get(activeId)?.entry : null;
    gridBox.replaceChildren(miniGrid(gridOf(cur), {
      cellSize: 24,
      numbers: entries.numbers,
      active: new Set(active?.cells || []),
      focus: active ? active.cells[0] : -1,
      circles: cur.circles,
      shaded: cur.shaded,
      label: 'Grid overview — click a square to jump to its clue',
      onCellClick: (i) => {
        const a = entries.acrossAt[i] >= 0 ? entries.across[entries.acrossAt[i]] : null;
        const dn = entries.downAt[i] >= 0 ? entries.down[entries.downAt[i]] : null;
        let target = a || dn;
        if (active && active.cells.includes(i) && a && dn) target = active === a ? dn : a;
        if (target) focusEntry(target.id);
      },
    }));
    if (active) {
      const clue = active.answer ? normalizeClue(cur.clues[active.answer] ?? '') : '';
      replaceChildren(activeInfo,
        h('strong', null, `${active.num} ${active.dir === 'across' ? 'Across' : 'Down'}`), ' ',
        h('span', { class: 'answer' }, active.answer || ''),
        h('div', { class: 'muted', text: clue || 'No clue yet' }));
    } else {
      replaceChildren(activeInfo,h('span', { class: 'muted' }, 'Select a clue to see it in the grid.'));
    }
  }

  function renderBankNote() {
    if (!clueBank.loaded) {
      bankNote.textContent = 'Loading clue suggestions…';
      return;
    }
    const missing = clueBank.missing.map((m) => SOURCE_LABELS[m] || m);
    bankNote.textContent = missing.length
      ? `${missing.join(' and ')} clue bank${missing.length > 1 ? 's are' : ' is'} not available yet (generated by npm run wordlist).`
      : '';
  }

  function applyFilter() {
    for (const row of rows.values()) {
      const st = row.li.dataset.status;
      const show = filter === 'all'
        || (filter === 'missing' && (st === 'missing' || st === 'contains'))
        || (filter === 'review' && (st === 'auto' || st === 'contains'));
      row.li.hidden = !show && row.entry.id !== activeId;
    }
  }

  // ---- actions ----
  function setClue(answer, value, source) {
    store.update((x) => {
      if (value === '') delete x.clues[answer];
      else x.clues[answer] = value;
      x.clueSources = { ...(x.clueSources || {}) };
      if (value === '') delete x.clueSources[answer];
      else x.clueSources[answer] = source;
    }, { kind: 'clues' });
  }

  function markReviewed(answer) {
    store.update((x) => { x.clueSources = { ...(x.clueSources || {}), [answer]: 'user' }; }, { kind: 'clues' });
  }

  function setActive(id) {
    if (activeId === id) return;
    activeId = id;
    session.clueEntry = id;
    const e = rows.get(id)?.entry;
    if (e) { session.index = e.cells[0]; session.dir = e.dir; }
    for (const row of rows.values()) row.li.classList.toggle('active', row.entry.id === id);
    if (popover && popover.entryId !== id) closePopover();
    renderGrid();
  }

  function focusEntry(id) {
    const row = rows.get(id);
    if (!row) return;
    row.li.hidden = false;
    setActive(id);
    if (row.input.disabled) row.li.scrollIntoView({ block: 'nearest' });
    else row.input.focus();
  }

  function onInputKey(ev, e) {
    if (popover && popover.entryId === e.id) {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        movePopover(ev.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (ev.key === 'Enter' && popover.index >= 0) {
        ev.preventDefault();
        pick(e, popover.items[popover.index]);
        return;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closePopover();
        return;
      }
    }
    if (ev.key === 'ArrowDown' && (ev.altKey || !popover)) {
      ev.preventDefault();
      openPopover(e);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const k = order.indexOf(e.id);
      const next = order[(k + (ev.shiftKey ? -1 : 1) + order.length) % order.length];
      if (next) focusEntry(next);
    }
  }

  function suggestionsFor(e) {
    const cur = d();
    const themeClue = themeClues(cur).get(e.answer) || '';
    return clueBank.suggestions(e.answer, { themeClue })
      .filter((s) => s.clue !== normalizeClue(cur.clues[e.answer] ?? ''));
  }

  async function suggestAllMissing() {
    if (!clueBank.loaded) await clueBank.load();
    const cur = d();
    let result = { filled: [], none: 0 };
    store.update((x) => {
      const theme = themeClues(x);
      result = fillMissingClues(x, entries.all, (answer) => clueBank.suggestions(answer, { themeClue: theme.get(answer) || '' })[0] || null);
    }, { kind: 'clues' });
    const { filled, none } = result;
    const added = filled.length;
    const msg = added
      ? `Added ${plural(added, 'suggested clue')} — marked “Review” until you check them.${none ? ` ${none} word(s) had no suggestion.` : ''}`
      : 'No suggestions found for the missing clues.';
    toast(msg, {
      type: added ? 'success' : 'warn',
      action: added ? {
        label: 'Undo',
        onClick: () => {
          if (store.draft?.id !== cur.id) return; // the toast outlived a switch to another draft
          // Only the suggestions themselves: clues typed, picked or reviewed since then stay.
          store.update((x) => { undoFilledClues(x, filled); }, { kind: 'clues' });
        },
      } : null,
    });
  }

  // ---- suggestions popover ----
  function openPopover(e) {
    closePopover();
    const row = rows.get(e.id);
    if (!row || !e.answer) return;
    const items = clueBank.loaded ? suggestionsFor(e) : [];
    const el = h('div', { class: 'sugg-pop', role: 'listbox', 'aria-label': `Suggestions for ${e.answer}` });
    if (!clueBank.loaded) el.append(h('div', { class: 'sugg-empty' }, 'Loading suggestions…'));
    else if (!items.length) el.append(h('div', { class: 'sugg-empty' }, `No suggestions for ${e.answer}. Your published clues will appear here next time.`));
    items.forEach((s, k) => {
      el.append(h('button', {
        class: 'sugg-item', type: 'button', role: 'option', tabIndex: -1, dataset: { k },
        onmousedown: (ev) => ev.preventDefault(), // keep focus in the input
        onclick: () => pick(e, s),
      }, h('span', { class: 'sugg-text', text: s.clue }), h('span', { class: ['sugg-src', s.source], text: SOURCE_LABELS[s.source] || s.source })));
    });
    row.li.append(el);
    popover = { el, entryId: e.id, items, index: -1 };
    row.suggBtn.setAttribute('aria-expanded', 'true');
    if (!row.input.matches(':focus')) row.input.focus();
  }

  function movePopover(step) {
    if (!popover || !popover.items.length) return;
    popover.index = (popover.index + step + popover.items.length) % popover.items.length;
    popover.el.querySelectorAll('.sugg-item').forEach((b, k) => {
      b.classList.toggle('hl', k === popover.index);
      if (k === popover.index) b.scrollIntoView({ block: 'nearest' });
    });
  }

  function pick(e, s) {
    // Picking a suggestion yourself counts as reviewed; only bulk "Suggest all missing" marks clues 'auto'.
    setClue(e.answer, s.clue, s.source === 'theme' ? 'theme' : 'user');
    const row = rows.get(e.id);
    if (row) { row.input.value = s.clue; row.input.focus(); }
    closePopover();
  }

  function closePopover() {
    if (!popover) return;
    rows.get(popover.entryId)?.suggBtn.setAttribute('aria-expanded', 'false');
    popover.el.remove();
    popover = null;
  }

  const onDocDown = (ev) => {
    if (popover && !popover.el.contains(ev.target) && !ev.target.closest?.('.sugg-btn')) closePopover();
  };
  document.addEventListener('mousedown', onDocDown);

  build();
  if (!clueBank.loaded) clueBank.load();
  if (activeId) requestAnimationFrame(() => rows.get(activeId)?.li.scrollIntoView({ block: 'center' }));

  return {
    update(detail) {
      if (detail.kind === 'grid' || detail.kind === 'load' || detail.kind === 'theme') {
        closePopover();
        build();
      } else if (detail.kind === 'clues' || detail.kind === 'external') {
        for (const row of rows.values()) refreshRow(row);
        renderSummary();
        renderGrid();
        renderBankNote();
        if (detail.kind === 'external') applyFilter();
      }
    },
    destroy() {
      document.removeEventListener('mousedown', onDocDown);
    },
  };
}
