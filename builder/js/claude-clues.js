// "Ask Claude" in the Clues step (SPEC §5): a ✦ button on every clue row opens a panel with three straightforward
// clues and three lateral "?" clues from Claude (POST /api/claude/clues, scripts/claude-clues.mjs). Click one to use
// it, "Try again" for six fresh ones (earlier suggestions are sent as `avoid`), Esc or × to close. A request keeps
// running when its panel is closed; the ✦ button spins meanwhile and shows a dot when the answer is in.
// Also: the "Claude" connection card in Site settings (GET /api/claude/status).
//
// Clue text from Claude is inserted with textContent only, like every clue.

import { h, icon, replaceChildren } from './dom.js';
import { ApiError } from './api.js';

/** What an older dev server (started before this feature) answers: 404 "Unknown API endpoint". */
const RESTART = {
  error: 'Restart npm run dev to use Ask Claude.',
  hint: 'The dev server that is running started before this feature existed: stop it (Ctrl+C) and run npm run dev again.',
};

async function call(method, url, json) {
  const init = { method, cache: 'no-store', headers: {} };
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError(0, 'Cannot reach the dev server. Is `npm run dev` still running?');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 404) throw new ApiError(404, RESTART.error, { ...RESTART, code: 'restart' });
    throw new ApiError(res.status, body?.error || `${method} ${url} failed (${res.status})`, body);
  }
  return body;
}

export const claudeApi = {
  /** { available, via: 'api' | 'cli' | null, model, hint, error?, code?, detail? } */
  status: () => call('GET', '/api/claude/status'),
  /** { answer, entryId?, isTheme?, title?, theme?, otherClues?, avoid? } -> { straightforward, lateral, via, model, ms } */
  clues: (body) => call('POST', '/api/claude/clues', body),
};

const VIA_LABEL = { cli: 'your Claude Code login', api: 'API key' };

// ---------------------------------------------------------------------------- requests (one per answer)

/**
 * Per answer, for this browser session: { state: 'loading' | 'done' | 'error', started, result, error, history,
 * seen }. `history` holds every clue Claude suggested for it (sent as `avoid` on "Try again"); `seen` is false
 * while a finished answer has not been looked at.
 */
const requests = new Map();
const listeners = new Set();
const notify = (answer) => { for (const fn of listeners) fn(answer); };

function ask(answer, body) {
  const st = requests.get(answer) || { history: [] };
  if (st.state === 'loading') return;
  Object.assign(st, { state: 'loading', started: Date.now(), error: null, seen: true });
  requests.set(answer, st);
  claudeApi.clues(body).then((result) => {
    Object.assign(st, { state: 'done', result });
    st.history = [...st.history, ...result.straightforward, ...result.lateral].slice(-100);
  }, (error) => {
    Object.assign(st, { state: 'error', error });
  }).finally(() => {
    st.seen = false;
    notify(answer);
  });
  notify(answer);
}

// ---------------------------------------------------------------------------- the clue rows

/**
 * The ✦ buttons and panels of the Clues tab.
 *   contextFor(entry) -> request body without `avoid` ({ answer, entryId, isTheme, title, theme, otherClues })
 *   currentClue(entry) -> the clue typed for it now ('' if none)
 *   onPick(entry, clue) -> use this clue
 *   onOpen(entry) -> (optional) its panel was opened
 * Call button(entry) while building a row, attach(entry.id, li) once the row exists, reset() before rebuilding the
 * rows and destroy() when the tab goes away.
 */
export function createClaudeAsk({ contextFor, currentClue, onPick, onOpen = () => {} }) {
  let rows = new Map(); // entry id -> { entry, btn, li, panel }

  function button(entry) {
    const btn = h('button', {
      class: 'claude-btn', type: 'button', disabled: !entry.answer,
      title: 'Ask Claude for clues',
      'aria-label': `Ask Claude for clues${entry.answer ? ` for ${entry.answer}` : ''}`,
      'aria-expanded': 'false',
      'aria-controls': `claude-panel-${entry.id}`,
      onclick: () => toggle(entry.id),
    }, icon('sparkle', { size: 15 }));
    const row = { entry, btn, li: null, panel: null };
    rows.set(entry.id, row);
    renderButton(row);
    return btn;
  }

  function attach(id, li) {
    const row = rows.get(id);
    if (row) row.li = li;
  }

  function toggle(id) {
    const row = rows.get(id);
    if (!row) return;
    if (row.panel) close(row);
    else open(row);
  }

  function open(row) {
    const { answer } = row.entry;
    if (!answer || !row.li) return;
    onOpen(row.entry);
    const st = requests.get(answer);
    row.panel = buildPanel(row);
    row.li.append(row.panel.el);
    row.btn.setAttribute('aria-expanded', 'true');
    if (!st) start(row);
    else st.seen = true;
    render(row, { focus: true });
    row.panel.el.scrollIntoView({ block: 'nearest' });
  }

  function close(row, { focusButton = false } = {}) {
    if (!row.panel) return;
    clearInterval(row.panel.timer);
    row.panel.el.remove();
    row.panel = null;
    row.btn.setAttribute('aria-expanded', 'false');
    renderButton(row);
    if (focusButton) row.btn.focus();
  }

  function start(row) {
    const { entry } = row;
    const st = requests.get(entry.answer);
    const current = currentClue(entry);
    const avoid = [...new Set([...(st?.history || []), ...(current ? [current] : [])])].slice(-100);
    ask(entry.answer, { ...contextFor(entry), avoid });
  }

  // ---- the panel ----
  function buildPanel(row) {
    const { entry } = row;
    const body = h('div', { class: 'claude-body', 'aria-live': 'polite' });
    const retry = h('button', { class: 'btn sm claude-retry', type: 'button', onclick: () => { start(row); render(row); } },
      icon('refresh', { size: 14 }), 'Try again');
    const meta = h('span', { class: 'claude-meta' });
    const el = h('div', {
      class: 'claude-panel', id: `claude-panel-${entry.id}`, role: 'region', 'aria-label': `Claude’s clues for ${entry.answer}`,
      onkeydown: (ev) => onPanelKey(ev, row),
    },
    h('div', { class: 'claude-head' },
      h('span', { class: 'claude-title' }, icon('sparkle', { size: 14 }), 'Claude'),
      h('span', { class: 'claude-for', text: `for ${entry.answer}` }),
      h('button', { class: 'icon-btn sm claude-close', type: 'button', 'aria-label': 'Close Claude’s clues', title: 'Close (Esc)', onclick: () => close(row, { focusButton: true }) },
        icon('x', { size: 14 }))),
    body,
    h('div', { class: 'claude-foot' }, retry, meta));
    return { el, body, retry, meta, timer: null };
  }

  function render(row, { focus = false } = {}) {
    renderButton(row);
    const { panel, entry } = row;
    if (!panel) return;
    const st = requests.get(entry.answer);
    clearInterval(panel.timer);
    panel.retry.disabled = !st || st.state === 'loading';
    if (!st || st.state === 'loading') {
      const secs = h('span', { class: 'claude-secs', 'aria-hidden': 'true' });
      const tick = () => { secs.textContent = `${Math.max(0, Math.floor((Date.now() - (st?.started || Date.now())) / 1000))} s`; };
      tick();
      panel.timer = setInterval(tick, 1000);
      replaceChildren(panel.body, h('div', { class: 'claude-thinking' },
        h('span', { class: 'spinner' }), h('span', null, 'Claude is thinking…'), secs));
      replaceChildren(panel.meta, 'Usually 10–20 seconds');
      return;
    }
    if (st.state === 'error') {
      const err = st.error;
      const hint = err?.body?.hint || '';
      replaceChildren(panel.body, h('div', { class: 'note error claude-error', role: 'alert' },
        icon('alert', { size: 15 }),
        h('div', null, h('strong', { text: err?.message || 'Claude could not write clues.' }), hint ? h('div', { class: 'claude-hint', text: hint }) : null)));
      replaceChildren(panel.meta, '');
      if (focus) panel.retry.focus();
      return;
    }
    const { result } = st;
    replaceChildren(panel.body,
      group(row, 'straight', 'Straightforward', result.straightforward),
      group(row, 'lateral', 'Lateral ?', result.lateral));
    replaceChildren(panel.meta, `via ${result.via === 'api' ? 'the Claude API' : 'Claude Code'} · ${Math.max(1, Math.round((result.ms || 0) / 1000))} s`);
    const first = panel.el.querySelector('.claude-clue');
    if (focus && first) first.focus();
  }

  function group(row, kind, label, clues) {
    const id = `claude-${kind}-${row.entry.id}`;
    return h('div', { class: ['claude-group', kind], role: 'group', 'aria-labelledby': id },
      h('div', { class: 'claude-group-title', id }, label),
      clues.length
        ? clues.map((clue) => h('button', {
          class: 'claude-clue', type: 'button', title: 'Use this clue',
          onclick: () => { close(row); onPick(row.entry, clue); },
        }, h('span', { class: 'claude-clue-text', text: clue }), h('span', { class: 'claude-use', 'aria-hidden': 'true' }, 'Use')))
        : h('div', { class: 'claude-empty' }, 'None passed the checks this time — try again.'));
  }

  function onPanelKey(ev, row) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      close(row, { focusButton: true });
      return;
    }
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    const items = [...row.panel.el.querySelectorAll('.claude-clue, .claude-retry:not(:disabled)')];
    if (!items.length) return;
    ev.preventDefault();
    const k = items.indexOf(document.activeElement);
    const next = k < 0 ? 0 : (k + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  }

  function renderButton(row) {
    const st = row.entry.answer ? requests.get(row.entry.answer) : null;
    const loading = st?.state === 'loading';
    row.btn.classList.toggle('busy', loading);
    row.btn.classList.toggle('ready', Boolean(st && !loading && !st.seen && !row.panel));
    row.btn.classList.toggle('failed', st?.state === 'error');
    row.btn.setAttribute('aria-busy', loading ? 'true' : 'false');
    row.btn.title = loading ? 'Claude is thinking…' : st && !st.seen && !row.panel ? 'Claude’s clues are ready' : 'Ask Claude for clues';
    replaceChildren(row.btn, loading ? h('span', { class: 'spinner claude-spin' }) : icon('sparkle', { size: 15 }));
  }

  // A request finished (or started, maybe from another row with the same answer): update the rows that show it.
  const onChange = (answer) => {
    for (const row of rows.values()) {
      if (row.entry.answer !== answer) continue;
      if (!row.panel) {
        renderButton(row);
        continue;
      }
      const st = requests.get(answer);
      if (st) st.seen = true;
      // Move focus to the new clues only when it is on this row's button or in its panel (not while typing).
      const active = document.activeElement;
      const focus = active === row.btn || row.panel.el.contains(active) || active === document.body;
      render(row, { focus });
    }
  };
  listeners.add(onChange);

  return {
    button,
    attach,
    /** Close every panel (e.g. the grid changed). */
    closeAll() { for (const row of rows.values()) close(row); },
    /** Forget the rows (they are about to be rebuilt); requests keep running. */
    reset() {
      for (const row of rows.values()) if (row.panel) clearInterval(row.panel.timer);
      rows = new Map();
    },
    destroy() {
      for (const row of rows.values()) if (row.panel) clearInterval(row.panel.timer);
      rows = new Map();
      listeners.delete(onChange);
    },
  };
}

// ---------------------------------------------------------------------------- Site settings card

/** The "Claude" card for Site settings: is Ask Claude connected, and how? Loads GET /api/claude/status. */
export function claudeStatusCard() {
  const pill = h('span', { class: 'pill muted' }, 'Checking…');
  const line = h('p', { class: 'claude-status-line' }, h('span', { class: 'spinner' }), ' Checking the connection…');
  const details = h('div', { class: 'claude-card-details' });
  const check = h('button', { class: 'btn sm', type: 'button', onclick: load }, icon('refresh', { size: 14 }), 'Check again');
  const card = h('section', { class: 'card claude-card', 'aria-labelledby': 'claude-card-title' },
    h('div', { class: 'card-head' },
      h('h2', { class: 'card-title claude-card-title', id: 'claude-card-title' }, icon('sparkle', { size: 15 }), 'Claude', pill),
      check),
    h('p', { class: 'card-help' }, 'Ask Claude (✦ on each row of the Clues step) writes three straightforward clues and three lateral “?” clues for a word. This only affects the builder on this computer, not your site.'),
    line,
    details);

  async function load() {
    check.disabled = true;
    replaceChildren(pill, 'Checking…');
    pill.className = 'pill muted';
    replaceChildren(line, h('span', { class: 'spinner' }), ' Checking the connection…');
    replaceChildren(details);
    try {
      render(await claudeApi.status());
    } catch (err) {
      render({ available: false, via: null, error: err.message, hint: err.body?.hint || '', code: err.body?.code || 'error' });
    } finally {
      check.disabled = false;
    }
  }

  function render(s) {
    if (s.available) {
      replaceChildren(pill, 'Connected');
      pill.className = 'pill ok';
      replaceChildren(line, h('strong', null, `Connected via ${VIA_LABEL[s.via] || s.via}`));
      replaceChildren(details,
        s.hint ? h('p', { class: 'muted', text: s.hint }) : null,
        h('p', { class: 'muted small' }, 'Model: ', h('span', { class: 'mono', text: s.model || '' })));
      return;
    }
    replaceChildren(pill, 'Not available');
    pill.className = 'pill warn';
    // Not set up at all: the steps below say what to do (plus anything specific, e.g. the SDK is missing). Logged
    // out, turned off, or the dev server needs a restart: the server's hint says exactly what to do.
    const setup = s.code === 'unavailable';
    replaceChildren(line, h('strong', null, setup ? 'Not available — how to set up' : 'Not available'));
    const why = setup ? [s.error, s.detail] : [s.error, s.hint];
    replaceChildren(details,
      s.error ? h('p', { class: 'claude-why', text: why.filter(Boolean).join(' ') }) : null,
      setup ? h('ol', { class: 'claude-setup' },
        h('li', null, h('strong', null, 'With your Claude plan (recommended): '),
          'install Claude Code, run ', h('code', null, 'claude'), ' in a terminal and log in. Then click Check again. '
          + 'Clues count toward your plan’s usage.'),
        h('li', null, h('strong', null, 'Or with an API key: '),
          'set ', h('code', null, 'ANTHROPIC_API_KEY'), ', run ', h('code', null, 'npm install'), ' and restart ',
          h('code', null, 'npm run dev'), '.')) : null,
      h('p', { class: 'muted small' }, 'More in README.md, “Ask Claude for clues”.'));
  }

  load();
  return card;
}
