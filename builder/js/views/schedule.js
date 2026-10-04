// Schedule: what is published when (every puzzle of a day — Mini, Midi, Daily — with its kind), gaps in the next
// 14 days, unpublish / open per puzzle, jump to drafts, and "Put it online" (commit + push to GitHub) with the
// number of changes waiting.

import { addDays, formatDate } from '../../../site/shared/puzzle.js';
import { h, icon, plural } from '../dom.js';
import { confirmDialog, toast, toastError } from '../dialogs.js';
import { api } from '../api.js';
import { openNewDraftDialog } from '../new-draft.js';
import { siteUrlFor } from '../preview.js';
import { goLiveControl } from '../go-live.js';
import {
  KINDS, draftKind, draftPuzzleId, entryId, kindLabel, numberLabel, puzzleKind, sortPuzzles,
} from '../kinds.js';

const kindBadge = (kind) => h('span', { class: ['kind-badge', `kind-${kind}`], text: kindLabel(kind) });

export function mountSchedule(container, app) {
  const strip = h('div', { class: 'day-strip' });
  const stripNote = h('p', { class: 'muted small' });
  const upcoming = h('div');
  const released = h('div');
  const todayEl = h('p', { class: 'muted' });
  const goLive = goLiveControl(app);

  container.append(h('div', { class: 'page' },
    h('header', { class: 'page-head page-head-split' },
      h('div', { class: 'page-head' },
        h('h1', null, 'Schedule'),
        todayEl),
      h('div', { class: 'golive-head' }, goLive.button, goLive.message)),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, 'Next 14 days'), stripNote),
      strip),
    h('section', { class: 'card' }, h('h2', { class: 'card-title' }, 'Upcoming'), upcoming),
    h('section', { class: 'card' }, h('h2', { class: 'card-title' }, 'Released'), released)));

  /** The draft behind a published puzzle: the one that published it if known, else any draft with its date and kind. */
  function draftFor(p) {
    const id = entryId(p);
    const list = app.drafts.filter((d) => draftPuzzleId(d) === id);
    return list.find((d) => app.publishedFor(d)) || list[0] || null;
  }

  /** Kinds a day still has room for (no published puzzle and no planned draft of that kind). */
  function freeKinds(date, pubs) {
    const used = new Set([...pubs.map(puzzleKind), ...app.drafts.filter((d) => d.date === date).map(draftKind)]);
    return KINDS.filter((k) => !used.has(k));
  }

  const dayParts = (date) => [
    new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`)),
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`)),
  ];

  function render() {
    const today = app.today();
    const tz = app.config?.timeZone;
    todayEl.textContent = `Today is ${formatDate(today)} (${tz ? `site time zone ${tz}` : 'each solver’s local date'}).`;

    // 14-day strip: every puzzle of the day, planned drafts of the kinds not published yet, and "Plan".
    const days = Array.from({ length: 14 }, (_, k) => addDays(today, k));
    let gaps = 0;
    strip.replaceChildren(...days.map((date) => {
      const pubs = app.publishedOn(date);
      const pubKinds = new Set(pubs.map(puzzleKind));
      const drafts = app.drafts
        .filter((d) => d.date === date && !pubKinds.has(draftKind(d)))
        .sort((a, b) => KINDS.indexOf(draftKind(a)) - KINDS.indexOf(draftKind(b)));
      if (!pubs.length) gaps++;
      const [weekday, rest] = dayParts(date);
      const free = freeKinds(date, pubs);
      const items = [
        ...pubs.map((p) => h('div', { class: 'dc-item', title: `${numberLabel(p)} “${p.title}” (${p.width}×${p.height})` },
          kindBadge(puzzleKind(p)), h('span', { class: 'dc-num' }, `#${p.number}`), h('span', { class: 'dc-title', text: p.title }))),
        ...drafts.map((d) => h('a', { class: 'dc-item planned', href: `#/draft/${d.id}/review`, title: `Planned ${kindLabel(draftKind(d))} draft, not published yet` },
          kindBadge(draftKind(d)), h('span', { class: 'dc-num' }, 'Draft'), h('span', { class: 'dc-title', text: d.title || 'Untitled' }))),
      ];
      return h('div', { class: ['day-cell', pubs.length ? 'filled' : drafts.length ? 'planned' : 'gap', date === today && 'today'], 'data-date': date },
        h('div', { class: 'dc-date' }, h('strong', null, weekday), h('span', null, rest)),
        items.length
          ? h('div', { class: 'dc-body dc-list' }, ...items,
            free.length ? h('button', {
              class: 'dc-more', type: 'button', title: `Plan another puzzle for ${formatDate(date)} (free: ${free.map(kindLabel).join(', ')})`,
              'aria-label': `Plan another puzzle for ${formatDate(date)}`,
              onclick: () => openNewDraftDialog(app, { date, kind: free[0] }),
            }, icon('plus', { size: 12 }), h('span', null, 'Add')) : null)
          : h('button', { class: 'dc-body dc-add', type: 'button', title: `Plan a puzzle for ${formatDate(date)}`, onclick: () => openNewDraftDialog(app, { date }) },
            icon('plus', { size: 14 }), h('span', null, 'Plan')));
    }));
    stripNote.textContent = gaps ? `${plural(gaps, 'day')} without a published puzzle` : 'Every day is covered';
    stripNote.className = gaps ? 'small warn-text' : 'small ok';

    const all = app.published?.puzzles || [];
    const up = sortPuzzles(all.filter((p) => p.date > today));
    const done = sortPuzzles(all.filter((p) => p.date <= today), { descending: true });
    upcoming.replaceChildren(up.length ? table(up, today) : h('p', { class: 'muted small' }, 'Nothing scheduled after today.'));
    released.replaceChildren(done.length ? table(done, today) : h('p', { class: 'muted small' }, 'Nothing released yet.'));
  }

  /** One row per puzzle; the puzzles of one day sit together (the date is shown on the first of them). */
  function table(list, today) {
    return h('div', { class: 'table-wrap' }, h('table', { class: 'table schedule-table' },
      h('thead', null, h('tr', null,
        h('th', null, 'Date'), h('th', null, 'Kind'), h('th', { class: 'num' }, '#'), h('th', null, 'Title'), h('th', null, 'Author'),
        h('th', null, 'Size'), h('th', null, 'Status'), h('th', { class: 'actions' }, ''))),
      h('tbody', null, list.map((p, k) => {
        const draft = draftFor(p);
        const id = entryId(p);
        const kind = puzzleKind(p);
        const first = k === 0 || list[k - 1].date !== p.date;
        return h('tr', { class: [!first && 'same-day'], 'data-id': id },
          h('td', null, first ? formatDate(p.date, 'short') : ''),
          h('td', null, kindBadge(kind)),
          h('td', { class: 'num' }, String(p.number)),
          h('td', { text: p.title }),
          h('td', { class: 'muted', text: p.author || '' }),
          h('td', null, `${p.width}×${p.height}`),
          h('td', null, p.date > today ? h('span', { class: 'pill info' }, 'Scheduled') : p.date === today ? h('span', { class: 'pill ok' }, 'Today') : h('span', { class: 'pill muted' }, 'Released')),
          h('td', { class: 'actions' }, h('div', { class: 'row gap-xs' },
            draft ? h('a', { class: 'btn sm', href: `#/draft/${draft.id}` }, 'Open draft') : null,
            h('a', {
              class: 'btn sm', href: siteUrlFor(id, today), target: '_blank', rel: 'noopener',
              // Scheduled puzzles are locked for solvers ("No peeking!"): open those in preview mode.
              title: p.date > today ? 'Preview in the player (solvers can open it on its day)' : 'Open in the player site',
              'aria-label': p.date > today ? `Preview ${numberLabel(p)} in the player` : `Open ${numberLabel(p)} in the player`,
            }, icon('external', { size: 14 })),
            h('button', { class: 'btn sm danger-ghost', type: 'button', onclick: () => unpublish(p), 'aria-label': `Unpublish ${numberLabel(p)}` }, 'Unpublish'))));
      }))));
  }

  async function unpublish(p) {
    const ok = await confirmDialog({
      title: `Unpublish ${numberLabel(p)}?`,
      message: [
        `The ${kindLabel(puzzleKind(p))} “${p.title}” (${formatDate(p.date)}) will be removed from site/puzzles/ and the index. Other puzzles of that day stay.`,
        `${puzzleKind(p) === 'daily' ? 'Dailies' : `${kindLabel(puzzleKind(p))}s`} after it are renumbered. Its draft (if any) is kept, so you can publish it again.`,
      ],
      confirmLabel: 'Unpublish',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.unpublish(entryId(p));
      await app.refreshPublished();
      // It is still on the live site until the removal is put online.
      toast(`Unpublished “${p.title}”`, {
        type: 'success',
        action: app.goLive.status?.ready ? { label: 'Put it online', onClick: () => app.goLive.run() } : null,
      });
    } catch (err) {
      toastError(err, 'Unpublish failed: ');
    }
  }

  render();
  app.refreshPublished();
  const onChange = () => render();
  for (const t of ['drafts', 'published', 'config']) app.addEventListener(t, onChange);
  return {
    destroy() {
      for (const t of ['drafts', 'published', 'config']) app.removeEventListener(t, onChange);
      goLive.destroy();
    },
  };
}
