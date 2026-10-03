// "Put it online" (SPEC §5): the dev server commits the published puzzles, the site settings and the word list and
// pushes them to GitHub (GET/POST /api/go-live), so nobody has to type git commands. One shared controller
// (app.goLive) feeds every place that shows it: the sidebar status line, the Schedule header and the button after
// publishing. Only one run at a time; every visible button shows its progress and result.

import { formatDate } from '../../site/shared/puzzle.js';
import { api } from './api.js';
import { debounce, h, icon, plural } from './dom.js';
import { openModal, toast } from './dialogs.js';

/** Where the one-time GitHub setup is explained. */
export const SETUP_DOC = 'README.md → “Putting the site online”';

/** A failed request -> { code, message, hint, committed, busy }. */
function friendlyError(err) {
  const body = err?.body || {};
  if (err?.status === 404 && !body.code) {
    return {
      code: 'unavailable',
      message: 'The builder’s server was started before this button existed.',
      hint: 'Stop npm run dev (Ctrl+C in its terminal), start it again, then try again.',
    };
  }
  if (err?.status === 0) return { code: 'offline', message: err.message, hint: '' };
  return {
    code: body.code || 'error',
    message: body.error || err?.message || String(err),
    hint: body.hint || '',
    committed: Boolean(body.committed),
    busy: Boolean(body.busy),
  };
}

export class GoLive extends EventTarget {
  /** Last GET /api/go-live; { unavailable: true } when the dev server predates it; { failed, message } on errors. */
  status = null;
  running = false;
  /** The last run: { at, ok: true, result } | { at, ok: false, error: { code, message, hint, committed } }. */
  outcome = null;
  /** Buttons of the mounted "Put it online" controls (a run they can show needs no toast). */
  controls = new Set();
  #inflight = null;
  #again = false;

  constructor() {
    super();
    this.refreshSoon = debounce(() => this.refresh(), 300);
  }

  #changed() { this.dispatchEvent(new Event('change')); }

  /**
   * Keep the status fresh without polling: after publishing / unpublishing / settings saves (app events), on
   * navigation, and when the window comes back to the front.
   */
  watch(app) {
    for (const type of ['published', 'config', 'route']) app.addEventListener(type, () => this.refreshSoon());
    window.addEventListener('focus', () => this.refreshSoon());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.refreshSoon(); });
    return this.refresh();
  }

  /** Re-read the status. A call while one is in flight reads once more afterwards (so nothing is missed). */
  refresh() {
    if (this.#inflight) {
      this.#again = true;
      return this.#inflight;
    }
    this.#inflight = (async () => {
      do {
        this.#again = false;
        try {
          this.status = await api.goLiveStatus();
        } catch (err) {
          this.status = err.status === 404 ? { unavailable: true } : { failed: true, message: err.message };
        }
      } while (this.#again);
      this.#expireOutcome();
      this.#changed();
      // Running from another tab: look again shortly, so this one does not show "Putting it online…" forever.
      if (this.status?.busy && !this.running) setTimeout(() => this.refreshSoon(), 3000);
    })().finally(() => { this.#inflight = null; });
    return this.#inflight;
  }

  /**
   * Forget the last result once it no longer describes the situation: a success when new changes are waiting (or
   * the folder stopped being ready), a failure once everything is online after all.
   */
  #expireOutcome() {
    const o = this.outcome;
    const s = this.status;
    if (!o || this.running || !s || s.unavailable || s.failed) return;
    const { any } = this.waiting();
    if (o.ok ? any || !s.ready : s.ready && !any) this.outcome = null;
  }

  /**
   * Commit + push. Resolves with the outcome (never rejects). `announce`: also report the result in a toast (for
   * runs started where no "Put it online" button shows it, e.g. the sidebar line or a toast action).
   */
  async run({ announce = false } = {}) {
    if (this.running) return this.outcome;
    this.running = true;
    const at = Date.now();
    this.#changed();
    try {
      this.outcome = { at, ok: true, result: await api.goLive() };
    } catch (err) {
      this.outcome = { at, ok: false, error: friendlyError(err) };
      // Started from another tab: look again once that one is likely done.
      if (this.outcome.error.busy) setTimeout(() => this.refresh(), 4000);
    } finally {
      this.running = false;
    }
    this.#changed();
    await this.refresh();
    // Report in a toast only when no "Put it online" button on screen shows the result itself.
    if (announce && ![...this.controls].some((b) => b.isConnected)) this.#announce();
    return this.outcome;
  }

  #announce() {
    const o = this.outcome;
    if (!o) return;
    const url = this.siteUrl();
    if (o.ok) {
      toast(o.result.upToDate ? 'Already online — nothing new to send.' : 'Online — your site updates in about a minute.', {
        type: 'success',
        action: url ? { label: 'Open your site', onClick: () => window.open(url, '_blank', 'noopener') } : null,
      });
    } else {
      toast([o.error.message, o.error.hint].filter(Boolean).join(' '), { type: 'error', timeout: 12000 });
    }
  }

  /** The site's address: the Share URL from Site settings, else the GitHub Pages address of the repository. */
  siteUrl() {
    return this.status?.siteUrl || this.status?.pagesUrl || null;
  }

  /** Changes waiting to go online (uncommitted files), and whether earlier commits are waiting too. */
  waiting() {
    const s = this.status;
    const count = Array.isArray(s?.pending) ? s.pending.length : 0;
    return { count, any: count > 0 || (s?.ahead || 0) > 0 };
  }

  /** What to show: { state: running|unknown|unavailable|setup|error|pending|online, label, title }. */
  summary() {
    const s = this.status;
    if (this.running || s?.busy) return { state: 'running', label: 'Putting it online…', title: 'Saving a commit and sending it to GitHub' };
    if (!s) return { state: 'unknown', label: '', title: '' };
    if (s.unavailable) {
      return {
        state: 'unavailable', label: 'Restart npm run dev',
        title: 'The dev server was started before “Put it online” existed. Stop npm run dev (Ctrl+C) and start it again.',
      };
    }
    if (s.failed) return { state: 'unknown', label: 'Online status unknown', title: s.message || '' };
    if (!s.ready) {
      return {
        state: 'setup', label: 'GitHub not set up',
        title: [s.problem?.error, s.problem?.hint, s.problem?.hint?.includes('README') ? null : `One-time setup: ${SETUP_DOC}.`].filter(Boolean).join(' '),
      };
    }
    const { count, any } = this.waiting();
    const where = `${s.branch || 'this branch'} → ${s.remote || 'origin'}`;
    if (any && this.outcome && !this.outcome.ok) {
      return { state: 'error', label: 'Couldn’t put it online', title: [this.outcome.error.message, this.outcome.error.hint].filter(Boolean).join(' ') };
    }
    if (count) return { state: 'pending', label: `${plural(count, 'change')} to put online`, title: `Click to commit and push (${where})` };
    if (any) return { state: 'pending', label: 'Ready to put online', title: `Saved commits are waiting to be pushed (${where}). Click to send them.` };
    return { state: 'online', label: 'Online ✓', title: `Everything is on GitHub (${where}).` };
  }
}

/** "Open your site" link, or null when the address is unknown. */
function siteLink(url) {
  return url ? h('a', { class: 'gm-link', href: url, target: '_blank', rel: 'noopener' }, 'Open your site', icon('external', { size: 12 })) : null;
}

/**
 * A "Put it online" button and its message line, following app.goLive.
 * Options: date() — the puzzle this is about (a future date gets "it unlocks at midnight on …").
 * Returns { button, message, destroy }; place both where they fit.
 */
export function goLiveControl(app, { date = () => null } = {}) {
  const gl = app.goLive;
  const since = Date.now(); // show results of runs started while this control exists
  const button = h('button', { class: 'btn primary golive-btn', type: 'button', onclick: () => gl.run() });
  const message = h('div', { class: 'golive-msg', role: 'status', 'aria-live': 'polite' });

  function line(kind, title, ...rest) {
    message.className = `golive-msg boxed ${kind}`;
    message.replaceChildren(
      h('div', { class: 'gm-title' }, icon(kind === 'ok' ? 'check' : 'alert', { size: 14 }), h('span', { text: title })),
      ...rest.filter(Boolean));
  }
  function plain(text, ...rest) {
    message.className = 'golive-msg';
    message.replaceChildren(h('span', { text }), ...rest.filter(Boolean));
  }

  function render() {
    const sum = gl.summary();
    const running = sum.state === 'running';
    message.removeAttribute('title');
    const { count, any } = gl.waiting();
    button.disabled = running;
    button.replaceChildren(...[
      running ? h('span', { class: 'spinner' }) : icon('upload', { size: 14 }),
      running ? 'Putting it online…' : 'Put it online',
      !running && count > 0 ? h('span', { class: 'golive-count', text: String(count), title: `${plural(count, 'change')} waiting` }) : null,
    ].filter(Boolean));
    button.setAttribute('aria-label', running ? 'Putting it online' : count ? `Put it online (${plural(count, 'change')})` : 'Put it online');
    const outcome = gl.outcome && gl.outcome.at >= since ? gl.outcome : null;
    // Primary while there is something to put online (or a failure to retry); secondary once everything is online
    // (still useful: it double-checks) and while it cannot work yet.
    const blocked = sum.state === 'setup' || sum.state === 'unavailable';
    button.classList.toggle('primary', running || (!blocked && (any || sum.state !== 'online')) || Boolean(outcome && !outcome.ok));

    if (running) {
      plain('Saving your changes and sending them to GitHub…');
    } else if (outcome?.ok) {
      const r = outcome.result;
      const d = date();
      const future = d && d > app.today();
      if (r.upToDate) line('ok', 'Already online — nothing new to send.', siteLink(gl.siteUrl()));
      else if (future) line('ok', `Online — it unlocks at midnight on ${formatDate(d)}.`, siteLink(gl.siteUrl()));
      else line('ok', 'Online — your site updates in about a minute.', siteLink(gl.siteUrl()));
    } else if (outcome) {
      const e = outcome.error;
      line('error', e.message,
        e.hint ? h('div', { class: 'gm-hint', text: e.hint }) : null,
        e.committed ? h('div', { class: 'gm-note', text: 'Your changes are saved in a commit on this computer; “Put it online” sends them once this is fixed.' }) : null);
    } else if (sum.state === 'setup') {
      // Compact: this shows on every visit until GitHub is set up. The details are in the tooltip / sidebar dialog.
      plain(`GitHub is not set up yet — see ${SETUP_DOC}.`);
      message.title = sum.title;
    } else if (sum.state === 'unavailable') {
      line('warn', 'Restart the builder’s server to use this button.',
        h('div', { class: 'gm-hint', text: 'Stop npm run dev (Ctrl+C in its terminal) and start it again. Until then: commit and push site/puzzles/ yourself.' }));
    } else if (sum.state === 'online') {
      plain('Everything is online.');
    } else if (any) {
      plain('Only on this computer until you put it online.');
    } else {
      message.replaceChildren();
    }
  }

  gl.addEventListener('change', render);
  gl.controls.add(button);
  render();
  return {
    button,
    message,
    destroy() {
      gl.removeEventListener('change', render);
      gl.controls.delete(button);
    },
  };
}

/** Details for the sidebar line: why it cannot go online yet, or why the last try failed. */
function explain(app) {
  const gl = app.goLive;
  const sum = gl.summary();
  const s = gl.status || {};
  let title = 'Put it online';
  let lines = [];
  let canRetry = false;
  if (sum.state === 'setup') {
    title = 'GitHub is not set up yet';
    lines = [s.problem?.error, s.problem?.hint, s.problem?.hint?.includes('README') ? null : `The one-time setup is explained step by step in ${SETUP_DOC}.`];
    canRetry = true;
  } else if (sum.state === 'unavailable') {
    title = 'Restart the builder’s server';
    lines = [sum.title, 'Your drafts and published puzzles are not affected.'];
  } else if (sum.state === 'error') {
    title = 'Couldn’t put it online';
    const e = gl.outcome.error;
    lines = [e.message, e.hint, e.committed ? 'Your changes are saved in a commit on this computer; trying again sends them.' : null];
    canRetry = true;
  } else {
    lines = [sum.title || sum.label];
  }
  return openModal({
    title,
    className: 'modal-confirm modal-golive',
    build: (close) => h('div', null,
      ...lines.filter(Boolean).map((t, k) => h('p', { class: k ? 'muted' : null, text: t })),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => close(false) }, canRetry ? 'Not now' : 'OK'),
        canRetry ? h('button', { class: 'btn primary', type: 'button', onclick: () => close(true) }, sum.state === 'setup' ? 'Check again' : 'Try again') : null)),
  }).then((retry) => {
    if (!retry) return;
    if (sum.state === 'setup') gl.refresh();
    else gl.run({ announce: true });
  });
}

/** The sidebar's status line ("Online ✓", "2 changes to put online", "GitHub not set up", …). */
export function goLiveStatusLine(app) {
  const gl = app.goLive;
  const el = h('button', { class: 'engine-status golive-status', type: 'button' });
  el.addEventListener('click', () => {
    const { state } = gl.summary();
    if (state === 'pending') gl.run({ announce: true });
    else if (state === 'setup' || state === 'error' || state === 'unavailable') explain(app);
  });
  function render() {
    const sum = gl.summary();
    el.hidden = sum.state === 'unknown' && !sum.label;
    el.dataset.state = sum.state;
    el.replaceChildren(
      sum.state === 'running' ? h('span', { class: 'spinner gl-spinner' }) : h('span', { class: ['dot', `gl-${sum.state}`] }),
      h('span', { class: 'es-text', text: sum.label }));
    el.title = sum.title || sum.label;
    el.disabled = sum.state === 'running' || sum.state === 'online' || sum.state === 'unknown';
  }
  gl.addEventListener('change', render);
  render();
  return el;
}
