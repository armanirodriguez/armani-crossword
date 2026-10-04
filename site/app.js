// Armani Crossword — player site bootstrap and hash router (SPEC §6).
//
//   #/                     today's puzzles (or the latest date before today that has any): one intro card for a
//                          single puzzle, one card per puzzle (Mini, Midi, Daily) when the date has several (§8);
//                          below them, "Claude's way": Claude's puzzles of today, or its latest set (§9)
//   #/puzzle/<id>          a specific puzzle: YYYY-MM-DD (the daily — every pre-§8 link), YYYY-MM-DD-mini,
//                          YYYY-MM-DD-midi, claude-YYYY-MM-DD[-mini|-midi] (future dates show "Unlocks on …")
//   #/archive              every released puzzle with this browser's status, grouped by date
//   #/archive/claude       the same for Claude's way
//
// The two series (§9) have separate indexes: puzzles/index.json and puzzles/claude/index.json. Claude's is optional:
// missing (404) means no Claude puzzles, and a failure to load it never takes the user's puzzles down with it.
//
// ?preview=1 (used by the builder) plays the puzzle stored in localStorage['xw:preview'], bypasses date
// locks and never persists progress. There is no login of any kind: progress lives in this browser.

import { formatDate, todayISO } from './shared/puzzle.js';
import { createStorage } from './js/storage.js';
import { DEFAULT_CONFIG, LoadError, checkPuzzle, loadConfig, loadIndex, loadPuzzleFile } from './js/data.js';
import {
  entriesOn, entryId, entryKind, findEntry, isLocked, kindLabel, parseRoute, pickToday, routeSeries, todaySignature,
} from './js/daily.js';
import { CLAUDE, CLAUDE_TITLE, MAIN, archiveHref } from './js/series.js';
import { loadingScreen, messageScreen } from './js/screens/common.js';
import { buildArchive } from './js/screens/archive.js';
import { createPuzzleScreen } from './js/screens/puzzle.js';
import { createDayScreen } from './js/screens/day.js';
import { createClaudeHomeScreen, createClaudeSection } from './js/screens/claude.js';
import { PROGRESS_PREFIX } from './js/progress.js';
import { closeAllOverlays, isOverlayOpen, toast } from './js/ui.js';

const PREVIEW_KEY = 'xw:preview';
const app = document.getElementById('app');

const preview = new URLSearchParams(window.location.search).get('preview') === '1';
let inIframe = false;
try { inIframe = window.self !== window.top; } catch { inIframe = true; }

const ctx = {
  config: { ...DEFAULT_CONFIG },
  index: { puzzles: [] },
  indexError: null,
  // Claude's way (§9): its own index. An error here is never shown as an error page; the last good copy stays.
  claudeIndex: { puzzles: [] },
  claudeIndexError: null,
  today: todayISO(null),
  preview,
  inIframe,
  // Preview never touches real progress: memory-only storage (also not reading saved progress).
  storage: preview ? createStorage({ backing: null }) : createStorage(),
  route: { name: 'today' },
};
// Read-only view of real localStorage (for the builder's preview puzzle).
const realStorage = createStorage({ persist: false });

let current = null; // the active screen controller ({ destroy })
let routeSeq = 0;
let dayChanged = false; // "today" moved on while a puzzle was being solved: re-route once it's left
// Play on a today's-puzzles card opens the puzzle straight into the grid; its back button then returns to the cards.
let pendingStart = null; // id whose route should skip the intro card (set just before the hash changes)
let fromCards = null; // id of the puzzle opened from the cards (its back button goes back in history)

function mount(el) {
  app.replaceChildren(el);
  app.removeAttribute('aria-busy');
}

function setTitle(part) {
  document.title = part ? `${part} · ${ctx.config.siteName}` : ctx.config.siteName;
}

/** Site name / tagline from config.json into the head (home-screen title, description). */
function applyBranding() {
  const set = (selector, value) => {
    const el = document.querySelector(selector);
    if (el && value) el.setAttribute('content', value);
  };
  set('meta[name="description"]', ctx.config.tagline);
  set('meta[property="og:description"]', ctx.config.tagline);
  set('meta[property="og:title"]', ctx.config.siteName);
  set('meta[name="apple-mobile-web-app-title"]', ctx.config.siteName);
}

/** (Re)load both series' indexes. The preview (the builder's draft) needs only the user's. */
async function refreshIndex() {
  const [main, claude] = await Promise.allSettled([loadIndex(MAIN), preview ? null : loadIndex(CLAUDE)]);
  if (main.status === 'fulfilled') {
    ctx.index = main.value;
    ctx.indexError = null;
  } else {
    ctx.indexError = main.reason;
  }
  if (claude.status === 'fulfilled') {
    if (claude.value) ctx.claudeIndex = claude.value;
    ctx.claudeIndexError = null;
  } else {
    ctx.claudeIndexError = claude.reason;
  }
}

const indexOf = (series) => (series === CLAUDE ? ctx.claudeIndex : ctx.index);
const indexErrorOf = (series) => (series === CLAUDE ? ctx.claudeIndexError : ctx.indexError);

/** Full-page error for a failed load, with a retry that re-runs the route. */
function showLoadError(err, { what = 'the puzzles' } = {}) {
  const kind = err instanceof LoadError ? err.kind : 'unknown';
  const retry = { label: 'Try again', primary: true, icon: 'refresh', onClick: () => { refreshIndex().then(route); } };
  if (kind === 'offline') {
    mount(messageScreen(ctx, {
      icon: 'offline',
      title: 'You’re offline',
      text: `We couldn’t load ${what}. Check your connection — we’ll retry when you’re back online.`,
      actions: [retry],
    }));
    setTitle('Offline');
    return;
  }
  mount(messageScreen(ctx, {
    icon: 'alert',
    title: kind === 'invalid' || kind === 'bad-json' ? 'This puzzle couldn’t be loaded' : 'Something went wrong',
    text: kind === 'invalid' || kind === 'bad-json'
      ? 'The puzzle file looks damaged. Please try again later.'
      : `We couldn’t load ${what}. Please try again in a moment.`,
    details: err?.details?.length ? err.details : [String(err?.message || err)],
    actions: [retry, { label: 'Archive', href: '#/archive' }],
  }));
  setTitle('Error');
}

function showPuzzle(raw, { entry, label, notice, autoStart = false, kindInLabel = false, siblings = [], mountFn = mount }) {
  const viaCards = fromCards === raw.id;
  current = createPuzzleScreen({
    ctx, raw, entry, label, notice, autoStart, kindInLabel, siblings, mount: mountFn,
    onBack: viaCards ? () => history.back() : null,
    backLabel: viaCards ? 'Back to today’s puzzles' : undefined,
  });
}

// ---------------------------------------------------------------- Claude's way on the home page (§9)

/** Load a set of puzzles in parallel: [{ entry, raw } | { entry, error }] (never rejects). */
async function loadSet(entries) {
  const results = await Promise.allSettled(entries.map((e) => loadPuzzleFile(entryId(e))));
  return entries.map((entry, k) => (results[k].status === 'fulfilled'
    ? { entry, raw: results[k].value }
    : { entry, error: results[k].reason }));
}

/** Today's (or the latest) Claude set for the home page, loaded: { day, items } or null when there is none. */
function loadClaudeHome() {
  if (preview) return Promise.resolve(null);
  const day = pickToday(ctx.claudeIndex, ctx.today);
  if (!day.entries.length) return Promise.resolve(null);
  return loadSet(day.entries).then((items) => ({ day, items }));
}

function claudeSection(home, { solo = false } = {}) {
  if (!home) return null;
  return createClaudeSection({
    ctx,
    date: home.day.date,
    isToday: home.day.isToday,
    items: home.items,
    solo,
    onPlay: playFromCards,
    onRetry: () => { refreshIndex().then(() => route()); },
  });
}

/**
 * A mount function for the user's home screens that puts Claude's section under them (re-read each time: progress
 * may have changed while a puzzle was open). The solving view itself never shows it.
 */
function homeMount(section) {
  if (!section) return mount;
  return (el) => {
    if (!el.classList.contains('screen-play')) {
      section.refresh();
      el.classList.add('has-claude');
      (el.querySelector('main') || el).append(section.el);
    }
    mount(el);
  };
}

/** Wrap a home screen's controller so the app can refresh Claude's statuses (storage events from other tabs). */
function homeController(ctl, section) {
  return {
    destroy: () => ctl.destroy(),
    get playing() { return Boolean(ctl.playing); },
    isHome: true,
    refresh() {
      if (ctl.isDay) ctl.refresh(); // rebuilds the day screen, Claude's section included
      else if (section && !ctl.playing) section.refresh();
    },
  };
}

/** Eyebrow for a puzzle of today or the latest day: "Today’s puzzle" (daily) / "Today’s Mini", "Latest Midi", … */
function dayLabel(kind, isToday) {
  const what = kind === 'daily' ? 'puzzle' : kindLabel(kind);
  return `${isToday ? 'Today’s' : 'Latest'} ${what}`;
}

/** Open a puzzle from a today's-puzzles card: straight into the grid. */
function playFromCards(id) {
  pendingStart = id;
  fromCards = id;
  window.location.hash = `#/puzzle/${id}`;
}

/** Several puzzles on one date: load them all (in parallel) and show one card each (+ Claude's section on home). */
async function showDay(seq, date, entries, { label, claude = null }) {
  const [items, claudeHome] = await Promise.all([loadSet(entries), claude]);
  if (seq !== routeSeq) return;
  // Nothing loaded at all (offline, …): the full-page error explains it better than three broken cards.
  if (items.every((item) => item.error)) throw items[0].error;
  const section = claudeSection(claudeHome);
  const ctl = createDayScreen({
    ctx, date, items, label, mount: homeMount(section),
    onPlay: playFromCards,
    onRetry: () => { refreshIndex().then(() => route()); },
  });
  current = section ? homeController(ctl, section) : ctl;
}

async function routeToday(seq, { autoStart = false } = {}) {
  if (preview) {
    const raw = realStorage.getJSON(PREVIEW_KEY, null);
    if (raw) {
      try {
        checkPuzzle(raw);
      } catch (err) {
        showLoadError(err, { what: 'the preview' });
        return;
      }
      showPuzzle(raw, { entry: findEntry(ctx.index, raw.id) || null, label: 'Preview', autoStart });
      return;
    }
    toast('No preview puzzle found — showing today’s puzzle.');
  }
  if (ctx.indexError) { showLoadError(ctx.indexError); return; }
  const day = pickToday(ctx.index, ctx.today);
  // Claude's set loads alongside the user's puzzles; a puzzle of it that fails shows as an error card in its section.
  const claude = loadClaudeHome();
  if (!day.entries.length) {
    const claudeHome = await claude;
    if (seq !== routeSeq) return;
    if (claudeHome) {
      // Nothing of the user's is out: Claude's section is the home page.
      const section = claudeSection(claudeHome, { solo: true });
      mount(createClaudeHomeScreen({
        ctx,
        section,
        notice: day.nextDate ? `The first ${ctx.config.siteName} puzzle unlocks on ${formatDate(day.nextDate)}.` : '',
      }));
      current = homeController({ destroy() {}, playing: false }, section);
      setTitle(null);
      return;
    }
    mount(messageScreen(ctx, {
      emoji: '🧩',
      title: 'No puzzles yet',
      text: day.nextDate
        ? `The first puzzle unlocks on ${formatDate(day.nextDate)}. See you then!`
        : 'The first one is on its way — check back soon!',
      active: 'today',
    }));
    setTitle(null);
    return;
  }
  if (day.entries.length > 1) {
    await showDay(seq, day.date, day.entries, { label: day.isToday ? 'Today’s puzzles' : 'Latest puzzles', claude });
    return;
  }
  // A single puzzle: the classic intro card.
  const [entry] = day.entries;
  const kind = entryKind(entry);
  const [raw, claudeHome] = await Promise.all([loadPuzzleFile(entryId(entry)), claude]);
  if (seq !== routeSeq) return;
  const section = claudeSection(claudeHome);
  showPuzzle(raw, { entry, label: dayLabel(kind, day.isToday), kindInLabel: kind !== 'daily', mountFn: homeMount(section) });
  if (section) current = homeController(current, section);
}

function showNoPuzzle(date, kind = 'daily', series = MAIN) {
  const what = series === CLAUDE ? `${CLAUDE_TITLE} ${kindLabel(kind)}` : kind === 'daily' ? 'puzzle' : kindLabel(kind);
  mount(messageScreen(ctx, {
    emoji: '🔎',
    title: 'No puzzle that day',
    text: `There’s no ${what} for ${formatDate(date)}.`,
    actions: [{ label: 'Today’s puzzle', href: '#/', primary: true }, { label: 'Archive', href: archiveHref(series) }],
  }));
  setTitle('Not found');
}

async function routePuzzle(seq, r) {
  const { id, date, kind } = r;
  const series = routeSeries(r);
  const index = indexOf(series);
  const indexError = indexErrorOf(series);
  const sameDay = indexError ? [] : entriesOn(index, date);
  const entry = findEntry(index, id);
  if (isLocked(date, ctx.today, preview)) {
    // Only scheduled puzzles get an unlock date; a future day with nothing published is simply "no puzzle".
    if (!indexError && !entry && !sameDay.length) {
      showNoPuzzle(date, kind, series);
      return;
    }
    mount(messageScreen(ctx, {
      icon: 'lock',
      title: `Unlocks on ${formatDate(date)}`,
      text: 'No peeking! This puzzle isn’t out yet.',
      actions: [{ label: 'Today’s puzzle', href: '#/', primary: true }, { label: 'Archive', href: archiveHref(series) }],
    }));
    setTitle('Locked');
    return;
  }
  // A date-only link (the daily's id) to a day that has no daily but other kinds: that day's puzzles. (Old links
  // only exist for the user's own puzzles.)
  if (series === MAIN && !entry && kind === 'daily' && sameDay.length) {
    if (sameDay.length > 1) {
      await showDay(seq, date, sameDay, { label: date === ctx.today ? 'Today’s puzzles' : 'From the archive' });
      return;
    }
    const only = sameDay[0];
    const raw = await loadPuzzleFile(entryId(only));
    if (seq !== routeSeq) return;
    showPuzzle(raw, { entry: only, label: date === ctx.today ? dayLabel(entryKind(only), true) : 'From the archive', kindInLabel: date === ctx.today });
    return;
  }
  // A Mini / Midi the index doesn't know is not there (no request needed). Dailies are still fetched, as before §8
  // (Claude's dailies are not: its index is the only way they are published).
  if (!entry && (kind !== 'daily' || series === CLAUDE) && !indexError && !preview) {
    showNoPuzzle(date, kind, series);
    return;
  }
  let raw;
  try {
    raw = await loadPuzzleFile(id);
  } catch (err) {
    if (seq !== routeSeq) return;
    if (err.kind === 'not-found') {
      showNoPuzzle(date, kind, series);
      return;
    }
    throw err;
  }
  if (seq !== routeSeq) return;
  const autoStart = pendingStart === id;
  pendingStart = null;
  const isToday = date === ctx.today;
  showPuzzle(raw, {
    entry,
    // Claude's way: "Claude’s way · Mini #3" (the date is on the card).
    label: series === CLAUDE ? CLAUDE_TITLE : isToday ? dayLabel(kind, true) : 'From the archive',
    kindInLabel: series === MAIN && isToday && kind !== 'daily',
    siblings: sameDay.filter((p) => entryId(p) !== id),
    autoStart,
  });
}

async function route({ autoStart = false } = {}) {
  const seq = ++routeSeq;
  closeAllOverlays();
  current?.destroy();
  current = null;
  ctx.today = todayISO(ctx.config.timeZone);
  dayChanged = false;
  const r = parseRoute(window.location.hash);
  ctx.route = r;
  if (r.name !== 'puzzle' || r.id !== fromCards) fromCards = null;
  if (r.name !== 'puzzle' || r.id !== pendingStart) pendingStart = null;
  if (r.unknown) history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/`);

  // Only show the spinner if loading takes a moment (avoids a flash on fast loads).
  const spinner = setTimeout(() => { if (seq === routeSeq && !current) mount(loadingScreen(ctx)); }, 180);
  try {
    if (r.name === 'archive') {
      const series = routeSeries(r);
      // Claude's archive keeps the last good copy of its index; only a never-loaded one is an error.
      const err = series === CLAUDE ? (!ctx.claudeIndex.puzzles.length && ctx.claudeIndexError) : ctx.indexError;
      if (err) showLoadError(err, { what: series === CLAUDE ? `${CLAUDE_TITLE} puzzles` : 'the puzzles' });
      else showArchive();
    } else if (r.name === 'puzzle') {
      await routePuzzle(seq, r);
    } else {
      await routeToday(seq, { autoStart });
    }
  } catch (err) {
    if (seq === routeSeq) showLoadError(err);
    if (!(err instanceof LoadError)) console.error(err);
  } finally {
    clearTimeout(spinner);
  }
  window.scrollTo(0, 0);
}

function showArchive({ refresh = false } = {}) {
  const series = routeSeries(ctx.route);
  const el = buildArchive(ctx, series);
  if (refresh) el.classList.add('is-refresh'); // no entrance animation for a live update
  mount(el);
  current = { destroy() {}, playing: false, isArchive: true };
  setTitle(series === CLAUDE ? `${CLAUDE_TITLE} archive` : 'Archive');
}

const DAY_CHECK_MS = 30_000;
/** How often to look for today's puzzle while it is missing from the index (e.g. a deploy that landed late). */
const INDEX_RECHECK_MS = 5 * 60_000;
let lastIndexCheck = 0;

/** Both series have today's puzzles out (else keep looking for a late deploy). */
const hasTodaysPuzzles = () => entriesOn(ctx.index, ctx.today).length > 0
  && (preview || entriesOn(ctx.claudeIndex, ctx.today).length > 0);
/** What the home page shows for today, in both series (to notice a deploy that changes it). */
const homeSignature = () => `${todaySignature(ctx.index, ctx.today)}||${todaySignature(ctx.claudeIndex, ctx.today)}`;

/** Has "today" moved on? Re-route when it has and nobody is mid-solve (or a dialog is open). */
function checkDay() {
  const today = todayISO(ctx.config.timeZone);
  if (today !== ctx.today) {
    ctx.today = today;
    dayChanged = true;
  }
  const idle = !current?.playing && !isOverlayOpen();
  if (dayChanged && idle) {
    dayChanged = false;
    lastIndexCheck = Date.now();
    refreshIndex().then(() => route());
  } else if (idle && !ctx.indexError && (!hasTodaysPuzzles() || ctx.route.name === 'today')
    && Date.now() - lastIndexCheck >= INDEX_RECHECK_MS) {
    // Today's puzzles aren't online yet (the user's or Claude's) — or today's puzzles are showing and another kind
    // (a Mini after the Daily, …) may still land: re-fetch the (small) indexes now and then and re-route once
    // today's set of puzzles changes in either series.
    lastIndexCheck = Date.now();
    const before = homeSignature();
    refreshIndex().then(() => {
      if (homeSignature() !== before && !current?.playing && !isOverlayOpen()) route();
    });
  }
}

/** Do two hashes name the same route? ('', '#' and '#/' are all today's puzzle.) */
function sameRoute(a, b) {
  const norm = (x) => {
    const h = String(x || '').replace(/^#/, '');
    return h === '' ? '/' : h.replace(/\/$/, '') || '/';
  };
  return norm(a) === norm(b);
}

async function boot() {
  const [config] = await Promise.all([loadConfig(), refreshIndex()]);
  ctx.config = config;
  ctx.today = todayISO(config.timeZone);
  applyBranding();
  window.addEventListener('hashchange', () => route());

  // Back online after an offline error: retry automatically.
  window.addEventListener('online', () => {
    if (ctx.indexError || app.querySelector('.screen-message')) refreshIndex().then(() => route());
  });

  // The daily puzzle flips at midnight, also while the page stays open in front: check now and then, and
  // whenever the page comes back. Re-route (today's card, the archive, an "Unlocks on …" page) unless the
  // solver is in the middle of a puzzle — then as soon as they leave it.
  if (!preview) {
    const onActive = () => { if (document.visibilityState !== 'hidden') checkDay(); };
    document.addEventListener('visibilitychange', onActive);
    window.addEventListener('focus', onActive);
    window.addEventListener('pageshow', onActive);
    setInterval(onActive, DAY_CHECK_MS);
  }

  // Links to the page that is already showing (the logo and "Today" on today's card, …) don't change the
  // hash, so no hashchange fires: treat a click on them as "refresh this view" (picks up a new day/puzzle).
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target instanceof Element ? e.target.closest('a[href^="#"]') : null;
    if (!a || !sameRoute(a.getAttribute('href'), window.location.hash)) return;
    e.preventDefault();
    refreshIndex().then(() => route());
  });

  // Progress saved in another tab: keep the statuses on the archive and on today's puzzle cards current
  // (the user's and Claude's).
  if (!preview) {
    window.addEventListener('storage', (e) => {
      const onArchive = ctx.route.name === 'archive' && current?.isArchive;
      if (!onArchive && !current?.isDay && !current?.isHome) return;
      if (e.key !== null && !e.key.startsWith(PROGRESS_PREFIX)) return;
      if (isOverlayOpen()) return;
      if (onArchive) showArchive({ refresh: true });
      else current.refresh();
    });
  }

  // Live preview: the builder rewrote the preview puzzle in another window/frame.
  if (preview) {
    window.addEventListener('storage', (e) => {
      if (e.key === PREVIEW_KEY && ctx.route.name === 'today') route({ autoStart: Boolean(current?.playing) });
    });
  }

  if (!preview && !ctx.storage.available) {
    setTimeout(() => toast('This browser is blocking storage, so your progress won’t be saved after you leave.', { tone: 'warn', duration: 5000 }), 600);
  }

  await route();
}

boot().catch((err) => {
  console.error(err);
  showLoadError(err);
});
