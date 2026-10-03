// Shared grid model. Used by the player site, the builder, the fill engine and the dev server.
// Pure ES module, no DOM / Node APIs, so it runs in browsers, web workers and Node.
//
// A grid is { width, height, cells } where `cells` is a row-major array of length width*height.
// Each cell is one of:
//   '#'        a block (black square)
//   ''         an empty white cell
//   'A'..'Z'   a white cell containing a letter

export const BLOCK = '#';
export const EMPTY = '';

export function makeGrid(width, height, fill = EMPTY) {
  return { width, height, cells: new Array(width * height).fill(fill) };
}

export function cloneGrid(grid) {
  return { width: grid.width, height: grid.height, cells: grid.cells.slice() };
}

export function toIndex(grid, row, col) {
  return row * grid.width + col;
}

export function toRowCol(grid, index) {
  return [Math.floor(index / grid.width), index % grid.width];
}

export function inBounds(grid, row, col) {
  return row >= 0 && col >= 0 && row < grid.height && col < grid.width;
}

/** True for blocks AND for positions outside the grid (edges behave like blocks). */
export function isBlockAt(grid, row, col) {
  return !inBounds(grid, row, col) || grid.cells[row * grid.width + col] === BLOCK;
}

export function isLetter(ch) {
  return typeof ch === 'string' && ch.length === 1 && ch >= 'A' && ch <= 'Z';
}

/**
 * Number the grid and list its entries (runs of >= 2 white cells), in standard crossword order.
 *
 * Returns {
 *   numbers: number[]   per cell; 0 = unnumbered
 *   across:  Entry[]    sorted by number
 *   down:    Entry[]    sorted by number
 *   all:     Entry[]    across then down
 *   acrossAt: number[]  per cell: index into `across` of the across entry covering it, or -1
 *   downAt:   number[]  per cell: index into `down` of the down entry covering it, or -1
 * }
 * Entry = { id: '1A' | '1D', num, dir: 'across' | 'down', row, col, length, cells: number[] (flat indices) }
 *
 * Runs of a single white cell are not entries (that cell is "unchecked" in that direction).
 */
export function computeEntries(grid) {
  const { width, height } = grid;
  const size = width * height;
  const numbers = new Array(size).fill(0);
  const acrossAt = new Array(size).fill(-1);
  const downAt = new Array(size).fill(-1);
  const across = [];
  const down = [];
  let n = 0;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (isBlockAt(grid, r, c)) continue;
      const startsAcross = isBlockAt(grid, r, c - 1) && !isBlockAt(grid, r, c + 1);
      const startsDown = isBlockAt(grid, r - 1, c) && !isBlockAt(grid, r + 1, c);
      if (!startsAcross && !startsDown) continue;
      n++;
      numbers[r * width + c] = n;
      if (startsAcross) {
        const cells = [];
        for (let cc = c; !isBlockAt(grid, r, cc); cc++) cells.push(r * width + cc);
        for (const i of cells) acrossAt[i] = across.length;
        across.push({ id: `${n}A`, num: n, dir: 'across', row: r, col: c, length: cells.length, cells });
      }
      if (startsDown) {
        const cells = [];
        for (let rr = r; !isBlockAt(grid, rr, c); rr++) cells.push(rr * width + c);
        for (const i of cells) downAt[i] = down.length;
        down.push({ id: `${n}D`, num: n, dir: 'down', row: r, col: c, length: cells.length, cells });
      }
    }
  }
  return { numbers, across, down, all: [...across, ...down], acrossAt, downAt };
}

/** Pattern of an entry: letters as-is, empty cells as '.', e.g. "C.T". */
export function entryPattern(grid, entry) {
  let s = '';
  for (const i of entry.cells) {
    const ch = grid.cells[i];
    s += isLetter(ch) ? ch : '.';
  }
  return s;
}

/** The entry's word if every cell holds a letter, else null. */
export function entryWord(grid, entry) {
  const p = entryPattern(grid, entry);
  return p.includes('.') ? null : p;
}

/**
 * Index of the cell symmetric to `index` under the given symmetry:
 *   'rotational' — 180° rotation (standard American crosswords)
 *   'mirror'     — left/right mirror
 *   'none'       — returns `index` itself
 */
export function symmetricIndex(grid, index, symmetry = 'rotational') {
  const [r, c] = toRowCol(grid, index);
  if (symmetry === 'rotational') return toIndex(grid, grid.height - 1 - r, grid.width - 1 - c);
  if (symmetry === 'mirror') return toIndex(grid, r, grid.width - 1 - c);
  return index;
}

/** True if the block pattern is symmetric under `symmetry` ('none' is always true). */
export function isSymmetric(grid, symmetry = 'rotational') {
  if (symmetry === 'none') return true;
  for (let i = 0; i < grid.cells.length; i++) {
    const j = symmetricIndex(grid, i, symmetry);
    if ((grid.cells[i] === BLOCK) !== (grid.cells[j] === BLOCK)) return false;
  }
  return true;
}

/** Groups of connected white cells (4-neighbour). Returns an array of arrays of flat indices. */
export function whiteRegions(grid) {
  const seen = new Uint8Array(grid.cells.length);
  const regions = [];
  for (let start = 0; start < grid.cells.length; start++) {
    if (seen[start] || grid.cells[start] === BLOCK) continue;
    const region = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      region.push(i);
      const [r, c] = toRowCol(grid, i);
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const rr = r + dr, cc = c + dc;
        if (isBlockAt(grid, rr, cc)) continue;
        const j = rr * grid.width + cc;
        if (!seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    regions.push(region);
  }
  return regions;
}

/**
 * Check a grid for construction problems. Returns an array of issues:
 *   { type, severity: 'error' | 'warning', message, cells: number[] }
 * Types:
 *   'invalid-cell'  a cell value that is not '#', '' or A-Z                       (error)
 *   'empty-cell'    a white cell without a letter (only if opts.requireFilled)    (error)
 *   'short-entry'   an entry shorter than opts.minLength (default 3)              (error)
 *   'unchecked'     a white cell that belongs to only one entry (or none)         (warning, or error if opts.requireChecked)
 *   'disconnected'  white cells split into more than one region                   (error)
 *   'asymmetric'    block pattern breaks opts.symmetry                            (warning)
 *   'no-entries'    grid has no entries at all                                    (error)
 */
export function validateGrid(grid, opts = {}) {
  const { minLength = 3, requireFilled = false, requireChecked = false, symmetry = 'none' } = opts;
  const issues = [];
  const bad = [];
  const empty = [];
  grid.cells.forEach((ch, i) => {
    if (ch === BLOCK) return;
    if (ch === EMPTY) empty.push(i);
    else if (!isLetter(ch)) bad.push(i);
  });
  if (bad.length) issues.push({ type: 'invalid-cell', severity: 'error', message: `${bad.length} cell(s) contain invalid characters`, cells: bad });
  if (requireFilled && empty.length) issues.push({ type: 'empty-cell', severity: 'error', message: `${empty.length} white cell(s) are empty`, cells: empty });

  const { all, acrossAt, downAt } = computeEntries(grid);
  if (!all.length) issues.push({ type: 'no-entries', severity: 'error', message: 'The grid has no entries', cells: [] });
  for (const e of all) {
    if (e.length < minLength) {
      issues.push({ type: 'short-entry', severity: 'error', message: `${e.id} is only ${e.length} letter(s) (minimum ${minLength})`, cells: e.cells });
    }
  }
  const unchecked = [];
  grid.cells.forEach((ch, i) => {
    if (ch !== BLOCK && (acrossAt[i] < 0 || downAt[i] < 0)) unchecked.push(i);
  });
  if (unchecked.length) {
    issues.push({
      type: 'unchecked',
      severity: requireChecked ? 'error' : 'warning',
      message: `${unchecked.length} cell(s) belong to only one entry`,
      cells: unchecked,
    });
  }
  const regions = whiteRegions(grid);
  if (regions.length > 1) {
    const smaller = regions.sort((a, b) => b.length - a.length).slice(1).flat();
    issues.push({ type: 'disconnected', severity: 'error', message: `White squares form ${regions.length} separate areas`, cells: smaller });
  }
  if (symmetry !== 'none' && !isSymmetric(grid, symmetry)) {
    issues.push({ type: 'asymmetric', severity: 'warning', message: `Block pattern is not ${symmetry}-symmetric`, cells: [] });
  }
  return issues;
}

/** Build a grid from layout rows ('#' block, anything else white) and an optional flat solution string. */
export function gridFromLayout(layout, solution = null) {
  const height = layout.length;
  const width = height ? layout[0].length : 0;
  const cells = [];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const i = r * width + c;
      if (layout[r][c] === BLOCK) cells.push(BLOCK);
      else cells.push(solution && isLetter(solution[i]) ? solution[i] : EMPTY);
    }
  }
  return { width, height, cells };
}

/** Layout rows for a grid: '#' for blocks, '.' for white cells. */
export function layoutFromGrid(grid) {
  const rows = [];
  for (let r = 0; r < grid.height; r++) {
    let row = '';
    for (let c = 0; c < grid.width; c++) row += grid.cells[r * grid.width + c] === BLOCK ? BLOCK : '.';
    rows.push(row);
  }
  return rows;
}
