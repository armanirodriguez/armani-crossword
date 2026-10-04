// Share text (SPEC §6 "Share"): a pure builder that is unit-tested, plus the delivery helpers
// (navigator.share -> clipboard -> execCommand('copy') -> manual textarea).
//
// 🧩 Armani Crossword #12 · Sat, Oct 3        (a daily)
// 🧩 Armani Crossword Mini #1 · Sun, Oct 4    (a mini / midi: the kind before the number, SPEC §8)
// ⏱️ 4:32 · ✨ no hints
// ⬛🟩🟩🟩🟩
// …
// https://friends.example/crossword/

import { KIND_LABELS, formatDuration, isValidDateId } from '../shared/puzzle.js';

export const SHARE_EMOJI = Object.freeze({
  block: '⬛',
  clean: '🟩', // solved unaided
  checked: '🟨', // was marked wrong by a check (then fixed)
  revealed: '🟪',
});

/** "2026-10-03" -> "Sat, Oct 3" (calendar date, independent of the device time zone). */
export function shareDate(dateId) {
  if (!isValidDateId(dateId)) return String(dateId ?? '');
  const [y, m, d] = dateId.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

/** Hint line part: "✨ no hints" | "🔍 2 checked" | "💡 1 revealed" | "🔍 2 checked · 💡 1 revealed". */
export function hintSummary(checks = 0, reveals = 0) {
  const parts = [];
  if (checks > 0) parts.push(`🔍 ${checks} checked`);
  if (reveals > 0) parts.push(`💡 ${reveals} revealed`);
  return parts.length ? parts.join(' · ') : '✨ no hints';
}

/**
 * Emoji rows for the share grid.
 * @param {{width:number, height:number, isBlock:boolean[]}} puzzle
 * @param {string[]} marks          per cell '' | 'wrong' | 'revealed'
 * @param {Iterable<number>} everWrong  cells ever flagged wrong by a check
 * @returns {string[]} one string per row
 */
export function shareGridRows(puzzle, marks, everWrong = []) {
  const wrong = everWrong instanceof Set ? everWrong : new Set(everWrong);
  const rows = [];
  for (let r = 0; r < puzzle.height; r++) {
    let row = '';
    for (let c = 0; c < puzzle.width; c++) {
      const i = r * puzzle.width + c;
      if (puzzle.isBlock[i]) row += SHARE_EMOJI.block;
      else if (marks?.[i] === 'revealed') row += SHARE_EMOJI.revealed;
      else if (wrong.has(i)) row += SHARE_EMOJI.checked;
      else row += SHARE_EMOJI.clean;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * The full share text.
 * @param {object} o
 * @param {string}  o.siteName
 * @param {number|null} o.number     puzzle number from the index (omitted when unknown, e.g. preview)
 * @param {string}  [o.kind='daily'] 'mini' | 'midi' | 'daily' — the kind label goes before the number (none for daily)
 * @param {string}  o.date           YYYY-MM-DD
 * @param {number}  o.elapsedMs
 * @param {number}  o.checks
 * @param {number}  o.reveals
 * @param {string[]|null} o.gridRows from shareGridRows(); omitted when null/empty or shareGrid is false
 * @param {boolean} [o.shareGrid=true]
 * @param {string}  o.url
 */
export function buildShareText({ siteName, number = null, kind = 'daily', date, elapsedMs, checks = 0, reveals = 0, gridRows = null, shareGrid = true, url = '' }) {
  const name = String(siteName || 'Armani Crossword').trim();
  const num = Number.isInteger(number) && number > 0 ? ` #${number}` : '';
  const kindWord = kind && kind !== 'daily' && KIND_LABELS[kind] ? ` ${KIND_LABELS[kind]}` : '';
  const lines = [
    `🧩 ${name}${kindWord}${num} · ${shareDate(date)}`,
    `⏱️ ${formatDuration(elapsedMs)} · ${hintSummary(checks, reveals)}`,
  ];
  if (shareGrid && gridRows?.length) lines.push(...gridRows);
  if (url) lines.push(url);
  return lines.join('\n');
}

/** The URL for the share text: config.shareUrl, else this page without hash/query (and without "index.html"). */
export function shareUrlFor(configUrl, location) {
  const configured = String(configUrl ?? '').trim();
  if (configured) return configured;
  if (!location) return '';
  return `${location.origin}${location.pathname.replace(/index\.html$/, '')}`;
}

// ---------------------------------------------------------------------------
// Delivery

/** True when the device's primary input is touch (where the native share sheet is the expected UX). */
export function prefersNativeShare(win = globalThis) {
  try {
    return Boolean(win.matchMedia?.('(pointer: coarse)').matches);
  } catch {
    return false;
  }
}

/** Copy via a temporary off-screen textarea and document.execCommand('copy'). */
export function legacyCopy(text, doc = globalThis.document) {
  if (!doc?.body) return false;
  const ta = doc.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
  doc.body.appendChild(ta);
  const prevFocus = doc.activeElement;
  let ok = false;
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = Boolean(doc.execCommand?.('copy'));
  } catch {
    ok = false;
  }
  ta.remove();
  try { prevFocus?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
  return ok;
}

/**
 * Share or copy `text`. MUST be called synchronously from a user gesture (navigator.share needs it).
 * Resolves to 'shared' | 'cancelled' | 'copied' | 'manual' (nothing worked: show the text for manual copy).
 */
export async function deliverShare(text, { nav = globalThis.navigator, doc = globalThis.document, preferNative = prefersNativeShare() } = {}) {
  if (preferNative && typeof nav?.share === 'function') {
    try {
      if (!nav.canShare || nav.canShare({ text })) {
        await nav.share({ text });
        return 'shared';
      }
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled';
      // NotAllowedError / unsupported: fall through to copying.
    }
  }
  if (nav?.clipboard?.writeText) {
    try {
      await nav.clipboard.writeText(text);
      return 'copied';
    } catch {
      /* permission denied / insecure context: try the legacy path */
    }
  }
  if (legacyCopy(text, doc)) return 'copied';
  return 'manual';
}
