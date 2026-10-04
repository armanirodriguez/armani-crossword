// Today's puzzles when a date has more than one (SPEC §8): one card per puzzle in Mini, Midi, Daily order, each
// with its kind, number, title, size, a silhouette of the grid, this browser's status and Play / Resume.
// (A date with a single puzzle keeps the classic intro card — see intro.js.)

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { formatDate, loadPuzzle, puzzleKind } from '../../shared/puzzle.js';
import { entryId, entryKind, kindLabel } from '../daily.js';
import { loadProgress, progressKey, progressStatus } from '../progress.js';
import { playState, silhouette } from './intro.js';
import { siteHeader } from './common.js';

/**
 * One card. `item` = { entry, raw } for a loaded puzzle, or { entry, error } when its file could not be loaded.
 */
function dayCard(ctx, item, { onPlay, onRetry }) {
  const { entry } = item;
  const kind = item.raw ? puzzleKind(item.raw) : entryKind(entry);
  const id = entryId(entry);
  const head = (status = null) => h('div', { class: 'day-card-head' },
    h('span', { class: ['kind-badge', `kind-${kind}`] }, kindLabel(kind)),
    entry.number ? h('span', { class: 'day-card-num' }, `#${entry.number}`) : null,
    status && h('span', { class: ['status-pill', `status-${status.state}`, 'day-card-status'] }, status.label));

  if (!item.raw) {
    return h('article', { class: ['day-card', `kind-${kind}`, 'is-error'], dataset: { id, kind } },
      head(),
      h('h2', { class: 'day-card-title' }, entry.title || 'Untitled'),
      h('p', { class: 'day-card-error' }, icon('alert', { size: 18 }), h('span', null, 'This puzzle couldn’t be loaded.')),
      h('div', { class: 'day-card-actions' },
        h('button', { type: 'button', class: 'btn btn-secondary day-card-play', onclick: onRetry }, icon('refresh', { size: 18 }), h('span', null, 'Try again'))));
  }

  const { raw } = item;
  const loaded = loadPuzzle(raw);
  const progress = loadProgress(ctx.storage, raw.id, loaded, raw.checksum);
  const status = progressStatus(progress);
  const { playLabel, playIcon } = playState(loaded, progress);
  const playBtn = h('button', {
    type: 'button',
    class: ['btn', status.state === 'new' || status.state === 'progress' ? 'btn-primary' : 'btn-secondary', 'day-card-play'],
    'aria-label': `${playLabel} — ${kindLabel(kind)}: ${raw.title || 'Untitled'}`,
    onclick: () => onPlay(raw.id),
  }, icon(playIcon, { size: 18 }), h('span', null, playLabel));

  return h('article', { class: ['day-card', `kind-${kind}`, `is-${status.state}`], dataset: { id: raw.id, kind } },
    head(status),
    h('div', { class: 'day-card-body' },
      h('div', { class: 'day-card-thumb' }, silhouette(loaded, progress, { fluid: true, className: 'thumb' })),
      h('div', { class: 'day-card-text' },
        h('h2', { class: 'day-card-title' }, raw.title || 'Untitled'),
        raw.author && h('p', { class: 'day-card-byline' }, `by ${raw.author}`),
        // The kind badge says what it is: only the size here (never "5×5 Mini" on a Daily card).
        h('p', { class: 'day-card-meta' }, `${raw.width}×${raw.height}`))),
    raw.note && h('p', { class: 'day-card-note' }, raw.note),
    h('div', { class: 'day-card-actions' }, playBtn));
}

/**
 * The screen.
 * @param {object} o
 * @param {object} o.ctx
 * @param {string} o.date             the puzzles' date
 * @param {Array<{entry, raw?, error?}>} o.items   in display order
 * @param {string} o.label            eyebrow ("Today’s puzzles", "Latest puzzles", …)
 * @param {string} [o.notice]
 * @param {(id: string) => void} o.onPlay
 * @param {() => void} o.onRetry
 * @param {(el: Node) => void} o.mount
 */
export function createDayScreen({ ctx, date, items, label, notice = '', onPlay, onRetry, mount }) {
  function build({ refresh = false } = {}) {
    const cards = items.map((item) => h('li', { class: 'day-cards-item' }, dayCard(ctx, item, { onPlay, onRetry })));
    const solved = items.filter((item) => item.raw
      && progressStatus(ctx.storage.getJSON(progressKey(item.raw.id), null)).state === 'solved').length;
    const sub = [`${items.length} puzzles`, solved ? `${solved} solved` : null].filter(Boolean).join(' · ');
    const el = h('div', { class: ['screen', 'screen-day', refresh && 'is-refresh'] },
      siteHeader(ctx, ctx.route?.name === 'today' ? 'today' : null),
      h('main', { class: 'page', id: 'main' },
        h('section', { class: 'day', 'aria-labelledby': 'day-title' },
          h('header', { class: 'day-header' },
            notice && h('p', { class: 'intro-notice' }, notice),
            h('p', { class: 'eyebrow' }, label),
            h('h1', { class: 'day-title', id: 'day-title' }, formatDate(date)),
            h('p', { class: 'day-sub' }, sub)),
          h('ol', { class: 'day-cards', dataset: { count: items.length } }, cards))));
    mount(el);
    document.title = `${label} · ${ctx.config.siteName}`;
  }
  build();
  return {
    destroy() {},
    playing: false,
    isDay: true,
    /** Re-read this browser's progress (another tab saved). */
    refresh() { build({ refresh: true }); },
  };
}
