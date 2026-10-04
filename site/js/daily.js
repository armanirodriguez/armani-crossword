// Which puzzles are "today's", which are released, and parsing of hash routes. Pure functions.
//
// A date can hold up to one puzzle of each kind (SPEC §8): Mini, Midi and Daily. Index entries are identified by
// their puzzle id ("2026-10-04" for a daily — the id every pre-§8 puzzle already has — "2026-10-04-mini", …).
// Each series (SPEC §9: the user's puzzles and "Claude's way") has its own index; every function here works on one
// index at a time. Entries of Claude's index carry series: 'claude' (data.js tags them) and ids "claude-2026-10-04-mini".

import { KINDS, KIND_LABELS, isValidDateId, isValidKind, parsePuzzleId, puzzleId } from '../shared/puzzle.js';
import { CLAUDE, seriesOf } from './series.js';

/** The kind of an index entry ('daily' when missing or unknown). */
export function entryKind(p) {
  return isValidKind(p?.kind) ? p.kind : 'daily';
}

/** The series of an index entry: 'claude' or 'main'. */
export function entrySeries(p) {
  return seriesOf(p);
}

/** The puzzle id of an index entry (derived from date + kind + series when the entry has no valid id). */
export function entryId(p) {
  const kind = entryKind(p);
  const series = entrySeries(p);
  const parsed = parsePuzzleId(p?.id);
  if (parsed && parsed.date === p.date && parsed.kind === kind && parsed.series === series) return p.id;
  return puzzleId(p?.date, kind, series);
}

/** "Mini" / "Midi" / "Daily". */
export function kindLabel(kind) {
  return KIND_LABELS[kind] || KIND_LABELS.daily;
}

const kindRank = (p) => KINDS.indexOf(entryKind(p));

/** Index entries (from puzzles/index.json) with a valid date, sorted oldest -> newest, then Mini, Midi, Daily. */
export function indexEntries(index) {
  const list = Array.isArray(index?.puzzles) ? index.puzzles : [];
  const seen = new Set();
  return list
    .filter((p) => p && isValidDateId(p.date))
    .filter((p) => {
      // At most one puzzle per date + kind (a damaged index with duplicates keeps the first).
      const id = entryId(p);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : kindRank(a) - kindRank(b)));
}

/** True when a puzzle dated `date` is still locked for a solver whose today is `today`. */
export function isLocked(date, today, preview = false) {
  return !preview && date > today;
}

/** Released puzzles, newest date first (within a date: Mini, Midi, Daily). All of them in preview mode. */
export function releasedPuzzles(index, today, preview = false) {
  return groupByDate(indexEntries(index).filter((p) => !isLocked(p.date, today, preview)))
    .reverse()
    .flatMap((g) => g.entries);
}

/** Entries grouped by date, in the order given: [{ date, entries }]. */
export function groupByDate(entries) {
  const groups = [];
  for (const p of entries) {
    const last = groups[groups.length - 1];
    if (last && last.date === p.date) last.entries.push(p);
    else groups.push({ date: p.date, entries: [p] });
  }
  return groups;
}

/** The puzzles of one date in display order (Mini, Midi, Daily). */
export function entriesOn(index, date) {
  return indexEntries(index).filter((p) => p.date === date);
}

/**
 * Today's puzzles: every puzzle dated `today`, else every puzzle of the latest date before it ("Latest").
 * Returns { date, entries, isToday } or { date: null, entries: [], nextDate } when nothing is released yet
 * (nextDate = the first upcoming puzzle's date, or null if there are none at all).
 */
export function pickToday(index, today) {
  const all = indexEntries(index);
  const released = all.filter((p) => p.date <= today);
  if (released.length) {
    const date = released[released.length - 1].date;
    return { date, entries: released.filter((p) => p.date === date), isToday: date === today };
  }
  const upcoming = all.find((p) => p.date > today);
  return { date: null, entries: [], isToday: false, nextDate: upcoming ? upcoming.date : null };
}

/**
 * Today's puzzle (single-puzzle view of pickToday): its daily if it has one, else its last puzzle.
 * Returns { entry, isToday } or { entry: null, nextDate }.
 */
export function pickDaily(index, today) {
  const t = pickToday(index, today);
  if (!t.entries.length) return { entry: null, isToday: false, nextDate: t.nextDate };
  return { entry: t.entries[t.entries.length - 1], isToday: t.isToday };
}

/** Index entry for a puzzle id (a bare date is the daily of that date), or null. Look Claude ids up in Claude's index. */
export function findEntry(index, id) {
  const parsed = parsePuzzleId(id);
  if (!parsed) return null;
  const want = puzzleId(parsed.date, parsed.kind, parsed.series);
  return indexEntries(index).find((p) => entryId(p) === want) || null;
}

/** Ids of the puzzles shown for `today` (to notice when a deploy adds or removes one). */
export function todaySignature(index, today) {
  const t = pickToday(index, today);
  return `${t.date || ''}|${t.entries.map(entryId).join(',')}`;
}

/**
 * Parse location.hash into a route (the user's series has no `series` field, as before SPEC §9):
 *   '' | '#' | '#/'                    -> { name: 'today' }
 *   '#/puzzle/2026-10-03'               -> { name: 'puzzle', id: '2026-10-03', date, kind: 'daily' }
 *   '#/puzzle/2026-10-03-mini'          -> { name: 'puzzle', id: '2026-10-03-mini', date, kind: 'mini' }
 *   '#/puzzle/claude-2026-10-03-mini'   -> { name: 'puzzle', id: 'claude-2026-10-03-mini', date, kind: 'mini', series: 'claude' }
 *   '#/archive'                         -> { name: 'archive' }
 *   '#/archive/claude'                  -> { name: 'archive', series: 'claude' }
 *   anything else                       -> { name: 'today', unknown: true }
 */
export function parseRoute(hash) {
  const h = String(hash || '').replace(/^#/, '');
  if (h === '' || h === '/') return { name: 'today' };
  const a = /^\/archive(\/claude)?\/?$/.exec(h);
  if (a) return a[1] ? { name: 'archive', series: CLAUDE } : { name: 'archive' };
  const m = /^\/puzzle\/([0-9a-z-]+?)\/?$/.exec(h);
  const parsed = m ? parsePuzzleId(m[1]) : null;
  if (parsed) {
    const r = { name: 'puzzle', id: m[1], date: parsed.date, kind: parsed.kind };
    if (parsed.series === CLAUDE) r.series = CLAUDE;
    return r;
  }
  return { name: 'today', unknown: true };
}

/** The series a route is about ('main' unless it names Claude's). */
export function routeSeries(r) {
  return seriesOf(r);
}

/**
 * "5×5 Mini", "15×15", "21×21". A daily of ≤ 7×7 is called a Mini (as before §8); a puzzle that already has a
 * Mini / Midi kind shows only its size (its kind is shown on its own).
 */
export function sizeLabel(width, height, kind = 'daily') {
  const base = `${width}×${height}`;
  return kind === 'daily' && Math.max(width, height) <= 7 ? `${base} Mini` : base;
}
