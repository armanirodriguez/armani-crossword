// Scores for single words from SCOWL (0–100, higher = better fill). See data/README.md for the bands.
//
//   base      SCOWL level -> LEVEL_SCORE (common words higher)
//   + WordNet WordNet knows the word: +3, plus up to +5 for corpus frequency (sense-tagged occurrences)
//   - unknown not in WordNet (directly or via its base form) at SCOWL level >= 50: -6 (obscure, slang, re-/non- coinages)
//   inflection plain plurals, -S/-ED/-ING verb forms and -ER/-EST comparatives that are not WordNet lemmas in their own
//             right score INFLECTION_PENALTY below their base form (and never above their own level's score)

import { junkReason } from './junk.mjs';

export const LEVEL_SCORE = { 10: 60, 20: 56, 35: 51, 40: 48, 50: 44, 55: 40, 60: 35, 70: 26 };
export const INFLECTION_PENALTY = 5;
export const UNKNOWN_PENALTY = 6;

/** Bonus for a word WordNet knows, growing with its sense-tagged corpus frequency (0 → +3 … ≥ 15 → +8). */
export function wordnetBonus(freq) {
  return 3 + Math.min(5, Math.round(1.5 * Math.log2(1 + freq)));
}

/**
 * Score every lowercase SCOWL word. Returns { scores: Map<WORD, score>, junk: Map<reason, count>, inflections: number }.
 * @param {import('./lexicon.mjs').Lexicon} lex
 */
export function scoreScowlWords(lex) {
  const scores = new Map();
  const junk = new Map();
  let inflections = 0;
  const known = (w) => lex.known(w);
  for (const [w, lvl] of lex.scowl.level) {
    const reason = junkReason(w, known);
    if (reason) {
      junk.set(reason, (junk.get(reason) || 0) + 1);
      continue;
    }
    const own = LEVEL_SCORE[lvl];
    let score;
    if (lex.isLemma(w)) {
      score = own + wordnetBonus(lex.wn.freq(w));
    } else {
      const an = lex.analyses(w);
      if (an.length) {
        // Plain inflection: score relative to its best base form.
        let best = -Infinity;
        for (const { base } of an) {
          const baseLevel = lex.level(base);
          const baseScore = (baseLevel ? LEVEL_SCORE[baseLevel] : own) + wordnetBonus(lex.wn.freq(base));
          best = Math.max(best, Math.min(own + wordnetBonus(lex.wn.freq(base)), baseScore));
        }
        score = best - INFLECTION_PENALTY;
        inflections++;
      } else {
        score = lvl >= 50 ? own - UNKNOWN_PENALTY : own;
      }
    }
    scores.set(w.toUpperCase(), clampScore(score));
  }
  return { scores, junk, inflections };
}

/**
 * Mixed-case SCOWL entries ("OKs") are proper nouns / symbols. Keep those at common levels (<= 50) that WordNet
 * defines (directly or via inflection) with moderate scores.
 */
export function scoreScowlCased(lex) {
  const scores = new Map();
  for (const [w, lvl] of lex.scowl.cased) {
    const lower = w.toLowerCase();
    if (lvl > 50 || junkReason(lower, (x) => lex.known(x)) || !(lex.wn.has(lower) || lex.known(lower))) continue;
    scores.set(w.toUpperCase(), lvl <= 35 ? 40 : 35);
  }
  return scores;
}

export function clampScore(s) {
  return Math.max(1, Math.min(100, Math.round(s)));
}
