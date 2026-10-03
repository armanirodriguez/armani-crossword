// Curated TSV files (data/curated/*.tsv), SPEC §2.9:
//   WORD<TAB>SCORE<TAB>clue 1[<TAB>clue 2[<TAB>clue 3 ...]]      '#' comment lines, blank lines ignored.
// Merge rules when several rows/files mention a word: any score 0 bans it; otherwise the max score wins; clues are
// concatenated in file order (files sorted by name) and de-duplicated (case-insensitively).

import fs from 'node:fs';
import path from 'node:path';
import { normalizeAnswer, normalizeClue } from '../../site/shared/puzzle.js';

/**
 * Parse one TSV file's text. Returns { rows: [{ word, score, clues, line }], warnings: string[] }.
 * Rows with an invalid word or score are skipped with a warning (never fatal: curation may be in progress).
 */
export function parseCuratedTsv(text, name = 'tsv') {
  const rows = [];
  const warnings = [];
  String(text ?? '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) return;
    const cols = line.split('\t');
    const word = normalizeAnswer(cols[0]);
    const where = `${name}:${i + 1}`;
    if (word.length < 3 || word.length > 21) {
      warnings.push(`${where}: skipped "${cols[0]}" (needs 3–21 letters A–Z)`);
      return;
    }
    const scoreText = (cols[1] ?? '').trim();
    if (!/^\d{1,3}$/.test(scoreText) || Number(scoreText) > 100) {
      warnings.push(`${where}: skipped ${word} (score "${scoreText}" is not an integer 0–100)`);
      return;
    }
    const clues = cols.slice(2).map(normalizeClue).filter(Boolean);
    rows.push({ word, score: Number(scoreText), clues, line: i + 1 });
  });
  return { rows, warnings };
}

/**
 * Merge parsed rows (in order) into Map<WORD, { score, banned, clues: string[], sources: string[] }>.
 * `rowsBySource` = [{ name, rows }]. Clues containing their own answer are dropped (and reported).
 */
export function mergeCurated(rowsBySource) {
  const merged = new Map();
  const warnings = [];
  for (const { name, rows } of rowsBySource) {
    for (const { word, score, clues } of rows) {
      let e = merged.get(word);
      if (!e) merged.set(word, (e = { score, banned: false, clues: [], sources: [] }));
      else e.score = Math.max(e.score, score);
      if (score === 0) e.banned = true;
      if (!e.sources.includes(name)) e.sources.push(name);
      for (const clue of clues) {
        if (normalizeAnswer(clue).includes(word)) {
          warnings.push(`${name}: dropped clue for ${word} that contains the answer: "${clue}"`);
          continue;
        }
        const key = clue.toLowerCase();
        if (!e.clues.some((c) => c.toLowerCase() === key)) e.clues.push(clue);
      }
    }
  }
  for (const e of merged.values()) if (e.banned) e.score = 0;
  return { merged, warnings };
}

/** Read and merge every *.tsv in a directory (sorted by file name). Missing directory -> empty result. */
export function loadCuratedDir(dir) {
  const rowsBySource = [];
  const warnings = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.tsv')).sort();
  } catch {
    return { merged: new Map(), warnings: [`curated dir not found: ${dir}`], files: [] };
  }
  for (const f of files) {
    const parsed = parseCuratedTsv(fs.readFileSync(path.join(dir, f), 'utf8'), f);
    rowsBySource.push({ name: f, rows: parsed.rows });
    warnings.push(...parsed.warnings);
  }
  const { merged, warnings: mergeWarnings } = mergeCurated(rowsBySource);
  return { merged, warnings: [...warnings, ...mergeWarnings], files };
}
