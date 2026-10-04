// The intro card shown before solving: title, author, date, number, size, note and Play / Resume.
// The grid itself stays hidden; only a silhouette of the block pattern (and filled squares) is shown.

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { formatDate, formatDuration, puzzleKind } from '../../shared/puzzle.js';
import { entryId, entryKind, kindLabel, sizeLabel } from '../daily.js';
import { CLAUDE, seriesOf } from '../series.js';
import { claudeMark, siteHeader } from './common.js';

/**
 * Small preview of the block pattern; filled squares are tinted, letters never shown.
 * `box` = the thumbnail's largest side in px; `vh` = cap as a share of the viewport height (short screens).
 * `fluid`: no inline cell size — the stylesheet sizes it from --n (the larger side), e.g. for the day cards.
 */
export function silhouette(loaded, progress, { box = 224, vh = 22, minCell = 6, className = '', fluid = false } = {}) {
  const { width, height, isBlock } = loaded;
  const n = Math.max(width, height);
  const cell = Math.max(minCell, Math.min(30, Math.floor(box / n)));
  const el = h('div', {
    class: ['silhouette', className, progress.solved && 'is-solved'],
    // On short screens the thumbnail shrinks (to ~22% of the viewport height) so Play stays in view.
    style: fluid
      ? { '--w': width, '--h': height, '--n': n }
      : { '--w': width, '--h': height, '--sc': vh ? `max(4px, min(${cell}px, calc(${vh}vh / ${n})))` : `${cell}px` },
    'aria-hidden': 'true',
  });
  for (let i = 0; i < width * height; i++) {
    const cls = isBlock[i] ? 'sb' : progress.letters[i] ? 'sf' : 'se';
    el.append(h('span', { class: cls }));
  }
  return el;
}

/**
 * Status line and Play button wording for a puzzle's progress:
 *   { status: null | { state: 'progress'|'solved'|'revealed', text }, playLabel, playIcon }
 */
export function playState(loaded, progress) {
  const whites = loaded.isBlock.filter((b) => !b).length;
  const filled = progress.letters.filter(Boolean).length;
  const pct = whites ? Math.round((filled / whites) * 100) : 0;
  if (progress.solved && progress.finish === 'revealed') {
    // Reveal › Puzzle ended it: don't present a give-up as a (record-fast) solve.
    return { status: { state: 'revealed', text: 'Puzzle revealed' }, playLabel: 'View puzzle', playIcon: 'eye' };
  }
  if (progress.solved) {
    return { status: { state: 'solved', text: `Solved in ${formatDuration(progress.elapsedMs)}` }, playLabel: 'See your solve', playIcon: 'eye' };
  }
  if (progress.started) {
    return { status: { state: 'progress', text: `${pct}% filled`, pct }, playLabel: `Resume · ${formatDuration(progress.elapsedMs)}`, playIcon: 'play' };
  }
  return { status: null, playLabel: 'Play', playIcon: 'play' };
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
 * @param {boolean} [o.kindInLabel] the label already names the kind ("Today’s Mini"): the number stays "#1"
 * @param {object[]} [o.siblings] index entries of the other puzzles on the same date (links under the card)
 */
export function buildIntro({ ctx, raw, loaded, entry, label, progress, onPlay, onShare, notice = '', kindInLabel = false, siblings = [] }) {
  const kind = puzzleKind(raw);
  // Claude's way (SPEC §9): the label is the series ("Claude’s way · Mini #3"), the kind is always named.
  const claude = seriesOf(raw) === CLAUDE;
  const state = playState(loaded, progress);
  const { playLabel, playIcon } = state;
  let status = null;
  if (state.status) {
    const ic = { solved: 'check', revealed: 'eye' }[state.status.state];
    status = h('p', { class: ['intro-status', state.status.state !== 'progress' && `is-${state.status.state}`] },
      ic && icon(ic, { size: 18 }), h('span', null, state.status.text));
  }

  const playBtn = h('button', { type: 'button', class: 'btn btn-primary btn-xl intro-play', onclick: onPlay }, icon(playIcon, { size: 20 }), h('span', null, playLabel));
  const shareBtn = progress.solved
    ? h('button', { type: 'button', class: 'btn btn-secondary btn-xl', onclick: onShare }, icon('share', { size: 20 }), h('span', null, 'Share'))
    : null;

  // "#2" for a daily; "Mini #1" for a mini (just "#1" when the label already says "Today’s Mini").
  const kindWord = (kind !== 'daily' || claude) && !kindInLabel ? kindLabel(kind) : '';
  const number = [kindWord, entry?.number ? `#${entry.number}` : ''].filter(Boolean).join(' ') || null;
  // (The eyebrow names a Claude puzzle's kind, so its size stands alone: a 5×5 Claude Daily is not "5×5 Mini".)
  const meta = [formatDate(raw.date), claude ? `${raw.width}×${raw.height}` : sizeLabel(raw.width, raw.height, kind)].filter(Boolean);
  const others = siblings.length
    ? h('nav', { class: 'intro-siblings', 'aria-label': 'More puzzles this day' },
      h('span', { class: 'intro-siblings-label' }, 'Also this day'),
      siblings.map((s) => h('a', { class: 'kind-chip', href: `#/puzzle/${entryId(s)}`, dataset: { kind: entryKind(s) } },
        h('span', { class: ['kind-badge', `kind-${entryKind(s)}`] }, kindLabel(entryKind(s))),
        h('span', { class: 'kind-chip-title' }, s.title || 'Untitled'))))
    : null;

  return h('div', { class: 'screen screen-intro' },
    siteHeader(ctx, ctx.route?.name === 'today' ? 'today' : null),
    h('main', { class: 'page page-center', id: 'main' },
      h('article', { class: ['intro-card', `kind-${kind}`, claude && 'series-claude'], dataset: { kind, series: claude ? CLAUDE : null } },
        notice && h('p', { class: 'intro-notice' }, notice),
        h('p', { class: 'eyebrow' }, claude && claudeMark(14), [label, number].filter(Boolean).join(' · ')),
        h('h1', { class: 'intro-title' }, raw.title || 'Untitled'),
        raw.author && h('p', { class: 'intro-byline' }, `by ${raw.author}`),
        h('p', { class: 'intro-meta' }, meta.join('  ·  ')),
        silhouette(loaded, progress),
        raw.note && h('p', { class: 'intro-note' }, raw.note),
        status,
        h('div', { class: 'intro-actions' }, playBtn, shareBtn),
        others)));
}
