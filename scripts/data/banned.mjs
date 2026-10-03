// Banned words: never allowed in fills or clues.
//
// Sources, all applied by the build:
//   1. data/banned.txt — one word per line, '#' comments; explicit list incl. variants (editable by the user).
//   2. Plural / 3rd-person forms of every listed word are banned automatically ("slur" -> "slurs").
//      (-ED/-ING forms are NOT generated automatically — they collide with innocent words — list them explicitly.)
//   3. BANNED_ROOTS: substrings that never occur in an acceptable entry, so compounds are caught too
//      ("bullshit", "motherfucker"). Only unambiguous roots belong here: "rapist" (therapist), "wank" (swank),
//      "twat" (wristwatch) and "nigg" (niggle) would hit innocent words.
//   4. Curated TSV rows with score 0 (handled in curated.mjs).

import { inflectionCandidates } from './morphology.mjs';

export const BANNED_ROOTS = [
  'fuck', 'shit', 'cunt', 'whore', 'bitch', 'porn', 'dildo', 'jizz', 'asshole', 'arsehole', 'dickhead', 'cocksuck',
  'nigger', 'nigga', 'faggot', 'slut', 'blowjob', 'handjob', 'rimjob', 'masturbat', 'ejaculat', 'pedophil',
  'paedophil', 'jigaboo', 'pickaninny', 'wetback', 'raghead', 'towelhead',
];

/** Parse a word-per-line file (banned.txt). Returns a Set of uppercase A–Z words. */
export function parseWordList(text) {
  const out = new Set();
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const word = line.split(/[\s;#]/)[0].toUpperCase().replace(/[^A-Z]/g, '');
    if (word) out.add(word);
  }
  return out;
}

/** Add plural / 3rd-person-singular spellings of every banned word (uppercase in, uppercase out). */
export function expandBanned(words) {
  const out = new Set(words);
  for (const w of words) {
    for (const form of ['pl', 's']) {
      // Only regular -s/-es/-ies/-ves spellings: Latin candidates would ban innocent words (anus -> ANI, a bird).
      for (const c of inflectionCandidates(w.toLowerCase(), form)) if (c.endsWith('s')) out.add(c.toUpperCase());
    }
  }
  return out;
}

/** A predicate over uppercase A–Z words: banned explicitly (incl. expansions) or containing a banned root. */
export function makeBannedPredicate(bannedSet) {
  const roots = BANNED_ROOTS.map((r) => r.toUpperCase());
  return (word) => {
    const w = word.toUpperCase();
    return bannedSet.has(w) || roots.some((r) => w.includes(r));
  };
}
