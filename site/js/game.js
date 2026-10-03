// Puzzle-solving state and input logic (DOM-free, unit-tested in tests/unit/site-game.test.js).
//
// A Game wraps a loaded puzzle (from loadPuzzle() in shared/puzzle.js) plus the solver's progress:
//   letters[i]   '' or 'A'..'Z' per cell ('' for blocks)
//   marks[i]     '' | 'wrong' (currently flagged by a check) | 'revealed' (locked)
//   everWrong    Set of cells that were ever flagged wrong (drives 🟨 in the share grid)
//   checks       number of check actions used; reveals = number of squares revealed
// and the selection (active cell + direction).
//
// Views subscribe with on(fn); fn(type, detail) is called with
//   'select'       selection changed
//   'letters'      letters and/or marks changed (detail.cells = changed cells)
//   'solved'       the grid was just completed correctly
//                  (detail.source = 'type' | 'check' | 'reveal' | 'reveal-puzzle' | 'restore' | …)
//   'filled-wrong' every square is filled but something is wrong

const OTHER = { across: 'down', down: 'across' };
const LETTER_RE = /^[A-Z]$/;

export class Game {
  /**
   * @param {object} puzzle   result of loadPuzzle()
   * @param {object} [progress] normalized progress ({ letters, marks, everWrong, checks, reveals, solved })
   * @param {{ readOnly?: boolean }} [opts]
   */
  constructor(puzzle, progress = null, { readOnly = false } = {}) {
    this.p = puzzle;
    this.size = puzzle.width * puzzle.height;
    this.order = [...puzzle.across, ...puzzle.down]; // Tab / auto-advance order
    this.readOnly = readOnly;
    const okArray = (a) => Array.isArray(a) && a.length === this.size;
    this.letters = okArray(progress?.letters) ? progress.letters.slice() : new Array(this.size).fill('');
    this.marks = okArray(progress?.marks) ? progress.marks.slice() : new Array(this.size).fill('');
    this.everWrong = new Set(progress?.everWrong || []);
    this.checks = progress?.checks || 0;
    this.reveals = progress?.reveals || 0;
    this.solved = Boolean(progress?.solved);
    this.listeners = new Set();
    this.dir = 'across';
    this.cell = -1;
    const start = this.nextIncomplete(null) || this.order[0];
    if (start) this.selectEntry(start, { silent: true });
  }

  // -- events ---------------------------------------------------------------

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, detail = {}) {
    for (const fn of this.listeners) fn(type, detail);
  }

  // -- queries --------------------------------------------------------------

  isBlock(i) { return Boolean(this.p.isBlock[i]); }
  isLocked(i) { return this.marks[i] === 'revealed'; }
  /** Can the solver change this cell right now? */
  canEdit(i) { return !this.solved && !this.readOnly && i >= 0 && !this.isBlock(i) && !this.isLocked(i); }

  entryAt(i, dir) {
    if (i < 0 || i >= this.size) return null;
    const k = dir === 'across' ? this.p.acrossAt[i] : this.p.downAt[i];
    return k >= 0 ? (dir === 'across' ? this.p.across[k] : this.p.down[k]) : null;
  }

  /** The active entry (the "word" being solved). */
  get entry() { return this.entryAt(this.cell, this.dir); }
  /** The crossing entry through the active cell. */
  get crossEntry() { return this.entryAt(this.cell, OTHER[this.dir]); }

  isEntryFilled(entry) { return entry.cells.every((i) => this.letters[i] !== ''); }
  firstEmpty(entry) { return entry.cells.find((i) => this.letters[i] === '') ?? null; }

  whiteCells() {
    const out = [];
    for (let i = 0; i < this.size; i++) if (!this.isBlock(i)) out.push(i);
    return out;
  }

  filledCount() { return this.whiteCells().filter((i) => this.letters[i] !== '').length; }
  isFull() { return this.whiteCells().every((i) => this.letters[i] !== ''); }
  isCorrect() { return this.whiteCells().every((i) => this.letters[i] === this.p.solution[i]); }

  /** First entry after `from` (in across-then-down order, wrapping) that still has an empty cell. */
  nextIncomplete(from) {
    const n = this.order.length;
    const start = from ? this.order.indexOf(from) : -1;
    for (let k = 1; k <= n; k++) {
      const e = this.order[(start + k + n) % n];
      if (e && !this.isEntryFilled(e)) return e;
    }
    return null;
  }

  /** Cells covered by a hint scope: 'square' | 'word' | 'puzzle'. */
  scopeCells(scope) {
    if (scope === 'square') return this.cell >= 0 ? [this.cell] : [];
    if (scope === 'word') return this.entry ? this.entry.cells.slice() : [];
    return this.whiteCells();
  }

  /**
   * Replace the solving state with a (normalized) progress record — e.g. one saved by another tab.
   * Keeps the selection. Emits 'letters' (detail.restore = true), never 'solved'.
   */
  restore(progress) {
    const okArray = (a) => Array.isArray(a) && a.length === this.size;
    const wasEmpty = this.cell >= 0 && this.letters[this.cell] === '';
    if (okArray(progress?.letters)) this.letters = progress.letters.slice();
    if (okArray(progress?.marks)) this.marks = progress.marks.slice();
    this.everWrong = new Set(progress?.everWrong || []);
    this.checks = progress?.checks || 0;
    this.reveals = progress?.reveals || 0;
    this.solved = this.solved || Boolean(progress?.solved);
    this.emit('letters', { cells: this.whiteCells(), restore: true });
    // The active square was filled meanwhile (in another tab): move on as if it had been typed here, so the
    // next letter doesn't overwrite it.
    const e = this.entry;
    if (wasEmpty && this.letters[this.cell] !== '' && e && !this.solved) {
      const next = this.firstEmpty(e);
      if (next != null) this.cell = next;
      else this._jumpToNextIncomplete(e);
      this.emit('select');
    }
  }

  /**
   * Complete the puzzle if every square is filled correctly but it is not marked solved yet (e.g. progress
   * restored after the puzzle was re-published with a fixed answer). Returns true when it just got solved.
   */
  completeIfSolved(source = 'restore') {
    if (this.solved || this.readOnly || !this.isFull() || !this.isCorrect()) return false;
    this.solved = true;
    this.emit('solved', { source });
    return true;
  }

  /** Snapshot for persistence (merged into the progress record by the caller). */
  toProgress() {
    return {
      letters: this.letters.slice(),
      marks: this.marks.slice(),
      everWrong: [...this.everWrong].sort((a, b) => a - b),
      checks: this.checks,
      reveals: this.reveals,
      solved: this.solved,
    };
  }

  // -- selection ------------------------------------------------------------

  /** Select a cell; keeps the direction unless the cell has no entry that way. */
  select(i, dir = this.dir, { silent = false } = {}) {
    if (i < 0 || i >= this.size || this.isBlock(i)) return;
    let d = dir;
    if (!this.entryAt(i, d) && this.entryAt(i, OTHER[d])) d = OTHER[d];
    if (i === this.cell && d === this.dir) return;
    this.cell = i;
    this.dir = d;
    if (!silent) this.emit('select');
  }

  /** Click/tap on a cell: re-tapping the active cell toggles direction. */
  tapCell(i) {
    if (i === this.cell) this.toggleDir();
    else this.select(i);
  }

  toggleDir() {
    const other = OTHER[this.dir];
    if (!this.entryAt(this.cell, other)) return;
    this.dir = other;
    this.emit('select');
  }

  /** Select an entry, at `cell` or its first empty cell (or its first cell when full). */
  selectEntry(entry, { cell = null, silent = false } = {}) {
    if (!entry) return;
    const target = cell ?? this.firstEmpty(entry) ?? entry.cells[0];
    this.cell = target;
    this.dir = entry.dir;
    if (!silent) this.emit('select');
  }

  /** Next/previous entry in across-then-down order (Tab / Shift+Tab / clue-bar arrows). */
  stepEntry(step = 1) {
    const n = this.order.length;
    if (!n) return;
    const cur = this.entry;
    const k = cur ? this.order.indexOf(cur) : -1;
    const next = this.order[(((k + step) % n) + n) % n];
    this.selectEntry(next);
  }

  /** Arrow keys: a perpendicular arrow first switches direction, otherwise move (skipping blocks). */
  move(dRow, dCol) {
    const axis = dCol !== 0 ? 'across' : 'down';
    if (axis !== this.dir && this.entryAt(this.cell, axis)) {
      this.dir = axis;
      this.emit('select');
      return;
    }
    const { width, height } = this.p;
    let r = Math.floor(this.cell / width) + dRow;
    let c = (this.cell % width) + dCol;
    while (r >= 0 && c >= 0 && r < height && c < width) {
      const i = r * width + c;
      if (!this.isBlock(i)) {
        this.select(i, axis);
        return;
      }
      r += dRow;
      c += dCol;
    }
  }

  // -- editing --------------------------------------------------------------

  _setLetter(i, ch) {
    this.letters[i] = ch;
    if (this.marks[i] === 'wrong') this.marks[i] = ''; // the flagged letter was changed
  }

  /** Type a letter into the active cell and advance (SPEC §6 "Input — desktop"). */
  type(letter) {
    const ch = String(letter || '').toUpperCase();
    if (!LETTER_RE.test(ch) || this.solved || this.readOnly || this.cell < 0) return;
    const i = this.cell;
    const e = this.entry;
    const wasFull = e ? this.isEntryFilled(e) : false;
    let changed = false;
    if (this.canEdit(i) && this.letters[i] !== ch) {
      this._setLetter(i, ch);
      changed = true;
    }

    // Advance.
    if (e) {
      const pos = e.cells.indexOf(i);
      if (wasFull) {
        // Overwriting inside a complete word: step to the next square; at its end move on.
        if (pos < e.cells.length - 1) this.cell = e.cells[pos + 1];
        else this._jumpToNextIncomplete(e);
      } else {
        // Next empty square in this word (wrapping), else the next unfinished word.
        const after = [...e.cells.slice(pos + 1), ...e.cells.slice(0, pos)];
        const nextEmpty = after.find((j) => this.letters[j] === '');
        if (nextEmpty !== undefined) this.cell = nextEmpty;
        else this._jumpToNextIncomplete(e);
      }
    }
    if (changed) this.emit('letters', { cells: [i] });
    this.emit('select');
    if (changed) this._afterLettersChanged('type');
    else this.completeIfSolved('type'); // retyping a letter on a full, correct grid still finishes it
  }

  _jumpToNextIncomplete(from) {
    const next = this.nextIncomplete(from);
    if (next) {
      this.cell = this.firstEmpty(next) ?? next.cells[0];
      this.dir = next.dir;
    }
  }

  /** Backspace: clear the active square, or (if empty) move back one square and clear that. */
  backspace() {
    if (this.solved || this.readOnly || this.cell < 0) return;
    const i = this.cell;
    if (this.canEdit(i) && this.letters[i] !== '') {
      this._setLetter(i, '');
      this.emit('letters', { cells: [i] });
      return;
    }
    const e = this.entry;
    if (!e) return;
    const pos = e.cells.indexOf(i);
    let target;
    if (pos > 0) {
      target = e.cells[pos - 1];
    } else {
      // At the start of a word: continue at the end of the previous word.
      const n = this.order.length;
      const prev = this.order[(this.order.indexOf(e) - 1 + n) % n];
      this.dir = prev.dir;
      target = prev.cells[prev.cells.length - 1];
    }
    this.cell = target;
    const cleared = this.canEdit(target) && this.letters[target] !== '';
    if (cleared) {
      this._setLetter(target, '');
      this.emit('letters', { cells: [target] });
    }
    this.emit('select');
  }

  /** Delete: clear the active square without moving. */
  del() {
    const i = this.cell;
    if (!this.canEdit(i) || this.letters[i] === '') return;
    this._setLetter(i, '');
    this.emit('letters', { cells: [i] });
  }

  // -- hints ----------------------------------------------------------------

  /** Flag wrong letters in scope. Returns { checked, wrong } (checked = filled squares examined). */
  check(scope) {
    if (this.solved || this.readOnly) return { checked: 0, wrong: 0 };
    let checked = 0;
    const wrongCells = [];
    for (const i of this.scopeCells(scope)) {
      if (this.isBlock(i) || this.isLocked(i) || this.letters[i] === '') continue;
      checked++;
      if (this.letters[i] !== this.p.solution[i]) {
        this.marks[i] = 'wrong';
        this.everWrong.add(i);
        wrongCells.push(i);
      }
    }
    if (checked > 0) {
      this.checks++;
      this.emit('letters', { cells: wrongCells, hint: 'check' });
    }
    if (!wrongCells.length) this.completeIfSolved('check');
    return { checked, wrong: wrongCells.length };
  }

  /**
   * Fill correct letters in scope, mark them revealed (locked). Returns { revealed, confirmed }.
   * When nothing needed revealing but the scope held letters the solver typed, the reveal has told them
   * those letters are right: that is counted as a check (`confirmed` = how many such squares), so a
   * reveal is never a free check.
   */
  reveal(scope) {
    if (this.solved || this.readOnly) return { revealed: 0, confirmed: 0 };
    const changed = [];
    let typedRight = 0;
    for (const i of this.scopeCells(scope)) {
      if (this.isBlock(i)) continue;
      if (this.letters[i] === this.p.solution[i]) {
        if (!this.isLocked(i)) typedRight++;
        continue;
      }
      this.letters[i] = this.p.solution[i];
      this.marks[i] = 'revealed';
      changed.push(i);
    }
    if (!changed.length) {
      if (typedRight) {
        this.checks++;
        this.emit('letters', { cells: [], hint: 'check' });
      }
      this.completeIfSolved('reveal');
      return { revealed: 0, confirmed: typedRight };
    }
    this.reveals += changed.length;
    this.emit('letters', { cells: changed, hint: 'reveal' });
    // Move off a now-locked square to the next empty one in the word, if any.
    const e = this.entry;
    if (e && scope !== 'puzzle' && this.isLocked(this.cell)) {
      const next = this.firstEmpty(e);
      if (next != null) { this.cell = next; this.emit('select'); }
    }
    this._afterLettersChanged(scope === 'puzzle' ? 'reveal-puzzle' : 'reveal');
    return { revealed: changed.length, confirmed: 0 };
  }

  _afterLettersChanged(source) {
    if (this.solved || !this.isFull()) return;
    if (this.isCorrect()) {
      this.solved = true;
      this.emit('solved', { source });
    } else {
      this.emit('filled-wrong', { source });
    }
  }
}
