// Grid fill engine (SPEC §3.2): fills the empty cells of a crossword grid with words from a WordList.
//
// It is a constraint-satisfaction search over the grid's incomplete entries ("variables"):
//
//   • Domain of a variable = bitset over the word indices of the Lexicon for its length (see lexicon.js),
//     initialised from the entry's pattern, minus avoided words and words already in the grid.
//   • Support counts: for every variable, position and letter, how many domain words have that letter there. Each
//     empty cell keeps the set of letters both of its entries still support. Propagation is variable-centric arc
//     consistency: when a cell loses letters, its other entry is "revised" — every word with a letter its cells
//     no longer allow is dropped, either word by word (few removals) or with one AND-NOT pass over the bitset and
//     a recount (most of the domain goes) — which may in turn shrink other cells, and so on to a fixpoint.
//     This is what makes the classic bug impossible: an entry whose cells all get filled by its crossings still
//     has a non-empty domain, so its letters always spell a list word.
//   • Duplicates: when a variable's domain shrinks to one word, that word is removed from every other variable of
//     the same length (a wipe-out there = a duplicate conflict). Entries complete in the input are kept as-is
//     (even if unlisted) but their words are excluded elsewhere.
//   • Undo: copy-on-write snapshots of each variable's state per search node, plus trailed cell masks.
//   • Variable order: smallest domain divided by "wipe-out weight" (dom/wdeg); entries that keep failing get
//     picked earlier after a restart. Ties → longer entry, then seeded random.
//   • Value order: word score (minus any `penalize` points) + look-ahead (how many words remain for each crossing
//     after placing the word, read straight from the support counts) + seeded noise. Once a search has had to
//     restart, the top candidates of each decision are also probed (assigned + propagated for real) and re-ranked by
//     the freedom they leave.
//   • Restarts with a geometrically growing backtrack cutoff; weights persist across restarts. A search that
//     exhausts the root without hitting the cutoff is a proof that the grid cannot be filled.
//   • Cooperative: yields a macrotask every ~30 ms so a worker can process 'cancel'; honours timeLimitMs and
//     options.signal.aborted. Deterministic for a given seed (given enough time).

import { computeEntries, entryPattern, isLetter, BLOCK, EMPTY } from '../site/shared/grid.js';
import { Lexicon, comparePairs } from './lexicon.js';
import { makeRng, normalizeSeed, normalizeWord, now, yieldToEventLoop, lowBit } from './util.js';

const ALL_LETTERS = (1 << 26) - 1;
/** Internal score given to `prefer` words so they rank above every list word. */
const PREFER_SCORE = 101;
/** Extra value-ordering bonus for prefer words (on top of PREFER_SCORE). */
const PREFER_BONUS = 60;
/** Variable-ordering offset that sends entries with no prefer word left behind those that still have one. */
const PREFER_LAST = 1e12;

/**
 * Search heuristics (tuned with scripts/bench-engine.mjs). Exported so benchmarks can experiment; treat as constant.
 *   laMin / laMean  value ordering: weight × log2(words left in the poorest crossing / mean over crossings)
 *   laCap           log2 cap: beyond ~1000 options a crossing counts as "rich enough"
 *   noise           randomness 1.0 → up to this many points of noise on a 0–100 score scale
 *   firstCutoff / cutoffGrowth   restart schedule (backtracks before the first restart; growth factor)
 *   probe / probeWeight / probeAfterRestarts   once the search has restarted this many times, the first `probe`
 *                   candidates of each decision are tried for real (assign + propagate) and re-ranked by
 *                   score + probeWeight × (log2 of the remaining search space relative to the best probe)
 */
export const FILL_TUNING = {
  laMin: 6.0,
  laMean: 3.0,
  laCap: 10,
  noise: 40,
  firstCutoff: 40,
  cutoffGrowth: 1.3,
  probe: 10,
  probeWeight: 10,
  probeAfterRestarts: 1,
};

/** With `penalize`: candidate moves allowed per fill, per variable (see _avoidPenalty). */
const DEFER_PER_VAR = 4;

const YIELD_EVERY_MS = 30;
const PROGRESS_EVERY_MS = 200;

/** Custom lexicons (base lexicon + prefer words), cached per base lexicon object. */
const customLexicons = new WeakMap();
const NO_BASE = {};
/** Support counts of a whole minScore prefix, cached per lexicon: Map<n, Int32Array(L × 26)>. */
const prefixCounts = new WeakMap();

function getPrefixCounts(lex, n) {
  let byN = prefixCounts.get(lex);
  if (!byN) prefixCounts.set(lex, (byN = new Map()));
  let c = byN.get(n);
  if (!c) {
    const L = lex.length;
    c = new Int32Array(L * 26);
    const { codes } = lex;
    for (let i = 0; i < n; i++) {
      const cb = i * L;
      for (let k = 0; k < L; k++) c[k * 26 + codes[cb + k]]++;
    }
    byN.set(n, c);
  }
  return c;
}

/**
 * Value-ordering penalties of a lexicon's first n words (the minScore prefix) as a Float32Array indexed by word, or
 * null when none of the given [word, points] pairs (all of the lexicon's length) is among them.
 */
function penaltyTable(lex, n, pairs) {
  if (!lex || !pairs) return null;
  let table = null;
  for (const [word, points] of pairs) {
    const i = lex.indexOf(word);
    if (i >= 0 && i < n) (table ||= new Float32Array(n))[i] = points;
  }
  return table;
}

const IDX_BITS = 262144; // 2^18: word index packing in sort keys (lexicons are far smaller)
const KEY_LEVELS = 4194304; // 2^22 quantised value levels
/** Added to ordering values before quantising, so that heavily penalized words (negative values) keep their order. */
const KEY_OFFSET = 1024;
/** Largest `penalize` value used (larger ones are capped): far below any other word already. */
export const MAX_PENALTY = 1000;

/**
 * Fill the empty cells of `grid`.
 *
 * Additions to SPEC §3.2 (used by the layout generator and fitWords, which create complete entries themselves):
 *   verifyComplete  when true, entries that are already complete in the input are NOT taken as user-forced: each
 *                   must be a list word with score ≥ minScore (or a prefer word, or listed in allowComplete) and
 *                   must not repeat another entry (unless allowDuplicates); otherwise the result is 'impossible'
 *                   with `problem` naming that entry.
 *   allowComplete   words accepted as complete entries as-is under verifyComplete (e.g. the theme answers).
 *   penalize        { WORD: points } (a plain object, a Map, or an array of [word, points]): lowers each word's score
 *                   by that many points for value ordering only, so recently used answers ("freshness") are tried
 *                   late. Eligibility is unchanged: a penalized word still counts towards minScore with its real
 *                   score and is used when nothing else fits. Prefer words are never penalized. See penaltiesOption.
 *   preferFirst     (default true) fill entries that can still take a prefer word before the others, so choices at
 *                   their crossings (skewed by penalties) cannot squeeze a theme word out. Layout proofs and fitWords
 *                   pass false: there prefer words are optional extras and the ordering slows proofs down
 *                   (measured ≈6% fewer theme answers placed within the same budget).
 * Never throws on malformed input: a missing/odd grid, word list or options give reason 'invalid'.
 * @returns {Promise<FillResult>} see SPEC §3.2
 */
export async function fillGrid(grid, wordlist, options = {}) {
  const t0 = now();
  const solver = new FillSolver(grid, wordlist, options, t0);
  if (solver.status !== 'ready') return solver.result();
  return solver.solve();
}

/**
 * Build the problem and run only the initial propagation (no search). Cheap feasibility check used by the layout
 * generator. Accepts the same options as fillGrid (incl. verifyComplete). Returns { ok, problem, solver }.
 */
export function checkFillable(grid, wordlist, options = {}) {
  const solver = new FillSolver(grid, wordlist, options, now());
  const ok = solver.status === 'ready' || solver.status === 'solved';
  return { ok, problem: ok ? null : solver.problem, solver };
}

/**
 * Normalised word list option: arrays, Sets and other iterables of words, or a single string of words separated
 * by commas/whitespace. Anything else → [].
 */
export function wordsOption(value) {
  if (value === null || value === undefined) return [];
  let list;
  if (typeof value === 'string') list = value.split(/[\s,;]+/);
  else if (typeof value[Symbol.iterator] === 'function') list = Array.from(value);
  else return [];
  return list.map(normalizeWord).filter(Boolean);
}

/**
 * Normalised `penalize` option: Map<WORD, points> with points > 0. Accepts a plain object { word: points }, a Map,
 * or an array (any iterable) of [word, points] pairs — all structured-clone friendly, so the option can be posted
 * to the worker as is. Words are normalised to A–Z; entries with a non-positive or non-numeric points value are
 * ignored, larger ones are capped at MAX_PENALTY; when a word appears twice the larger penalty wins. Anything else
 * → an empty Map.
 */
export function penaltiesOption(value) {
  const out = new Map();
  if (!value || typeof value !== 'object') return out;
  let pairs;
  if (value instanceof Map) pairs = value.entries();
  else if (typeof value[Symbol.iterator] === 'function') pairs = value;
  else pairs = Object.entries(value);
  for (const pair of pairs) {
    if (!pair || typeof pair !== 'object') continue;
    const word = normalizeWord(pair[0]);
    const points = Number(pair[1]);
    if (!word || !Number.isFinite(points) || points <= 0) continue;
    if (!(out.get(word) >= points)) out.set(word, Math.min(points, MAX_PENALTY));
  }
  return out;
}

class FillSolver {
  constructor(grid, wordlist, options, t0) {
    this.t0 = t0;
    this.grid = grid;
    this.wordlist = wordlist;
    if (!options || typeof options !== 'object') options = {};
    this.minScore = Math.max(1, Number.isFinite(options.minScore) ? options.minScore : 30);
    this.timeLimitMs = Number.isFinite(options.timeLimitMs) ? Math.max(0, options.timeLimitMs) : 8000;
    this.randomness = Math.min(1, Math.max(0, Number.isFinite(options.randomness) ? options.randomness : 0.25));
    this.allowDuplicates = !!options.allowDuplicates;
    this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    this.signal = options.signal && typeof options.signal === 'object' ? options.signal : null;
    this.rng = makeRng(normalizeSeed(options.seed));
    this.avoid = new Set(wordsOption(options.avoid));
    this.prefer = new Set(wordsOption(options.prefer).filter((w) => w.length >= 2 && !this.avoid.has(w)));
    this.preferFirst = options.preferFirst !== false && this.prefer.size > 0;
    this.penalize = penaltiesOption(options.penalize);
    for (const w of this.prefer) this.penalize.delete(w);
    this.verifyComplete = !!options.verifyComplete;
    this.allowComplete = new Set(wordsOption(options.allowComplete));

    this.stats = { ms: 0, nodes: 0, backtracks: 0, restarts: 0, avgScore: null, minWordScore: null };
    this.status = 'ready';
    this.reason = null;
    this.problem = null;
    this.cells = null;
    this.failVar = -1;
    this._setup();
  }

  // ---------------------------------------------------------------------------
  // Setup

  _setup() {
    const { grid, wordlist } = this;
    if (!grid || typeof grid !== 'object') return this._invalid('No grid given');
    if (!wordlist || typeof wordlist.lexicon !== 'function' || typeof wordlist.count !== 'function') {
      return this._invalid('No word list given');
    }
    const { width, height } = grid;
    const cells = grid.cells;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || !Array.isArray(cells) || cells.length !== width * height) {
      return this._invalid('The grid size does not match its cells');
    }
    for (let i = 0; i < cells.length; i++) {
      const ch = cells[i];
      if (ch !== BLOCK && ch !== EMPTY && !isLetter(ch)) return this._invalid(`Cell ${i} contains an invalid value`);
    }
    const ent = computeEntries(grid);
    this.entries = ent;
    const covered = new Uint8Array(cells.length);
    for (const e of ent.all) for (const i of e.cells) covered[i] = 1;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] === EMPTY && !covered[i]) {
        return this._invalid('An empty square is not part of any entry (it is boxed in by blocks)', null, [i]);
      }
    }

    // Split entries into fixed (complete in the input — user-forced, kept as-is) and variables.
    const vars = [];
    const fixedWords = new Set();
    const complete = [];
    for (const e of ent.all) {
      const pattern = entryPattern(grid, e);
      if (pattern.includes('.')) vars.push({ entry: e, pattern });
      else {
        fixedWords.add(pattern);
        complete.push({ entry: e, word: pattern });
      }
    }
    // verifyComplete: complete entries the caller did not vouch for (allowComplete) must be usable fill words.
    if (this.verifyComplete && complete.length) {
      const counts = new Map();
      for (const { word } of complete) counts.set(word, (counts.get(word) || 0) + 1);
      for (const { entry, word } of complete) {
        if (this.allowComplete.has(word)) continue;
        if (!this._usableWord(word)) {
          return this._badEntry(entry, word, `${entry.id} (${word}) is not a word in the list${this.minScore > 1 ? ` with score ≥ ${this.minScore}` : ''}`);
        }
        if (counts.get(word) > 1 && !this.allowDuplicates) {
          return this._badEntry(entry, word, `${entry.id} (${word}) repeats another entry`);
        }
      }
    }
    this.fixedWords = fixedWords;
    this.vars = vars;
    const V = vars.length;
    if (V === 0) {
      this.status = 'solved';
      this.cells = cells.slice();
      return;
    }

    // One lexicon per length (custom when prefer words of that length exist), with its value-ordering penalties.
    const lexByLen = new Map();
    const penByLen = new Map();
    for (const [word, points] of this.penalize) {
      if (!penByLen.has(word.length)) penByLen.set(word.length, []);
      penByLen.get(word.length).push([word, points]);
    }
    for (const v of vars) {
      const L = v.entry.length;
      if (lexByLen.has(L)) continue;
      const fl = this._fillLexicon(L);
      fl.pen = penaltyTable(fl.lex, fl.n, penByLen.get(L));
      lexByLen.set(L, fl);
    }

    // Per-variable static data.
    let domWords = 0;
    let cntSize = 0;
    let maxN = 1;
    for (const v of vars) {
      const L = v.entry.length;
      const { lex, n, pen, nPrefer } = lexByLen.get(L);
      v.L = L;
      v.lex = lex;
      v.n = n;
      v.nPrefer = nPrefer;
      v.pen = pen;
      v.nw = (n + 31) >>> 5;
      v.stride = lex ? lex.stride : 0;
      v.bits = lex ? lex.bits : null;
      v.codes = lex ? lex.codes : null;
      v.scores = lex ? lex.scores : null;
      v.off = domWords;
      domWords += v.nw;
      v.cntOff = cntSize;
      cntSize += L * 26;
      v.cells = Int32Array.from(v.entry.cells);
      v.crossVar = new Int32Array(L).fill(-1);
      v.crossPos = new Int32Array(L).fill(-1);
      if (n > maxN) maxN = n;
    }
    this.dom = new Uint32Array(Math.max(1, domWords));
    this.size = new Int32Array(V);
    this.cnt = new Int32Array(Math.max(1, cntSize));
    this.weight = new Float64Array(V).fill(1);
    this.wipeouts = new Int32Array(V);

    // Cell → covering variables.
    const nCells = cells.length;
    this.cellVar = [new Int32Array(nCells).fill(-1), new Int32Array(nCells).fill(-1)];
    this.cellPos = [new Int32Array(nCells).fill(-1), new Int32Array(nCells).fill(-1)];
    vars.forEach((v, vi) => {
      const d = v.entry.dir === 'across' ? 0 : 1;
      v.dirIndex = d;
      for (let k = 0; k < v.L; k++) {
        this.cellVar[d][v.cells[k]] = vi;
        this.cellPos[d][v.cells[k]] = k;
      }
    });
    vars.forEach((v) => {
      const o = 1 - v.dirIndex;
      for (let k = 0; k < v.L; k++) {
        const c = v.cells[k];
        v.crossVar[k] = this.cellVar[o][c];
        v.crossPos[k] = this.cellPos[o][c];
      }
    });

    // Variables of the same length share a lexicon: duplicates are only possible among them.
    const groups = new Map();
    vars.forEach((v, vi) => {
      if (!groups.has(v.L)) groups.set(v.L, []);
      groups.get(v.L).push(vi);
    });
    for (const v of vars) v.group = Int32Array.from(groups.get(v.L));
    this.hasPenalties = vars.some((v) => v.pen);
    this.deferBudget = DEFER_PER_VAR * V;

    // log2 table for look-ahead.
    this.log2 = new Float32Array(maxN + 2);
    for (let c = 1; c < this.log2.length; c++) this.log2[c] = Math.min(FILL_TUNING.laCap, Math.log2(c));

    // Trail, queues and per-variable snapshot stamps (see "Propagation" below).
    this.trail = new Int32Array(1 << 16);
    this.trailLen = 0;
    this.epoch = 1;
    this.stamp = new Int32Array(V);
    this.varQ = [];
    this.inQ = new Uint8Array(V);
    this.singleQ = [];
    this.mask = new Int32Array(nCells);
    for (let i = 0; i < nCells; i++) {
      const ch = cells[i];
      this.mask[i] = ch === EMPTY ? ALL_LETTERS : ch === BLOCK ? 0 : 1 << (ch.charCodeAt(0) - 65);
    }

    // Initial domains & support counts.
    for (let vi = 0; vi < V; vi++) this._initDomain(vi);
    for (let vi = 0; vi < V; vi++) {
      if (this.size[vi] === 0) return this._fail(vi, 'impossible');
    }

    // Initial arc consistency: each empty cell's letters = intersection of its entries' supports; then revise
    // the variables to a fixpoint.
    for (let c = 0; c < nCells; c++) {
      if (cells[c] !== EMPTY) continue;
      let m = ALL_LETTERS;
      for (let d = 0; d < 2; d++) {
        const vi = this.cellVar[d][c];
        if (vi >= 0) m &= this._support(vars[vi], this.cellPos[d][c]);
      }
      this.mask[c] = m;
      if (!m) return this._fail(this.cellVar[0][c] >= 0 ? this.cellVar[0][c] : this.cellVar[1][c], 'impossible');
    }
    for (let vi = 0; vi < V; vi++) {
      this._enqueueVar(vi);
      if (this.size[vi] === 1) this.singleQ.push(vi);
    }
    if (!this._propagate()) return this._fail(this.failVar, 'impossible');
    this.rootMark = this._checkpoint();
  }

  /** Lexicon used for entries of length L: the list's own, or a custom one when prefer words of that length exist. */
  _fillLexicon(L) {
    const base = this.wordlist.lexicon(L);
    const prefer = [...this.prefer].filter((w) => w.length === L).sort();
    if (!prefer.length) return { lex: base, n: base ? base.prefixCount(this.minScore) : 0, nPrefer: 0 };
    // Custom lexicons are cached per base lexicon (a WeakMap, so editing the list invalidates them).
    const key = `${this.minScore}|${prefer.join(',')}`;
    const cacheKey = base || NO_BASE;
    let cache = customLexicons.get(cacheKey);
    if (!cache) customLexicons.set(cacheKey, (cache = new Map()));
    let lex = cache.get(key);
    if (!lex) {
      const pairs = prefer.map((w) => [w, PREFER_SCORE]);
      if (base) {
        const n = base.prefixCount(this.minScore);
        const preferSet = new Set(prefer);
        for (let i = 0; i < n; i++) if (!preferSet.has(base.words[i])) pairs.push([base.words[i], base.scores[i]]);
      }
      lex = new Lexicon(L, pairs);
      if (cache.size >= 32) cache.delete(cache.keys().next().value);
      cache.set(key, lex);
    }
    // Prefer words sort first (PREFER_SCORE beats every list score), so they are indices [0, prefer.length).
    return { lex, n: lex.n, nPrefer: prefer.length };
  }

  /** True while some prefer word is still in vi's domain. */
  _preferLeft(vi) {
    const v = this.vars[vi];
    const np = v.nPrefer;
    if (!np) return false;
    const { dom } = this;
    const full = np >>> 5;
    for (let w = 0; w < full; w++) if (dom[v.off + w]) return true;
    const rem = np & 31;
    return rem !== 0 && (dom[v.off + full] & (2 ** rem - 1)) !== 0;
  }

  _initDomain(vi) {
    const v = this.vars[vi];
    const { dom, cnt } = this;
    const { off, nw, n, L, codes, cntOff } = v;
    if (!v.lex || n === 0) {
      this.size[vi] = 0;
      return;
    }
    // Start from the minScore prefix.
    for (let w = 0; w < nw; w++) dom[off + w] = 0xffffffff;
    if (n & 31) dom[off + nw - 1] = ((1 << (n & 31)) - 1) >>> 0;
    const fixed = v.lex.constraints(v.pattern);
    // Words to drop by name: avoided words and words already in the grid.
    const drop = [];
    for (const word of this.avoid) if (word.length === L) drop.push(word);
    if (!this.allowDuplicates) for (const word of this.fixedWords) if (word.length === L) drop.push(word);

    if (!fixed.length) {
      // Unconstrained entry: copy the cached prefix counts, then subtract dropped words.
      cnt.set(getPrefixCounts(v.lex, n), cntOff);
      let size = n;
      for (const word of drop) {
        const i = v.lex.indexOf(word);
        if (i < 0 || i >= n || !(dom[off + (i >>> 5)] & (1 << (i & 31)))) continue;
        dom[off + (i >>> 5)] &= ~(1 << (i & 31));
        size--;
        const cb = i * L;
        for (let k = 0; k < L; k++) cnt[cntOff + k * 26 + codes[cb + k]]--;
      }
      this.size[vi] = size;
      return;
    }
    for (const f of fixed) for (let w = 0; w < nw; w++) dom[off + w] &= v.bits[f + w];
    for (const word of drop) {
      const i = v.lex.indexOf(word);
      if (i >= 0 && i < n) dom[off + (i >>> 5)] &= ~(1 << (i & 31));
    }
    this.size[vi] = this._recount(vi);
  }

  // ---------------------------------------------------------------------------
  // Propagation
  //
  // Undo uses copy-on-write snapshots: the first time a variable is modified after a checkpoint, its whole state
  // (domain words, support counts, size) is pushed on the trail; later changes in the same epoch modify it in
  // place. Cell masks are trailed individually. Restricting a variable either removes the doomed words one by one
  // (when few are removed) or filters the bitset in bulk and recounts the survivors (when most are removed — the
  // usual case when a crossing letter gets fixed), so a node costs roughly O(words kept), not O(words removed).

  /** Start a new undo point; returns its trail mark. */
  _checkpoint() {
    this.epoch++;
    return this.trailLen;
  }

  _ensureTrail(extra) {
    if (this.trailLen + extra > this.trail.length) {
      let len = this.trail.length * 2;
      while (len < this.trailLen + extra) len *= 2;
      const t = new Int32Array(len);
      t.set(this.trail.subarray(0, this.trailLen));
      this.trail = t;
    }
  }

  /** Save vi's state on the trail unless already saved since the last checkpoint. */
  _snapshot(vi) {
    if (this.stamp[vi] === this.epoch) return;
    this.stamp[vi] = this.epoch;
    const v = this.vars[vi];
    const nc = v.L * 26;
    this._ensureTrail(v.nw + nc + 3);
    const { trail, dom, cnt } = this;
    let t = this.trailLen;
    for (let w = 0; w < v.nw; w++) trail[t++] = dom[v.off + w] | 0;
    for (let j = 0; j < nc; j++) trail[t++] = cnt[v.cntOff + j];
    trail[t++] = this.size[vi];
    trail[t++] = vi;
    trail[t++] = -1; // record type: variable snapshot
    this.trailLen = t;
  }

  _setMask(c, m) {
    this._ensureTrail(3);
    this.trail[this.trailLen++] = this.mask[c];
    this.trail[this.trailLen++] = c;
    this.trail[this.trailLen++] = -2; // record type: cell mask
    this.mask[c] = m;
  }

  /** Undo the trail back to `mark`. */
  _undo(mark) {
    const { trail, dom, cnt, size, mask, vars } = this;
    let t = this.trailLen;
    while (t > mark) {
      const type = trail[--t];
      if (type === -1) {
        const vi = trail[--t];
        size[vi] = trail[--t];
        const v = vars[vi];
        for (let j = v.L * 26 - 1; j >= 0; j--) cnt[v.cntOff + j] = trail[--t];
        for (let w = v.nw - 1; w >= 0; w--) dom[v.off + w] = trail[--t];
      } else {
        const c = trail[--t];
        mask[c] = trail[--t];
      }
    }
    this.trailLen = t;
    this.failVar = -1;
    this.epoch++; // later changes must snapshot again
  }

  _enqueueVar(vi) {
    if (!this.inQ[vi]) {
      this.inQ[vi] = 1;
      this.varQ.push(vi);
    }
  }

  /** Letters with at least one supporting word at position k of variable v. */
  _support(v, k) {
    const { cnt } = this;
    const base = v.cntOff + k * 26;
    let s = 0;
    for (let l = 0; l < 26; l++) if (cnt[base + l] > 0) s |= 1 << l;
    return s;
  }

  _sizeChanged(vi) {
    const s = this.size[vi];
    if (s === 1) this.singleQ.push(vi);
    else if (s === 0 && this.failVar < 0) this.failVar = vi;
  }

  /**
   * After vi's domain changed: narrow the masks of its cells to its supports and queue the crossing entries of
   * every cell that lost letters. Positions to check are given as a bit set (all positions if -1).
   */
  _pushSupports(vi, positions) {
    const v = this.vars[vi];
    const { mask } = this;
    for (let k = 0; k < v.L; k++) {
      if (positions !== -1 && !(positions & (1 << k))) continue;
      const c = v.cells[k];
      const m = mask[c] & this._support(v, k);
      if (m === mask[c]) continue;
      if (m === 0) {
        if (this.failVar < 0) this.failVar = vi;
        return;
      }
      this._setMask(c, m);
      const f = v.crossVar[k];
      if (f >= 0) this._enqueueVar(f);
    }
  }

  /** Remove one word (duplicate prevention). */
  _removeWord(vi, i) {
    const v = this.vars[vi];
    this._snapshot(vi);
    this.dom[v.off + (i >>> 5)] &= ~(1 << (i & 31));
    this.size[vi]--;
    const { cnt } = this;
    const { codes, L, cntOff } = v;
    const cb = i * L;
    let lost = 0;
    for (let k = 0; k < L; k++) {
      if (--cnt[cntOff + k * 26 + codes[cb + k]] === 0) lost |= 1 << k;
    }
    this._sizeChanged(vi);
    if (lost && this.failVar < 0) this._pushSupports(vi, lost);
  }

  /**
   * Revise variable vi against the current masks of its cells: drop every word that has a letter its cell no
   * longer allows. Few removals → word by word with count updates; many → one bulk pass over the bitset (an AND-NOT
   * per removed (position, letter)) followed by a recount of the survivors.
   */
  _revise(vi) {
    const v = this.vars[vi];
    const { cnt, dom, mask } = this;
    const { off, nw, bits, stride, codes, L, cntOff, cells } = v;
    const remOffs = [];
    let est = 0;
    for (let k = 0; k < L; k++) {
      const allowed = mask[cells[k]];
      const base = cntOff + k * 26;
      for (let l = 0; l < 26; l++) {
        if (cnt[base + l] > 0 && !(allowed & (1 << l))) {
          remOffs.push((k * 26 + l) * stride);
          est += cnt[base + l];
        }
      }
    }
    if (!remOffs.length) return;
    this._snapshot(vi);
    const size = this.size[vi];
    if (est * 4 < size) {
      // Few words go: remove them individually.
      let lost = 0;
      let removed = 0;
      for (const bo of remOffs) {
        for (let w = 0; w < nw; w++) {
          let x = dom[off + w] & bits[bo + w];
          if (!x) continue;
          dom[off + w] &= ~x;
          while (x) {
            const t = x & -x;
            x ^= t;
            removed++;
            const cb = ((w << 5) | lowBit(t)) * L;
            for (let k = 0; k < L; k++) {
              if (--cnt[cntOff + k * 26 + codes[cb + k]] === 0) lost |= 1 << k;
            }
          }
        }
      }
      this.size[vi] = size - removed;
      this._sizeChanged(vi);
      if (lost && this.failVar < 0) this._pushSupports(vi, lost);
    } else {
      // Most words go: bulk filter, then recount.
      const nr = remOffs.length;
      for (let w = 0; w < nw; w++) {
        let x = dom[off + w];
        if (!x) continue;
        for (let j = 0; j < nr && x; j++) x &= ~bits[remOffs[j] + w];
        dom[off + w] = x;
      }
      this.size[vi] = this._recount(vi);
      this._sizeChanged(vi);
      if (this.failVar < 0) this._pushSupports(vi, -1);
    }
  }

  /** Rebuild vi's support counts from its domain; returns the domain size. */
  _recount(vi) {
    const v = this.vars[vi];
    const { cnt, dom } = this;
    const { off, nw, codes, L, cntOff } = v;
    cnt.fill(0, cntOff, cntOff + L * 26);
    let size = 0;
    for (let w = 0; w < nw; w++) {
      let x = dom[off + w];
      while (x) {
        const t = x & -x;
        x ^= t;
        size++;
        const cb = ((w << 5) | lowBit(t)) * L;
        for (let k = 0; k < L; k++) cnt[cntOff + k * 26 + codes[cb + k]]++;
      }
    }
    return size;
  }

  /** Process the queues to a fixpoint. Returns false on a wipe-out (this.failVar is set). */
  _propagate() {
    const { varQ, singleQ, vars, inQ } = this;
    while (this.failVar < 0) {
      if (varQ.length) {
        const vi = varQ.pop();
        inQ[vi] = 0;
        this._revise(vi);
      } else if (singleQ.length) {
        const vi = singleQ.pop();
        if (this.size[vi] !== 1 || this.allowDuplicates) continue;
        const v = vars[vi];
        const i = this._firstWord(vi);
        const word = i >>> 5;
        const bit = 1 << (i & 31);
        for (const vj of v.group) {
          if (vj !== vi && (this.dom[vars[vj].off + word] & bit)) {
            this._removeWord(vj, i);
            if (this.failVar >= 0) break;
          }
        }
      } else {
        return true;
      }
    }
    for (const vi of varQ) inQ[vi] = 0;
    varQ.length = 0;
    singleQ.length = 0;
    return false;
  }

  _firstWord(vi) {
    const v = this.vars[vi];
    for (let w = 0; w < v.nw; w++) {
      const x = this.dom[v.off + w];
      if (x) return (w << 5) | lowBit(x);
    }
    return -1;
  }

  /** Assign word index i to variable vi and propagate. */
  _assign(vi, i) {
    const v = this.vars[vi];
    this._snapshot(vi);
    this.dom.fill(0, v.off, v.off + v.nw);
    this.dom[v.off + (i >>> 5)] = 1 << (i & 31);
    this.size[vi] = this._recount(vi);
    this.singleQ.push(vi);
    this._pushSupports(vi, -1);
    return this._propagate();
  }

  // ---------------------------------------------------------------------------
  // Heuristics

  /**
   * dom/wdeg variable choice; -1 when every variable is down to a single word (solved).
   * Entries that can still take a prefer (theme) word go first, so that crossing choices — which value ordering
   * may skew away from penalized words — cannot squeeze a theme word out before it gets its turn.
   */
  _selectVar() {
    const { size, weight, vars, rng } = this;
    const { preferFirst } = this;
    let best = -1;
    let bestKey = Infinity;
    let bestL = 0;
    let ties = 0;
    for (let vi = 0; vi < vars.length; vi++) {
      const s = size[vi];
      if (s <= 1) continue;
      let key = s / weight[vi];
      if (preferFirst && !this._preferLeft(vi)) key += PREFER_LAST;
      const L = vars[vi].L;
      if (key < bestKey || (key === bestKey && L > bestL)) {
        best = vi;
        bestKey = key;
        bestL = L;
        ties = 1;
      } else if (key === bestKey && L === bestL) {
        // Reservoir-sample among exact ties so restarts explore different orders.
        ties++;
        if (rng() * ties < 1) best = vi;
      }
    }
    return best;
  }

  /**
   * Domain of vi ordered best-first: { cands } (Int32Array of word indices), plus { vals } (the ordering value of
   * each, descending) when some entry has `penalize` points — see _avoidPenalty.
   */
  _orderValues(vi) {
    const v = this.vars[vi];
    const { dom, cnt, size, vars, log2, rng } = this;
    const n = size[vi];
    const keys = new Float64Array(n);
    const { L, codes, scores, crossVar, crossPos, lex, pen } = v;
    const noise = this.randomness * FILL_TUNING.noise;
    const { laMin, laMean, laCap } = FILL_TUNING;
    const prefer = this.prefer.size ? this.prefer : null;
    let j = 0;
    for (let w = 0; w < v.nw; w++) {
      let x = dom[v.off + w];
      while (x) {
        const t = x & -x;
        x ^= t;
        const i = (w << 5) | lowBit(t);
        let val = scores[i];
        if (val >= PREFER_SCORE && prefer && prefer.has(lex.words[i])) val += PREFER_BONUS;
        else if (pen) val -= pen[i];
        // Look-ahead: words left in each crossing if this word is placed.
        let mn = laCap;
        let sum = 0;
        let nc = 0;
        const cb = i * L;
        for (let k = 0; k < L; k++) {
          const f = crossVar[k];
          if (f < 0 || size[f] <= 1) continue;
          const lg = log2[cnt[vars[f].cntOff + crossPos[k] * 26 + codes[cb + k]]];
          if (lg < mn) mn = lg;
          sum += lg;
          nc++;
        }
        if (nc) val += laMin * mn + laMean * (sum / nc);
        else val += (laMin + laMean) * laCap;
        if (noise) val += noise * rng();
        let q = Math.round((val + KEY_OFFSET) * 64);
        if (q < 0) q = 0;
        else if (q >= KEY_LEVELS) q = KEY_LEVELS - 1;
        keys[j++] = (KEY_LEVELS - 1 - q) * IDX_BITS + i;
      }
    }
    keys.sort();
    const cands = new Int32Array(n);
    for (let k = 0; k < n; k++) cands[k] = keys[k] % IDX_BITS;
    if (!this.hasPenalties) return { cands, vals: null };
    const vals = new Float64Array(n);
    for (let k = 0; k < n; k++) vals[k] = (KEY_LEVELS - 1 - Math.floor(keys[k] / IDX_BITS)) / 64 - KEY_OFFSET;
    return { cands, vals };
  }

  /**
   * Penalty points of the words the last assignment to vi fixed in other entries: variables that had several words
   * left (`sizesBefore`, the sizes at the decision's checkpoint) and are down to a single, penalized one.
   */
  _newlyFixedPenalty(vi, sizesBefore) {
    const { vars, size } = this;
    let p = 0;
    for (let u = 0; u < vars.length; u++) {
      if (u !== vi && size[u] === 1 && sizesBefore[u] > 1 && vars[u].pen) p += vars[u].pen[this._firstWord(u)];
    }
    return p;
  }

  /**
   * Lower the value of frame f's current candidate (the one at f.ptr − 1) by p points and move it down its remaining
   * candidates accordingly, so the next one gets tried first. Each candidate is moved at most once per frame (the
   * next time it comes up it is taken). Returns false, changing nothing, if it was moved before or is still the
   * best option left.
   */
  _defer(f, p) {
    const { cands, vals } = f;
    const i = cands[f.ptr - 1];
    if (f.deferred && f.deferred.has(i)) return false;
    const v = vals[f.ptr - 1] - p;
    let j = f.ptr;
    if (j >= cands.length || vals[j] < v) return false;
    for (; j < cands.length && vals[j] >= v; j++) {
      cands[j - 1] = cands[j];
      vals[j - 1] = vals[j];
    }
    cands[j - 1] = i;
    vals[j - 1] = v;
    f.ptr--;
    (f.deferred ||= new Set()).add(i);
    return true;
  }

  /**
   * Re-rank the first few candidates by actually placing each one and propagating: values that wipe out are
   * dropped, and the rest are ordered by word score (minus the penalties of the word and of the penalized words it
   * forces elsewhere) plus how much freedom (Σ log2 domain size) they leave; the others follow in their order.
   */
  _probe(vi, cands) {
    const K = Math.min(FILL_TUNING.probe, cands.length);
    const mark = this._checkpoint();
    const { size, vars } = this;
    const v = vars[vi];
    const sizesBefore = this.hasPenalties ? size.slice() : null;
    const probed = [];
    let best = -Infinity;
    for (let j = 0; j < K; j++) {
      const i = cands[j];
      if (this._assign(vi, i)) {
        let freedom = 0;
        for (let u = 0; u < vars.length; u++) if (size[u] > 1) freedom += Math.log2(size[u]);
        let score = v.scores[i];
        if (sizesBefore) score -= (v.pen ? v.pen[i] : 0) + this._newlyFixedPenalty(vi, sizesBefore);
        probed.push({ i, freedom, score });
        if (freedom > best) best = freedom;
      } else {
        this.weight[this.failVar] += 1;
      }
      this._undo(mark);
    }
    const w = FILL_TUNING.probeWeight;
    probed.sort((a, b) => (b.score + w * (b.freedom - best)) - (a.score + w * (a.freedom - best)));
    const out = new Int32Array(probed.length + cands.length - K);
    probed.forEach((p, k) => { out[k] = p.i; });
    out.set(cands.subarray(K), probed.length);
    return out;
  }

  /**
   * With `penalize`, after frame f's candidate i was assigned successfully: does the assignment cost penalty points
   * — the word's own, or those of penalized words it forced elsewhere? Entries the crossings complete are never
   * chosen themselves (most of a mini's acrosses, once its downs are in), so this is where those get avoided. The
   * frame ranked i by its own penalty only, so first i moves down the frame by the forced points if other
   * candidates then rank better; otherwise this is the best the decision can do, and the cost is charged to the
   * decisions that led here: the nearest one (parent frame, grandparent, …) that has an alternative ranking better
   * once its choice is charged tries that alternative first. Returns true if another candidate should be tried
   * (the frames above it are popped) — the caller then continues its loop, which undoes to the top frame's
   * checkpoint. Each candidate moves at most once per frame, and a fill has a budget of moves. (After a restart,
   * frames are probed instead, which ranks by both penalties directly.)
   */
  _avoidPenalty(stack, f, i) {
    const v = this.vars[f.vi];
    const own = v.pen ? v.pen[i] : 0;
    const forced = this._newlyFixedPenalty(f.vi, f.sizes);
    if (!own && !forced) return false;
    if (forced && this._defer(f, forced)) {
      this.deferBudget--;
      return true;
    }
    for (let d = stack.length - 2; d >= 0; d--) {
      if (this._defer(stack[d], own + forced)) {
        this.deferBudget--;
        stack.length = d + 1;
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Search

  async solve() {
    const { vars, signal } = this;
    const deadline = this.t0 + this.timeLimitMs;
    let lastYield = now();
    let lastProgress = lastYield;
    let cutoff = FILL_TUNING.firstCutoff;
    let backtracksAtRestart = 0;
    let bestAssigned = 0;
    const stack = []; // frames: { vi, cands, vals, sizes, deferred, ptr, mark } (see below)
    const stats = this.stats;

    const countAssigned = () => {
      let a = 0;
      for (let vi = 0; vi < vars.length; vi++) if (this.size[vi] === 1) a++;
      return a;
    };

    outer: for (;;) {
      const vi = this._selectVar();
      if (vi < 0) return this._success();
      let { cands, vals } = this._orderValues(vi);
      // Easy grids are solved before the first restart with cheap ordering; hard ones get probing (which ranks by
      // penalties itself, see _probe).
      if (FILL_TUNING.probe > 1 && stats.restarts >= FILL_TUNING.probeAfterRestarts) {
        cands = this._probe(vi, cands);
        vals = null;
      }
      // With penalties (vals): the variable sizes at this checkpoint, to see which words an assignment forces.
      const sizes = vals ? this.size.slice() : null;
      stack.push({ vi, cands, vals, sizes, deferred: null, ptr: 0, mark: this._checkpoint() });

      for (;;) {
        // Housekeeping: time limit, abort, yielding, progress.
        const t = now();
        if (t - lastYield >= YIELD_EVERY_MS) {
          await yieldToEventLoop();
          lastYield = now();
        }
        if (signal && signal.aborted) return this._stop('aborted');
        if (t >= deadline) return this._stop('timeout');
        if (this.onProgress && t - lastProgress >= PROGRESS_EVERY_MS) {
          lastProgress = t;
          const assigned = countAssigned();
          if (assigned > bestAssigned) bestAssigned = assigned;
          this._emitProgress(t, assigned, bestAssigned);
        }

        const f = stack[stack.length - 1];
        this._undo(f.mark);
        if (f.ptr >= f.cands.length) {
          // Every value of this variable failed: backtrack to the parent decision.
          stack.pop();
          if (!stack.length) return this._fail(this._worstVar(), 'impossible', true);
          continue;
        }
        const i = f.cands[f.ptr++];
        stats.nodes++;
        if (this._assign(f.vi, i)) {
          if (f.vals && this.deferBudget > 0 && this._avoidPenalty(stack, f, i)) continue;
          continue outer;
        }

        // Wipe-out: weight the culprit so dom/wdeg picks it earlier next time.
        stats.backtracks++;
        const fv = this.failVar;
        this.weight[fv] += 1;
        this.wipeouts[fv]++;
        if (stats.backtracks - backtracksAtRestart > cutoff) {
          stats.restarts++;
          backtracksAtRestart = stats.backtracks;
          cutoff *= FILL_TUNING.cutoffGrowth;
          this._undo(this.rootMark);
          stack.length = 0;
          continue outer;
        }
      }
    }
  }

  _emitProgress(t, assigned, bestAssigned) {
    const total = this.vars.length;
    try {
      this.onProgress({
        ms: Math.round(t - this.t0),
        nodes: this.stats.nodes,
        backtracks: this.stats.backtracks,
        restarts: this.stats.restarts,
        assigned,
        total,
        best: bestAssigned,
        progress: total ? bestAssigned / total : 1,
      });
    } catch {
      // A failing progress callback must not break the fill.
    }
  }

  /** The variable that wiped out most often (best guess at the bottleneck). */
  _worstVar() {
    let best = -1;
    let bestW = 0;
    for (let vi = 0; vi < this.vars.length; vi++) {
      if (this.wipeouts[vi] > bestW) {
        bestW = this.wipeouts[vi];
        best = vi;
      }
    }
    return best >= 0 ? best : this.failVar;
  }

  _success() {
    const out = this.grid.cells.slice();
    const wl = this.wordlist;
    let sum = 0;
    let count = 0;
    let min = Infinity;
    for (let vi = 0; vi < this.vars.length; vi++) {
      const v = this.vars[vi];
      const word = v.lex.words[this._firstWord(vi)];
      for (let k = 0; k < v.L; k++) {
        const c = v.cells[k];
        if (out[c] === EMPTY) out[c] = word[k];
      }
      if (!this.prefer.has(word)) {
        const s = wl.score(word) ?? 0;
        sum += s;
        count++;
        if (s < min) min = s;
      }
    }
    this.cells = out;
    this.status = 'solved';
    this.stats.avgScore = count ? Math.round((sum / count) * 10) / 10 : null;
    this.stats.minWordScore = count ? min : null;
    return this.result();
  }

  _stop(reason) {
    this._undo(this.rootMark);
    this.status = reason;
    this.reason = reason;
    this.problem = this._describe(this._worstVar(), reason);
    return this.result();
  }

  _fail(vi, reason, proven = false) {
    this.status = reason;
    this.reason = reason;
    this.problem = this._describe(vi, reason, proven);
    return this.result();
  }

  /** May `word` appear in a fill? (a prefer word, or a list word with score ≥ minScore that is not avoided) */
  _usableWord(word) {
    if (this.prefer.has(word)) return true;
    if (this.avoid.has(word) || !this.wordlist.has(word)) return false;
    return (this.wordlist.score(word) ?? 0) >= this.minScore;
  }

  /** verifyComplete found a complete entry that is not acceptable: the grid cannot be filled as it is. */
  _badEntry(entry, word, message) {
    this.status = 'impossible';
    this.reason = 'impossible';
    this.problem = { entryId: entry.id, pattern: word, message, cells: entry.cells.slice() };
    return this.result();
  }

  _invalid(message, entryId = null, cells = []) {
    this.status = 'invalid';
    this.reason = 'invalid';
    this.problem = { entryId, pattern: null, message, cells };
    return this.result();
  }

  /** Human-readable explanation for the entry that blocked the fill. */
  _describe(vi, reason, proven = false) {
    if (vi === undefined || vi < 0 || !this.vars || !this.vars[vi]) {
      if (reason === 'aborted') return null;
      return { entryId: null, pattern: null, message: reason === 'timeout' ? 'Ran out of time before finding a fill' : 'No fill exists for this grid' };
    }
    const v = this.vars[vi];
    const { id } = v.entry;
    const pattern = v.pattern;
    const shown = pattern.replace(/\./g, '_');
    let message;
    if (reason === 'aborted') message = 'Fill stopped';
    else if (v.L < 3 && !this.wordlist.lexicon(v.L)) message = `${id} is only ${v.L} letter${v.L === 1 ? '' : 's'} long; the word list has no words that short`;
    else if (!v.n) message = `The word list has no ${v.L}-letter words${this.minScore > 1 ? ` with score ≥ ${this.minScore}` : ''} for ${id}`;
    else if (this.wordlist.count(pattern, { minScore: this.minScore }) === 0 && !this._preferFits(pattern)) {
      message = `No word in the list fits ${id} (${shown})${this.minScore > 1 ? ` with score ≥ ${this.minScore}` : ''}`;
    } else if (reason === 'timeout') {
      message = `Couldn't fill around ${id} (${shown}) in time — try a lower minimum score, unlocking letters or adding blocks`;
    } else if (proven) {
      message = `No fill exists: ${id} (${shown}) cannot be completed with its crossings — try a lower minimum score, unlocking letters or adding blocks`;
    } else {
      message = `${id} (${shown}) has no word that works with its crossing entries`;
    }
    return { entryId: id, pattern, message };
  }

  /** True if some prefer word (which may be missing from the list) fits the pattern ('.' = any letter). */
  _preferFits(pattern) {
    const re = new RegExp(`^${pattern}$`);
    for (const w of this.prefer) if (w.length === pattern.length && re.test(w)) return true;
    return false;
  }

  result() {
    const ok = this.status === 'solved';
    const stats = { ...this.stats, ms: Math.round(now() - this.t0) };
    return {
      ok,
      cells: ok ? this.cells : null,
      reason: ok ? null : this.reason,
      stats,
      problem: ok ? null : this.problem,
    };
  }
}
