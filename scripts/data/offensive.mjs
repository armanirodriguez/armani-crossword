// Detect WordNet senses we never want to derive entries or clues from: senses marked as obscene, slurs or
// disparaging (usage-domain pointers), senses whose gloss describes slang / vulgar / sexual / drug meanings, and senses
// whose synset contains a banned word ("cock, prick, dick, shaft, pecker, tool, putz").

// Usage-domain synsets (";u" pointers): obscenity/vulgarism, ethnic slur, disparagement.
const BAD_USAGE = new Set(['n07139048', 'n06731706', 'n06730109']);

const OFFENSIVE_GLOSS = new RegExp([
  'offensive', 'obscen', 'vulgar', 'slur', 'derogator', 'disparag', 'contemptuous', 'taboo', 'insulting',
  'slang for', 'slang term', 'street names?', 'sexual', 'sex act', 'copulat', 'genital', 'penis', 'vagina', 'testicle',
  'scrotum', '\\banus', 'buttocks', 'nipple', 'feces', 'faeces', 'excrement', '\\burin', 'masturbat',
  'prostitut', 'brothel', '\\bpimp\\b', 'orgasm', 'erotic', 'porno', 'homosexual', 'lesbian', 'heroin\\b', 'cocaine',
  'marijuana', 'cannabis', 'hallucinogen', 'narcotic', '\\brape', 'incest', 'pedophil', '\\bnazi', 'lynch', 'suicide',
  'genocide', 'holocaust', 'torture', 'killing of', 'menstrua', 'vomit', 'diarrhea', 'flatulen',
].join('|'), 'i');

/** True if a synset should never be used for entries or clues. `isBanned(WORD)` checks the ban list. */
export function isOffensiveSynset(synset, isBanned) {
  if (synset.ptrs.some((p) => p.sym === ';u' && BAD_USAGE.has(p.key))) return true;
  if (OFFENSIVE_GLOSS.test(synset.gloss)) return true;
  return synset.words.some((w) => isBanned(w.replace(/[^A-Za-z]/g, '').toUpperCase()));
}

/** True if free text (a clue) contains a banned word. */
export function textHasBannedWord(text, isBanned) {
  const toks = String(text).match(/[A-Za-z]+/g) || [];
  return toks.some((t) => t.length >= 3 && isBanned(t.toUpperCase()));
}
