// Small read-only SVG rendering of a grid: layout gallery thumbnails, the Clues tab overview, Schedule cards.

const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/**
 * Render a grid as an SVG element.
 * Options:
 *   cellSize      px per cell in the viewBox (the SVG scales with CSS width)
 *   letters       draw letters (default true)
 *   numbers       per-cell numbers array (from computeEntries) or null
 *   highlight     Set of cell indices drawn in the "theme" colour
 *   active        Set of cell indices drawn in the "active entry" colour
 *   focus         a single cell index drawn in the "selected cell" colour
 *   circles/shaded  arrays or Sets of cell indices
 *   onCellClick   (index) => void — makes cells clickable
 *   label         aria-label
 */
export function miniGrid(grid, opts = {}) {
  const {
    cellSize = 12, letters = true, numbers = null, highlight = null, active = null, focus = -1,
    circles = [], shaded = [], onCellClick = null, label = 'Grid preview',
  } = opts;
  const { width, height, cells } = grid;
  const W = width * cellSize;
  const H = height * cellSize;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mini-grid', role: 'img', 'aria-label': label });
  svg.style.aspectRatio = `${width} / ${height}`;
  const circleSet = new Set(circles);
  const shadedSet = new Set(shaded);
  svg.appendChild(el('rect', { x: 0, y: 0, width: W, height: H, class: 'mg-bg' }));
  for (let i = 0; i < cells.length; i++) {
    const r = Math.floor(i / width);
    const c = i % width;
    const x = c * cellSize;
    const y = r * cellSize;
    const ch = cells[i];
    let cls = 'mg-cell';
    if (ch === '#') cls += ' mg-block';
    else if (i === focus) cls += ' mg-focus';
    else if (active?.has(i)) cls += ' mg-active';
    else if (highlight?.has(i)) cls += ' mg-theme';
    else if (shadedSet.has(i)) cls += ' mg-shaded';
    const rect = el('rect', { x, y, width: cellSize, height: cellSize, class: cls });
    if (onCellClick && ch !== '#') {
      rect.addEventListener('click', () => onCellClick(i));
      rect.style.cursor = 'pointer';
    }
    svg.appendChild(rect);
    if (ch === '#') continue;
    if (circleSet.has(i)) {
      svg.appendChild(el('circle', { cx: x + cellSize / 2, cy: y + cellSize / 2, r: cellSize * 0.46, class: 'mg-circle' }));
    }
    if (numbers && numbers[i]) {
      const t = el('text', { x: x + cellSize * 0.07, y: y + cellSize * 0.3, class: 'mg-num', 'font-size': cellSize * 0.28 });
      t.textContent = String(numbers[i]);
      svg.appendChild(t);
    }
    if (letters && ch) {
      const t = el('text', {
        x: x + cellSize / 2,
        y: y + cellSize * (numbers ? 0.8 : 0.74),
        class: 'mg-letter',
        'font-size': cellSize * (numbers ? 0.56 : 0.62),
        'text-anchor': 'middle',
      });
      t.textContent = ch;
      if (onCellClick) t.style.pointerEvents = 'none';
      svg.appendChild(t);
    }
  }
  // Grid lines on top (one path keeps the DOM small).
  let d = '';
  for (let c = 1; c < width; c++) d += `M${c * cellSize} 0V${H}`;
  for (let r = 1; r < height; r++) d += `M0 ${r * cellSize}H${W}`;
  svg.appendChild(el('path', { d, class: 'mg-lines' }));
  svg.appendChild(el('rect', { x: 0.5, y: 0.5, width: W - 1, height: H - 1, class: 'mg-border' }));
  return svg;
}
