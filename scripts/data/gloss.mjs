// Text helpers for turning WordNet glosses into short crossword clues, and for making sure a clue never gives away
// its answer.

import { normalizeAnswer } from '../../site/shared/puzzle.js';

export const MAX_CLUE_LENGTH = 60;

// A leading "(domain)" in a gloss becomes a crossword-style suffix: "(Greek mythology) god of love" ->
// "God of love, in Greek myth". Unlisted domains that look like a subject ("(baseball)") become ", in <domain>";
// usage notes ("(of persons)", "(usually followed by `to')") are simply dropped.
const DOMAIN_SUFFIX = {
  'greek mythology': 'in Greek myth', 'roman mythology': 'in Roman myth', 'norse mythology': 'in Norse myth',
  'classical mythology': 'in classical myth', 'teutonic mythology': 'in Germanic myth', 'celtic mythology': 'in Celtic myth',
  'egyptian mythology': 'in Egyptian myth', 'hindu mythology': 'in Hindu myth', 'irish mythology': 'in Irish myth',
  'old testament': 'in the Old Testament', 'new testament': 'in the New Testament', 'bible': 'in the Bible',
  'informal': 'informally', 'slang': 'in slang', 'colloquial': 'informally', 'british': 'in Britain',
  'chiefly british': 'in Britain', 'british informal': 'in British slang', 'archaic': 'archaically',
  'obsolete': 'archaically', 'scottish': 'in Scotland', 'australian': 'in Australia', 'canadian': 'in Canada',
  'mathematics': 'in math', 'computer science': 'in computing', 'computing': 'in computing', 'nautical': 'at sea',
  'military': 'in the military', 'roman catholic church': 'in the Catholic Church', 'christianity': 'in Christianity',
};
const SUBJECT_DOMAIN = /^[a-z][a-z ]{2,24}$/; // plain subject such as "baseball", "music", "law", "Italian cuisine"
const USAGE_NOTE = /^(of|usually|often|sometimes|especially|esp|used|followed|preceded|plural|singular|or|as|in|with|by|for|e\.g|i\.e)\b|`|'/i;

// Words a clue must not end with after cutting (dangling function words).
const TRAILING_STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'nor', 'but', 'of', 'to', 'with', 'for', 'in', 'on', 'by', 'as', 'at', 'from', 'into',
  'onto', 'that', 'which', 'who', 'whom', 'whose', 'is', 'are', 'was', 'were', 'be', 'its', 'their', 'his', 'her',
  'especially', 'usually', 'often', 'very', 'more', 'most', 'than', 'being', 'such', 'some', 'any', 'one', 'other',
  'not', 'no', 'so', 'when', 'where', 'while', 'if', 'about', 'between', 'over', 'under', 'through', 'without',
  'within', 'having', 'esp', 'typically', 'etc', 'e.g', 'i.e', 'like', 'also', 'up', 'kind', 'sort', 'type', 'lot',
  'number', 'series', 'piece', 'variety', 'manner', 'way', 'degree',
]);

// Cut points, strongest first: we cut *before* the matched text. Weak cuts (prepositions) are used only when no
// strong one produces a short-enough clue. " of " / " and " / " or " are never cut points (they carry the meaning).
const STRONG_CUTS = [', ', ' that ', ' which ', ' who ', ' whose ', ' where ', ' when ', ' usually ', ' especially ',
  ' typically ', ' often ', ' sometimes ', ' esp ', ' such as ', ' including ', ' consisting ', ' as in ', ' i.e. ',
  ' e.g. ', ' resulting ', ' characterized ', ' used ', ' made ', ' based ', ' known ', ' found ', ' located ',
  ' formerly ', ' named ', ' noted ', ' remembered ', ' famous ', ' celebrated ', ' best known '];
const WEAK_CUTS = [' with ', ' in ', ' on ', ' for ', ' from ', ' by ', ' to ', ' at ', ' into ', ' during ', ' after ',
  ' before ', ' between ', ' against ', ' without ', ' having ', ' as '];
// Last resort: drop a trailing coordinate or complement ("member of a state or other political community" ->
// "member of a state").
const LAST_RESORT_CUTS = [' or ', ' and ', ' of '];
const INCOMPLETE_ENDING = /\b(in|with|by|on) (association|connection|addition|contrast|relation|response|accordance|conjunction|comparison|conformity|combination|order|front|place|terms|case|favor|favour|charge|spite|view|light|search|need|return|exchange|preparation|honor|memory|anticipation|behalf)$/i;
const TO_HEADS = /\b(belonging|relating|pertaining|related|attached|similar|equal|close|according|prior|subject|contrary|opposed|accustomed|devoted|ability|inability|tendency|right|power|attempt|desire|need|failure|effort|means|permission|willingness|unwillingness|readiness|capacity|freedom|chance|opportunity|intention|obligation|duty|way|order|able|unable|likely|ready|willing|due|used|tending|inclined|enough|sufficient|so as|as)$/i;
const OF_HEADS = /\b(sum|product|total|result|difference|quotient|ratio|square|kind|sort|type|course|part|piece|lot|number|group|series|set|variety|member|one|form|act|state|quality|process|means|way|amount|degree|lack|use|study|branch|unit|period|section|division|portion|side|end|top|bottom|front|back|center|centre|edge|rest|full|matter|instance|case|example)$/i;

const REPLACEMENTS = [
  [/\bUnited States\b/g, 'U.S.'], [/\bUnited Kingdom\b/g, 'U.K.'], [/\bU\.S\.\s+of\s+America\b/g, 'U.S.'],
  [/\s+/g, ' '],
];

/** Uppercase the first letter. */
export function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Split a raw WordNet gloss into its definition (before examples / first semicolon), domain and cleaned text. */
export function glossDefinition(gloss) {
  let g = String(gloss || '');
  const quote = g.indexOf('"');
  if (quote >= 0) g = g.slice(0, quote); // example sentences
  g = g.replace(/;\s*$/, '').trim();
  let domain = null;
  const m = g.match(/^\(([^)]*)\)\s*/);
  if (m) {
    g = g.slice(m[0].length);
    const raw = m[1].trim();
    const d = raw.toLowerCase();
    if (DOMAIN_SUFFIX[d]) domain = DOMAIN_SUFFIX[d];
    else if (SUBJECT_DOMAIN.test(d) && !USAGE_NOTE.test(d)) domain = `in ${raw}`; // "(Italian cuisine)" keeps its case
  }
  // First definition only: split at semicolons outside parentheses. A leading clause that is only a usage note
  // ("of textiles; having a rough surface") is skipped.
  const clauses = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= g.length; i++) {
    if (g[i] === '(') depth++;
    else if (g[i] === ')') depth = Math.max(0, depth - 1);
    else if (i === g.length || (g[i] === ';' && depth === 0)) { clauses.push(g.slice(start, i).trim()); start = i + 1; }
  }
  g = (clauses[0] || '').split(' -- ')[0]; // "something unusual -- perhaps worthy of collecting"
  if (clauses.length > 1 && /^of (\w+ ?){1,3}$/i.test(g)) g = clauses[1];
  // "in American football a point awarded for ..." -> "point awarded for ...", domain "in American football"
  const lead = !domain && g.match(/^in ((?:[A-Za-z]+ ){0,2}[A-Za-z]+),? (?=(a|an|the) )/);
  if (lead && !/^(a|an|the|which|that|order|addition|general|particular)\b/i.test(lead[1])) {
    domain = `in ${lead[1]}`;
    g = g.slice(lead[0].length);
  }
  // Remaining parentheticals: short object phrases are part of the sentence ("use of (land)", "from (a casting)")
  // and lose their parentheses; anything else (life dates, trade names, usage asides) is removed.
  let broken = false;
  g = g.replace(/\s*\(([^()]*)\)/g, (m, inner) => {
    const t = inner.trim();
    // "having a tendency (to)": a bare preposition keeps its parentheses, the crossword convention.
    if (/^(to|on|of|with|for|from|by|at|in|into|up|out|off)$/.test(t)) return ` (${t})`;
    const objectLike = /^(?:(?:a|an|the) )?[a-z]+$/.test(t) || /^[a-z]+ or [a-z]+$/.test(t);
    if (objectLike && !/ly\b/.test(t) && !USAGE_NOTE.test(t)) return ` ${t}`;
    // A longer parenthetical that is the sentence's object ("preventing (the efforts, plans, or desires) of") can't
    // be dropped without breaking the definition.
    if (/^(the|a|an|one's|someone's|someone|something|his|her|their|its)\b/.test(t)) broken = true;
    return '';
  });
  if (broken) g = '';
  for (const [re, rep] of REPLACEMENTS) g = g.replace(re, rep);
  return { text: g.trim(), domain };
}

/** Strip trailing punctuation, keeping the final period of an abbreviation ("U.S."). */
function stripPunct(text) {
  const t = text.replace(/[\s,;:.-]+$/, '');
  return /\b(?:[A-Z]\.)+[A-Z]$/.test(t) ? `${t}.` : t;
}

function stripTrailing(text) {
  let t = stripPunct(text);
  for (;;) {
    const m = t.match(/\s+([A-Za-z.]+)$/);
    if (!m || !TRAILING_STOP.has(m[1].toLowerCase())) break;
    t = stripPunct(t.slice(0, m.index));
  }
  return t;
}

// Hedges after which a definition can always be cut, even when it is short enough ("..., especially in Ireland").
const HEDGE_CUTS = [' especially ', ' usually ', ' typically ', ' esp ', ' e.g. ', ' i.e. ', ', as ', ', also '];

/**
 * Cut `text` to at most `max` chars at the best boundary, or return null if no acceptable cut exists.
 * A cut result needs >= 3 words and must not end on a dangling word (`badEnding`, e.g. a verb form that needs an
 * object: "measures for apprehending"). Cuts before character `minCut` are not allowed (used to keep a noun
 * phrase's head: "small usually nocturnal lizard" must not become "Small").
 */
export function cutToLength(text, max, badEnding = () => false, minCut = 0, okCoordinationCut = () => true) {
  const acceptable = (c, minWords = 3) => c.length >= 8 && c.length <= max && c.split(' ').length >= minWords &&
    !badEnding(c.slice(c.lastIndexOf(' ') + 1).toLowerCase()) &&
    !/\b(that|which|who|whom|whose|where|when)( \S+){0,3}$/.test(c) && // no truncated relative clause
    !INCOMPLETE_ENDING.test(c); // "... in association" (with whom?)
  const bestCut = (cuts, limit, minWords = 3) => {
    let best = null;
    for (const cut of cuts) {
      for (let i = text.indexOf(cut); i >= 0 && i <= limit; i = text.indexOf(cut, i + 1)) {
        if (i < minCut) continue;
        // "member of a state | or other political community" is a safe cut; "ice hockey | or soccer team" is not.
        const after = text.slice(i + cut.length);
        const next = after.split(' ')[0];
        // Never cut inside a list: "situation, | condition, or course of action".
        if (cut === ', ' && (/^(or|and)\b/.test(after) || /^[\w-]+(?: [\w-]+)?,? (?:or|and) /.test(after))) continue;
        if ((cut === ' or ' || cut === ' and ') && !okCoordinationCut(next)) continue;
        if (cut === ' of ' && /^(which|whom|whose)$/.test(next)) continue; // "fly the female | of which ..."
        // "course | of action", "kind | of situation": the noun before " of " is meaningless without its complement.
        if (cut === ' of ' && OF_HEADS.test(text.slice(0, i))) continue;
        if (cut === ' of ' && /^[A-Z]/.test(next)) continue; // "the character | of Philip Marlowe"
        if (/^ (which|whom) $/.test(cut) && /\bof$/.test(text.slice(0, i))) continue; // same, cut one word later
        // "no ability | to roar", "a tendency | to ...": these nouns need their complement.
        if (cut === ' to ' && TO_HEADS.test(text.slice(0, i))) continue;
        const candidate = stripTrailing(text.slice(0, i));
        // Trailing-word stripping can itself expose "the sum | of one and one": re-check the noun before " of ".
        if (text.startsWith(' of ', candidate.length) && OF_HEADS.test(candidate)) continue;
        if (acceptable(candidate, minWords) && (!best || candidate.length > best.length)) best = candidate;
      }
    }
    return best;
  };
  const hedged = bestCut(HEDGE_CUTS, max, 2); // "Feline mammal | usually having thick soft fur ..."
  if (hedged) return hedged;
  if (text.length <= max) return stripPunct(text);
  return bestCut(STRONG_CUTS, max) || bestCut(WEAK_CUTS, max) || bestCut(LAST_RESORT_CUTS, max);
}

/**
 * Turn a gloss into a clue: first definition, leading article removed, capitalized, <= MAX_CLUE_LENGTH chars,
 * cut at a natural boundary, domain appended (", in Greek myth"). Returns null if it can't be made short and clean.
 */
export function shortenGloss(gloss, opts = {}) {
  const { text, domain } = glossDefinition(gloss);
  return finishGlossText(text, domain, opts);
}

/** Shared tail of shortenGloss, exported so callers can transform the definition text first (inflection). */
export function finishGlossText(text, domain, { maxLength = MAX_CLUE_LENGTH, badEnding, minCut = 0, okCoordinationCut } = {}) {
  const article = text.match(/^\s*(a|an|the)\s+/i);
  let t = text.slice(article ? article[0].length : 0).trim();
  if (article) minCut = Math.max(0, minCut - article[0].length);
  if (!t || /[`"]|\s'|'\s|'$|\.\.\.|[[\]{}<>=]/.test(t)) return null;
  // ", in sports" adds nothing to "Bodily position adopted in some sports".
  const domainWord = domain ? domain.split(' ').pop().toLowerCase() : '';
  const suffix = domain && !t.toLowerCase().includes(domainWord) ? `, ${domain}` : '';
  const cut = cutToLength(t, maxLength - suffix.length, badEnding, minCut, okCoordinationCut);
  if (!cut) return null;
  t = cut;
  if (t.length < 3 || /^[^A-Za-z]/.test(t) || /\b(e\.g|i\.e|etc)\b/.test(t)) return null;
  if (/[(,]$/.test(t) || (/\)$/.test(t) && !/ \([a-z]+\)$/.test(t))) return null;
  if ((t.match(/\(/g) || []).length !== (t.match(/\)/g) || []).length) return null;
  return capitalize(t) + suffix;
}

/** Lowercase alphabetic tokens of a clue. */
export function clueTokens(clue) {
  return String(clue).toLowerCase().match(/[a-z]+/g) || [];
}

/**
 * Do two words share a stem? Conservative (prefers false positives): equal, one nearly a prefix of the other
 * (run/running, abandon/abandonment), or a long common prefix (decide/decision).
 */
export function shareStem(a, b) {
  if (a === b) return true;
  const m = Math.min(a.length, b.length);
  let lcp = 0;
  while (lcp < m && a[lcp] === b[lcp]) lcp++;
  if (lcp < 3) return false;
  return lcp >= m - 1 || (lcp >= 4 && lcp >= 0.6 * m);
}

/**
 * True if `clue` gives away `answer`: its letters contain the answer (the builder's own check, spaces ignored), or a
 * clue word shares a stem with the answer or with one of `related` (base lemma, phrase parts; >= 3 letters).
 */
export function clueLeaks(clue, answer, related = []) {
  const A = answer.toUpperCase();
  if (normalizeAnswer(clue).includes(A)) return true;
  const forbidden = [A.toLowerCase(), ...related.map((r) => r.toLowerCase()).filter((r) => r.length >= 3)];
  const a = A.toLowerCase();
  for (const tok of clueTokens(clue)) {
    // Function words only count when identical ("the" must not block THEME, but does block THE).
    if (FUNCTION_TOKENS.has(tok)) {
      if (forbidden.includes(tok)) return true;
      continue;
    }
    for (const f of forbidden) if (shareStem(tok, f)) return true;
    // A clue word hidden inside the answer: RECONSTRUCTED / "constructed", SANDPAPER / "paper", or a 3-letter part
    // of a compound: HUBCAP / "cap", BUTTERFLY / "fly".
    if (tok.length >= 4 && a.includes(tok)) return true;
    if (tok.length === 3 && a.length >= 6 && (a.startsWith(tok) || a.endsWith(tok))) return true;
    // A variant spelling: DISENFRANCHISE / "disfranchise", COLOUR / "color", TYMPANIST / "timpanist".
    if (tok.length >= 5 && tok.length >= 0.7 * a.length && isSubsequence(tok, a)) return true;
    if (tok.length >= 7 && tok[0] === a[0] && Math.abs(tok.length - a.length) <= 2 && editDistance(tok, a, 2) <= 2) return true;
  }
  return false;
}

/** Levenshtein distance, giving up (returning max + 1) once it exceeds `max`. */
function editDistance(x, y, max) {
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[y.length];
}

function isSubsequence(small, big) {
  let j = 0;
  for (let i = 0; i < big.length && j < small.length; i++) if (big[i] === small[j]) j++;
  return j === small.length;
}

const FUNCTION_TOKENS = new Set([
  'a', 'an', 'the', 'and', 'or', 'nor', 'but', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into',
  'onto', 'that', 'this', 'these', 'those', 'than', 'then', 'there', 'their', 'they', 'them', 'one', 'ones', 'are',
  'was', 'were', 'has', 'had', 'have', 'not', 'all', 'any', 'can', 'out', 'its', 'his', 'her', 'him', 'our', 'you',
  'who', 'how', 'may', 'now', 'off', 'too', 'use', 'used', 'way', 'some', 'such', 'more', 'most', 'other', 'over',
  'under', 'about', 'which', 'what', 'when', 'where', 'while', 'being', 'been', 'also', 'very', 'usually', 'often',
  'especially', 'etc',
]);
