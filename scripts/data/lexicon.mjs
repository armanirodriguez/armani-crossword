// Lexicon: WordNet + SCOWL + morphology behind one small API with caching. Shared by scoring and clue derivation.

import { analyze, inflect, inflectPhrase } from './morphology.mjs';

export class Lexicon {
  /** @param {import('./wordnet.mjs').WordNet} wn  @param {ReturnType<import('./scowl.mjs').loadScowl>} scowl */
  constructor(wn, scowl) {
    this.wn = wn;
    this.scowl = scowl;
    this._analyses = new Map();
    this.isWord = (w) => scowl.all.has(w);
    this.hasLemma = (lemma, pos) => wn.hasLower(lemma, pos);
  }

  /** SCOWL level of a lowercase word (undefined if absent). */
  level(word) {
    return this.scowl.level.get(word);
  }

  /** True if WordNet has `word` as a lowercase lemma in any part of speech. */
  isLemma(word) {
    const l = this.wn.lowerLemmas;
    return l.n.has(word) || l.v.has(word) || l.a.has(word) || l.r.has(word);
  }

  /** Verified inflectional analyses of a lowercase word ([{ base, pos, form }]); cached. */
  analyses(word) {
    let a = this._analyses.get(word);
    if (!a) this._analyses.set(word, (a = analyze(word, this.hasLemma)));
    return a;
  }

  /** WordNet knows the word directly or as an inflection of a known lemma. */
  known(word) {
    return this.isLemma(word) || this.analyses(word).length > 0;
  }

  inflect(word, form) {
    return inflect(word, form, this.isWord);
  }

  inflectPhrase(phrase, form) {
    return inflectPhrase(phrase, form, this.isWord);
  }
}
