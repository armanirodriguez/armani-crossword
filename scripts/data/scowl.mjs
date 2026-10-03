// SCOWL word lists, as packaged by `wordlist-english`.
//
// Files are `<variant>-words-<level>.json` where a LOWER level means a MORE common word (10 = the ~4k most common
// words … 70 = rare dictionary words). We read the dialect-neutral "english" lists plus the "american" additions
// (so we get COLOR, not COLOUR). The package lowercases nearly everything; the few mixed-case entries (OK, dB, pH)
// are kept with their original spelling in `cased` so callers can treat them as proper nouns / symbols.

import fs from 'node:fs';
import path from 'node:path';

export const SCOWL_LEVELS = [10, 20, 35, 40, 50, 55, 60, 70];
const VARIANTS = ['english', 'american'];

/** Strip accents: "café" -> "cafe". */
export function deaccent(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Load SCOWL levels.
 * Returns {
 *   level: Map<lowercase word, lowest level>,  // lowercase entries only (accents stripped)
 *   cased: Map<original-case word, lowest level>, // entries containing capitals ("OK", "kHz")
 *   all: Set<lowercase word>,                   // every entry lowercased — the spelling oracle for inflection
 *   version: string
 * }
 */
export function loadScowl(pkgDir) {
  const level = new Map();
  const cased = new Map();
  const all = new Set();
  for (const lvl of SCOWL_LEVELS) {
    for (const variant of VARIANTS) {
      const file = path.join(pkgDir, `${variant}-words-${lvl}.json`);
      if (!fs.existsSync(file)) continue;
      for (const raw of JSON.parse(fs.readFileSync(file, 'utf8'))) {
        const w = deaccent(String(raw));
        if (!/^[A-Za-z]+$/.test(w)) continue; // apostrophes, digits, hyphens: not crossword entries
        all.add(w.toLowerCase());
        if (w !== w.toLowerCase()) {
          if (!cased.has(w)) cased.set(w, lvl);
        } else if (!level.has(w)) {
          level.set(w, lvl);
        }
      }
    }
  }
  let version = '';
  try {
    version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version || '';
  } catch { /* optional */ }
  return { level, cased, all, version };
}
