// Archive: released puzzles, newest first, with this browser's status for each.

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { formatDate } from '../../shared/puzzle.js';
import { releasedPuzzles, sizeLabel } from '../daily.js';
import { progressKey, progressStatus } from '../progress.js';
import { siteHeader } from './common.js';

export function buildArchive(ctx) {
  const list = releasedPuzzles(ctx.index, ctx.today, ctx.preview);
  const items = list.map((p) => {
    const status = progressStatus(ctx.storage.getJSON(progressKey(p.date), null));
    const isToday = p.date === ctx.today;
    return h('li', null,
      h('a', { class: ['archive-item', `is-${status.state}`], href: `#/puzzle/${p.date}` },
        h('span', { class: 'archive-num' }, p.number ? `#${p.number}` : '—'),
        h('span', { class: 'archive-main' },
          h('span', { class: 'archive-title' }, h('span', { class: 'archive-title-text' }, p.title || 'Untitled'), isToday && h('span', { class: 'pill pill-today' }, 'Today')),
          h('span', { class: 'archive-meta' }, [formatDate(p.date, 'short'), sizeLabel(p.width, p.height), p.author && `by ${p.author}`].filter(Boolean).join(' · '))),
        h('span', { class: ['status-pill', `status-${status.state}`] }, status.label),
        icon('chevronRight', { size: 18, className: 'archive-chevron' })));
  });

  const solved = list.filter((p) => progressStatus(ctx.storage.getJSON(progressKey(p.date), null)).state === 'solved').length;

  return h('div', { class: 'screen screen-archive' },
    siteHeader(ctx, 'archive'),
    h('main', { class: 'page', id: 'main' },
      h('div', { class: 'archive' },
        h('header', { class: 'archive-header' },
          h('h1', { class: 'archive-heading' }, 'Archive'),
          list.length ? h('p', { class: 'archive-sub' }, `${list.length} puzzle${list.length === 1 ? '' : 's'} · ${solved} solved in this browser`) : null),
        list.length
          ? h('ol', { class: 'archive-list' }, items)
          : h('p', { class: 'archive-empty' }, 'No puzzles yet — check back soon.'))));
}
