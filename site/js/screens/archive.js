// Archive: released puzzles, newest date first, with this browser's status for each.
// A date with several puzzles (SPEC §8: Mini, Midi, Daily) is one group — a date heading over its rows, each
// with a kind badge. A date with a single daily is a plain row, exactly as before kinds existed.

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { formatDate } from '../../shared/puzzle.js';
import { entryId, entryKind, groupByDate, kindLabel, releasedPuzzles, sizeLabel } from '../daily.js';
import { progressKey, progressStatus } from '../progress.js';
import { siteHeader } from './common.js';

function archiveRow(ctx, p, { grouped }) {
  const id = entryId(p);
  const kind = entryKind(p);
  const status = progressStatus(ctx.storage.getJSON(progressKey(id), null));
  const isToday = p.date === ctx.today;
  // A grouped row sits under its date heading, so its meta line leaves the date out.
  // Next to a kind badge the size stands alone (a grouped Daily is not "5×5 Mini").
  const size = grouped ? `${p.width}×${p.height}` : sizeLabel(p.width, p.height, kind);
  const meta = [!grouped && formatDate(p.date, 'short'), size, p.author && `by ${p.author}`];
  return h('li', null,
    h('a', { class: ['archive-item', `is-${status.state}`, `kind-${kind}`], href: `#/puzzle/${id}`, dataset: { id, kind } },
      h('span', { class: 'archive-num' }, p.number ? `#${p.number}` : '—'),
      h('span', { class: 'archive-main' },
        h('span', { class: 'archive-title' },
          (grouped || kind !== 'daily') && h('span', { class: ['kind-badge', `kind-${kind}`] }, kindLabel(kind)),
          h('span', { class: 'archive-title-text' }, p.title || 'Untitled'),
          isToday && !grouped && h('span', { class: 'pill pill-today' }, 'Today')),
        h('span', { class: 'archive-meta' }, meta.filter(Boolean).join(' · '))),
      h('span', { class: ['status-pill', `status-${status.state}`] }, status.label),
      icon('chevronRight', { size: 18, className: 'archive-chevron' })));
}

export function buildArchive(ctx) {
  const list = releasedPuzzles(ctx.index, ctx.today, ctx.preview);
  const items = groupByDate(list).map((g) => {
    if (g.entries.length === 1) return archiveRow(ctx, g.entries[0], { grouped: false });
    return h('li', { class: 'archive-day', dataset: { date: g.date } },
      h('h2', { class: 'archive-day-heading' },
        h('span', null, formatDate(g.date)),
        g.date === ctx.today && h('span', { class: 'pill pill-today' }, 'Today')),
      h('ol', { class: 'archive-day-list' }, g.entries.map((p) => archiveRow(ctx, p, { grouped: true }))));
  });

  const solved = list.filter((p) => progressStatus(ctx.storage.getJSON(progressKey(entryId(p)), null)).state === 'solved').length;

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
