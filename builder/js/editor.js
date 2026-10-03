// Draft editor shell: header (title, save status, undo/redo, preview) + step tabs hosting one tab module.
// Each tab module exports mount(container, ctx) -> { update(detail), destroy(), onShow?() }.

import { draftEntries, formatDate } from '../../site/shared/puzzle.js';
import { h, icon, replaceChildren } from './dom.js';
import { hasUnpublishedChanges } from './draft-utils.js';
import { openPreviewTab } from './preview.js';
import { mountSetup } from './tabs/setup.js';
import { mountTheme } from './tabs/theme.js';
import { mountFill } from './tabs/fill.js';
import { mountClues } from './tabs/clues.js';
import { mountReview } from './tabs/review.js';

export const TABS = [
  { id: 'setup', label: 'Setup', short: 'Setup', mount: mountSetup },
  { id: 'theme', label: 'Theme & Layout', short: 'Theme', mount: mountTheme },
  { id: 'grid', label: 'Grid & Fill', short: 'Grid', mount: mountFill },
  { id: 'clues', label: 'Clues', short: 'Clues', mount: mountClues },
  { id: 'review', label: 'Review & Publish', short: 'Publish', mount: mountReview },
];

const STATUS_TEXT = {
  saved: 'Saved', pending: 'Unsaved changes', saving: 'Saving…', error: 'Save failed — retrying',
  conflict: 'Not saved — changed in another tab',
};

export function mountEditor(container, app, { tab }) {
  const { store } = app;
  const draft = () => store.draft;
  const ctx = {
    app,
    store,
    session: app.session(draft().id),
    goTab: (id) => app.navigate(`#/draft/${draft().id}/${id}`),
  };

  const titleEl = h('h1', { class: 'ed-title' });
  const chips = h('div', { class: 'ed-chips' });
  const saveEl = h('span', {
    class: 'save-status', role: 'status', 'aria-live': 'polite',
    // While a save is refused (another tab saved or deleted this draft), clicking asks which version to keep.
    onclick: () => { if (store.status === 'conflict') app.resolveConflict(); },
  });
  const undoBtn = h('button', { class: 'icon-btn', type: 'button', onclick: () => store.undo() }, icon('undo'));
  const redoBtn = h('button', { class: 'icon-btn', type: 'button', onclick: () => store.redo() }, icon('redo'));
  const previewBtn = h('button', {
    class: 'btn', type: 'button', title: 'Open the player with this puzzle in a new tab',
    onclick: () => openPreviewTab(draft(), app.today()),
  }, icon('eye'), 'Preview');
  const tabButtons = new Map();
  const tabNav = h('nav', { class: 'steps', role: 'tablist', 'aria-label': 'Puzzle steps' },
    TABS.map((t, k) => {
      const b = h('a', {
        class: 'step', role: 'tab', href: `#/draft/${draft().id}/${t.id}`, title: `${t.label} (Alt+${k + 1})`,
      }, h('span', { class: 'step-n', text: String(k + 1) }), h('span', { class: 'step-label', text: t.label }),
      h('span', { class: 'step-short', text: t.short }),
      h('span', { class: 'step-badge' }));
      tabButtons.set(t.id, b);
      return b;
    }));
  const body = h('div', { class: 'ed-body' });

  container.classList.add('editor');
  container.append(
    h('header', { class: 'ed-head' },
      h('div', { class: 'ed-head-main' }, titleEl, chips),
      h('div', { class: 'ed-head-tools' }, saveEl, h('span', { class: 'tool-sep' }), undoBtn, redoBtn, previewBtn)),
    tabNav,
    body,
  );

  let currentTab = null;
  let currentId = null;

  function setTab(id) {
    if (id === currentId && currentTab) return;
    currentTab?.destroy?.();
    body.replaceChildren();
    const def = TABS.find((t) => t.id === id) || TABS[0];
    currentId = def.id;
    const el = h('div', { class: ['tab', `tab-${def.id}`], role: 'tabpanel' });
    body.appendChild(el);
    currentTab = def.mount(el, ctx);
    for (const [tid, b] of tabButtons) {
      b.classList.toggle('active', tid === def.id);
      b.setAttribute('aria-selected', String(tid === def.id));
    }
    body.scrollTop = 0;
  }

  // ---- header -----------------------------------------------------------
  function renderHeader() {
    const d = draft();
    if (!d) return;
    titleEl.textContent = d.title || 'Untitled puzzle';
    titleEl.classList.toggle('placeholder', !d.title);
    const pub = app.publishedFor(d);
    // Edits after publishing are saved to the draft only; say so until "Publish update".
    const behind = pub && hasUnpublishedChanges(d);
    replaceChildren(chips,
      h('span', { class: ['chip', !d.date && 'warn'] }, d.date ? formatDate(d.date, 'short') : 'No release date'),
      h('span', { class: 'chip' }, `${d.width}×${d.height}`),
      pub ? h('span', { class: 'chip ok' }, icon('check', { size: 12 }), `Published #${pub.number}`) : null,
      behind ? h('a', {
        class: 'chip warn chip-unpublished', href: `#/draft/${d.id}/review`,
        title: 'You changed this puzzle after publishing it. Solvers still get the published version until you publish the update.',
      }, 'Changes not published') : null,
    );
    renderBadges();
  }

  function renderHistory() {
    undoBtn.disabled = !store.canUndo;
    redoBtn.disabled = !store.canRedo;
    undoBtn.title = store.canUndo ? `Undo ${store.undoLabel} (Ctrl+Z)`.replace('  ', ' ') : 'Nothing to undo';
    redoBtn.title = store.canRedo ? `Redo ${store.redoLabel} (Ctrl+Shift+Z)`.replace('  ', ' ') : 'Nothing to redo';
    undoBtn.setAttribute('aria-label', undoBtn.title);
    redoBtn.setAttribute('aria-label', redoBtn.title);
  }

  function renderSave() {
    const s = store.status;
    saveEl.className = `save-status ${s}`;
    saveEl.replaceChildren(s === 'saved' ? icon('check', { size: 14 }) : h('span', { class: 'save-dot' }), STATUS_TEXT[s] || s);
    if (s === 'conflict' && store.conflict?.kind === 'deleted') saveEl.lastChild.textContent = 'Not saved — deleted in another tab';
    saveEl.title = s === 'error' ? String(store.error?.message || '') : s === 'conflict' ? 'Click to choose which version to keep' : '';
    saveEl.style.cursor = s === 'conflict' ? 'pointer' : '';
  }

  /** Small progress hints on the step tabs. */
  function renderBadges() {
    const d = draft();
    const { all } = draftEntries(d);
    const complete = all.filter((e) => e.answer);
    const clued = complete.filter((e) => e.clue).length;
    const empties = d.cells.filter((c) => c === '').length;
    const badges = {
      setup: d.title && d.date ? 'done' : '',
      theme: d.theme.length ? String(d.theme.length) : '',
      grid: empties === 0 && all.length ? 'done' : '',
      clues: complete.length ? (clued === all.length && empties === 0 ? 'done' : `${clued}/${all.length}`) : '',
      review: app.publishedFor(d) ? 'done' : '',
    };
    for (const [id, b] of tabButtons) {
      const el = b.querySelector('.step-badge');
      const v = badges[id];
      el.replaceChildren(v === 'done' ? icon('check', { size: 12 }) : (v || ''));
      el.className = `step-badge ${v === 'done' ? 'done' : v ? 'count' : ''}`;
    }
  }

  // ---- events -----------------------------------------------------------
  const onChange = (e) => {
    renderHistory();
    renderHeader();
    currentTab?.update?.(e.detail);
  };
  const onStatus = () => renderSave();
  const onExternal = (e) => { renderHeader(); currentTab?.update?.({ kind: 'external', what: e.type }); };
  // Answers of recent puzzles arrived (tags, checks and the Review checklist use them).
  const onRecent = () => currentTab?.update?.({ kind: 'external', what: 'recent' });
  store.addEventListener('change', onChange);
  store.addEventListener('status', onStatus);
  for (const t of ['published', 'wordindex', 'config']) app.addEventListener(t, onExternal);
  app.engine.addEventListener('status', onExternal);
  app.clueBank.addEventListener('loaded', onExternal);
  app.recentAnswers.addEventListener('loaded', onRecent);

  renderHeader();
  renderHistory();
  renderSave();
  setTab(tab);

  return {
    setTab,
    destroy() {
      currentTab?.destroy?.();
      // Leaving the draft stops a layout generation that was left running in the background (theme.js).
      ctx.session.layoutJob?.cancel();
      store.removeEventListener('change', onChange);
      store.removeEventListener('status', onStatus);
      for (const t of ['published', 'wordindex', 'config']) app.removeEventListener(t, onExternal);
      app.engine.removeEventListener('status', onExternal);
      app.clueBank.removeEventListener('loaded', onExternal);
      app.recentAnswers.removeEventListener('loaded', onRecent);
    },
  };
}
