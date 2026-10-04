// "Claude's way" on the home page (SPEC §9): a second series of puzzles that a scheduled Claude session makes every
// day (a Mini, a Midi and a Daily on one theme). The home page shows the user's own puzzles exactly as before, then
// this section with Claude's puzzles of today — or its latest set, labelled "Latest". When the user has no puzzles
// at all, the section is the whole home page (createClaudeHomeScreen).
//
// The cards are the same as on the user's "today's puzzles" screen (day.js), with Claude's accent colour.

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { isValidDateId } from '../../shared/puzzle.js';
import { progressKey, progressStatus } from '../progress.js';
import { CLAUDE, CLAUDE_TAGLINE, CLAUDE_TITLE, archiveHref } from '../series.js';
import { dayCard } from './day.js';
import { claudeMark, siteHeader } from './common.js';

/** "2026-10-02" -> "Friday, October 2" (a calendar date, independent of the device's time zone). */
export function dayName(dateId) {
  if (!isValidDateId(dateId)) return String(dateId ?? '');
  const [y, m, d] = dateId.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * The section. Re-rendered in place by refresh() (progress saved in another tab, or back from a puzzle), so it can
 * be moved between the screens it is attached to.
 * @param {object} o
 * @param {object} o.ctx
 * @param {string} o.date        the date of the set shown
 * @param {boolean} o.isToday    false: the latest set before today ("Latest")
 * @param {Array<{entry, raw?, error?}>} o.items   Mini, Midi, Daily order
 * @param {(id: string) => void} o.onPlay
 * @param {() => void} o.onRetry
 * @param {boolean} [o.solo]     the whole home page (the user has no puzzles yet): a page heading, no panel
 * @returns {{ el: HTMLElement, refresh(): void }}
 */
export function createClaudeSection({ ctx, date, isToday, items, onPlay, onRetry, solo = false }) {
  const el = h('section', {
    class: ['claude-way', solo ? 'is-solo' : 'is-below'],
    'aria-labelledby': 'claude-way-title',
    dataset: { date, series: CLAUDE },
  });

  function render() {
    const solved = items.filter((item) => item.raw
      && progressStatus(ctx.storage.getJSON(progressKey(item.raw.id), null)).state === 'solved').length;
    // "Today · Friday, October 2" (no year: it is today or close to it); each part stays on one line.
    const when = [h('span', null, isToday ? 'Today' : 'Latest'), ' · ', h('span', null, dayName(date))];
    el.replaceChildren(
      h('header', { class: 'cw-header' },
        h('p', { class: 'eyebrow cw-when' }, when),
        h(solo ? 'h1' : 'h2', { class: 'cw-title', id: 'claude-way-title' }, claudeMark(solo ? 22 : 20), h('span', null, CLAUDE_TITLE)),
        h('p', { class: 'cw-sub' }, CLAUDE_TAGLINE),
        solved ? h('p', { class: 'cw-progress' }, `${solved} of ${items.length} solved`) : null),
      h('ol', { class: 'day-cards cw-cards', dataset: { count: items.length } },
        items.map((item) => h('li', { class: 'day-cards-item' }, dayCard(ctx, item, { onPlay, onRetry })))),
      h('p', { class: 'cw-more' },
        h('a', { class: 'cw-archive-link', href: archiveHref(CLAUDE) },
          h('span', null, 'Claude’s way archive'), icon('chevronRight', { size: 18 }))));
  }

  render();
  return { el, refresh: render };
}

/**
 * Home page with only Claude's section (the user has published nothing yet, or nothing that is out).
 * @param {object} o
 * @param {object} o.ctx
 * @param {{ el: HTMLElement }} o.section   createClaudeSection({ solo: true, … })
 * @param {string} [o.notice]   e.g. when the user's first puzzle unlocks
 */
export function createClaudeHomeScreen({ ctx, section, notice = '' }) {
  return h('div', { class: 'screen screen-claude-home' },
    siteHeader(ctx, 'today'),
    h('main', { class: 'page', id: 'main' },
      notice && h('p', { class: 'cw-notice' }, notice),
      section.el));
}
