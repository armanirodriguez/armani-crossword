// The crossword grid as DOM cells (CSS grid with 1px gaps as the grid lines).
//
// render() recomputes every cell's visual state from the Game and only touches the DOM for cells whose
// state string changed, so a keystroke on a 21×21 grid updates a handful of nodes.
// fit() picks an integer cell size that fits the available box; when even the minimum size does not fit
// (21×21 on a 320 px phone) the board scrolls inside itself instead of the page.

import { h, setClass } from './dom.js';

const GAP = 1; // px between cells (the grid lines)
const BORDER = 2; // px outer border

export class GridView {
  /**
   * @param {import('./game.js').Game} game
   * @param {{ onCell?: (i:number) => void, label?: string }} opts
   */
  constructor(game, { onCell = () => {}, label = 'Crossword grid' } = {}) {
    this.game = game;
    const { width, height, numbers, circles, shaded } = game.p;
    this.grid = h('div', {
      class: 'grid',
      tabindex: 0,
      role: 'group',
      'aria-label': `${label}, ${width} by ${height}`,
      style: { '--w': width, '--h': height },
    });
    this.board = h('div', { class: 'board' }, this.grid);
    this.cells = [];
    this.stateCache = [];
    this.letterCache = [];
    for (let i = 0; i < width * height; i++) {
      const block = game.isBlock(i);
      const el = h('div', { class: block ? 'cell is-block' : 'cell', dataset: { i } });
      let letter = null;
      if (!block) {
        if (numbers[i]) el.append(h('span', { class: 'num', 'aria-hidden': 'true' }, String(numbers[i])));
        letter = h('span', { class: 'letter' });
        el.append(letter);
        if (circles.has(i)) el.classList.add('has-circle');
        if (shaded.has(i)) el.classList.add('is-shaded');
        el.setAttribute('aria-label', this.cellLabel(i));
      }
      this.cells.push({ el, letter, base: el.className });
      this.grid.append(el);
    }

    // Mouse: prevent focus loss/text selection; select on click (also a tap on touch screens).
    this.grid.addEventListener('mousedown', (e) => {
      if (e.target.closest('.cell')) {
        e.preventDefault();
        this.focus();
      }
    });
    this.grid.addEventListener('click', (e) => {
      const cell = e.target.closest('.cell');
      if (!cell || cell.classList.contains('is-block')) return;
      onCell(Number(cell.dataset.i));
    });
    this.cell = 16;
    this.scrollMode = false;
  }

  cellLabel(i) {
    const { width, numbers } = this.game.p;
    const r = Math.floor(i / width) + 1;
    const c = (i % width) + 1;
    return `${numbers[i] ? `${numbers[i]}, ` : ''}row ${r}, column ${c}`;
  }

  focus() {
    try { this.grid.focus({ preventScroll: true }); } catch { /* ignore */ }
  }

  /** Size cells to fit a box of availW × availH px. */
  fit(availW, availH, { minCell = 14, maxCell = 96 } = {}) {
    const { width, height } = this.game.p;
    const byW = Math.floor((availW - 2 * BORDER - (width - 1) * GAP) / width);
    const byH = Math.floor((availH - 2 * BORDER - (height - 1) * GAP) / height);
    let cell = Math.min(byW, byH, maxCell);
    const scroll = cell < minCell;
    if (scroll) cell = minCell;
    this.cell = cell;
    this.grid.style.setProperty('--cell', `${cell}px`);
    this.grid.classList.toggle('is-tiny', cell < 22);
    if (scroll !== this.scrollMode) {
      this.scrollMode = scroll;
      this.board.classList.toggle('is-scroll', scroll);
    }
    if (scroll) this.scrollActiveIntoView();
    return cell;
  }

  /** Pixel size of the grid for a given cell size (used by layout code). */
  static gridSize(cells, cell) {
    return cells * cell + (cells - 1) * GAP + 2 * BORDER;
  }

  render() {
    const g = this.game;
    const word = new Set(g.entry?.cells || []);
    const cross = new Set(g.crossEntry?.cells || []);
    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i];
      if (!c.letter) continue;
      let s = c.base;
      if (i === g.cell) s += ' is-active';
      else if (word.has(i)) s += ' is-word';
      else if (cross.has(i)) s += ' is-cross';
      const mark = g.marks[i];
      if (mark === 'wrong') s += ' is-wrong';
      else if (mark === 'revealed') s += ' is-revealed';
      if (this.stateCache[i] !== s) {
        this.stateCache[i] = s;
        c.el.className = s;
      }
      const ch = g.letters[i];
      if (this.letterCache[i] !== ch) {
        this.letterCache[i] = ch;
        c.letter.textContent = ch;
      }
    }
    setClass(this.grid, 'is-solved', g.solved);
    if (this.scrollMode) this.scrollActiveIntoView();
  }

  /** In scroll mode keep the active cell (with a margin) inside the board's viewport. */
  scrollActiveIntoView() {
    const c = this.cells[this.game.cell];
    if (!c) return;
    const b = this.board;
    const el = c.el;
    const margin = this.cell * 1.5;
    const left = el.offsetLeft - margin;
    const right = el.offsetLeft + el.offsetWidth + margin;
    const top = el.offsetTop - margin;
    const bottom = el.offsetTop + el.offsetHeight + margin;
    let sl = b.scrollLeft;
    let st = b.scrollTop;
    if (left < sl) sl = left;
    else if (right > sl + b.clientWidth) sl = right - b.clientWidth;
    if (top < st) st = top;
    else if (bottom > st + b.clientHeight) st = bottom - b.clientHeight;
    if (sl !== b.scrollLeft || st !== b.scrollTop) b.scrollTo({ left: sl, top: st });
  }

  /** A celebratory ripple across the grid (CSS animation, staggered by distance from the corner). */
  celebrate() {
    const { width } = this.game.p;
    this.cells.forEach((c, i) => {
      if (!c.letter) return;
      c.el.style.setProperty('--d', `${((i % width) + Math.floor(i / width)) * 45}ms`);
    });
    this.grid.classList.remove('celebrate');
    void this.grid.offsetWidth; // restart the animation
    this.grid.classList.add('celebrate');
  }
}
