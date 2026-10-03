// Which puzzle is "today's", which are released, and parsing of hash routes. Pure functions.

import { isValidDateId } from '../shared/puzzle.js';

/** Index entries (from puzzles/index.json) with a valid date, sorted oldest -> newest. */
export function indexEntries(index) {
  const list = Array.isArray(index?.puzzles) ? index.puzzles : [];
  return list
    .filter((p) => p && isValidDateId(p.date))
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** True when a puzzle dated `date` is still locked for a solver whose today is `today`. */
export function isLocked(date, today, preview = false) {
  return !preview && date > today;
}

/** Released puzzles, newest first (all of them in preview mode). */
export function releasedPuzzles(index, today, preview = false) {
  return indexEntries(index).filter((p) => !isLocked(p.date, today, preview)).reverse();
}

/**
 * Today's puzzle: the one dated `today`, else the latest one before it.
 * Returns { entry, isToday } or { entry: null, nextDate } when nothing is released yet
 * (nextDate = the first upcoming puzzle's date, or null if there are none at all).
 */
export function pickDaily(index, today) {
  const all = indexEntries(index);
  const released = all.filter((p) => p.date <= today);
  if (released.length) {
    const entry = released[released.length - 1];
    return { entry, isToday: entry.date === today };
  }
  const upcoming = all.find((p) => p.date > today);
  return { entry: null, isToday: false, nextDate: upcoming ? upcoming.date : null };
}

/** Index entry for a date, or null. */
export function findEntry(index, date) {
  return indexEntries(index).find((p) => p.date === date) || null;
}

/**
 * Parse location.hash into a route:
 *   '' | '#' | '#/'          -> { name: 'today' }
 *   '#/puzzle/2026-10-03'     -> { name: 'puzzle', date }
 *   '#/archive'               -> { name: 'archive' }
 *   anything else             -> { name: 'today', unknown: true }
 */
export function parseRoute(hash) {
  const h = String(hash || '').replace(/^#/, '');
  if (h === '' || h === '/') return { name: 'today' };
  if (/^\/archive\/?$/.test(h)) return { name: 'archive' };
  const m = /^\/puzzle\/(\d{4}-\d{2}-\d{2})\/?$/.exec(h);
  if (m && isValidDateId(m[1])) return { name: 'puzzle', date: m[1] };
  return { name: 'today', unknown: true };
}

/** "5×5 Mini", "15×15", "21×21" (Mini for ≤ 7×7). */
export function sizeLabel(width, height) {
  const base = `${width}×${height}`;
  return Math.max(width, height) <= 7 ? `${base} Mini` : base;
}
