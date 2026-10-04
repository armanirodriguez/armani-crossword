// Preview contract (SPEC §5): the builder writes a published-format puzzle to localStorage['xw:preview'] and
// loads /site/index.html?preview=1, which plays it without date locks and without saving progress.
// The builder and the site are served by the same dev server, so they share localStorage.

import { previewPuzzle } from './draft-utils.js';
import { toast } from './dialogs.js';
import { idDate } from './kinds.js';

export const PREVIEW_KEY = 'xw:preview';
export const PREVIEW_URL = '/site/index.html?preview=1';

/**
 * Link to a published puzzle in the local player, by puzzle id (a date for a daily, "2026-10-05-mini" …). A
 * puzzle dated after `today` is locked for solvers ("Unlocks on …"), so its creator gets the player's preview
 * mode, which opens published puzzles of any date and never saves progress.
 */
export function siteUrlFor(id, today) {
  const date = idDate(id) || id;
  return date > today ? `/site/index.html?preview=1#/puzzle/${id}` : `/site/#/puzzle/${id}`;
}

/** Store the preview puzzle. Returns { ok, notes }. */
export function writePreview(draft, today) {
  const { puzzle, notes } = previewPuzzle(draft, today);
  if (!puzzle) return { ok: false, notes };
  try {
    localStorage.setItem(PREVIEW_KEY, JSON.stringify(puzzle));
  } catch (err) {
    return { ok: false, notes: [`Could not write the preview to localStorage: ${err.message}`] };
  }
  return { ok: true, notes };
}

export function openPreviewTab(draft, today) {
  const { ok, notes } = writePreview(draft, today);
  if (!ok) {
    toast(notes[0] || 'Nothing to preview yet', { type: 'warn' });
    return;
  }
  window.open(PREVIEW_URL, '_blank', 'noopener');
}
