// Inline stroke icons (24×24, currentColor). Built with createElementNS from static path data.

import { svg } from './dom.js';

// Each icon: list of [tag, attributes].
const ICONS = {
  pause: [
    ['rect', { x: 6.5, y: 5, width: 3.6, height: 14, rx: 1, fill: 'currentColor', stroke: 'none' }],
    ['rect', { x: 13.9, y: 5, width: 3.6, height: 14, rx: 1, fill: 'currentColor', stroke: 'none' }],
  ],
  play: [['path', { d: 'M8 5.5v13a.8.8 0 0 0 1.2.7l10.3-6.5a.8.8 0 0 0 0-1.4L9.2 4.8A.8.8 0 0 0 8 5.5z', fill: 'currentColor', stroke: 'none' }]],
  calendar: [
    ['rect', { x: 3.5, y: 5, width: 17, height: 15.5, rx: 2.5 }],
    ['path', { d: 'M3.5 10h17M8 3v4M16 3v4' }],
  ],
  bulb: [
    ['path', { d: 'M9 18h6M10 21h4' }],
    ['path', { d: 'M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1.1 2V16h5v-.2c.1-.8.5-1.5 1.1-2A6 6 0 0 0 12 3z' }],
  ],
  list: [['path', { d: 'M9 6h11M9 12h11M9 18h11' }], ['path', { d: 'M4.5 6h.01M4.5 12h.01M4.5 18h.01', 'stroke-width': 2.6 }]],
  share: [
    ['path', { d: 'M12 3v12M7.5 7.5 12 3l4.5 4.5' }],
    ['path', { d: 'M5 12v6.5A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V12' }],
  ],
  chevronLeft: [['path', { d: 'm14.5 5.5-6.5 6.5 6.5 6.5' }]],
  chevronRight: [['path', { d: 'm9.5 5.5 6.5 6.5-6.5 6.5' }]],
  close: [['path', { d: 'M6 6l12 12M18 6 6 18' }]],
  check: [['path', { d: 'm5 12.5 4.5 4.5L19 7.5' }]],
  backspace: [
    ['path', { d: 'M9 5h10.5A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5H9l-6-7z' }],
    ['path', { d: 'm11.5 9.5 5 5M16.5 9.5l-5 5' }],
  ],
  lock: [['rect', { x: 5, y: 10.5, width: 14, height: 10, rx: 2 }], ['path', { d: 'M8 10.5V8a4 4 0 0 1 8 0v2.5' }]],
  offline: [
    ['path', { d: 'M2 8.5a15 15 0 0 1 5-2.7M22 8.5a15 15 0 0 0-11-3.4M5 12.5a10 10 0 0 1 4-2.2M19 12.5a10 10 0 0 0-2.4-1.6M8.5 16a5 5 0 0 1 6 -.6' }],
    ['path', { d: 'M12 20h.01', 'stroke-width': 3 }],
    ['path', { d: 'M3 3l18 18' }],
  ],
  alert: [
    ['path', { d: 'M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z' }],
    ['path', { d: 'M12 9.5v4' }],
    ['path', { d: 'M12 17h.01', 'stroke-width': 2.6 }],
  ],
  grid: [
    ['rect', { x: 3.5, y: 3.5, width: 17, height: 17, rx: 2.5 }],
    ['path', { d: 'M9.2 3.5v17M14.8 3.5v17M3.5 9.2h17M3.5 14.8h17' }],
  ],
  clock: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M12 7.5V12l3 2' }]],
  eye: [
    ['path', { d: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z' }],
    ['circle', { cx: 12, cy: 12, r: 3 }],
  ],
  search: [['circle', { cx: 11, cy: 11, r: 6.5 }], ['path', { d: 'm20 20-4.2-4.2' }]],
  copy: [['rect', { x: 8.5, y: 8.5, width: 12, height: 12, rx: 2 }], ['path', { d: 'M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5' }]],
  refresh: [['path', { d: 'M20 11a8 8 0 0 0-14.6-4.5L3.5 9M4 13a8 8 0 0 0 14.6 4.5l1.9-2.5' }], ['path', { d: 'M3.5 4v5h5M20.5 20v-5h-5' }]],
};

/** An icon element. `size` in px (default 22). Decorative (aria-hidden). */
export function icon(name, { size = 22, strokeWidth = 2, className = '' } = {}) {
  const parts = ICONS[name] || [];
  return svg(
    'svg',
    {
      class: ['icon', className],
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': strokeWidth,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    parts.map(([tag, attrs]) => svg(tag, attrs)),
  );
}
