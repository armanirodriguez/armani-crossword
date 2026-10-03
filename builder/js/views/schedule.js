// Schedule: what is published when, gaps in the next 14 days, unpublish, jump to drafts.

import { addDays, formatDate } from '../../../site/shared/puzzle.js';
import { h, icon, plural } from '../dom.js';
import { confirmDialog, toast, toastError } from '../dialogs.js';
import { api } from '../api.js';
import { openNewDraftDialog } from '../new-draft.js';
import { siteUrlFor } from '../preview.js';

export function mountSchedule(container, app) {
  const strip = h('div', { class: 'day-strip' });
  const stripNote = h('p', { class: 'muted small' });
  const upcoming = h('div');
  const released = h('div');
  const todayEl = h('p', { class: 'muted' });

  container.append(h('div', { class: 'page' },
    h('header', { class: 'page-head' },
      h('h1', null, 'Schedule'),
      todayEl),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, 'Next 14 days'), stripNote),
      strip),
    h('section', { class: 'card' }, h('h2', { class: 'card-title' }, 'Upcoming'), upcoming),
    h('section', { class: 'card' }, h('h2', { class: 'card-title' }, 'Released'), released)));

  /** The draft behind a published date: the one that published it if known, else any draft with that date. */
  function draftFor(date) {
    const list = app.drafts.filter((d) => d.date === date);
    return list.find((d) => app.publishedFor(d)) || list[0] || null;
  }

  function render() {
    const today = app.today();
    const tz = app.config?.timeZone;
    todayEl.textContent = `Today is ${formatDate(today)} (${tz ? `site time zone ${tz}` : 'each solver’s local date'}).`;
    const pub = app.publishedByDate();

    // 14-day strip
    const days = Array.from({ length: 14 }, (_, k) => addDays(today, k));
    let gaps = 0;
    strip.replaceChildren(...days.map((date) => {
      const p = pub.get(date);
      const draft = !p ? app.drafts.find((d) => d.date === date) : null;
      if (!p) gaps++;
      const [weekday, rest] = [
        new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`)),
        new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`)),
      ];
      return h('div', { class: ['day-cell', p ? 'filled' : draft ? 'planned' : 'gap', date === today && 'today'] },
        h('div', { class: 'dc-date' }, h('strong', null, weekday), h('span', null, rest)),
        p ? h('div', { class: 'dc-body' }, h('span', { class: 'dc-num' }, `#${p.number}`), h('span', { class: 'dc-title', text: p.title }))
          : draft ? h('a', { class: 'dc-body', href: `#/draft/${draft.id}/review`, title: 'Planned draft, not published yet' },
            h('span', { class: 'dc-num' }, 'Draft'), h('span', { class: 'dc-title', text: draft.title || 'Untitled' }))
            : h('button', { class: 'dc-body dc-add', type: 'button', title: `Plan a puzzle for ${formatDate(date)}`, onclick: () => openNewDraftDialog(app, { date }) },
              icon('plus', { size: 14 }), h('span', null, 'Plan')));
    }));
    stripNote.textContent = gaps ? `${plural(gaps, 'day')} without a published puzzle` : 'Every day is covered';
    stripNote.className = gaps ? 'small warn-text' : 'small ok';

    const all = app.published?.puzzles || [];
    const up = all.filter((p) => p.date > today).sort((a, b) => (a.date < b.date ? -1 : 1));
    const done = all.filter((p) => p.date <= today).sort((a, b) => (a.date < b.date ? 1 : -1));
    upcoming.replaceChildren(up.length ? table(up, today) : h('p', { class: 'muted small' }, 'Nothing scheduled after today.'));
    released.replaceChildren(done.length ? table(done, today) : h('p', { class: 'muted small' }, 'Nothing released yet.'));
  }

  function table(list, today) {
    return h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null,
        h('th', { class: 'num' }, '#'), h('th', null, 'Date'), h('th', null, 'Title'), h('th', null, 'Author'),
        h('th', null, 'Size'), h('th', null, 'Status'), h('th', { class: 'actions' }, ''))),
      h('tbody', null, list.map((p) => {
        const draft = draftFor(p.date);
        return h('tr', null,
          h('td', { class: 'num' }, String(p.number)),
          h('td', null, formatDate(p.date, 'short')),
          h('td', { text: p.title }),
          h('td', { class: 'muted', text: p.author || '' }),
          h('td', null, `${p.width}×${p.height}`),
          h('td', null, p.date > today ? h('span', { class: 'pill info' }, 'Scheduled') : p.date === today ? h('span', { class: 'pill ok' }, 'Today') : h('span', { class: 'pill muted' }, 'Released')),
          h('td', { class: 'actions' }, h('div', { class: 'row gap-xs' },
            draft ? h('a', { class: 'btn sm', href: `#/draft/${draft.id}` }, 'Open draft') : null,
            h('a', {
              class: 'btn sm', href: siteUrlFor(p.date, today), target: '_blank', rel: 'noopener',
              // Scheduled puzzles are locked for solvers ("No peeking!"): open those in preview mode.
              title: p.date > today ? 'Preview in the player (solvers can open it on its day)' : 'Open in the player site',
              'aria-label': p.date > today ? `Preview #${p.number} in the player` : `Open #${p.number} in the player`,
            }, icon('external', { size: 14 })),
            h('button', { class: 'btn sm danger-ghost', type: 'button', onclick: () => unpublish(p) }, 'Unpublish'))));
      }))));
  }

  async function unpublish(p) {
    const ok = await confirmDialog({
      title: `Unpublish #${p.number}?`,
      message: [
        `“${p.title}” (${formatDate(p.date)}) will be removed from site/puzzles/ and the index.`,
        'Puzzles after it are renumbered. Its draft (if any) is kept, so you can publish it again.',
      ],
      confirmLabel: 'Unpublish',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.unpublish(p.date);
      await app.refreshPublished();
      toast(`Unpublished “${p.title}”`, { type: 'success' });
    } catch (err) {
      toastError(err, 'Unpublish failed: ');
    }
  }

  render();
  app.refreshPublished();
  const onChange = () => render();
  for (const t of ['drafts', 'published', 'config']) app.addEventListener(t, onChange);
  return { destroy() { for (const t of ['drafts', 'published', 'config']) app.removeEventListener(t, onChange); } };
}
