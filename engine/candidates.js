// Candidate words for one entry, ranked for the builder's side panel (SPEC §3.4).
//
// viability = min over the entry's incomplete crossing entries of the number of list words that still fit that
// crossing once the candidate is placed (0 = the candidate makes some crossing impossible; null = no incomplete
// crossings). Placing a word only changes one letter of each crossing pattern, so for every crossing we count the
// matches for each of the 26 letters once (≤ 26 bitset counts) and look candidates up in that table — cheap even
// for an empty 15-letter slot with thousands of candidates.

import { computeEntries, entryPattern, isLetter } from '../site/shared/grid.js';
import { normalizeWord } from './util.js';
import { penaltiesOption } from './fill.js';

/**
 * @param {{width:number,height:number,cells:string[]}} grid
 * @param {string} entryId e.g. '12A'
 * @param {import('./wordlist.js').WordList} wordlist
 * @param {{minScore?:number, limit?:number, filter?:string, penalize?:object|Map|Array}} options
 *   filter: only words containing this text (letters only; case-insensitive). A leading '^' means "starts with".
 *   penalize: answer freshness penalties as for fillGrid; rows of penalized words get `penalized: true` (the order
 *   is unchanged — the builder shows the tag next to the real score).
 * @returns {{word:string, score:number, viability:number|null, penalized?:true}[]} viable words first, by score
 *   (desc), then by viability (desc) and alphabetically; dead ends (viability 0) last. Malformed input (no grid,
 *   cells of the wrong shape, no word list) gives [] rather than an exception.
 */
export function rankCandidates(grid, entryId, wordlist, options = {}) {
  if (!options || typeof options !== 'object') options = {};
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 0;
  const limit = Number.isFinite(options.limit) ? options.limit : options.limit === Infinity ? Infinity : 200;
  const filter = options.filter ?? '';
  const penalties = penaltiesOption(options.penalize);
  if (!wellFormed(grid) || !wordlist || typeof wordlist.match !== 'function') return [];
  const { all, acrossAt, downAt, across, down } = computeEntries(grid);
  const entry = all.find((e) => e.id === entryId);
  if (!entry) return [];
  const pattern = entryPattern(grid, entry);

  // Words already used elsewhere in the grid are not offered again.
  const used = new Set();
  for (const e of all) {
    if (e === entry) continue;
    const p = entryPattern(grid, e);
    if (!p.includes('.')) used.add(p);
  }

  const rawFilter = String(filter ?? '').trim();
  const prefixOnly = rawFilter.startsWith('^');
  const needle = normalizeWord(rawFilter);
  let matches = wordlist.match(pattern, { minScore, exclude: used });
  if (needle) matches = matches.filter(({ word }) => (prefixOnly ? word.startsWith(needle) : word.includes(needle)));

  // Per crossing: number of matches for each letter placed at the crossing cell.
  const tables = [];
  entry.cells.forEach((cell, k) => {
    if (isLetter(grid.cells[cell])) return; // letter already fixed: every candidate agrees with it
    const other = entry.dir === 'across' ? down[downAt[cell]] : across[acrossAt[cell]];
    if (!other) return; // unchecked cell
    const crossPattern = entryPattern(grid, other);
    const q = other.cells.indexOf(cell);
    const counts = new Int32Array(26).fill(-1);
    tables.push({ k, q, crossPattern, counts });
  });

  const out = matches.map(({ word, score }) => {
    let viability = null;
    for (const t of tables) {
      const code = word.charCodeAt(t.k) - 65;
      let n = t.counts[code];
      if (n < 0) {
        const p = t.crossPattern.slice(0, t.q) + word[t.k] + t.crossPattern.slice(t.q + 1);
        n = wordlist.count(p, { minScore });
        t.counts[code] = n;
      }
      if (viability === null || n < viability) viability = n;
    }
    return penalties.has(word) ? { word, score, viability, penalized: true } : { word, score, viability };
  });

  out.sort((a, b) => {
    const deadA = a.viability === 0 ? 1 : 0;
    const deadB = b.viability === 0 ? 1 : 0;
    return deadA - deadB || b.score - a.score || (b.viability ?? 0) - (a.viability ?? 0) || (a.word < b.word ? -1 : 1);
  });
  return out.slice(0, Math.max(0, limit));
}

/** A grid object with integer dimensions and a cells array of matching length holding only '#', '' or A–Z. */
function wellFormed(grid) {
  if (!grid || typeof grid !== 'object') return false;
  const { width, height, cells } = grid;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return false;
  if (!Array.isArray(cells) || cells.length !== width * height) return false;
  return cells.every((ch) => ch === '#' || ch === '' || isLetter(ch));
}
