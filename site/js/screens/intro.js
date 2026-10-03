// The intro card shown before solving: title, author, date, number, size, note and Play / Resume.
// The grid itself stays hidden; only a silhouette of the block pattern (and filled squares) is shown.

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { formatDate, formatDuration } from '../../shared/puzzle.js';
import { sizeLabel } from '../daily.js';
import { siteHeader } from './common.js';

/** Small preview of the block pattern; filled squares are tinted, letters never shown. */
function silhouette(loaded, progress) {
  const { width, height, isBlock } = loaded;
  const n = Math.max(width, height);
  const cell = Math.max(6, Math.min(30, Math.floor(224 / n)));
  const el = h('div', {
    class: ['silhouette', progress.solved && 'is-solved'],
    // On short screens the thumbnail shrinks (to ~22% of the viewport height) so Play stays in view.
    style: { '--w': width, '--h': height, '--sc': `max(4px, min(${cell}px, calc(22vh / ${n})))` },
    'aria-hidden': 'true',
  });
  for (let i = 0; i < width * height; i++) {
    const cls = isBlock[i] ? 'sb' : progress.letters[i] ? 'sf' : 'se';
    el.append(h('span', { class: cls }));
  }
  return el;
}

/**
 * @param {object} o
 * @param {object} o.ctx
 * @param {object} o.raw        published puzzle JSON
 * @param {object} o.loaded     loadPuzzle(raw)
 * @param {object|null} o.entry index entry (for the number)
 * @param {string} o.label      eyebrow text, e.g. "Today's puzzle"
 * @param {object} o.progress   normalized progress
 * @param {() => void} o.onPlay
 * @param {(e:Event) => void} o.onShare
 * @param {string} [o.notice]   optional line above the card (e.g. "No new puzzle today")
 */
export function buildIntro({ ctx, raw, loaded, entry, label, progress, onPlay, onShare, notice = '' }) {
  const whites = loaded.isBlock.filter((b) => !b).length;
  const filled = progress.letters.filter(Boolean).length;
  const pct = whites ? Math.round((filled / whites) * 100) : 0;

  let status = null;
  let playLabel = 'Play';
  let playIcon = 'play';
  if (progress.solved && progress.finish === 'revealed') {
    // Reveal › Puzzle ended it: don't present a give-up as a (record-fast) solve.
    status = h('p', { class: 'intro-status is-revealed' }, icon('eye', { size: 18 }), h('span', null, 'Puzzle revealed'));
    playLabel = 'View puzzle';
    playIcon = 'eye';
  } else if (progress.solved) {
    status = h('p', { class: 'intro-status is-solved' }, icon('check', { size: 18 }), h('span', null, `Solved in ${formatDuration(progress.elapsedMs)}`));
    playLabel = 'See your solve';
    playIcon = 'eye';
  } else if (progress.started) {
    status = h('p', { class: 'intro-status' }, h('span', null, `${pct}% filled`));
    playLabel = `Resume · ${formatDuration(progress.elapsedMs)}`;
  }

  const playBtn = h('button', { type: 'button', class: 'btn btn-primary btn-xl intro-play', onclick: onPlay }, icon(playIcon, { size: 20 }), h('span', null, playLabel));
  const shareBtn = progress.solved
    ? h('button', { type: 'button', class: 'btn btn-secondary btn-xl', onclick: onShare }, icon('share', { size: 20 }), h('span', null, 'Share'))
    : null;

  const number = entry?.number ? `#${entry.number}` : null;
  const meta = [formatDate(raw.date), sizeLabel(raw.width, raw.height)].filter(Boolean);

  return h('div', { class: 'screen screen-intro' },
    siteHeader(ctx, ctx.route?.name === 'today' ? 'today' : null),
    h('main', { class: 'page page-center', id: 'main' },
      h('article', { class: 'intro-card' },
        notice && h('p', { class: 'intro-notice' }, notice),
        h('p', { class: 'eyebrow' }, [label, number].filter(Boolean).join(' · ')),
        h('h1', { class: 'intro-title' }, raw.title || 'Untitled'),
        raw.author && h('p', { class: 'intro-byline' }, `by ${raw.author}`),
        h('p', { class: 'intro-meta' }, meta.join('  ·  ')),
        silhouette(loaded, progress),
        raw.note && h('p', { class: 'intro-note' }, raw.note),
        status,
        h('div', { class: 'intro-actions' }, playBtn, shareBtn))));
}
