// Pure helpers for editing drafts (no DOM). Grid mutations take the draft object and change it in place;
// callers wrap them in store.update(…, { kind: 'grid' }) so they are undoable and autosaved.

import {
  BLOCK, EMPTY, computeEntries, entryPattern, isLetter, layoutFromGrid, symmetricIndex, validateGrid,
} from '../../site/shared/grid.js';
import {
  PUZZLE_FORMAT, addDays, checksum, draftEntries, draftToPuzzle, encodeSolution, isValidDateId, normalizeAnswer, normalizeClue,
} from '../../site/shared/puzzle.js';

export const SIZE_PRESETS = [
  { w: 5, h: 5, label: '5×5', hint: 'Mini' },
  { w: 7, h: 7, label: '7×7', hint: 'Midi' },
  { w: 9, h: 9, label: '9×9', hint: 'Small' },
  { w: 11, h: 11, label: '11×11', hint: 'Medium' },
  { w: 13, h: 13, label: '13×13', hint: 'Large' },
  { w: 15, h: 15, label: '15×15', hint: 'Daily' },
];
export const MIN_SIZE = 3;
export const MAX_BUILDER_SIZE = 21;

export const gridOf = (d) => ({ width: d.width, height: d.height, cells: d.cells });

// ---------------------------------------------------------------------------
// Grid mutations

/** Remove cell indices that are blocks from locked / circles / shaded. */
function pruneDecorations(d) {
  const white = (i) => d.cells[i] !== BLOCK;
  d.locked = d.locked.filter(white);
  d.circles = d.circles.filter(white);
  d.shaded = d.shaded.filter(white);
}

/** Toggle a block at `i` and its symmetric partner (per d.symmetry). Letters in affected cells are removed. */
export function toggleBlock(d, i) {
  const grid = gridOf(d);
  const makeBlock = d.cells[i] !== BLOCK;
  const partner = symmetricIndex(grid, i, d.symmetry);
  for (const j of new Set([i, partner])) d.cells[j] = makeBlock ? BLOCK : EMPTY;
  if (makeBlock) pruneDecorations(d);
  else d.locked = d.locked.filter((x) => x !== i && x !== partner);
}

/** Put a letter in a white cell (a block becomes white, keeping symmetry). Typed letters are locked. */
export function setLetter(d, i, letter, { lock = true } = {}) {
  if (d.cells[i] === BLOCK) {
    const partner = symmetricIndex(gridOf(d), i, d.symmetry);
    if (partner !== i && d.cells[partner] === BLOCK) d.cells[partner] = EMPTY;
  }
  d.cells[i] = letter;
  setLocked(d, [i], lock && Boolean(letter));
}

export function clearCell(d, i) {
  if (d.cells[i] === BLOCK) return;
  d.cells[i] = EMPTY;
  setLocked(d, [i], false);
}

/** Write `word` into an entry's cells. */
export function placeWord(d, entry, word, { lock = true } = {}) {
  entry.cells.forEach((i, k) => { d.cells[i] = word[k]; });
  setLocked(d, entry.cells, lock);
}

export function setLocked(d, cells, locked) {
  const set = new Set(d.locked);
  for (const i of cells) {
    if (locked && isLetter(d.cells[i])) set.add(i);
    else set.delete(i);
  }
  d.locked = [...set].sort((a, b) => a - b);
}

/** Clear every letter that is not locked. Returns how many cells were cleared. */
export function clearUnlocked(d) {
  const locked = new Set(d.locked);
  let n = 0;
  d.cells.forEach((ch, i) => {
    if (isLetter(ch) && !locked.has(i)) { d.cells[i] = EMPTY; n++; }
  });
  return n;
}

export function lockAll(d) {
  d.locked = d.cells.map((ch, i) => (isLetter(ch) ? i : -1)).filter((i) => i >= 0);
}

export function toggleDecoration(d, key, i) {
  if (d.cells[i] === BLOCK) return;
  const set = new Set(d[key]);
  if (set.has(i)) set.delete(i); else set.add(i);
  d[key] = [...set].sort((a, b) => a - b);
}

/** Start over with an empty grid of a new size. */
export function resizeDraft(d, width, height) {
  d.width = width;
  d.height = height;
  d.cells = new Array(width * height).fill(EMPTY);
  d.locked = [];
  d.circles = [];
  d.shaded = [];
}

export function gridHasContent(d) {
  return d.cells.some((ch) => ch !== EMPTY);
}

// ---------------------------------------------------------------------------
// Theme list parsing ("Jack o' lantern | Carved October decoration")

/**
 * Parse the theme textarea. Returns { items, theme } where
 *   items: [{ line, raw, answer, clue, length, problems: [{ level: 'error'|'warn'|'info', text }] }] (non-blank lines)
 *   theme: [{ answer, clue, raw }] the usable entries (valid, unique) in priority order — stored as draft.theme
 */
export function parseThemeText(text, { width, height, wordIndex = null } = {}) {
  const maxLen = Math.max(width || 0, height || 0);
  const items = [];
  const theme = [];
  const seen = new Map();
  String(text || '').split('\n').forEach((rawLine, lineNo) => {
    if (!rawLine.trim()) return;
    const bar = rawLine.indexOf('|');
    const raw = (bar >= 0 ? rawLine.slice(0, bar) : rawLine).trim();
    const clue = bar >= 0 ? normalizeClue(rawLine.slice(bar + 1)) : '';
    const answer = normalizeAnswer(raw);
    const problems = [];
    if (!answer) problems.push({ level: 'error', text: 'No letters' });
    else if (answer.length < 3) problems.push({ level: 'error', text: 'Too short (min 3)' });
    else if (maxLen && answer.length > maxLen) problems.push({ level: 'error', text: `Too long for ${width}×${height}` });
    if (answer && seen.has(answer)) problems.push({ level: 'error', text: `Duplicate of line ${seen.get(answer) + 1}` });
    if (clue && answer.length >= 3 && normalizeAnswer(clue).includes(answer)) problems.push({ level: 'warn', text: 'Clue contains the answer' });
    if (answer && answer.length >= 3 && wordIndex && wordIndex.size && !wordIndex.has(answer)) {
      problems.push({ level: 'info', text: 'Not in word list', title: 'Fine for theme words — they are placed as they are' });
    }
    const item = { line: lineNo, raw, answer, clue, length: answer.length, problems };
    items.push(item);
    if (answer && !seen.has(answer)) seen.set(answer, lineNo);
    if (!problems.some((p) => p.level === 'error' && !p.text.startsWith('Too long'))) {
      if (!theme.some((t) => t.answer === answer) && answer.length >= 3) theme.push({ answer, clue, raw });
    }
  });
  return { items, theme };
}

/**
 * How many theme answers a generated grid of this size typically holds (what the layout generator manages with
 * ordinary theme words): ≈1–2 in a 5×5, 2–3 in a 9×9, 3–5 in a 15×15. Returns { min, max, text: '2–3' }.
 */
export function themeCapacity(width, height) {
  const size = Math.round(Math.sqrt(width * height));
  const [min, max] = size <= 8 ? [1, 2] : size <= 10 ? [2, 3] : size <= 14 ? [3, 4] : [3, 5];
  return { min, max, text: `${min}–${max}` };
}

// ---------------------------------------------------------------------------
// Analysis

/** Entries + per-entry info used by the Grid and Clues tabs. */
export function analyze(d) {
  return draftEntries(d); // { numbers, across, down, all, acrossAt, downAt } with .answer / .clue
}

/** Answers of the draft's theme list. */
export function themeAnswers(d) {
  return new Set((d.theme || []).map((t) => t.answer));
}

/** Map answer -> theme clue (from the theme list). */
export function themeClues(d) {
  const m = new Map();
  for (const t of d.theme || []) if (t.clue) m.set(t.answer, t.clue);
  return m;
}

/**
 * Grid statistics & problems for the Stats panel.
 * Returns { words, blocks, whites, empty, avgLength, avgScore, scored, lowest, notInList, duplicates, issues }
 */
export function gridStats(d, wordIndex) {
  const grid = gridOf(d);
  const { all } = analyze(d);
  const theme = themeAnswers(d);
  const blocks = d.cells.filter((c) => c === BLOCK).length;
  const empty = d.cells.filter((c) => c === EMPTY).length;
  const avgLength = all.length ? all.reduce((s, e) => s + e.length, 0) / all.length : 0;
  const scored = [];
  const notInList = [];
  const counts = new Map();
  for (const e of all) {
    if (!e.answer) continue;
    counts.set(e.answer, [...(counts.get(e.answer) || []), e]);
    const score = wordIndex?.size ? wordIndex.score(e.answer) : undefined;
    if (score !== undefined) scored.push({ entry: e, word: e.answer, score });
    else if (wordIndex?.size && !theme.has(e.answer)) notInList.push(e);
  }
  const avgScore = scored.length ? scored.reduce((s, x) => s + x.score, 0) / scored.length : null;
  const lowest = scored.filter((x) => !theme.has(x.word)).sort((a, b) => a.score - b.score).slice(0, 6);
  const duplicates = [...counts.values()].filter((list) => list.length > 1);
  const issues = validateGrid(grid, { minLength: 3, symmetry: d.symmetry });
  return {
    words: all.length, blocks, whites: d.cells.length - blocks, empty, avgLength, avgScore,
    scored: scored.length, lowest, notInList, duplicates, issues,
  };
}

/**
 * Entries where `word` could go: same length, and every cell is empty, holds an unlocked letter (would be
 * replaced), or already holds the same letter. Sorted: fewest replaced letters first.
 */
export function slotsForWord(d, word, entries) {
  const locked = new Set(d.locked);
  const out = [];
  for (const e of entries) {
    if (e.length !== word.length) continue;
    let replaced = 0;
    let ok = true;
    e.cells.forEach((i, k) => {
      if (!ok) return;
      const ch = d.cells[i];
      if (ch === word[k]) return;
      if (ch === EMPTY) return;
      if (locked.has(i)) ok = false;
      else replaced++;
    });
    if (ok) out.push({ entry: e, replaced });
  }
  return out.sort((a, b) => a.replaced - b.replaced || a.entry.num - b.entry.num);
}

/** The entry at a cell in a direction, falling back to the other direction. */
export function entryAt(entries, index, dir) {
  const { across, down, acrossAt, downAt } = entries;
  const a = acrossAt[index] >= 0 ? across[acrossAt[index]] : null;
  const dn = downAt[index] >= 0 ? down[downAt[index]] : null;
  return dir === 'down' ? (dn || a) : (a || dn);
}

export { entryPattern, computeEntries };

// ---------------------------------------------------------------------------
// Dates & ids

/** First date >= `from` that is not in `taken` (a Set of YYYY-MM-DD). */
export function nextFreeDate(from, taken) {
  let d = from;
  for (let k = 0; k < 3660 && taken.has(d); k++) d = addDays(d, 1);
  return d;
}

/** "Spooky Season!" -> "spooky-season-k3x9" (valid draft id). */
export function makeDraftId(title = '') {
  const slug = normalizeClue(title).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `${slug || 'puzzle'}-${rand}`;
}

// ---------------------------------------------------------------------------
// Preview (SPEC §5 "Preview contract")

export const NO_CLUE_YET = '(no clue yet)';

/**
 * A published-format puzzle for the preview, even when the draft is not finished (SPEC §5 preview contract):
 * missing clues become "(no clue yet)", a missing date becomes `fallbackDate`, empty squares are shown as "X".
 * Structural problems (short entries, disconnected areas …) do not block the preview.
 * Returns { puzzle, notes: string[] } — puzzle is null only when the grid has no entries at all.
 */
export function previewPuzzle(d, fallbackDate) {
  const notes = [];
  const strict = draftToPuzzle(d);
  if (strict.puzzle) return { puzzle: { ...strict.puzzle, preview: true }, notes };

  const date = isValidDateId(d.date) ? d.date : fallbackDate;
  if (!isValidDateId(d.date)) notes.push('No release date yet — previewing as today.');
  const cells = d.cells.map((c) => (c === EMPTY ? 'X' : c));
  const empties = d.cells.filter((c) => c === EMPTY).length;
  if (empties) notes.push(`${empties} empty square${empties === 1 ? '' : 's'} shown as “X”.`);
  const copy = { ...d, cells, date };
  const { across, down } = draftEntries(copy);
  if (!across.length && !down.length) return { puzzle: null, notes: ['The grid has no words yet.'] };
  let missing = 0;
  const clue = (e) => {
    if (e.clue) return e.clue;
    missing++;
    return NO_CLUE_YET;
  };
  const plain = cells.join('');
  const white = (list) => [...new Set(list || [])].filter((i) => Number.isInteger(i) && plain[i] && plain[i] !== BLOCK).sort((a, b) => a - b);
  const puzzle = {
    format: PUZZLE_FORMAT,
    id: date,
    date,
    title: normalizeClue(d.title) || 'Untitled',
    author: normalizeClue(d.author),
    note: String(d.note ?? '').trim(),
    width: d.width,
    height: d.height,
    layout: layoutFromGrid(gridOf(copy)),
    circles: white(d.circles),
    shaded: white(d.shaded),
    solution: encodeSolution(plain, date),
    checksum: checksum(plain),
    clues: {
      across: across.map((e) => ({ num: e.num, clue: clue(e) })),
      down: down.map((e) => ({ num: e.num, clue: clue(e) })),
    },
    preview: true,
  };
  if (missing) notes.push(`${missing} clue${missing === 1 ? '' : 's'} missing — shown as “${NO_CLUE_YET}”.`);
  return { puzzle, notes };
}

// ---------------------------------------------------------------------------
// Clue bookkeeping

/** Answers of the complete entries in the grid right now. */
export function gridAnswers(d) {
  return new Set(draftEntries(d).all.map((e) => e.answer).filter(Boolean));
}

/**
 * Clues that came from the theme list (clueSources 'theme') follow edits of the theme list: a changed "| clue"
 * replaces them, a removed one clears them (the 'theme' marker stays, so they come back when a clue is typed
 * again). Clues the user wrote or picked ('user') are never touched. Mutates `d`; returns the answers changed.
 */
export function syncThemeClues(d) {
  const changed = [];
  const sources = d.clueSources || {};
  for (const t of d.theme || []) {
    if (sources[t.answer] !== 'theme') continue;
    const next = normalizeClue(t.clue || '');
    const cur = d.clues[t.answer];
    if (next) {
      if (cur !== next) { d.clues[t.answer] = next; changed.push(t.answer); }
    } else if (cur !== undefined) {
      delete d.clues[t.answer];
      changed.push(t.answer);
    }
  }
  return changed;
}

/**
 * Theme-sourced clues that no longer match the theme list (e.g. edited in an older version of the builder):
 * [{ answer, clue, themeClue }] for answers in the grid.
 */
export function staleThemeClues(d) {
  const inGrid = gridAnswers(d);
  const out = [];
  for (const t of d.theme || []) {
    const themeClue = normalizeClue(t.clue || '');
    if (!themeClue || !inGrid.has(t.answer) || d.clueSources?.[t.answer] !== 'theme') continue;
    const clue = normalizeClue(d.clues[t.answer] ?? '');
    if (clue && clue !== themeClue) out.push({ answer: t.answer, clue, themeClue });
  }
  return out;
}

/** Clues longer than this many characters may wrap onto a second line in the player's clue bar on small phones. */
export const LONG_CLUE_CHARS = 80;

/** True when a clue is long enough to wrap on small phones. */
export const isLongClue = (clue) => normalizeClue(clue ?? '').length > LONG_CLUE_CHARS;

/** Entries in the grid whose clue is long: [{ id, answer, length }] in grid order (each answer once). */
export function longClues(d) {
  const seen = new Set();
  const out = [];
  for (const e of draftEntries(d).all) {
    if (!e.answer || seen.has(e.answer) || !isLongClue(e.clue)) continue;
    seen.add(e.answer);
    out.push({ id: e.id, answer: e.answer, length: e.clue.length });
  }
  return out;
}

/** How many clues in the grid were filled in automatically and not reviewed yet (orphaned answers don't count). */
export function autoClueCount(d) {
  const inGrid = gridAnswers(d);
  return Object.entries(d.clueSources || {})
    .filter(([answer, src]) => src === 'auto' && inGrid.has(answer) && normalizeClue(d.clues[answer] ?? '')).length;
}

/**
 * "Suggest all missing": give every complete word without a clue its top suggestion. `suggest(answer)` returns
 * { clue, source } or null. Mutates `d`; returns { filled: [{ answer, clue, source, prevClue, prevSource }], none }
 * — `filled` is what undoFilledClues() needs.
 */
export function fillMissingClues(d, entries, suggest) {
  const filled = [];
  let none = 0;
  const done = new Set();
  d.clueSources = { ...(d.clueSources || {}) };
  for (const e of entries) {
    if (!e.answer || done.has(e.answer) || normalizeClue(d.clues[e.answer] ?? '')) continue;
    done.add(e.answer);
    const top = suggest(e.answer);
    if (!top || !normalizeClue(top.clue || '')) { none++; continue; }
    const source = top.source === 'theme' ? 'theme' : 'auto';
    filled.push({ answer: e.answer, clue: top.clue, source, prevClue: d.clues[e.answer], prevSource: d.clueSources[e.answer] });
    d.clues[e.answer] = top.clue;
    d.clueSources[e.answer] = source;
  }
  return { filled, none };
}

/**
 * Undo fillMissingClues() — but only for clues that are still exactly what it put there. Anything typed, picked
 * or marked reviewed since is kept. Mutates `d`; returns how many clues were removed.
 */
export function undoFilledClues(d, filled) {
  let n = 0;
  d.clueSources = { ...(d.clueSources || {}) };
  for (const f of filled) {
    if (d.clues[f.answer] !== f.clue || d.clueSources[f.answer] !== f.source) continue;
    if (f.prevClue === undefined) delete d.clues[f.answer]; else d.clues[f.answer] = f.prevClue;
    if (f.prevSource === undefined) delete d.clueSources[f.answer]; else d.clueSources[f.answer] = f.prevSource;
    n++;
  }
  return n;
}

/** Answers with a clue that Refill would clear (complete words with at least one unlocked letter). */
export function cluedWordsRefillWouldReplace(d) {
  const locked = new Set(d.locked);
  const out = new Set();
  for (const e of draftEntries(d).all) {
    if (!e.answer || !normalizeClue(d.clues[e.answer] ?? '')) continue;
    if (e.cells.some((i) => !locked.has(i))) out.add(e.answer);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// "Is the published puzzle up to date?"

/** FNV-1a (32-bit) of a string, as 8 hex digits. */
function fnv1a(text, seed = 0x811c9dc5) {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * A short fingerprint of what solvers get from a published-format puzzle (ignores publishedAt / preview flags).
 * Stored on the draft at publish time (`publishedFingerprint`) to notice edits that are not published yet.
 */
export function puzzleFingerprint(puzzle) {
  if (!puzzle || typeof puzzle !== 'object') return '';
  const text = JSON.stringify([
    puzzle.date, puzzle.title, puzzle.author, puzzle.note, puzzle.width, puzzle.height, puzzle.layout,
    puzzle.circles, puzzle.shaded, puzzle.solution, puzzle.checksum, puzzle.clues,
  ]);
  return fnv1a(text) + fnv1a(text, 0x01234567);
}

/** The fingerprint the draft would publish as right now ('' when it cannot be published as it is). */
export function draftFingerprint(d) {
  const { puzzle } = draftToPuzzle(d);
  return puzzle ? puzzleFingerprint(puzzle) : '';
}

/**
 * True when the draft has edits that the published puzzle does not have yet. `publishedFp` defaults to the
 * fingerprint recorded at publish time; drafts published before that was recorded give false (unknown).
 */
export function hasUnpublishedChanges(d, publishedFp = d?.publishedFingerprint) {
  if (!publishedFp) return false;
  return draftFingerprint(d) !== publishedFp;
}
