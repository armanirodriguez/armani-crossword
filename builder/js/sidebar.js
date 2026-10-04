// Left sidebar: new puzzle, drafts list (open / duplicate / delete), site tools, "Put it online" status, engine
// status, theme toggle.

import { formatDate } from '../../site/shared/puzzle.js';
import { h, icon, timeAgo } from './dom.js';
import { confirmDialog, toastError } from './dialogs.js';
import { getPref, setPref } from './prefs.js';
import { openNewDraftDialog } from './new-draft.js';
import { hasUnpublishedChanges } from './draft-utils.js';
import { goLiveStatusLine } from './go-live.js';
import { draftKind, kindLabel, numberLabel } from './kinds.js';

export function mountSidebar(el, app) {
  const list = h('nav', { class: 'draft-list', 'aria-label': 'Drafts' });
  const engineStatus = h('button', { class: 'engine-status', type: 'button', title: 'Fill engine status (click to retry)' });
  const themeBtn = h('button', { class: 'icon-btn', type: 'button' });
  const navLinks = {
    schedule: navLink('#/schedule', 'calendar', 'Schedule'),
    words: navLink('#/words', 'book', 'Word list'),
    settings: navLink('#/settings', 'settings', 'Site settings'),
  };

  // On narrow screens (tablets) the sidebar collapses to its brand row; this button opens it.
  const menuBtn = h('button', {
    class: 'icon-btn menu-toggle', type: 'button', 'aria-label': 'Show drafts and tools', 'aria-expanded': 'false',
    onclick: () => setOpen(!el.classList.contains('open')),
  }, icon('menu'));
  function setOpen(open) {
    el.classList.toggle('open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
  }

  el.append(
    h('div', { class: 'brand' },
      h('a', { href: '#/', class: 'brand-link' },
        h('span', { class: 'brand-mark', 'aria-hidden': 'true' }),
        h('span', null, h('strong', null, 'Armani Crossword'), h('small', null, 'Builder'))),
      menuBtn),
    h('div', { class: 'side-actions' },
      h('button', { class: 'btn primary block', type: 'button', onclick: () => openNewDraftDialog(app) }, icon('plus'), 'New puzzle')),
    h('div', { class: 'side-label' }, 'Drafts'),
    list,
    h('div', { class: 'side-label' }, 'Site'),
    h('nav', { class: 'side-nav', 'aria-label': 'Site tools' },
      navLinks.schedule, navLinks.words, navLinks.settings,
      h('a', { class: 'side-link', href: '/site/', target: '_blank', rel: 'noopener' }, icon('external'), h('span', null, 'Open player site'))),
    h('footer', { class: 'side-foot' }, goLiveStatusLine(app), engineStatus, themeBtn),
  );

  function navLink(href, iconName, label) {
    return h('a', { class: 'side-link', href }, icon(iconName), h('span', null, label));
  }

  // ---- drafts list ----
  function statusText(d) {
    if (app.publishedFor(d)) {
      const base = `#${app.publishedFor(d).number} · ${formatDate(d.date, 'short')}`; // (the kind badge is beside it)
      return d.behind
        ? { text: `${base} · edited`, cls: 'warn', title: 'Published, but changed since: publish an update to make the changes live' }
        : { text: base, cls: 'ok', title: 'Published' };
    }
    if (d.date) {
      const clash = app.dateConflict(d);
      return { text: formatDate(d.date, 'short'), cls: clash ? 'warn' : '', title: clash ? `${numberLabel(clash)} “${clash.title}” is already published on this date` : 'Release date (not published yet)' };
    }
    return { text: 'No date', cls: 'muted', title: 'No release date yet' };
  }

  function renderList() {
    const activeId = app.route.kind === 'draft' ? app.route.id : null;
    list.replaceChildren();
    if (!app.drafts.length) {
      list.append(h('p', { class: 'side-empty' }, 'No drafts yet. Click “New puzzle” to start.'));
      return;
    }
    for (const d of app.drafts) {
      const st = statusText(d);
      const row = h('div', { class: ['draft-row', d.id === activeId && 'active'] },
        h('a', { class: 'draft-link', href: `#/draft/${d.id}`, title: d.updatedAt ? `Edited ${timeAgo(d.updatedAt)}` : '' },
          h('span', { class: 'dr-title', text: d.title || 'Untitled' }),
          h('span', { class: 'dr-meta' },
            h('span', { class: ['kind-badge', `kind-${draftKind(d)}`], text: kindLabel(draftKind(d)) }),
            h('span', { class: ['dr-status', st.cls], text: st.text, title: st.title }),
            h('span', { text: `${d.width}×${d.height}` }))),
        h('div', { class: 'dr-actions' },
          h('button', {
            class: 'icon-btn sm', type: 'button', title: 'Duplicate', 'aria-label': `Duplicate ${d.title || 'Untitled'}`,
            onclick: () => app.duplicateDraft(d.id).catch((err) => toastError(err)),
          }, icon('copy', { size: 14 })),
          h('button', {
            class: 'icon-btn sm danger', type: 'button', title: 'Delete', 'aria-label': `Delete ${d.title || 'Untitled'}`,
            onclick: () => remove(d),
          }, icon('trash', { size: 14 }))));
      list.append(row);
    }
  }

  async function remove(d) {
    const pub = app.publishedFor(d);
    const ok = await confirmDialog({
      title: 'Delete draft?',
      message: [
        `“${d.title || 'Untitled'}” will be deleted from drafts/. This cannot be undone.`,
        pub ? 'The published puzzle stays online — unpublish it from the Schedule if you want it gone too.' : null,
      ].filter(Boolean),
      confirmLabel: 'Delete draft',
      danger: true,
    });
    if (!ok) return;
    try {
      await app.deleteDraft(d.id);
    } catch (err) {
      toastError(err, 'Delete failed: ');
    }
  }

  // Keep the current draft's row in sync while editing (title, date, size) without refetching.
  app.store.addEventListener('change', (e) => {
    const d = app.store.draft;
    if (!d || !['meta', 'grid', 'load', 'clues', 'theme'].includes(e.detail.kind)) return;
    const row = app.drafts.find((x) => x.id === d.id);
    if (!row) return;
    const next = {
      title: d.title, date: d.date, kind: draftKind(d), width: d.width, height: d.height,
      publishedAt: d.publishedAt || '', publishedDate: d.publishedDate || '', publishedId: d.publishedId || '',
      // Only known for the open draft: edited after publishing, not published again yet.
      behind: Boolean(app.publishedFor(d) && hasUnpublishedChanges(d)),
    };
    if (Object.keys(next).some((k) => row[k] !== next[k])) {
      Object.assign(row, next);
      renderList();
    }
  });

  function renderNav() {
    for (const [kind, link] of Object.entries(navLinks)) link.classList.toggle('active', app.route.kind === kind);
  }

  // ---- engine status ----
  function renderEngine() {
    const { status, message } = app.engine;
    const label = { idle: 'Engine idle', loading: 'Engine loading…', ready: 'Engine ready', unavailable: 'Engine unavailable' }[status];
    engineStatus.replaceChildren(h('span', { class: ['dot', status] }), h('span', { class: 'es-text' }, label));
    engineStatus.title = `${message || label}${status === 'unavailable' ? ' — click to retry' : ''}`;
    engineStatus.disabled = status !== 'unavailable';
  }
  engineStatus.addEventListener('click', () => app.engine.restart());

  // ---- light / dark ----
  const THEMES = ['auto', 'light', 'dark'];
  function applyTheme(t) {
    if (t === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    themeBtn.replaceChildren(icon(t === 'dark' ? 'moon' : 'sun'));
    themeBtn.title = `Appearance: ${t} (click to change)`;
    themeBtn.setAttribute('aria-label', themeBtn.title);
  }
  themeBtn.addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(getPref('theme', 'auto')) + 1) % THEMES.length];
    setPref('theme', next === 'auto' ? null : next);
    applyTheme(next);
  });
  applyTheme(getPref('theme', 'auto'));

  app.addEventListener('drafts', renderList);
  app.addEventListener('published', renderList);
  app.addEventListener('route', () => { renderList(); renderNav(); setOpen(false); });
  app.engine.addEventListener('status', renderEngine);
  renderList();
  renderNav();
  renderEngine();
}
