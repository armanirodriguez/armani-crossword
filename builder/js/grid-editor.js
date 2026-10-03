// The big editable grid on the Grid & Fill tab.
//
// Modes (what a click does): 'letters' (select / toggle direction), 'blocks' (toggle block + symmetric partner),
// 'circles', 'shaded'. The keyboard works the same in every mode:
//   A–Z type (typed letters are locked) · . toggle block · Backspace / Delete clear · arrows move
//   (a perpendicular arrow first switches direction) · Tab / Shift+Tab next / previous entry · Space toggles
//   direction — except right after typing a letter, where it is ignored so a phrase like "peanut butter" can be
//   typed straight in (theme answers drop their spaces too) · Enter toggles a circle / shading in those modes ·
//   Home / End jump within the entry · Esc leaves.
// Keys are captured by a visually hidden <input> so touch keyboards on tablets work too.

import { BLOCK, computeEntries, isLetter } from '../../site/shared/grid.js';
import { h } from './dom.js';
import { clearCell, entryAt, setLetter, toggleBlock, toggleDecoration } from './draft-utils.js';

const MIN_CELL = 16;
const MAX_CELL = 64;

export class GridEditor {
  /**
   * @param {HTMLElement} container  element the grid should fill (its size decides the cell size)
   * @param {{ store, session: { index, dir, mode }, onSelect?: (entry) => void }} opts
   */
  constructor(container, { store, session, onSelect = () => {} }) {
    this.store = store;
    this.session = session;
    this.onSelect = onSelect;
    this.readOnly = false;
    this.preview = null;          // { cells: number[], word: string }
    this.marks = { problem: new Set(), hint: new Set(), issue: new Set() };
    this.cellEls = [];
    this.entries = null;
    this.afterLetter = false;     // the last key typed a letter (a Space right after it is part of a phrase)

    this.gridEl = h('div', { class: 'xw-grid', role: 'grid', 'aria-label': 'Crossword grid' });
    this.input = h('input', {
      class: 'grid-input',
      type: 'text',
      'data-grid-input': '',
      autocomplete: 'off',
      autocapitalize: 'characters',
      spellcheck: false,
      'aria-label': 'Grid keyboard input. Type letters; arrows move; period toggles a block.',
      onkeydown: (e) => this.#onKey(e),
      oninput: () => this.#onInput(),
      onfocus: () => this.root.classList.add('focused'),
      onblur: () => this.root.classList.remove('focused'),
    });
    this.root = h('div', { class: 'xw-grid-wrap' }, this.gridEl, this.input);
    this.gridEl.addEventListener('mousedown', (e) => this.#onPointer(e));
    container.appendChild(this.root);
    this.container = container;
    this.resizeObserver = new ResizeObserver(() => this.#fit());
    this.resizeObserver.observe(container);
    this.render();
  }

  destroy() {
    this.resizeObserver.disconnect();
    this.root.remove();
  }

  get draft() { return this.store.draft; }

  focus() { this.input.focus({ preventScroll: true }); }

  /** The selected entry (or null when the cursor is on a block / an unchecked cell). */
  currentEntry() {
    if (!this.entries) return null;
    const { index, dir } = this.session;
    if (this.draft.cells[index] === BLOCK) return null;
    return entryAt(this.entries, index, dir);
  }

  // ---- rendering ---------------------------------------------------------

  #build() {
    const d = this.draft;
    this.gridEl.replaceChildren();
    this.cellEls = [];
    this.gridEl.style.setProperty('--cols', d.width);
    this.gridEl.style.setProperty('--rows', d.height);
    for (let i = 0; i < d.cells.length; i++) {
      const num = h('span', { class: 'xc-num' });
      const letter = h('span', { class: 'xc-l' });
      const cell = h('div', { class: 'xc', role: 'gridcell', dataset: { i } }, num, letter);
      this.cellEls.push({ cell, num, letter });
      this.gridEl.appendChild(cell);
    }
    this.builtSize = `${d.width}x${d.height}`;
    this.#fit();
  }

  #fit() {
    const d = this.draft;
    if (!d) return;
    const w = this.container.clientWidth;
    const hgt = this.container.clientHeight;
    if (!w || !hgt) return;
    // The grid is n cells + (n − 1) 1px gap lines + a 2px border on each side (see .xw-grid).
    const fit = (space, n) => (space - 4 - (n - 1)) / n;
    const size = Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor(Math.min(fit(w, d.width), fit(hgt, d.height)))));
    this.gridEl.style.setProperty('--cell', `${size}px`);
  }

  /** Sync the DOM with the draft, selection, preview and marks. */
  render() {
    const d = this.draft;
    if (!d) return;
    if (this.builtSize !== `${d.width}x${d.height}`) this.#build();
    if (this.session.index >= d.cells.length) this.session.index = 0;
    this.entries = computeEntries({ width: d.width, height: d.height, cells: d.cells });
    this.#fixDirection();
    const { numbers } = this.entries;
    const locked = new Set(d.locked);
    const circles = new Set(d.circles);
    const shaded = new Set(d.shaded);
    const current = this.currentEntry();
    const inWord = new Set(current ? current.cells : []);
    const previewAt = new Map();
    if (this.preview) this.preview.cells.forEach((i, k) => previewAt.set(i, this.preview.word[k]));

    for (let i = 0; i < d.cells.length; i++) {
      const { cell, num, letter } = this.cellEls[i];
      const ch = d.cells[i];
      const isBlock = ch === BLOCK;
      const pv = previewAt.get(i);
      const cls = ['xc'];
      if (isBlock) cls.push('block');
      else {
        if (inWord.has(i)) cls.push('word');
        if (isLetter(ch)) cls.push(locked.has(i) ? 'locked' : 'auto');
        if (circles.has(i)) cls.push('circle');
        if (shaded.has(i)) cls.push('shaded');
        if (pv && pv !== ch) cls.push('preview');
        if (this.marks.problem.has(i)) cls.push('problem');
        if (this.marks.hint.has(i)) cls.push('hint');
        if (this.marks.issue.has(i)) cls.push('issue');
      }
      if (i === this.session.index) cls.push('sel');
      const className = cls.join(' ');
      if (cell.className !== className) cell.className = className;
      const n = !isBlock && numbers[i] ? String(numbers[i]) : '';
      if (num.textContent !== n) num.textContent = n;
      const shown = isBlock ? '' : (pv || ch || '');
      if (letter.textContent !== shown) letter.textContent = shown;
    }
    this.root.classList.toggle('readonly', this.readOnly);
    this.root.dataset.mode = this.session.mode;
  }

  /** If the cursor's cell has no entry in the current direction but has one in the other, switch. */
  #fixDirection() {
    const { index, dir } = this.session;
    const { acrossAt, downAt } = this.entries;
    if (dir === 'across' && acrossAt[index] < 0 && downAt[index] >= 0) this.session.dir = 'down';
    else if (dir === 'down' && downAt[index] < 0 && acrossAt[index] >= 0) this.session.dir = 'across';
  }

  /** Show `word` in `entry`'s cells without changing the draft (hover preview); setPreview(null) clears it. */
  setPreview(entry, word) {
    const next = entry && word && word.length === entry.cells.length ? { cells: entry.cells, word } : null;
    if (!next && !this.preview) return;
    this.preview = next;
    this.render();
  }

  /** marks: { problem?, hint?, issue? } — iterables of cell indices (missing keys are cleared). */
  setMarks(marks = {}) {
    this.marks = {
      problem: new Set(marks.problem || []),
      hint: new Set(marks.hint || []),
      issue: new Set(marks.issue || []),
    };
    this.render();
  }

  /**
   * Set (or clear, with no cells) one kind of mark and keep the others — hover highlights must not wipe out the
   * "problem" marks of a failed fill.
   */
  setMark(kind, cells = []) {
    const next = new Set(cells);
    if (!next.size && !this.marks[kind].size) return;
    this.marks = { ...this.marks, [kind]: next };
    this.render();
  }

  /** Drop transient hover state (preview word, hint / issue highlights), e.g. when the hovered list is rebuilt. */
  clearHover() {
    const had = this.preview || this.marks.hint.size || this.marks.issue.size;
    this.preview = null;
    this.marks = { ...this.marks, hint: new Set(), issue: new Set() };
    if (had) this.render();
  }

  setMode(mode) {
    this.session.mode = mode;
    this.render();
  }

  // ---- selection ---------------------------------------------------------

  select(index, dir = this.session.dir) {
    const prev = `${this.session.index}:${this.session.dir}`;
    this.session.index = index;
    this.session.dir = dir;
    // A hover preview belongs to the previously selected word's candidate list.
    if (prev !== `${index}:${dir}`) this.preview = null;
    this.render();
    if (prev !== `${this.session.index}:${this.session.dir}`) this.onSelect(this.currentEntry());
  }

  /** Select an entry; the cursor goes to its first empty cell (or first cell). */
  selectEntry(entry, { focus = false } = {}) {
    if (!entry) return;
    const d = this.draft;
    const target = entry.cells.find((i) => !isLetter(d.cells[i])) ?? entry.cells[0];
    this.select(target, entry.dir);
    if (focus) this.focus();
    this.#scrollIntoView(target);
  }

  #scrollIntoView(i) {
    this.cellEls[i]?.cell.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  #move(dr, dc) {
    const d = this.draft;
    const r = Math.floor(this.session.index / d.width) + dr;
    const c = (this.session.index % d.width) + dc;
    if (r < 0 || c < 0 || r >= d.height || c >= d.width) return;
    this.select(r * d.width + c);
  }

  /** Move within the current entry by `step` cells (stays put at the ends). */
  #stepInEntry(step) {
    const e = this.currentEntry();
    if (!e) return false;
    const k = e.cells.indexOf(this.session.index);
    const next = e.cells[k + step];
    if (next === undefined) return false;
    this.select(next, e.dir);
    return true;
  }

  #nextEntry(step) {
    const all = this.entries.all;
    if (!all.length) return;
    const cur = this.currentEntry();
    let k = cur ? all.indexOf(cur) : -1;
    k = (k + step + all.length) % all.length;
    this.selectEntry(all[k]);
  }

  // ---- editing -----------------------------------------------------------

  #edit(label, fn) {
    if (this.readOnly) return false;
    this.store.update(fn, { kind: 'grid', label });
    return true;
  }

  typeLetter(letter) {
    const i = this.session.index;
    if (!this.#edit(`type ${letter}`, (d) => setLetter(d, i, letter))) return;
    this.render();
    this.#stepInEntry(1);
  }

  #toggleBlockAt(i) {
    this.#edit(this.draft.cells[i] === BLOCK ? 'remove block' : 'add block', (d) => toggleBlock(d, i));
  }

  #toggleDecorationAt(key, i) {
    if (this.draft.cells[i] === BLOCK) return;
    this.#edit(key === 'circles' ? 'circle' : 'shading', (d) => toggleDecoration(d, key, i));
  }

  #backspace() {
    const d = this.draft;
    const i = this.session.index;
    if (isLetter(d.cells[i])) {
      this.#edit('delete letter', (dd) => clearCell(dd, i));
      return;
    }
    if (this.#stepInEntry(-1)) {
      const j = this.session.index;
      if (isLetter(d.cells[j])) this.#edit('delete letter', (dd) => clearCell(dd, j));
    }
  }

  // ---- input handlers ----------------------------------------------------

  #onPointer(e) {
    const cellEl = e.target.closest('.xc');
    if (!cellEl) return;
    this.afterLetter = false;
    e.preventDefault(); // keep focus on the hidden input
    const i = Number(cellEl.dataset.i);
    const d = this.draft;
    const mode = this.session.mode;
    if (mode === 'blocks') {
      this.#toggleBlockAt(i);
      this.select(i);
    } else if (mode === 'circles' || mode === 'shaded') {
      this.#toggleDecorationAt(mode, i);
      this.select(i);
    } else if (i === this.session.index && d.cells[i] !== BLOCK) {
      this.select(i, this.session.dir === 'across' ? 'down' : 'across');
    } else {
      this.select(i);
    }
    this.focus();
  }

  #onInput() {
    // Virtual keyboards (tablets) may not send usable keydown events; read what was typed instead.
    const letters = this.input.value.toUpperCase().replace(/[^A-Z]/g, '');
    this.input.value = '';
    for (const ch of letters) this.typeLetter(ch);
  }

  #onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // shortcuts (undo …) are handled globally
    const key = e.key;
    if (key === 'Shift' || key === 'CapsLock') return; // typing capitals is still "typing letters"
    let handled = true;
    const afterLetter = this.afterLetter;
    this.afterLetter = false;
    if (/^[a-zA-Z]$/.test(key)) {
      this.typeLetter(key.toUpperCase());
      this.afterLetter = true;
    } else if (key === ' ' && afterLetter) {
      // Typing a phrase: the space between words is dropped, like in theme answers. A second Space toggles.
    } else if (key === '.') {
      this.#toggleBlockAt(this.session.index);
      this.render();
      this.#move(...(this.session.dir === 'across' ? [0, 1] : [1, 0]));
    } else if (key === 'Backspace') this.#backspace();
    else if (key === 'Delete') {
      const i = this.session.index;
      if (isLetter(this.draft.cells[i])) this.#edit('delete letter', (d) => clearCell(d, i));
    } else if (key.startsWith('Arrow')) {
      const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
      const want = horizontal ? 'across' : 'down';
      if (this.session.dir !== want && this.draft.cells[this.session.index] !== BLOCK && this.#hasEntry(want)) {
        this.select(this.session.index, want);
      } else {
        const delta = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[key];
        this.session.dir = want;
        this.#move(...delta);
      }
    } else if (key === 'Tab') this.#nextEntry(e.shiftKey ? -1 : 1);
    else if (key === ' ') this.select(this.session.index, this.session.dir === 'across' ? 'down' : 'across');
    else if (key === 'Enter') {
      if (this.session.mode === 'circles' || this.session.mode === 'shaded') this.#toggleDecorationAt(this.session.mode, this.session.index);
      else if (this.session.mode === 'blocks') this.#toggleBlockAt(this.session.index);
      else handled = false;
    } else if (key === 'Home' || key === 'End') {
      const ent = this.currentEntry();
      if (ent) this.select(key === 'Home' ? ent.cells[0] : ent.cells.at(-1));
    } else if (key === 'Escape') this.input.blur();
    else handled = false;
    if (handled) e.preventDefault();
  }

  #hasEntry(dir) {
    const i = this.session.index;
    return dir === 'across' ? this.entries.acrossAt[i] >= 0 : this.entries.downAt[i] >= 0;
  }
}
