// Proper nouns from WordNet (places, people, deities, months, languages, peoples, brands …).
//
// The SCOWL package has almost no capitalized entries, so WordNet's capitalized noun lemmas are the proper-noun
// source. Fame is estimated from how often other synsets' definitions mention the name ("a city in Ohio" counts for
// OHIO) — a surprisingly good notability signal — plus corpus tag counts and a bonus for categories every solver
// knows (countries, US states, capitals, months, planets, major deities). Taxonomic names (genera, families) are
// skipped, as are acronyms (all-caps) and offensive senses.
//
//   score = 26 + 5·log2(1 + mentions) + 6 if corpus-tagged + category bonus (8 / 3) − 8 for trade names, in [10, 55]
//   → never-mentioned names land below the default fill threshold (30); famous ones at 40–55.

import { isOffensiveSynset } from './offensive.mjs';
import { clampScore } from './scoring.mjs';

const TIER_A = /^(country|[A-Za-z_]+_country|kingdom|sultanate|republic|American_state|national_capital|continent|ocean|Gregorian_calendar_month|weekday|day_of_the_week|terrestrial_planet|Jovian_planet|gas_giant|planet|sign_of_the_zodiac|Greek_deity|Roman_deity|Norse_deity|Great_Lakes)$/;
const TIER_B = /^(state_capital|provincial_capital|city|port|river|lake|sea|island|mountain_peak|volcano|desert|range|mountain_range|Apostle|apostle|patriarch|prophet|Evangelist|Muse|Titan|Egyptian_deity|Hindu_deity|Semitic_deity|Celtic_deity|mythical_being|Old_Testament|Gospel|book|President_of_the_United_States|composer|writer|poet|painter|dramatist|philosopher|physicist|fictional_character|natural_language|religion)$/;
const TRADE_NAME = new Set(['n06858649', 'n06864792']);
const TAXONOMIC_LEX = new Set(['noun.plant', 'noun.animal']);
const TAXONOMIC_PART = /^(genus|family|order|class|phylum|subfamily|suborder|subclass|superfamily|subphylum|tribe|division|subgenus|kingdom|superorder|infraorder)$/i;

// Title words that may precede a name inside a longer capitalized run ("Lake Erie", "Mount Etna", "Saint Paul").
const TITLE_WORDS = new Set(['Lake', 'Mount', 'Saint', 'River', 'Cape', 'Fort', 'Port', 'King', 'Queen', 'Prince',
  'Princess', 'Emperor', 'Empress', 'Pope', 'General', 'Sir', 'Lord', 'Lady', 'President', 'Gulf', 'Bay', 'Sea', 'Isle',
  'Mt', 'St', 'Upper', 'Lower', 'Greater', 'Old', 'Ancient', 'Modern']);

/**
 * Count, for every capitalized phrase of 1–3 words ("Ohio", "Lake_Erie"), in how many synset definitions it occurs
 * (excluding the synset that defines the name itself). Example sentences are ignored. Within a run of capitalized
 * words only prefixes count ("New York City" counts New, New_York, New_York_City — not "York"), so "Zealand" gets no
 * credit from "New Zealand"; a run starting with a title word also credits the rest ("Lake Erie" credits "Erie").
 */
export function countGlossMentions(wn) {
  const counts = new Map();
  for (const s of wn.synsets.values()) {
    const def = s.gloss.split('"')[0];
    const toks = def.split(/[^A-Za-z'-]+/).filter(Boolean);
    const own = new Set(s.words);
    const seen = new Set();
    const credit = (parts) => {
      for (let n = 1; n <= Math.min(3, parts.length); n++) {
        const key = parts.slice(0, n).join('_');
        if (!own.has(key) && !seen.has(key)) {
          seen.add(key);
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
    };
    for (let i = 0; i < toks.length;) {
      if (!/^[A-Z][a-z]/.test(toks[i])) { i++; continue; }
      let j = i;
      while (j < toks.length && /^[A-Z][a-z]/.test(toks[j])) j++;
      const run = toks.slice(i, j);
      credit(run);
      if (run.length > 1 && TITLE_WORDS.has(run[0])) credit(run.slice(1));
      i = j;
    }
  }
  return counts;
}

/** Hypernym / instance-hypernym lemmas of a synset (first word of each target). */
function hypernymNames(wn, s) {
  const out = [];
  for (const p of s.ptrs) {
    if (p.sym === '@i' || p.sym === '@') {
      const t = wn.synsets.get(p.key);
      if (t) out.push(...t.words);
    }
  }
  return out;
}

/**
 * Collect proper-noun entries.
 * Returns Map<WORD, { score, lemma }> (lemma = WordNet spelling, e.g. "Lake_Erie", for clue derivation).
 * @param {import('./wordnet.mjs').WordNet} wn
 * @param {(WORD: string) => boolean} isBanned
 */
export function collectProperNouns(wn, isBanned, { maxLength = 15 } = {}) {
  const mentions = countGlossMentions(wn);
  const out = new Map();
  for (const s of wn.synsets.values()) {
    if (s.pos !== 'n' || TAXONOMIC_LEX.has(s.lexFile)) continue;
    let offensive = null; // computed lazily
    for (const lemma of s.words) {
      if (!/[A-Z]/.test(lemma) || lemma === lemma.toUpperCase()) continue; // not capitalized, or an acronym
      const parts = lemma.split(/[_-]/);
      // Every part a capitalized name with a vowel ("Lake", "Erie"); no "Mt", "St.", digits, apostrophes.
      if (!parts.every((p) => /^[A-Z][a-z]+$/.test(p) && /[aeiouy]/.test(p))) continue;
      if (parts.some((p) => TAXONOMIC_PART.test(p))) continue;
      const word = parts.join('').toUpperCase();
      if (word.length < 3 || word.length > maxLength || isBanned(word) || parts.some((p) => isBanned(p.toUpperCase()))) continue;
      if (offensive === null) offensive = isOffensiveSynset(s, isBanned);
      if (offensive) break;
      const m = mentions.get(lemma) || 0;
      const tags = wn.tagCount(lemma.toLowerCase(), s.key);
      const hyps = hypernymNames(wn, s);
      let score = 26 + 5 * Math.log2(1 + m) + (tags > 0 ? 6 : 0);
      if (hyps.some((h) => TIER_A.test(h))) score += 8;
      else if (hyps.some((h) => TIER_B.test(h)) || /^\((Old|New) Testament|^\((Greek|Roman|Norse) mythology/.test(s.gloss)) score += 3;
      if (s.ptrs.some((p) => p.sym === ';u' && TRADE_NAME.has(p.key)) || /\btrade ?(name|mark)/i.test(s.gloss)) score -= 8;
      score -= 4 * Math.max(0, parts.length - 2); // "New_York_State", "Holy_Roman_Empire": long names are weak fill
      score = Math.min(55, Math.max(10, clampScore(score)));
      // Full personal names ("Erik_Satie") have letter-friendly spellings, so the filler reaches for them constantly,
      // but most are obscure to casual solvers. Keep them below the default fill threshold (30) unless curated.
      if (parts.length >= 2 && s.lexFile === 'noun.person') score = Math.min(score, 26);
      const prev = out.get(word);
      if (!prev || score > prev.score) out.set(word, { score, lemma });
    }
  }
  return out;
}
