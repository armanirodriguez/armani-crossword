// Clue quality gates for Claude's way (SPEC §9), pure functions shared by `publish` and `check`.
//
// Errors (publishing refuses): a missing clue, a clue over MAX_CLUE_LENGTH, a clue that contains its own answer
// (as a whole word; for answers of 4+ letters also as letters starting at a word, so "ice-cream" leaks ICECREAM but
// "presidenT AFTer" does not leak TAFT) or a
// word sharing the answer's root (BAKING for BAKED, RUNNING for RUNS), duplicate clue text, a banned word in an
// answer or a clue, a missing title. Warnings (shown, not blocking): a clue word hidden inside the answer
// (HOUSE in HAUNTEDHOUSE), which is usually worth rephrasing.

import { MAX_CLUE_LENGTH } from './common.mjs';

/** Uppercase A–Z words of a text (accents stripped): "Jack-o'-lantern" -> ['JACK', 'O', 'LANTERN']. */
export function textWords(text) {
  return String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().match(/[A-Z]+/g) || [];
}

const lettersOnly = (text) => textWords(text).join('');

/**
 * True when `answer` (4+ letters) runs through the clue's letters starting at the start of a word: "Ice-cream treat"
 * leaks ICECREAM, "Greatly" leaks GREAT. Mid-word runs are coincidences a solver never sees (TAFT in "presidenT
 * AFTer", EAR in "hEARing") and are fine.
 */
function leaksAcrossWords(clue, answer) {
  const words = textWords(clue);
  const joined = words.join('');
  let start = 0;
  const starts = new Set();
  for (const w of words) {
    starts.add(start);
    start += w.length;
  }
  for (let i = joined.indexOf(answer); i !== -1; i = joined.indexOf(answer, i + 1)) if (starts.has(i)) return true;
  return false;
}

/**
 * Candidate roots of a word (uppercase A–Z), each at least 3 letters, including the word itself:
 * BAKED -> BAKED, BAK, BAKE; RUNNING -> RUNNING, RUNN, RUNNE, RUN; PARTIES -> PARTIES, PARTY, PARTIE, PARTI.
 */
export function stems(word) {
  const w = String(word).toUpperCase().replace(/[^A-Z]/g, '');
  const out = new Set();
  const add = (s) => {
    if (s.length >= 3) out.add(s);
  };
  const base = (s) => {
    add(s);
    // A doubled final consonant: RUNN -> RUN, STOPP -> STOP (not LL / SS: SPELL, PASS keep theirs as well).
    if (/([B-DF-HJ-NP-TV-Z])\1$/.test(s)) add(s.slice(0, -1));
    add(`${s}E`);
  };
  add(w);
  const strip = (x) => {
    for (const [suf, rep] of [['IES', 'Y'], ['IED', 'Y'], ['IER', 'Y'], ['IEST', 'Y'], ['ILY', 'Y']]) {
      if (x.endsWith(suf) && x.length - suf.length >= 2) add(x.slice(0, -suf.length) + rep);
    }
    for (const suf of ['INGS', 'ING', 'ED', 'ERS', 'ER', 'EST', 'LY', 'NESS', 'ES', 'S']) {
      if (!x.endsWith(suf) || x.length - suf.length < 3) continue;
      if (suf === 'S' && /SS$/.test(x)) continue;
      const root = x.slice(0, -suf.length);
      if (suf === 'S' || suf === 'ES' || suf === 'LY' || suf === 'NESS') add(root);
      else base(root);
    }
  };
  strip(w);
  // One more level for plurals of derived forms: BAKERS -> BAKER -> BAKE.
  if (/S$/.test(w) && !/SS$/.test(w)) strip(w.slice(0, -1));
  return out;
}

/**
 * Why a clue gives its answer away, or null:
 *   - the answer as a whole word of the clue, or (answers of 4+ letters) inside the clue's letters;
 *   - a clue word sharing a root with the answer.
 */
export function clueLeak(clue, answer) {
  const A = String(answer).toUpperCase();
  const words = textWords(clue);
  if (words.includes(A) || (A.length >= 4 && leaksAcrossWords(clue, A))) return `contains its answer ${A}`;
  const roots = stems(A);
  for (const w of words) {
    if (w.length < 3) continue;
    for (const s of stems(w)) {
      if (roots.has(s)) return `"${w.toLowerCase()}" shares the root ${s} with the answer ${A}`;
    }
  }
  return null;
}

const SMALL_WORDS = new Set(['THE', 'AND', 'FOR', 'BUT', 'NOT', 'ARE', 'WAS', 'ONE', 'HAS', 'HAD', 'ITS', 'YOU', 'WITH', 'THAT', 'THIS', 'FROM', 'INTO', 'ONTO', 'WHAT', 'WHEN', 'SOME', 'THEY', 'THEM', 'THAN', 'THEN', 'BEEN', 'HAVE', 'WERE', 'WILL', 'YOUR']);

/** A clue word hidden inside the answer (HOUSE in HAUNTEDHOUSE, CAP in HUBCAP), or null. Warning only. */
export function clueHint(clue, answer) {
  const A = String(answer).toUpperCase();
  for (const w of textWords(clue)) {
    if (SMALL_WORDS.has(w)) continue;
    if (w.length >= 4 && A.includes(w)) return `"${w.toLowerCase()}" is part of the answer ${A}`;
    if (w.length === 3 && A.length >= 6 && (A.startsWith(w) || A.endsWith(w))) return `"${w.toLowerCase()}" is part of the answer ${A}`;
  }
  return null;
}

/** Duplicate-detection key of a clue: case, spacing and punctuation ignored. */
export function clueKey(clue) {
  return String(clue ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Check a puzzle's clues and answers.
 * @param entries  [{ id: '1A', answer: 'PIE', clue: 'text' | '' }]
 * @param isBanned (WORD) -> reason | null
 * @param title    puzzle title
 * @returns { errors: string[], warnings: string[] }
 */
export function checkClues({ entries, isBanned = () => null, title }) {
  const errors = [];
  const warnings = [];
  if (!String(title ?? '').trim()) errors.push('The puzzle needs a title (plan "title" or --title)');
  const byKey = new Map();
  for (const e of entries) {
    const clue = String(e.clue ?? '').replace(/\s+/g, ' ').trim();
    const banned = isBanned(e.answer);
    if (banned) errors.push(`${e.id} ${e.answer}: banned answer (${banned})`);
    if (!clue) {
      errors.push(`${e.id} ${e.answer}: missing clue`);
      continue;
    }
    if (clue.length > MAX_CLUE_LENGTH) errors.push(`${e.id} ${e.answer}: clue is ${clue.length} characters (max ${MAX_CLUE_LENGTH})`);
    const leak = clueLeak(clue, e.answer);
    if (leak) errors.push(`${e.id} ${e.answer}: clue ${leak} — "${clue}"`);
    else {
      const hint = clueHint(clue, e.answer);
      if (hint) warnings.push(`${e.id} ${e.answer}: ${hint} — "${clue}"`);
    }
    const badWord = textWords(clue).find((w) => w.length >= 3 && isBanned(w));
    if (badWord) errors.push(`${e.id} ${e.answer}: clue uses a banned word (${badWord.toLowerCase()})`);
    const key = clueKey(clue);
    if (byKey.has(key)) errors.push(`${e.id} ${e.answer}: same clue as ${byKey.get(key)} — "${clue}"`);
    else byKey.set(key, `${e.id} ${e.answer}`);
  }
  return { errors, warnings };
}
