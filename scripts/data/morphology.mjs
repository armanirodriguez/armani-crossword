// English inflectional morphology for the word-data pipeline.
//
// WordNet's `*.exc` exception files are not shipped by the `wordnet-db` package, so we implement WordNet's "morphy"
// detachment rules ourselves, plus compact tables of irregular verbs and nouns, plus rules the original morphy lacks
// (consonant doubling, -ied/-ier/-iest, -ves plurals, Latin plurals).
//
// Two directions:
//   analyze(word)            "abandoned" -> [{ base: 'abandon', pos: 'v', form: 'ed' }]   (answer -> base lemma)
//   inflect(base, form)      ('stop', 'ed') -> 'stopped'                                   (synonym -> matching form)
// Generation produces candidate spellings by rule and lets a dictionary oracle (`isWord`, normally the SCOWL word
// set) pick the attested one; this resolves the cases rules alone get wrong (travel/traveled, refer/referred, roof/roofs).
//
// Forms: 'pl' noun plural · 's' verb 3rd-person singular · 'ed' verb past/past participle (regular -ED; ambiguous) ·
//        'past' irregular simple past · 'pp' irregular past participle · 'ing' present participle ·
//        'er' comparative · 'est' superlative.

// base: [past, pastParticiple]. Only verbs whose past or participle is not plain "+ed".
const IRREGULAR_VERBS = {
  abide: ['abode', 'abode'], arise: ['arose', 'arisen'], awake: ['awoke', 'awoken'], bear: ['bore', 'borne'],
  beat: ['beat', 'beaten'], become: ['became', 'become'], befall: ['befell', 'befallen'], beget: ['begot', 'begotten'],
  begin: ['began', 'begun'], behold: ['beheld', 'beheld'], bend: ['bent', 'bent'], beset: ['beset', 'beset'],
  bet: ['bet', 'bet'], bid: ['bid', 'bid'], bind: ['bound', 'bound'], bite: ['bit', 'bitten'], bleed: ['bled', 'bled'],
  blow: ['blew', 'blown'], break: ['broke', 'broken'], breed: ['bred', 'bred'], bring: ['brought', 'brought'],
  broadcast: ['broadcast', 'broadcast'], build: ['built', 'built'], burst: ['burst', 'burst'], buy: ['bought', 'bought'],
  cast: ['cast', 'cast'], catch: ['caught', 'caught'], choose: ['chose', 'chosen'], cling: ['clung', 'clung'],
  come: ['came', 'come'], cost: ['cost', 'cost'], creep: ['crept', 'crept'], cut: ['cut', 'cut'],
  deal: ['dealt', 'dealt'], dig: ['dug', 'dug'], dive: ['dove', 'dived'], do: ['did', 'done'], draw: ['drew', 'drawn'],
  drink: ['drank', 'drunk'], drive: ['drove', 'driven'], dwell: ['dwelt', 'dwelt'], eat: ['ate', 'eaten'],
  fall: ['fell', 'fallen'], feed: ['fed', 'fed'], feel: ['felt', 'felt'], fight: ['fought', 'fought'],
  find: ['found', 'found'], flee: ['fled', 'fled'], fling: ['flung', 'flung'], fly: ['flew', 'flown'],
  forbid: ['forbade', 'forbidden'], forecast: ['forecast', 'forecast'], foresee: ['foresaw', 'foreseen'],
  foretell: ['foretold', 'foretold'], forget: ['forgot', 'forgotten'], forgive: ['forgave', 'forgiven'],
  forsake: ['forsook', 'forsaken'], freeze: ['froze', 'frozen'], get: ['got', 'gotten'], give: ['gave', 'given'],
  go: ['went', 'gone'], grind: ['ground', 'ground'], grow: ['grew', 'grown'], hang: ['hung', 'hung'],
  have: ['had', 'had'], hear: ['heard', 'heard'], hew: ['hewed', 'hewn'], hide: ['hid', 'hidden'], hit: ['hit', 'hit'],
  hold: ['held', 'held'], hurt: ['hurt', 'hurt'], keep: ['kept', 'kept'], kneel: ['knelt', 'knelt'],
  know: ['knew', 'known'], lay: ['laid', 'laid'], lead: ['led', 'led'], leave: ['left', 'left'], lend: ['lent', 'lent'],
  let: ['let', 'let'], lie: ['lay', 'lain'], light: ['lit', 'lit'], lose: ['lost', 'lost'], make: ['made', 'made'],
  mean: ['meant', 'meant'], meet: ['met', 'met'], mislay: ['mislaid', 'mislaid'], mislead: ['misled', 'misled'],
  mistake: ['mistook', 'mistaken'], mow: ['mowed', 'mown'], outdo: ['outdid', 'outdone'], outrun: ['outran', 'outrun'],
  overcome: ['overcame', 'overcome'], overdo: ['overdid', 'overdone'], overhear: ['overheard', 'overheard'],
  override: ['overrode', 'overridden'], overrun: ['overran', 'overrun'], oversee: ['oversaw', 'overseen'],
  oversleep: ['overslept', 'overslept'], overtake: ['overtook', 'overtaken'], overthrow: ['overthrew', 'overthrown'],
  partake: ['partook', 'partaken'], pay: ['paid', 'paid'], put: ['put', 'put'], quit: ['quit', 'quit'],
  read: ['read', 'read'], rebuild: ['rebuilt', 'rebuilt'], redo: ['redid', 'redone'], repay: ['repaid', 'repaid'],
  rewrite: ['rewrote', 'rewritten'], rid: ['rid', 'rid'], ride: ['rode', 'ridden'], ring: ['rang', 'rung'],
  rise: ['rose', 'risen'], run: ['ran', 'run'], say: ['said', 'said'], see: ['saw', 'seen'], seek: ['sought', 'sought'],
  sell: ['sold', 'sold'], send: ['sent', 'sent'], set: ['set', 'set'], sew: ['sewed', 'sewn'], shake: ['shook', 'shaken'],
  shed: ['shed', 'shed'], shine: ['shone', 'shone'], shoot: ['shot', 'shot'], show: ['showed', 'shown'],
  shrink: ['shrank', 'shrunk'], shut: ['shut', 'shut'], sing: ['sang', 'sung'], sink: ['sank', 'sunk'], sit: ['sat', 'sat'],
  slay: ['slew', 'slain'], sleep: ['slept', 'slept'], slide: ['slid', 'slid'], sling: ['slung', 'slung'],
  slink: ['slunk', 'slunk'], slit: ['slit', 'slit'], sow: ['sowed', 'sown'], speak: ['spoke', 'spoken'],
  speed: ['sped', 'sped'], spend: ['spent', 'spent'], spin: ['spun', 'spun'], spit: ['spat', 'spat'],
  split: ['split', 'split'], spread: ['spread', 'spread'], spring: ['sprang', 'sprung'], stand: ['stood', 'stood'],
  steal: ['stole', 'stolen'], stick: ['stuck', 'stuck'], sting: ['stung', 'stung'], stink: ['stank', 'stunk'],
  stride: ['strode', 'stridden'], strike: ['struck', 'struck'], string: ['strung', 'strung'], strive: ['strove', 'striven'],
  swear: ['swore', 'sworn'], sweep: ['swept', 'swept'], swell: ['swelled', 'swollen'], swim: ['swam', 'swum'],
  swing: ['swung', 'swung'], take: ['took', 'taken'], teach: ['taught', 'taught'], tear: ['tore', 'torn'],
  tell: ['told', 'told'], think: ['thought', 'thought'], throw: ['threw', 'thrown'], thrust: ['thrust', 'thrust'],
  tread: ['trod', 'trodden'], undergo: ['underwent', 'undergone'], understand: ['understood', 'understood'],
  undertake: ['undertook', 'undertaken'], undo: ['undid', 'undone'], unwind: ['unwound', 'unwound'],
  uphold: ['upheld', 'upheld'], upset: ['upset', 'upset'], wake: ['woke', 'woken'], wear: ['wore', 'worn'],
  weave: ['wove', 'woven'], wed: ['wed', 'wed'], weep: ['wept', 'wept'], win: ['won', 'won'], wind: ['wound', 'wound'],
  withdraw: ['withdrew', 'withdrawn'], withhold: ['withheld', 'withheld'], withstand: ['withstood', 'withstood'],
  wring: ['wrung', 'wrung'], write: ['wrote', 'written'],
};

/** Verbs whose 3rd-person singular is irregular. `be` is handled separately (is/was/been/being). */
const IRREGULAR_THIRD = { be: 'is', have: 'has', do: 'does', go: 'goes', undo: 'undoes', redo: 'redoes', outdo: 'outdoes', overdo: 'overdoes', undergo: 'undergoes' };

const IRREGULAR_NOUNS = {
  child: 'children', man: 'men', woman: 'women', person: 'people', foot: 'feet', tooth: 'teeth', goose: 'geese',
  mouse: 'mice', louse: 'lice', ox: 'oxen', die: 'dice', criterion: 'criteria', phenomenon: 'phenomena',
  datum: 'data', medium: 'media', bacterium: 'bacteria', index: 'indices', appendix: 'appendices', matrix: 'matrices',
  vertex: 'vertices', axis: 'axes', passerby: 'passersby',
};

const IRREGULAR_ADJ = {
  good: ['better', 'best'], well: ['better', 'best'], bad: ['worse', 'worst'], ill: ['worse', 'worst'],
  far: ['farther', 'farthest'], little: ['less', 'least'], many: ['more', 'most'], much: ['more', 'most'],
};

// Reverse indexes for analysis.
const PAST_TO_BASE = new Map();
const PP_TO_BASE = new Map();
for (const [base, [past, pp]] of Object.entries(IRREGULAR_VERBS)) {
  if (past !== base + 'ed') push(PAST_TO_BASE, past, base);
  if (pp !== base + 'ed') push(PP_TO_BASE, pp, base);
}
const THIRD_TO_BASE = new Map(Object.entries(IRREGULAR_THIRD).map(([b, t]) => [t, b]));
const PLURAL_TO_BASE = new Map(Object.entries(IRREGULAR_NOUNS).map(([b, p]) => [p, b]));
const ADJ_TO_BASE = new Map();
for (const [base, [er, est]] of Object.entries(IRREGULAR_ADJ)) {
  push(ADJ_TO_BASE, er, { base, form: 'er' });
  push(ADJ_TO_BASE, est, { base, form: 'est' });
}
function push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

const VOWEL = /[aeiou]/;
const isConsonant = (ch) => /[a-z]/.test(ch) && !VOWEL.test(ch);

/** Rough syllable count (vowel groups, silent final e). Good enough to decide -er vs "more". */
export function syllables(word) {
  const w = word.toLowerCase().replace(/e$/, '');
  const groups = w.match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 0);
}

/** True if the word ends consonant-vowel-consonant (final consonant not w/x/y) — candidate for doubling, which is
 *  mandatory for one-syllable words (stop -> stopped, big -> bigger) and stress-dependent otherwise (refer -> referred,
 *  visit -> visited: both spellings are generated and the dictionary oracle decides). */
function endsCVC(w) {
  const n = w.length;
  if (n < 3) return false;
  const [a, b, c] = [w[n - 3], w[n - 2], w[n - 1]];
  return isConsonant(a) && VOWEL.test(b) && isConsonant(c) && !/[wxy]/.test(c) && !(a === 'q' && b === 'u');
}

/**
 * Candidate spellings of `base` in inflection `form`, most likely first. Pure rules; no dictionary.
 * Returns [] when the form doesn't apply.
 */
export function inflectionCandidates(base, form) {
  const w = base.toLowerCase();
  const out = [];
  const add = (s) => { if (s && !out.includes(s)) out.push(s); };
  const irr = IRREGULAR_VERBS[w];
  switch (form) {
    case 'pl': {
      if (IRREGULAR_NOUNS[w]) add(IRREGULAR_NOUNS[w]);
      if (/man$/.test(w) && !/(human|german|shaman|talisman|ottoman|caiman|walkman)$/.test(w)) add(w.slice(0, -3) + 'men');
      if (/[^aeiou]y$/.test(w)) add(w.slice(0, -1) + 'ies');
      else if (/(s|x|z|ch|sh)$/.test(w)) add(w + 'es');
      else if (/[^aeiou]o$/.test(w)) { add(w + 'es'); add(w + 's'); }
      if (/[^f]fe$/.test(w)) add(w.slice(0, -2) + 'ves');
      if (/[^f]f$/.test(w)) add(w.slice(0, -1) + 'ves');
      add(w + 's');
      if (/z$/.test(w)) add(w + 'zes'); // quiz -> quizzes
      // Latin/Greek plurals (only ever chosen when the oracle attests them).
      if (/us$/.test(w)) add(w.slice(0, -2) + 'i');
      if (/um$/.test(w)) add(w.slice(0, -2) + 'a');
      if (/on$/.test(w)) add(w.slice(0, -2) + 'a');
      if (/is$/.test(w)) add(w.slice(0, -2) + 'es');
      if (/[ei]x$/.test(w)) add(w.slice(0, -2) + 'ices');
      if (/a$/.test(w)) add(w + 'e');
      break;
    }
    case 's': {
      if (w === 'be') { add('is'); break; }
      if (IRREGULAR_THIRD[w]) { add(IRREGULAR_THIRD[w]); break; }
      if (/[^aeiou]y$/.test(w)) add(w.slice(0, -1) + 'ies');
      else if (/(s|x|z|ch|sh|[^aeiou]o)$/.test(w)) add(w + 'es');
      else add(w + 's');
      break;
    }
    case 'ing': {
      if (w === 'be') { add('being'); break; }
      if (/ie$/.test(w)) add(w.slice(0, -2) + 'ying'); // die -> dying
      else if (/[^aeiouy]e$/.test(w) || /[^e]ue$/.test(w)) add(w.slice(0, -1) + 'ing'); // make -> making, argue -> arguing
      else if (endsCVC(w)) { add(w + w[w.length - 1] + 'ing'); if (syllables(w) > 1) add(w + 'ing'); } // run -> running; visit -> visiting
      else add(w + 'ing'); // see -> seeing, play -> playing
      if (/c$/.test(w)) add(w + 'king'); // panic -> panicking
      break;
    }
    case 'ed':
    case 'past':
    case 'pp': {
      if (w === 'be') { if (form === 'past') add('was'); if (form === 'pp') add('been'); break; }
      if (irr) {
        // 'ed' (a regular -ED answer, which reads as past tense or participle) takes the simple past: a clue in the
        // past tense ("Did away with" for ABOLISHED) matches the answer's past-tense reading.
        add(form === 'pp' ? irr[1] : irr[0]);
        break;
      }
      if (/e$/.test(w)) add(w + 'd');
      else if (/[^aeiou]y$/.test(w)) add(w.slice(0, -1) + 'ied');
      else if (endsCVC(w)) { add(w + w[w.length - 1] + 'ed'); if (syllables(w) > 1) add(w + 'ed'); } else add(w + 'ed');
      if (/c$/.test(w)) add(w + 'ked'); // panic -> panicked
      break;
    }
    case 'er':
    case 'est': {
      const suffix = form;
      if (IRREGULAR_ADJ[w]) { add(IRREGULAR_ADJ[w][form === 'er' ? 0 : 1]); break; }
      if (/e$/.test(w)) add(w + (suffix === 'er' ? 'r' : 'st'));
      else if (/[^aeiou]y$/.test(w)) add(w.slice(0, -1) + 'i' + suffix);
      else if (endsCVC(w)) { add(w + w[w.length - 1] + suffix); if (syllables(w) > 1) add(w + suffix); } else add(w + suffix);
      break;
    }
    default:
      break;
  }
  return out;
}

/**
 * Inflect `base` into `form`, choosing the spelling the oracle attests. Returns null when no candidate is attested
 * (prefer no clue over a misspelled one). For 'er'/'est' on long adjectives, returns "more X" / "most X".
 */
export function inflect(base, form, isWord) {
  const w = base.toLowerCase();
  if ((form === 'er' || form === 'est') && !IRREGULAR_ADJ[w] && syllables(w) >= 3) {
    return `${form === 'er' ? 'more' : 'most'} ${w}`;
  }
  const cands = inflectionCandidates(w, form);
  for (const c of cands) if (isWord(c)) return c;
  if ((form === 'er' || form === 'est') && !IRREGULAR_ADJ[w] && syllables(w) === 2 && !/y$/.test(w)) {
    return `${form === 'er' ? 'more' : 'most'} ${w}`;
  }
  // Irregular forms and the three special cases are spelled correctly by definition even if the oracle lacks them.
  if (IRREGULAR_VERBS[w] || IRREGULAR_THIRD[w] || IRREGULAR_NOUNS[w] || IRREGULAR_ADJ[w] || w === 'be') return cands[0] || null;
  return null;
}

/**
 * Inflect a phrase ("give up", "hot dog") by inflecting its head word: the first word for verbs, the last for nouns,
 * the only word for adjectives (multi-word adjectives are not inflected). Returns null when impossible.
 */
export function inflectPhrase(phrase, form, isWord) {
  const words = phrase.split(' ');
  if (words.length === 1) return inflect(phrase, form, isWord);
  if (form === 'pl') {
    const last = inflect(words[words.length - 1], 'pl', isWord);
    return last ? [...words.slice(0, -1), last].join(' ') : null;
  }
  if (form === 'er' || form === 'est') return null;
  const first = inflect(words[0], form, isWord);
  return first ? [first, ...words.slice(1)].join(' ') : null;
}

const FORM_POS = { pl: 'n', s: 'v', ed: 'v', past: 'v', pp: 'v', ing: 'v', er: 'a', est: 'a' };
export const formPos = (form) => FORM_POS[form];

/**
 * Detachment rules (WordNet morphy's, plus doubling/-ied/-ves/Latin plurals). Each: [suffix, replacement, form].
 * Order doesn't matter: every rule is tried and verified.
 */
const RULES = [
  // nouns
  ['s', '', 'pl'], ['ses', 's', 'pl'], ['xes', 'x', 'pl'], ['zes', 'z', 'pl'], ['ches', 'ch', 'pl'],
  ['shes', 'sh', 'pl'], ['men', 'man', 'pl'], ['ies', 'y', 'pl'], ['oes', 'o', 'pl'], ['ves', 'f', 'pl'],
  ['ves', 'fe', 'pl'], ['i', 'us', 'pl'], ['a', 'um', 'pl'], ['a', 'on', 'pl'], ['es', 'is', 'pl'], ['ae', 'a', 'pl'],
  ['zzes', 'z', 'pl'],
  // verbs
  ['s', '', 's'], ['ies', 'y', 's'], ['es', 'e', 's'], ['es', '', 's'],
  ['ed', 'e', 'ed'], ['ed', '', 'ed'], ['ied', 'y', 'ed'], ['ked', '', 'ed'],
  ['ing', 'e', 'ing'], ['ing', '', 'ing'], ['ying', 'ie', 'ing'], ['king', '', 'ing'],
  // adjectives
  ['er', '', 'er'], ['est', '', 'est'], ['er', 'e', 'er'], ['est', 'e', 'est'], ['ier', 'y', 'er'], ['iest', 'y', 'est'],
];

/**
 * All verified inflectional analyses of a (lowercase) word: [{ base, pos: 'n'|'v'|'a', form }].
 * `hasLemma(lemma, pos)` says whether the lexicon (WordNet) has that base with that part of speech. An analysis is
 * kept only if re-inflecting the base by rule reproduces the word (so "bed" is not "be"+"d", "sing" not "s"+"ing").
 */
export function analyze(word, hasLemma) {
  const w = word.toLowerCase();
  const out = [];
  const seen = new Set();
  const add = (base, form) => {
    const pos = FORM_POS[form];
    const key = `${base}|${form}`;
    if (seen.has(key) || base === w || base.length < 2 || !hasLemma(base, pos)) return;
    seen.add(key);
    out.push({ base, pos, form });
  };
  // Irregulars (trusted tables).
  for (const b of PAST_TO_BASE.get(w) || []) add(b, IRREGULAR_VERBS[b][0] === IRREGULAR_VERBS[b][1] ? 'ed' : 'past');
  for (const b of PP_TO_BASE.get(w) || []) if (IRREGULAR_VERBS[b][0] !== IRREGULAR_VERBS[b][1]) add(b, 'pp');
  if (w === 'was' || w === 'were') add('be', 'past');
  if (w === 'been') add('be', 'pp');
  if (THIRD_TO_BASE.has(w)) add(THIRD_TO_BASE.get(w), 's');
  if (PLURAL_TO_BASE.has(w)) add(PLURAL_TO_BASE.get(w), 'pl');
  for (const { base, form } of ADJ_TO_BASE.get(w) || []) add(base, form);
  // Regular rules, verified by regeneration.
  for (const [suffix, repl, form] of RULES) {
    if (!w.endsWith(suffix) || w.length - suffix.length < 1) continue;
    const stem = w.slice(0, w.length - suffix.length);
    const bases = [stem + repl];
    // Undo consonant doubling: "stopped" -> "stopp" -> "stop".
    if (repl === '' && /([b-df-hj-np-tv-z])\1$/.test(stem)) bases.push(stem.slice(0, -1));
    for (const base of bases) {
      if (base.length < 2) continue;
      if (IRREGULAR_VERBS[base] && (form === 'ed')) continue; // "taked" is not a word
      if (inflectionCandidates(base, form).includes(w)) add(base, form);
    }
  }
  return out;
}

export const _tables = { IRREGULAR_VERBS, IRREGULAR_NOUNS, IRREGULAR_ADJ };
