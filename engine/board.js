// Board: mutable block-pattern state used by the layout generator (layout.js).
//
// Every cell is a block or white. White cells may be "required" (they hold a theme letter, or are the symmetric
// partner of such a cell, so they can never become blocks) and may carry a theme letter. Blocks are always set in
// symmetric pairs. The invariant the generator maintains is: every maximal run of white cells, in both
// directions, is either 0 or ≥ 3 long — which makes every entry ≥ 3 letters and every white cell checked.

import { symmetricIndex } from '../site/shared/grid.js';

export class Board {
  constructor(width, height, symmetry = 'rotational') {
    this.W = width;
    this.H = height;
    this.n = width * height;
    this.symmetry = symmetry;
    this.block = new Uint8Array(this.n);
    this.req = new Uint8Array(this.n);
    this.letter = new Array(this.n).fill('');
    /** Theme index occupying the cell in each direction (-1 = none). */
    this.themeA = new Int16Array(this.n).fill(-1);
    this.themeD = new Int16Array(this.n).fill(-1);
    this.partner = new Int32Array(this.n);
    const g = { width, height, cells: [] };
    for (let i = 0; i < this.n; i++) this.partner[i] = symmetricIndex(g, i, symmetry);
    this.blocks = 0;
  }

  clone() {
    const b = Object.create(Board.prototype);
    b.W = this.W;
    b.H = this.H;
    b.n = this.n;
    b.symmetry = this.symmetry;
    b.block = this.block.slice();
    b.req = this.req.slice();
    b.letter = this.letter.slice();
    b.themeA = this.themeA.slice();
    b.themeD = this.themeD.slice();
    b.partner = this.partner; // immutable, shared
    b.blocks = this.blocks;
    return b;
  }

  /** Make cell i (and its partner) a block. False if either must stay white. */
  setBlock(i) {
    const p = this.partner[i];
    if (this.req[i] || this.req[p]) return false;
    if (!this.block[i]) { this.block[i] = 1; this.blocks++; }
    if (!this.block[p]) { this.block[p] = 1; this.blocks++; }
    return true;
  }

  /** Mark cell i (and its partner) as required white. False if either is a block. */
  require(i) {
    const p = this.partner[i];
    if (this.block[i] || this.block[p]) return false;
    this.req[i] = 1;
    this.req[p] = 1;
    return true;
  }

  isBlockRC(r, c) {
    return r < 0 || c < 0 || r >= this.H || c >= this.W || this.block[r * this.W + c] === 1;
  }

  /** Cells of a slot. */
  slotCells(r, c, dir, len) {
    const out = new Array(len);
    for (let k = 0; k < len; k++) out[k] = dir === 'across' ? r * this.W + c + k : (r + k) * this.W + c;
    return out;
  }

  /**
   * Block every white run shorter than 3 (they can only be fixed by blocking them, since blocks are never removed).
   * Repeats until stable. False if such a run contains a required cell.
   */
  repairShortRuns() {
    const { W, H } = this;
    for (let changed = true; changed;) {
      changed = false;
      for (let pass = 0; pass < 2; pass++) {
        const lines = pass === 0 ? H : W;
        const len = pass === 0 ? W : H;
        for (let a = 0; a < lines; a++) {
          let start = -1;
          for (let b = 0; b <= len; b++) {
            const i = b < len ? (pass === 0 ? a * W + b : b * W + a) : -1;
            const white = i >= 0 && !this.block[i];
            if (white && start < 0) start = b;
            if (!white && start >= 0) {
              const runLen = b - start;
              if (runLen < 3) {
                for (let k = start; k < b; k++) {
                  const j = pass === 0 ? a * W + k : k * W + a;
                  if (!this.setBlock(j)) return false;
                }
                changed = true;
              }
              start = -1;
            }
          }
        }
      }
    }
    return true;
  }

  /** True if all white cells are 4-connected. */
  isConnected() {
    const { n, W, H } = this;
    let start = -1;
    let whites = 0;
    for (let i = 0; i < n; i++) if (!this.block[i]) { whites++; if (start < 0) start = i; }
    if (whites === 0) return false;
    const seen = new Uint8Array(n);
    const stack = [start];
    seen[start] = 1;
    let count = 0;
    while (stack.length) {
      const i = stack.pop();
      count++;
      const r = (i / W) | 0;
      const c = i - r * W;
      if (c > 0 && !this.block[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (c < W - 1 && !this.block[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (r > 0 && !this.block[i - W] && !seen[i - W]) { seen[i - W] = 1; stack.push(i - W); }
      if (r < H - 1 && !this.block[i + W] && !seen[i + W]) { seen[i + W] = 1; stack.push(i + W); }
    }
    return count === whites;
  }

  /** Grid cells: '#' blocks, theme letters, '' elsewhere. */
  toCells() {
    const out = new Array(this.n);
    for (let i = 0; i < this.n; i++) out[i] = this.block[i] ? '#' : this.letter[i];
    return out;
  }
}
