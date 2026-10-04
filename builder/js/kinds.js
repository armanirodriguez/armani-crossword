// Puzzle kinds (SPEC §8): a date holds up to one Mini, one Midi and one Daily. Pure helpers (no DOM) the builder
// uses for ids, labels, numbering and "next free date".
//
// The id / kind basics live in site/shared/puzzle.js; they are read through a namespace import so this module
// also works with a copy of puzzle.js that predates them (the fallbacks below follow the same contract).

import * as shared from '../../site/shared/puzzle.js';
import { isValidDateId } from '../../site/shared/puzzle.js';

export const KINDS = Array.isArray(shared.KINDS) ? shared.KINDS : ['mini', 'midi', 'daily'];
export const KIND_LABELS = shared.KIND_LABELS || { mini: 'Mini', midi: 'Midi', daily: 'Daily' };
export const DEFAULT_KIND = 'daily';

/** One-line descriptions for the kind pickers. */
export const KIND_HELP = {
  mini: 'Quick, about a minute or two. Usually 5×5.',
  midi: 'A coffee-break puzzle. Usually 7×7 to 11×11.',
  daily: 'The main puzzle of the day. Usually 13×13 or 15×15.',
};

export const isKind = (k) => KINDS.includes(k);
export const kindLabel = (k) => KIND_LABELS[isKind(k) ? k : DEFAULT_KIND];
/** Display order: Mini, Midi, Daily. */
export const kindOrder = (k) => (isKind(k) ? KINDS.indexOf(k) : KINDS.indexOf(DEFAULT_KIND));

/** `YYYY-MM-DD` for a daily (as before), `YYYY-MM-DD-mini` / `YYYY-MM-DD-midi` otherwise. */
export const puzzleId = typeof shared.puzzleId === 'function'
  ? shared.puzzleId
  : (date, kind = DEFAULT_KIND) => (!isKind(kind) || kind === 'daily' ? date : `${date}-${kind}`);

/** `{ date, kind }` of a puzzle id, or null. */
export const parsePuzzleId = typeof shared.parsePuzzleId === 'function'
  ? shared.parsePuzzleId
  : (id) => {
    const m = /^(\d{4}-\d{2}-\d{2})(?:-(mini|midi))?$/.exec(String(id ?? ''));
    return m && isValidDateId(m[1]) ? { date: m[1], kind: m[2] || 'daily' } : null;
  };

/** A puzzle's (or index entry's) kind: missing ⇒ daily. */
export const puzzleKind = (p) => (isKind(p?.kind) ? p.kind : DEFAULT_KIND);

/** The kind a grid size suggests: mini up to 7, midi up to 11, else daily (only a default; the user chooses). */
export const suggestKind = typeof shared.suggestKind === 'function'
  ? shared.suggestKind
  : (width, height = width) => {
    const n = Math.max(Number(width) || 0, Number(height) || 0);
    return n <= 7 ? 'mini' : n <= 11 ? 'midi' : 'daily';
  };

/** A draft's kind (drafts made before kinds existed are dailies). */
export const draftKind = (d) => (isKind(d?.kind) ? d.kind : DEFAULT_KIND);

/** The id the draft publishes to right now, or null without a valid release date. */
export const draftPuzzleId = (d) => (isValidDateId(d?.date) ? puzzleId(d.date, draftKind(d)) : null);

/**
 * The id the draft was last published to: `publishedId` when recorded, else (published before kinds existed)
 * the daily on `publishedDate`. Null when it was never published.
 */
export function recordedPuzzleId(d) {
  if (d?.publishedId && parsePuzzleId(d.publishedId)) return d.publishedId;
  return isValidDateId(d?.publishedDate) ? puzzleId(d.publishedDate, 'daily') : null;
}

/** An index entry's id (old indexes may lack `id`; it is the date for a daily). */
export const entryId = (p) => (p?.id ? p.id : puzzleId(p?.date, puzzleKind(p)));

/** The date of a puzzle id or plain date (YYYY-MM-DD), else ''. */
export function idDate(idOrDate) {
  if (isValidDateId(idOrDate)) return idOrDate;
  return parsePuzzleId(idOrDate)?.date || '';
}

/** "#12" for a daily, "Mini #3" otherwise (numbers count per kind). */
export function numberLabel(p) {
  const kind = puzzleKind(p);
  const num = p?.number ?? '?';
  return kind === 'daily' ? `#${num}` : `${kindLabel(kind)} #${num}`;
}

/** Sort index entries by date, then Mini, Midi, Daily. Returns a new array. */
export function sortPuzzles(list, { descending = false } = {}) {
  const sign = descending ? -1 : 1;
  return [...(list || [])].sort((a, b) => (a.date < b.date ? -sign : a.date > b.date ? sign : 0)
    || kindOrder(puzzleKind(a)) - kindOrder(puzzleKind(b)));
}

/**
 * The dates taken for `kind`: published puzzles of that kind and (optionally) other drafts of that kind.
 * `drafts`: rows with { id, date, kind? }.
 */
export function takenDatesForKind(kind, { published = [], drafts = [], exceptDraft = null } = {}) {
  const k = isKind(kind) ? kind : DEFAULT_KIND;
  const taken = new Set();
  for (const p of published || []) if (puzzleKind(p) === k && isValidDateId(p.date)) taken.add(p.date);
  for (const d of drafts || []) if (d.id !== exceptDraft && d.date && draftKind(d) === k) taken.add(d.date);
  return taken;
}

/**
 * The number a puzzle of `kind` on `date` gets: its position in date order among the published puzzles of that
 * kind (counting it once if it is already there). Null without a valid date.
 */
export function predictedNumber(published, date, kind) {
  if (!isValidDateId(date)) return null;
  const dates = new Set((published || []).filter((p) => puzzleKind(p) === kind).map((p) => p.date));
  dates.add(date);
  return [...dates].sort().indexOf(date) + 1;
}

/** How many published puzzles of `kind` dated after `date` get renumbered when one is added on `date`. */
export function renumberedBy(published, date, kind) {
  const same = (published || []).filter((p) => puzzleKind(p) === kind);
  if (same.some((p) => p.date === date)) return 0;
  return same.filter((p) => p.date > date).length;
}
