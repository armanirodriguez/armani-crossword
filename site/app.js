// Armani Crossword — player site bootstrap and hash router (SPEC §6).
//
//   #/                     today's puzzle (or the latest one before today)
//   #/puzzle/YYYY-MM-DD    a specific puzzle (future dates show "Unlocks on …")
//   #/archive              every released puzzle with this browser's status
//
// ?preview=1 (used by the builder) plays the puzzle stored in localStorage['xw:preview'], bypasses date
// locks and never persists progress. There is no login of any kind: progress lives in this browser.

import { formatDate, todayISO } from './shared/puzzle.js';
import { createStorage } from './js/storage.js';
import { DEFAULT_CONFIG, LoadError, checkPuzzle, loadConfig, loadIndex, loadPuzzleFile } from './js/data.js';
import { findEntry, isLocked, parseRoute, pickDaily } from './js/daily.js';
import { loadingScreen, messageScreen } from './js/screens/common.js';
import { buildArchive } from './js/screens/archive.js';
import { createPuzzleScreen } from './js/screens/puzzle.js';
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

async function refreshIndex() {
  try {
    ctx.index = await loadIndex();
    ctx.indexError = null;
  } catch (err) {
    ctx.indexError = err;
  }
}

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

function showPuzzle(raw, { entry, label, notice, autoStart = false }) {
  current = createPuzzleScreen({ ctx, raw, entry, label, notice, autoStart, mount });
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
      showPuzzle(raw, { entry: findEntry(ctx.index, raw.date), label: 'Preview', autoStart });
      return;
    }
    toast('No preview puzzle found — showing today’s puzzle.');
  }
  if (ctx.indexError) { showLoadError(ctx.indexError); return; }
  const daily = pickDaily(ctx.index, ctx.today);
  if (!daily.entry) {
    mount(messageScreen(ctx, {
      emoji: '🧩',
      title: 'No puzzles yet',
      text: daily.nextDate
        ? `The first puzzle unlocks on ${formatDate(daily.nextDate)}. See you then!`
        : 'The first one is on its way — check back soon!',
      active: 'today',
    }));
    setTitle(null);
    return;
  }
  const raw = await loadPuzzleFile(daily.entry.date);
  if (seq !== routeSeq) return;
  showPuzzle(raw, { entry: daily.entry, label: daily.isToday ? 'Today’s puzzle' : 'Latest puzzle' });
}

function showNoPuzzle(date) {
  mount(messageScreen(ctx, {
    emoji: '🔎',
    title: 'No puzzle that day',
    text: `There’s no puzzle for ${formatDate(date)}.`,
    actions: [{ label: 'Today’s puzzle', href: '#/', primary: true }, { label: 'Archive', href: '#/archive' }],
  }));
  setTitle('Not found');
}

async function routePuzzle(seq, date) {
  if (isLocked(date, ctx.today, preview)) {
    // Only scheduled puzzles get an unlock date; a future day with nothing published is simply "no puzzle".
    if (!ctx.indexError && !findEntry(ctx.index, date)) {
      showNoPuzzle(date);
      return;
    }
    mount(messageScreen(ctx, {
      icon: 'lock',
      title: `Unlocks on ${formatDate(date)}`,
      text: 'No peeking! This puzzle isn’t out yet.',
      actions: [{ label: 'Today’s puzzle', href: '#/', primary: true }, { label: 'Archive', href: '#/archive' }],
    }));
    setTitle('Locked');
    return;
  }
  let raw;
  try {
    raw = await loadPuzzleFile(date);
  } catch (err) {
    if (seq !== routeSeq) return;
    if (err.kind === 'not-found') {
      showNoPuzzle(date);
      return;
    }
    throw err;
  }
  if (seq !== routeSeq) return;
  const entry = findEntry(ctx.index, date);
  showPuzzle(raw, { entry, label: date === ctx.today ? 'Today’s puzzle' : 'From the archive' });
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
  if (r.unknown) history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/`);

  // Only show the spinner if loading takes a moment (avoids a flash on fast loads).
  const spinner = setTimeout(() => { if (seq === routeSeq && !current) mount(loadingScreen(ctx)); }, 180);
  try {
    if (r.name === 'archive') {
      if (ctx.indexError) showLoadError(ctx.indexError);
      else showArchive();
    } else if (r.name === 'puzzle') {
      await routePuzzle(seq, r.date);
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
  const el = buildArchive(ctx);
  if (refresh) el.classList.add('is-refresh'); // no entrance animation for a live update
  mount(el);
  current = { destroy() {}, playing: false, isArchive: true };
  setTitle('Archive');
}

const DAY_CHECK_MS = 30_000;
/** How often to look for today's puzzle while it is missing from the index (e.g. a deploy that landed late). */
const INDEX_RECHECK_MS = 5 * 60_000;
let lastIndexCheck = 0;

const hasTodaysPuzzle = () => Boolean(ctx.index?.puzzles?.some((p) => p.date === ctx.today));

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
  } else if (idle && !ctx.indexError && !hasTodaysPuzzle() && Date.now() - lastIndexCheck >= INDEX_RECHECK_MS) {
    // Today's puzzle isn't online yet: re-fetch the (small) index now and then and show the puzzle once it lands.
    lastIndexCheck = Date.now();
    refreshIndex().then(() => { if (hasTodaysPuzzle() && !current?.playing && !isOverlayOpen()) route(); });
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

  // Progress saved in another tab: keep the archive's statuses current.
  if (!preview) {
    window.addEventListener('storage', (e) => {
      if (ctx.route.name !== 'archive' || !current?.isArchive) return;
      if (e.key !== null && !e.key.startsWith(PROGRESS_PREFIX)) return;
      if (isOverlayOpen()) return;
      showArchive({ refresh: true });
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
