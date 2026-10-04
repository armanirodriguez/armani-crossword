// Answer freshness: answers of puzzles published shortly before or after a draft's date (GET /api/recent-answers).
// Autofill, Refill, layout generation and "Fit them in for me" avoid them (the engine's `penalize` option, when the
// Fill option "Avoid repeating recent answers" is on), the Words panel tags them ("used Oct 1") and the Checks panel
// and the Review checklist list the ones in the grid.
//
// The draft's own puzzle (its date and kind) is left out; the other kinds of the same day count, so same-day
// puzzles avoid sharing answers. Results are cached per (date, kind, window) and dropped whenever the published
// puzzles change.

import { draftEntries, isValidDateId } from '../../site/shared/puzzle.js';
import { api } from './api.js';
import { DEFAULT_KIND, idDate, kindLabel, parsePuzzleId } from './kinds.js';

/** After a failed request, ask again this much later (not on every render). */
const RETRY_MS = 30_000;

/** Points taken off a recently used answer's score when the engine orders its choices (it is not banned). */
export const RECENT_PENALTY = 30;
/** Window choices (days before and after the draft's date). */
export const RECENT_WINDOWS = [7, 14, 30, 60, 90];

/**
 * "2026-10-01" -> "Oct 1" (with the year when it differs from `relativeTo`'s). A puzzle id of a Mini / Midi
 * ("2026-10-01-mini") reads "Oct 1 Mini".
 */
export function shortDate(dateId, relativeTo = '') {
  const date = idDate(dateId);
  if (!date) return String(dateId ?? '');
  const [y, m, d] = date.split('-').map(Number);
  const opts = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (relativeTo && relativeTo.slice(0, 4) !== date.slice(0, 4)) opts.year = 'numeric';
  const kind = isValidDateId(dateId) ? 'daily' : parsePuzzleId(dateId)?.kind;
  const text = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', opts);
  return kind && kind !== 'daily' ? `${text} ${kindLabel(kind)}` : text;
}

/** Of `dates` (YYYY-MM-DD, or puzzle ids), the one closest to `date` (earlier wins a tie). */
export function nearestDate(dates, date) {
  if (!isValidDateId(date)) return dates[dates.length - 1] ?? null;
  const dist = (x) => Math.abs(Date.parse(idDate(x) || x) - Date.parse(date));
  return [...dates].sort((a, b) => dist(a) - dist(b) || (a < b ? -1 : 1))[0] ?? null;
}

/**
 * The engine's `penalize` option: { WORD: points } for every recently used answer except this draft's theme answers
 * (the user chose those; the engine never penalizes theme / prefer words either). Null when there is nothing to
 * avoid.
 * @param {Map<string, string[]>|null} recent  answer -> dates
 * @param {Iterable<string>} themeAnswers
 */
export function recentPenalties(recent, themeAnswers = [], points = RECENT_PENALTY) {
  if (!recent?.size) return null;
  const theme = new Set(themeAnswers);
  const out = {};
  for (const word of recent.keys()) if (!theme.has(word)) out[word] = points;
  return Object.keys(out).length ? out : null;
}

/**
 * Answers in the draft's grid that a recent puzzle also used:
 * [{ answer, dates, entries, theme }] in clue order (across answers first, then down).
 */
export function recentRepeats(d, recent) {
  if (!recent?.size) return [];
  const theme = new Set((d.theme || []).map((t) => t.answer));
  const byAnswer = new Map();
  for (const e of draftEntries(d).all) {
    if (!e.answer || !recent.has(e.answer)) continue;
    if (!byAnswer.has(e.answer)) byAnswer.set(e.answer, { answer: e.answer, dates: recent.get(e.answer), entries: [], theme: theme.has(e.answer) });
    byAnswer.get(e.answer).entries.push(e);
  }
  return [...byAnswer.values()];
}

/** "used Oct 1" / "used Oct 1 +2" — the use closest to the draft's date (and how many more). */
export function usedLabel(dates, date) {
  const near = nearestDate(dates, date);
  if (!near) return '';
  return `used ${shortDate(near, date)}${dates.length > 1 ? ` +${dates.length - 1}` : ''}`;
}

/** "Used in the puzzles of Sep 28 and Oct 5" (for titles / checklists). */
export function usedSentence(dates, date) {
  const list = dates.map((x) => shortDate(x, date));
  const joined = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0] || '';
  return `Used in the puzzle${dates.length === 1 ? '' : 's'} of ${joined}`;
}

/**
 * Loads and caches recent answers. Events: 'loaded' (detail { date, days }) when a result arrives.
 * get() never throws: while loading, or when the server cannot answer (an old dev server), it returns null.
 */
export class RecentAnswers extends EventTarget {
  #cache = new Map(); // `${date}|${days}` -> { promise, value: Map|null }
  #generation = 0;

  /** The cached result (answer -> dates) or null; starts loading it when missing. */
  get(date, days, kind = DEFAULT_KIND) {
    const entry = this.#entry(date, days, kind);
    return entry ? entry.value : null;
  }

  /** Resolves to the result (answer -> dates); an empty Map when it cannot be loaded. */
  async load(date, days, kind = DEFAULT_KIND) {
    const entry = this.#entry(date, days, kind);
    if (!entry) return new Map();
    await entry.promise;
    return entry.value || new Map();
  }

  /** Forget everything (the published puzzles changed). */
  invalidate() {
    this.#generation++;
    this.#cache.clear();
  }

  #entry(date, days, kind) {
    if (!isValidDateId(date) || !Number.isInteger(days) || days < 0) return null;
    const key = `${date}|${kind}|${days}`;
    let entry = this.#cache.get(key);
    if (!entry) {
      const generation = this.#generation;
      entry = { value: null, promise: null };
      entry.promise = api.recentAnswers(date, days, kind).then((res) => {
        entry.value = new Map(Object.entries(res?.answers || {}).filter(([, dates]) => Array.isArray(dates) && dates.length));
      }, (err) => {
        console.warn('Recent answers are unavailable:', err?.message || err);
        entry.value = new Map();
        const retry = setTimeout(() => { if (this.#cache.get(key) === entry) this.#cache.delete(key); }, RETRY_MS);
        retry?.unref?.(); // (Node, in tests: don't keep the process alive for it)
      }).then(() => {
        if (generation === this.#generation) this.dispatchEvent(new CustomEvent('loaded', { detail: { date, days, kind } }));
      });
      this.#cache.set(key, entry);
    }
    return entry;
  }
}

export const recentAnswers = new RecentAnswers();
