// Armani Crossword builder — entry point: app context, hash router, global shortcuts.
//
// Routes:
//   #/                          home (drafts overview / getting started)
//   #/draft/<id>/<tab>          draft editor; tab = setup | theme | grid | clues | review
//   #/schedule  #/words  #/settings

import { makeDraft, normalizeClue, todayISO, isValidDateId, isValidDraftId } from '../site/shared/puzzle.js';
import { api } from './js/api.js';
import { DraftStore } from './js/store.js';
import { engine } from './js/engine-bridge.js';
import { clueBank } from './js/clue-bank.js';
import { WordIndex, loadWordData } from './js/word-index.js';
import { getFillOptions, getPref, setPref } from './js/prefs.js';
import { recentAnswers, recentPenalties } from './js/recent-answers.js';
import { h, isTextEntry, debounce } from './js/dom.js';
import { openModal, toast, toastError } from './js/dialogs.js';
import { makeDraftId, nextFreeDate } from './js/draft-utils.js';
import {
  DEFAULT_KIND, draftKind, draftPuzzleId, entryId, isKind, recordedPuzzleId, sortPuzzles, suggestKind, takenDatesForKind,
} from './js/kinds.js';
import { mountSidebar } from './js/sidebar.js';
import { mountEditor, TABS } from './js/editor.js';
import { mountHome } from './js/views/home.js';
import { mountSchedule } from './js/views/schedule.js';
import { mountWordList } from './js/views/wordlist.js';
import { mountSettings } from './js/views/settings.js';
import { GoLive } from './js/go-live.js';

/**
 * Shared application context handed to every view.
 * Events: 'drafts' (draft list changed), 'published' (index changed), 'config', 'wordindex', 'route'.
 * app.goLive ("Put it online": commit + push the published content) has its own 'change' event.
 */
class App extends EventTarget {
  store = new DraftStore();
  engine = engine;
  clueBank = clueBank;
  recentAnswers = recentAnswers;
  goLive = new GoLive();
  wordIndex = null;
  config = { siteName: 'Armani Crossword', timeZone: null };
  published = { format: 'crossword-index/1', puzzles: [] };
  drafts = [];
  route = { kind: 'home' };
  #sessions = new Map();

  /** Today's date in the site's time zone (what solvers will see). */
  today() { return todayISO(this.config?.timeZone || null); }

  /** Per-draft UI state that survives tab switches (selection, mode, generated layouts …). */
  session(id) {
    if (!this.#sessions.has(id)) {
      this.#sessions.set(id, { index: 0, dir: 'across', mode: 'letters', layouts: null, clueEntry: null });
    }
    return this.#sessions.get(id);
  }

  emit(type, detail = null) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async refreshDrafts() {
    try {
      this.drafts = await withKinds(await api.listDrafts());
      this.emit('drafts');
    } catch (err) {
      toastError(err, 'Could not load drafts: ');
    }
  }

  async refreshPublished() {
    try {
      this.published = await api.listPublished();
      this.recentAnswers.invalidate();
      this.emit('published');
    } catch (err) {
      toastError(err, 'Could not load published puzzles: ');
    }
  }

  async loadConfig() {
    try {
      this.config = await api.getConfig();
      this.emit('config');
    } catch (err) {
      toastError(err, 'Could not load site settings: ');
    }
  }

  /** The date a draft's answers are compared with recent puzzles around: its release date, else today. */
  freshnessDate(d) { return isValidDateId(d?.date) ? d.date : this.today(); }

  /**
   * Answers of puzzles published within the Fill options' window around the draft's date (answer -> dates; the
   * other kinds of the same day count too, so same-day puzzles avoid sharing answers), or null
   * while they load (a 'loaded' event on app.recentAnswers follows).
   */
  recentFor(d) { return d ? this.recentAnswers.get(this.freshnessDate(d), getFillOptions().recentDays, draftKind(d)) : null; }

  /**
   * The engine's `penalize` option for a draft: recently used answers (not its theme answers) when the Fill option
   * "Avoid repeating recent answers" is on, else null.
   */
  async freshnessPenalties(d) {
    const { avoidRecent, recentDays } = getFillOptions();
    if (!avoidRecent || !d) return null;
    const recent = await this.recentAnswers.load(this.freshnessDate(d), recentDays, draftKind(d));
    return recentPenalties(recent, (d.theme || []).map((t) => t.answer));
  }

  /** Published index entries by puzzle id (a date holds up to one Mini, Midi and Daily). */
  publishedById() {
    return new Map((this.published?.puzzles || []).map((p) => [entryId(p), p]));
  }

  /** The published puzzles of one date, in Mini, Midi, Daily order. */
  publishedOn(date) {
    return sortPuzzles((this.published?.puzzles || []).filter((p) => p.date === date));
  }

  /**
   * The published puzzle that came from this draft: it recorded publishing to the id it would publish to now
   * (same date and kind), or (for drafts published before the builder recorded that, like the sample) the puzzle
   * at that id has the same title.
   */
  publishedFor(d) {
    const id = draftPuzzleId(d);
    const p = id ? this.publishedById().get(id) : null;
    if (!p) return null;
    if (d.publishedAt) {
      const recorded = recordedPuzzleId(d);
      return !recorded || recorded === id ? p : null;
    }
    return normalizeClue(d.title) && normalizeClue(d.title) === p.title ? p : null;
  }

  /** A published puzzle that occupies this draft's date and kind but is not this draft. */
  dateConflict(d) {
    const id = draftPuzzleId(d);
    const p = id ? this.publishedById().get(id) : null;
    return p && !this.publishedFor(d) ? p : null;
  }

  /** Dates already used for `kind` by published puzzles and (optionally) by other drafts of that kind. */
  takenDates({ kind = DEFAULT_KIND, includeDrafts = true, exceptDraft = null } = {}) {
    return takenDatesForKind(kind, {
      published: this.published?.puzzles || [],
      drafts: includeDrafts ? this.drafts : [],
      exceptDraft,
    });
  }

  /** The next day from today without a puzzle (or planned draft) of this kind. */
  suggestDate(exceptDraft = null, kind = DEFAULT_KIND) {
    return nextFreeDate(this.today(), this.takenDates({ kind, exceptDraft }));
  }

  /** Create a draft on the server and open it. */
  async createDraft({
    title = '', width = 9, height = width, date = null, tab = 'theme', kind = suggestKind(width, height), kindChosen = false,
  } = {}) {
    const draft = makeDraft({
      id: makeDraftId(title),
      width,
      height,
      title,
      author: getPref('author', ''),
      date: date ?? this.suggestDate(null, kind),
    });
    draft.kind = isKind(kind) ? kind : suggestKind(width, height);
    // A kind the user picked stays put when the size changes; otherwise Setup follows the size (see setup.js).
    if (kindChosen) draft.kindSource = 'user';
    draft.themeText = '';
    await api.saveDraft(draft, { create: true });
    await this.refreshDrafts();
    this.navigate(`#/draft/${draft.id}/${tab}`);
    return draft.id;
  }

  async duplicateDraft(id) {
    const src = this.store.draft?.id === id ? this.store.draft : await api.getDraft(id);
    const now = new Date().toISOString();
    const copy = {
      ...structuredClone(src),
      id: makeDraftId(src.title || 'copy'),
      title: src.title ? `${src.title} (copy)` : '',
      date: '',
      createdAt: now,
      updatedAt: now,
    };
    delete copy.publishedAt;
    delete copy.publishedDate;
    delete copy.publishedId;
    delete copy.publishedFingerprint;
    await api.saveDraft(copy, { create: true });
    await this.refreshDrafts();
    toast(`Duplicated “${src.title || 'Untitled'}”`, { type: 'success' });
    this.navigate(`#/draft/${copy.id}/setup`);
  }

  async deleteDraft(id) {
    if (this.store.draft?.id === id) this.store.unload();
    await api.deleteDraft(id);
    broadcast({ type: 'deleted', id });
    await this.refreshDrafts();
    if (this.route.kind === 'draft' && this.route.id === id) this.navigate('#/');
  }

  navigate(hash) {
    if (location.hash === hash) router();
    else location.hash = hash;
  }

  /** Ask what to do about a save that another tab made impossible (see store.js); resolves when handled. */
  resolveConflict() { return resolveConflict(); }
}

/**
 * Drafts list rows carry each draft's `kind`. A dev server from before kinds existed leaves it out: then read
 * the drafts themselves (there are only a few), so lists and "next free date" still know which is which.
 */
async function withKinds(rows) {
  if (!Array.isArray(rows) || rows.every((r) => 'kind' in r)) return rows;
  return Promise.all(rows.map(async (r) => {
    if ('kind' in r) return r;
    try {
      const d = await api.getDraft(r.id);
      return { ...r, kind: draftKind(d), publishedId: r.publishedId || d.publishedId || '' };
    } catch {
      return { ...r, kind: DEFAULT_KIND };
    }
  }));
}

export const app = new App();

// ---------------------------------------------------------------------------
// Several tabs / windows on the same drafts
//
// Saves carry the version they are based on, so a stale tab can never silently overwrite newer work (the store
// goes to 'conflict' and we ask). To make that rare, tabs tell each other about saves and deletes, and a tab
// with no unsaved edits quietly picks up the newer version (also when it comes back to the front).

const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('xwb:drafts') : null;
function broadcast(msg) {
  try { channel?.postMessage(msg); } catch { /* ignore */ }
}
const refreshDraftsSoon = debounce(() => app.refreshDrafts(), 600);

/** If the open draft has no unsaved edits and a newer version is on disk (or it is gone), catch up. */
async function syncOpenDraft() {
  const { store } = app;
  const d = store.draft;
  if (!d || !store.clean || app.route.kind !== 'draft') return;
  let fresh;
  try {
    fresh = await api.getDraft(d.id);
  } catch (err) {
    if (err.status === 404 && store.draft === d && store.clean) {
      store.unload();
      toast('This draft was deleted in another tab.', { type: 'warn' });
      router();
    }
    return;
  }
  if (store.draft !== d || !store.clean) return; // edited (or switched) meanwhile: the save will sort it out
  if (fresh.updatedAt && fresh.updatedAt !== store.baseVersion) {
    store.load(fresh);
    toast('Updated with the changes saved in another tab.', { timeout: 2500 });
  }
}

if (channel) {
  channel.addEventListener('message', (e) => {
    const msg = e.data || {};
    if (msg.type !== 'saved' && msg.type !== 'deleted') return;
    refreshDraftsSoon();
    if (msg.id && msg.id === app.store.draft?.id) syncOpenDraft();
  });
}
app.store.addEventListener('saved', (e) => {
  broadcast({ type: 'saved', id: e.detail.draft.id, updatedAt: e.detail.draft.updatedAt });
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  refreshDraftsSoon();
  syncOpenDraft();
});

let conflictPromise = null;
/**
 * The store refused to save because the draft changed (or was deleted) elsewhere. Let the user pick a version.
 * Resolves with 'reloaded' | 'kept' | 'closed' | undefined (dismissed: the draft stays unsaved, the header says so).
 */
function resolveConflict() {
  if (conflictPromise) return conflictPromise;
  const { store } = app;
  const c = store.conflict;
  const d = store.draft;
  if (!c || !d) return Promise.resolve(undefined);
  const name = `“${d.title || 'Untitled'}”`;
  const deleted = c.kind === 'deleted';
  conflictPromise = (async () => {
    const choice = await openModal({
      title: deleted ? 'This draft was deleted' : 'This draft was changed in another tab',
      className: 'modal-confirm modal-conflict',
      build: (close) => h('div', null,
        h('p', {
          text: deleted
            ? `${name} was deleted in another tab or window. Your latest edits here have not been saved.`
            : `${name} was saved from another tab or window after you opened it here. Your latest edits here have not been saved, so nothing was overwritten.`,
        }),
        h('p', { class: 'muted', text: deleted ? 'Restore it with your edits, or let it go?' : 'Which version do you want to keep?' }),
        h('div', { class: 'modal-actions' },
          deleted
            ? h('button', { class: 'btn', type: 'button', onclick: () => close('close') }, 'Let it go')
            : h('button', { class: 'btn', type: 'button', onclick: () => close('reload') }, 'Load the other version'),
          h('button', { class: 'btn primary', type: 'button', onclick: () => close('keep') },
            deleted ? 'Restore it with my edits' : 'Keep my version'))),
    });
    if (store.draft !== d) return undefined; // switched away meanwhile
    try {
      if (choice === 'keep') {
        await store.overwrite();
        refreshDraftsSoon();
        toast(deleted ? 'Draft restored.' : 'Saved your version.', { type: 'success', timeout: 2500 });
        return 'kept';
      }
      if (choice === 'reload') {
        store.load(await api.getDraft(d.id));
        toast('Loaded the version saved in the other tab.', { timeout: 2500 });
        return 'reloaded';
      }
      if (choice === 'close') {
        store.unload();
        await app.refreshDrafts();
        app.navigate('#/');
        return 'closed';
      }
    } catch (err) {
      toastError(err, 'Could not do that: ');
    }
    return undefined;
  })().finally(() => { conflictPromise = null; });
  return conflictPromise;
}

app.store.addEventListener('conflict', () => {
  if (!leaving) resolveConflict();
});

// ---------------------------------------------------------------------------
// Router

const main = document.getElementById('main');
let current = null; // { key, view }

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'draft' && parts[1]) {
    const tab = TABS.some((t) => t.id === parts[2]) ? parts[2] : null;
    return { kind: 'draft', id: parts[1], tab };
  }
  if (['schedule', 'words', 'settings'].includes(parts[0])) return { kind: parts[0] };
  return { kind: 'home' };
}

let routing = Promise.resolve();
function router() {
  routing = routing.then(route, route);
  return routing;
}

let lastHash = location.hash; // the URL of the screen that is showing (restored when leaving is cancelled)
let leaving = false;          // a "leave with unsaved edits?" dialog is open

const routeKey = (r) => (r.kind === 'draft' ? `draft:${r.id}` : r.kind);

/** Put the address bar back without routing (the user chose to stay). */
function cancelNavigation() {
  history.replaceState(null, '', lastHash || '#/');
}

/**
 * Leaving a draft (or switching drafts): make sure its edits are on disk. If saving fails or was refused, ask —
 * never drop edits silently. Resolves true when it is OK to go on.
 */
async function leaveDraft() {
  const { store } = app;
  leaving = true; // a refused save here is handled by the dialog below, not by the conflict pop-up
  try {
    for (;;) {
      try {
        await store.flush();
        return true;
      } catch (err) {
        if (!store.draft) return true;
        const choice = await unsavedDialog(store, err);
        if (choice === 'discard') { store.unload(); return true; }
        if (choice === 'keep') {
          try { await store.overwrite(); return true; } catch (e) { toastError(e, 'Could not save: '); continue; }
        }
        if (choice !== 'retry') return false; // 'stay' / dismissed
      }
    }
  } finally {
    leaving = false;
  }
}

/** 'stay' | 'retry' | 'keep' | 'discard' | undefined */
function unsavedDialog(store, err) {
  const c = store.conflict;
  const name = `“${store.draft?.title || 'Untitled'}”`;
  const message = c
    ? (c.kind === 'deleted'
      ? `${name} was deleted in another tab, so your latest edits could not be saved.`
      : `${name} was changed in another tab, so your latest edits were not saved (nothing was overwritten).`)
    : `Your latest edits to ${name} could not be saved: ${err?.message || err}`;
  return openModal({
    title: 'Unsaved changes',
    className: 'modal-confirm modal-unsaved',
    build: (close) => h('div', null,
      h('p', { text: message }),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn danger-ghost', type: 'button', onclick: () => close('discard') }, 'Discard my edits'),
        h('button', { class: 'btn', type: 'button', onclick: () => close('stay') }, 'Stay here'),
        c
          ? h('button', { class: 'btn primary', type: 'button', onclick: () => close('keep') }, c.kind === 'deleted' ? 'Restore it with my edits' : 'Keep my version')
          : h('button', { class: 'btn primary', type: 'button', onclick: () => close('retry') }, 'Try saving again'))),
  });
}

async function route() {
  const r = parseHash();
  let reopened = false;
  // Views with unsaved state of their own (Site settings) may ask before being left.
  if (current?.view?.canLeave && current.key !== routeKey(r) && !(await current.view.canLeave())) {
    cancelNavigation();
    return undefined;
  }
  if (app.store.draft && (r.kind !== 'draft' || r.id !== app.store.draft.id)) {
    if (!(await leaveDraft())) {
      cancelNavigation();
      return undefined;
    }
  }
  lastHash = location.hash;
  if (r.kind === 'draft') {
    if (!isValidDraftId(r.id)) return showMissing(r.id);
    // Coming back to the draft that is still loaded (e.g. from the Schedule): pick up saves made elsewhere.
    reopened = app.store.draft?.id === r.id && current?.key !== `draft:${r.id}`;
    if (app.store.draft?.id !== r.id) {
      // Tear down the previous view first so it never renders the incoming draft with stale UI state.
      current?.view?.destroy?.();
      current = null;
      main.replaceChildren(h('div', { class: 'boot' }, 'Opening draft…'));
      try {
        app.store.load(await api.getDraft(r.id));
      } catch (err) {
        if (err.status === 404) return showMissing(r.id);
        toastError(err);
        return undefined;
      }
    }
    const tab = r.tab || getPref(`tab:${r.id}`, null) || 'setup';
    if (current?.key === `draft:${r.id}`) {
      current.view.setTab(tab);
    } else {
      mount(`draft:${r.id}`, (el) => mountEditor(el, app, { tab }));
    }
    setPref(`tab:${r.id}`, tab);
  } else if (r.kind === 'schedule') mount('schedule', (el) => mountSchedule(el, app));
  else if (r.kind === 'words') mount('words', (el) => mountWordList(el, app));
  else if (r.kind === 'settings') mount('settings', (el) => mountSettings(el, app));
  else mount('home', (el) => mountHome(el, app));
  app.route = r;
  app.emit('route', r);
  if (reopened) syncOpenDraft();
  return undefined;
}

function mount(key, factory) {
  current?.view?.destroy?.();
  main.replaceChildren();
  const el = h('div', { class: 'view' });
  main.appendChild(el);
  current = { key, view: factory(el) };
  main.scrollTop = 0;
}

function showMissing(id) {
  mount(`missing:${id}`, (el) => {
    el.append(h('div', { class: 'empty-state' },
      h('h2', { text: 'Draft not found' }),
      h('p', { text: `There is no draft called “${id}”. It may have been deleted.` }),
      h('a', { class: 'btn primary', href: '#/' }, 'Back to drafts')));
    return {};
  });
  app.route = { kind: 'missing' };
  app.emit('route', app.route);
}

// ---------------------------------------------------------------------------
// Global keyboard shortcuts

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (app.store.draft) app.store.flush().then(() => toast('Saved', { type: 'success', timeout: 1200 }), (err) => toastError(err));
    return;
  }
  if (!app.store.draft || app.route.kind !== 'draft') return;
  if (mod && !e.altKey && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
    if (isTextEntry(document.activeElement)) return; // let text fields use their own undo
    e.preventDefault();
    const redo = e.key.toLowerCase() === 'y' || e.shiftKey;
    if (redo) app.store.redo(); else app.store.undo();
    return;
  }
  if (e.altKey && !mod && /^Digit[1-5]$/.test(e.code)) {
    e.preventDefault();
    const tab = TABS[Number(e.code.slice(5)) - 1];
    app.navigate(`#/draft/${app.store.draft.id}/${tab.id}`);
  }
});

window.addEventListener('beforeunload', (e) => {
  // saveOnUnload() sends pending edits and says whether some may still be lost (failed / refused / in flight).
  const warn = app.store.saveOnUnload() || Boolean(current?.view?.isDirty?.());
  if (warn) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------------------------------------------------------------------------
// Boot

async function boot() {
  mountSidebar(document.getElementById('sidebar'), app);
  await Promise.all([app.loadConfig(), app.refreshDrafts(), app.refreshPublished()]);
  window.addEventListener('hashchange', router);
  await router();
  app.goLive.watch(app); // "Put it online" status (sidebar and buttons); never blocks booting

  // Background work: the word list (for scores / warnings) and the fill engine, then the clue banks.
  loadWordData().then(({ wordlistText, userWordsText }) => {
    app.wordIndex = new WordIndex(wordlistText, userWordsText);
    app.emit('wordindex');
  }).catch((err) => {
    console.warn(err);
    toast('Could not load data/wordlist.txt — scores and word checks are unavailable.', { type: 'warn' });
  });
  engine.start();
  clueBank.load();
}

boot().catch((err) => {
  console.error(err);
  main.replaceChildren(h('div', { class: 'empty-state' },
    h('h2', { text: 'The builder could not start' }),
    h('p', { text: String(err?.message || err) })));
});

// Handy for debugging in the console.
window.xwb = app;
