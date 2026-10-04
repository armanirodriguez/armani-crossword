// "Share" button behaviour shared by the solved modal, the play header and the intro card.

import { puzzleKind } from '../../shared/puzzle.js';
import { buildShareText, deliverShare, shareGridRows, shareUrlFor } from '../share.js';
import { CLAUDE, CLAUDE_LABEL, seriesOf } from '../series.js';
import { showCopyFallback, toast } from '../ui.js';

/**
 * Build the share text for a solved puzzle. Claude's way puzzles use the series label instead of the site name
 * (SPEC §9): "🧩 Claude's way Mini #3 · Mon, Oct 5".
 * @param {object} ctx      app context (config)
 * @param {object} raw      published puzzle
 * @param {object|null} entry index entry (number)
 * @param {object} loaded   loadPuzzle(raw)
 * @param {{ elapsedMs, checks, reveals, marks, everWrong }} result
 */
export function shareTextFor(ctx, raw, entry, loaded, result) {
  return buildShareText({
    siteName: seriesOf(raw) === CLAUDE ? CLAUDE_LABEL : ctx.config.siteName,
    number: entry?.number ?? null,
    kind: puzzleKind(raw),
    date: raw.date,
    elapsedMs: result.elapsedMs,
    checks: result.checks,
    reveals: result.reveals,
    gridRows: shareGridRows(loaded, result.marks, result.everWrong),
    shareGrid: ctx.config.shareGrid !== false,
    url: ctx.config.shareLink === false ? '' : shareUrlFor(ctx.config.shareUrl, window.location),
  });
}

/** Share/copy the text. Call synchronously from the click handler (navigator.share needs the gesture). */
export function shareNow(text) {
  return deliverShare(text).then((outcome) => {
    if (outcome === 'copied') toast('Copied to clipboard — paste it in your group chat!', { tone: 'success' });
    else if (outcome === 'manual') showCopyFallback(text);
    return outcome;
  });
}
