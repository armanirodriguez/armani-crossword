// Clue lists (Across | Down) and the single-clue bar shown above the grid (desktop) or above the
// on-screen keyboard (touch).

import { h, setClass, prefersReducedMotion } from './dom.js';
import { icon } from './icons.js';

/** Across and Down lists with active / crossing / completed highlighting and auto-scroll. */
export class ClueLists {
  /**
   * @param {import('./game.js').Game} game
   * @param {{ onSelect: (entry) => void, className?: string }} opts
   */
  constructor(game, { onSelect, className = '' }) {
    this.game = game;
    this.items = new Map();
    this.lists = {};
    this.el = h('div', { class: ['clue-lists', className] });
    for (const dir of ['across', 'down']) {
      const list = h('ol', { class: 'clue-list', 'aria-label': `${dir === 'across' ? 'Across' : 'Down'} clues` });
      for (const entry of game.p[dir]) {
        const li = h('li', { class: 'clue', dataset: { id: entry.id } },
          h('span', { class: 'clue-num' }, String(entry.num)),
          h('span', { class: 'clue-text' }, entry.clue));
        li.addEventListener('click', () => onSelect(entry));
        list.append(li);
        this.items.set(entry.id, { li, entry, list, state: '' });
      }
      this.lists[dir] = list;
      this.el.append(h('section', { class: 'clue-col' },
        h('h2', { class: 'clue-heading' }, dir === 'across' ? 'Across' : 'Down'),
        list));
    }
    this.lastActive = null;
    this.lastCross = null;
  }

  render({ scroll = true } = {}) {
    const g = this.game;
    const active = g.entry?.id;
    const cross = g.crossEntry?.id;
    for (const [id, item] of this.items) {
      const filled = g.isEntryFilled(item.entry);
      const state = `${id === active}|${id === cross}|${filled}`;
      if (state === item.state) continue;
      item.state = state;
      setClass(item.li, 'is-active', id === active);
      setClass(item.li, 'is-cross', id === cross);
      setClass(item.li, 'is-filled', filled);
      if (id === active) item.li.setAttribute('aria-current', 'true');
      else item.li.removeAttribute('aria-current');
    }
    if (scroll && (active !== this.lastActive || cross !== this.lastCross)) {
      if (active) this.scrollToItem(this.items.get(active));
      if (cross) this.scrollToItem(this.items.get(cross));
    }
    this.lastActive = active;
    this.lastCross = cross;
  }

  /** Scroll the item's own list (never the page) so the item is visible, near the top. */
  scrollToItem(item, { instant = false } = {}) {
    if (!item) return;
    const { list, li } = item;
    if (list.scrollHeight <= list.clientHeight + 1) return; // list doesn't scroll (e.g. in a sheet)
    const top = li.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    const bottom = top + li.offsetHeight;
    if (top >= list.scrollTop + 4 && bottom <= list.scrollTop + list.clientHeight - 4) return;
    const target = Math.max(0, top - Math.min(48, list.clientHeight / 4));
    list.scrollTo({ top: target, behavior: instant || prefersReducedMotion() ? 'auto' : 'smooth' });
  }

  /** In a sheet the whole sheet body scrolls: bring the active clue into view there. */
  revealActiveIn(container) {
    const item = this.items.get(this.game.entry?.id);
    if (!item || !container) return;
    const li = item.li;
    const cRect = container.getBoundingClientRect();
    const r = li.getBoundingClientRect();
    if (r.top < cRect.top || r.bottom > cRect.bottom) {
      container.scrollTop += r.top - cRect.top - cRect.height / 3;
    }
  }
}

/** The active clue: ‹ [1A] clue text › — tapping the text toggles direction. */
export class ClueBar {
  constructor(game, { onPrev, onNext, onToggle }) {
    this.game = game;
    this.num = h('span', { class: 'cluebar-num' });
    this.text = h('span', { class: 'cluebar-text' });
    this.body = h('button', { type: 'button', class: 'cluebar-body', 'aria-live': 'polite', title: 'Switch direction' }, this.num, this.text);
    this.body.addEventListener('click', onToggle);
    const prev = h('button', { type: 'button', class: 'cluebar-nav', 'aria-label': 'Previous clue' }, icon('chevronLeft', { size: 24 }));
    const next = h('button', { type: 'button', class: 'cluebar-nav', 'aria-label': 'Next clue' }, icon('chevronRight', { size: 24 }));
    // Prevent the buttons from stealing focus from the grid (keeps hardware typing working).
    for (const b of [prev, next, this.body]) b.addEventListener('mousedown', (e) => e.preventDefault());
    prev.addEventListener('click', onPrev);
    next.addEventListener('click', onNext);
    this.el = h('div', { class: 'cluebar' }, prev, this.body, next);
    this.key = '';
  }

  render() {
    const e = this.game.entry;
    const key = e ? e.id : '';
    if (key === this.key) return;
    this.key = key;
    this.num.textContent = e ? `${e.num}${e.dir === 'across' ? 'A' : 'D'}` : '';
    this.text.textContent = e ? e.clue : '';
    const len = e ? e.clue.length : 0;
    this.el.dataset.len = len > 110 ? 'xl' : len > 70 ? 'l' : 'm';
    this.body.setAttribute('aria-label', e ? `${e.num} ${e.dir}: ${e.clue}, ${e.length} letters` : '');
    this.fitText();
  }

  /**
   * The whole clue is always shown (never cut off with an ellipsis): long clues first step the font down
   * (to 13 px) to stay within MAX_LINES lines — the height the bar reserves on phones, so the grid above it
   * doesn't resize as the selection moves — and only the rare clue that still doesn't fit grows the bar.
   * Call again when the bar's width may have changed.
   */
  fitText() {
    const t = this.text;
    if (!t.isConnected || !t.textContent) {
      t.style.removeProperty('--cb-fs');
      return;
    }
    const base = parseFloat(getComputedStyle(this.el).getPropertyValue('--cb-base')) || 16;
    let fs = base;
    t.style.setProperty('--cb-fs', `${fs}px`);
    while (fs > ClueBar.MIN_FONT && t.offsetHeight > Math.ceil(fs * ClueBar.LINE_HEIGHT * ClueBar.MAX_LINES) + 1) {
      fs -= 1;
      t.style.setProperty('--cb-fs', `${fs}px`);
    }
  }
}
ClueBar.MAX_LINES = 3;
ClueBar.MIN_FONT = 13;
ClueBar.LINE_HEIGHT = 1.3; // keep in sync with .cluebar-text in styles.css
