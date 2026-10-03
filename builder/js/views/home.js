// Home: how it works + recent drafts + what is coming up.

import { addDays, formatDate } from '../../../site/shared/puzzle.js';
import { h, icon, timeAgo } from '../dom.js';
import { openNewDraftDialog } from '../new-draft.js';

const STEPS = [
  ['Type theme words', 'A few words or phrases that tie the puzzle together.'],
  ['Generate a grid', 'Get symmetric grids that hold them, filled with good words.'],
  ['Tweak & clue', 'Adjust any word, then write clues (with suggestions).'],
  ['Publish', 'Pick a date. Friends just open the site and play.'],
];

export function mountHome(container, app) {
  const recent = h('div', { class: 'home-drafts' });
  const upcoming = h('div', { class: 'home-upcoming' });

  container.append(h('div', { class: 'page home' },
    h('section', { class: 'hero card' },
      h('div', null,
        h('h1', null, 'Make a crossword for your friends'),
        h('p', { class: 'muted' }, 'From a handful of theme words to a published daily puzzle in a few minutes.'),
        h('button', { class: 'btn primary lg', type: 'button', onclick: () => openNewDraftDialog(app) }, icon('plus'), 'New puzzle')),
      h('ol', { class: 'how-steps' }, STEPS.map(([t, d], k) => h('li', null,
        h('span', { class: 'hs-n' }, String(k + 1)), h('div', null, h('strong', null, t), h('span', { class: 'muted small' }, d)))))),
    h('div', { class: 'home-cols' },
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, 'Recent drafts')), recent),
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, 'Next 7 days'),
        h('a', { class: 'btn sm link', href: '#/schedule' }, 'Schedule', icon('arrowRight', { size: 14 }))), upcoming))));

  function render() {
    recent.replaceChildren();
    if (!app.drafts.length) {
      recent.append(h('div', { class: 'empty-hint' }, h('strong', null, 'No drafts yet'), h('span', null, 'Start with “New puzzle”.')));
    } else {
      recent.append(h('ul', { class: 'link-list' }, app.drafts.slice(0, 8).map((d) => h('li', null,
        h('a', { href: `#/draft/${d.id}` },
          h('span', { class: 'll-title', text: d.title || 'Untitled' }),
          h('span', { class: 'muted small' }, `${d.width}×${d.height} · ${d.date ? formatDate(d.date, 'short') : 'no date'} · edited ${timeAgo(d.updatedAt)}`))))));
    }
    const pub = app.publishedByDate();
    const today = app.today();
    const days = Array.from({ length: 7 }, (_, k) => addDays(today, k));
    upcoming.replaceChildren(h('ul', { class: 'day-list' }, days.map((date) => {
      const p = pub.get(date);
      const draft = !p && app.drafts.find((d) => d.date === date);
      return h('li', { class: ['day', p ? 'filled' : draft ? 'planned' : 'gap'] },
        h('span', { class: 'day-date' }, date === today ? 'Today' : formatDate(date, 'short').replace(/, \d{4}$/, '')),
        p ? h('span', null, h('strong', null, `#${p.number} `), p.title)
          : draft ? h('a', { href: `#/draft/${draft.id}` }, `Draft: ${draft.title || 'Untitled'} (not published)`)
            : h('button', { class: 'btn sm link', type: 'button', onclick: () => openNewDraftDialog(app, { date }) }, icon('plus', { size: 12 }), 'Plan a puzzle'));
    })));
  }

  render();
  const onChange = () => render();
  for (const t of ['drafts', 'published', 'config']) app.addEventListener(t, onChange);
  return { destroy() { for (const t of ['drafts', 'published', 'config']) app.removeEventListener(t, onChange); } };
}
