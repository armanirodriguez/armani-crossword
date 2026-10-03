#!/usr/bin/env node
// Build the word data: data/wordlist.txt, data/clues-curated.json, data/clues-dictionary.json.
//
//   npm run wordlist                                   # sources -> data/
//   node scripts/build-wordlist.mjs --out-dir /tmp/x --curated-dir tests/fixtures/data/curated
//
// Options:
//   --out-dir <dir>       where to write the three outputs (default: data/)
//   --curated-dir <dir>   curated TSVs to merge (default: data/curated/)
//   --banned <file>       banned word list (default: data/banned.txt)
//   --samples <n>         print n random dictionary clues at the end (quality review)
//   --seed <n>            seed for the samples (default 1)
//   --quiet               only print errors
//
// Pipeline (see data/README.md):
//   1. SCOWL words scored by frequency level, WordNet knowledge and inflection; junk dropped.
//   2. + WordNet proper nouns and multi-word collocations (moderate scores).
//   3. Curated TSV scores override everything (score 0 = ban); banned.txt words removed.
//   4. Clue banks: curated clues; WordNet-derived clues for every word scoring >= 25.
// All outputs are written atomically (temp file + rename): other tools may read them while we run.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWordList, expandBanned, makeBannedPredicate } from './data/banned.mjs';
import { ClueDeriver } from './data/clues.mjs';
import { collectCollocations } from './data/collocations.mjs';
import { loadCuratedDir } from './data/curated.mjs';
import { Lexicon } from './data/lexicon.mjs';
import { collectProperNouns } from './data/propernouns.mjs';
import { loadScowl } from './data/scowl.mjs';
import { scoreScowlCased, scoreScowlWords } from './data/scoring.mjs';
import { WordNet } from './data/wordnet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DICTIONARY_MIN_SCORE = 25;
export const WORDNET_MIN_SCORE = 20;
export const SCORE_BANDS = [[70, 100, '70-100'], [50, 69, '50-69'], [35, 49, '35-49'], [1, 34, '1-34']];

function parseArgs(argv) {
  const opts = {
    outDir: path.join(ROOT, 'data'),
    curatedDir: path.join(ROOT, 'data', 'curated'),
    banned: path.join(ROOT, 'data', 'banned.txt'),
    samples: 0,
    seed: 1,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--out-dir') opts.outDir = path.resolve(next());
    else if (a === '--curated-dir') opts.curatedDir = path.resolve(next());
    else if (a === '--banned') opts.banned = path.resolve(next());
    else if (a === '--samples') opts.samples = Number(next()) || 0;
    else if (a === '--seed') opts.seed = Number(next()) || 1;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown option ${a}`);
  }
  return opts;
}

/** Write a file atomically: readers see either the old or the new complete content. */
export function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/** JSON object with one key per line: valid JSON, diff-friendly, compact. Keys sorted. */
function jsonLines(map) {
  const keys = [...map.keys()].sort();
  if (!keys.length) return '{}\n';
  return `{\n${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(map.get(k))}`).join(',\n')}\n}\n`;
}

function packageVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || '?';
  } catch {
    return '?';
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Run the whole pipeline. Returns stats (also used by tests). */
export function build(opts) {
  const t0 = Date.now();
  const log = opts.quiet ? () => {} : (...a) => console.log(...a);
  const wnDir = path.join(ROOT, 'node_modules', 'wordnet-db', 'dict');
  const scowlDir = path.join(ROOT, 'node_modules', 'wordlist-english');

  const wn = WordNet.load(wnDir);
  const scowl = loadScowl(scowlDir);
  const lex = new Lexicon(wn, scowl);
  const bannedText = fs.existsSync(opts.banned) ? fs.readFileSync(opts.banned, 'utf8') : '';
  const bannedListed = parseWordList(bannedText);
  const isBanned = makeBannedPredicate(expandBanned(bannedListed));

  // 1–2. Candidate words from every source; the same word from several sources keeps its best score.
  const entries = new Map(); // WORD -> { score, source, lemma? }
  const offer = (word, score, source, lemma = null) => {
    const prev = entries.get(word);
    if (!prev || score > prev.score) entries.set(word, { score, source, lemma: lemma ?? prev?.lemma ?? null });
    else if (lemma && !prev.lemma) prev.lemma = lemma;
  };
  const scowlScored = scoreScowlWords(lex);
  for (const [w, s] of scowlScored.scores) offer(w, s, 'scowl');
  for (const [w, s] of scoreScowlCased(lex)) offer(w, s, 'scowl-proper');
  // WordNet-only entries need some evidence: below WORDNET_MIN_SCORE they are noise rather than emergency fill.
  const proper = collectProperNouns(wn, isBanned);
  for (const [w, { score, lemma }] of proper) if (score >= WORDNET_MIN_SCORE) offer(w, score, 'proper', lemma);
  const phrases = collectCollocations(lex, isBanned);
  for (const [w, { score, lemma }] of phrases) if (score >= WORDNET_MIN_SCORE) offer(w, score, 'phrase', lemma);

  // 3. Curated scores are authoritative; score 0 bans.
  const curated = loadCuratedDir(opts.curatedDir);
  let curatedBans = 0;
  let curatedAdded = 0;
  for (const [w, e] of curated.merged) {
    if (e.banned) {
      if (entries.delete(w)) curatedBans++;
      continue;
    }
    if (!entries.has(w)) curatedAdded++;
    const prev = entries.get(w);
    entries.set(w, { score: e.score, source: 'curated', lemma: prev?.lemma ?? null });
  }
  // A curated ban also covers the word's regular plural / -s forms (CONDOM → CONDOMS), unless that form was curated
  // separately with a positive score (SEX is banned, SEXES is curated at 15 and stays).
  const curatedBanned = [...curated.merged].filter(([, e]) => e.banned).map(([w]) => w);
  for (const w of expandBanned(curatedBanned)) {
    const e = curated.merged.get(w);
    if (e && !e.banned) continue;
    if (entries.delete(w)) curatedBans++;
  }
  let bannedRemoved = 0;
  for (const w of [...entries.keys()]) {
    if (isBanned(w) || !/^[A-Z]{3,21}$/.test(w)) {
      entries.delete(w);
      bannedRemoved++;
    }
  }

  // Word list.
  const words = [...entries.keys()].sort();
  const curatedFileCount = curated.files.length;
  const header = [
    '# Crossword Club word list — generated by scripts/build-wordlist.mjs (npm run wordlist). Do not edit by hand:',
    '# change data/curated/*.tsv or data/banned.txt and rebuild, or add your own words in data/user-words.txt.',
    '# Format: WORD;SCORE — WORD is A-Z (3-21 letters), SCORE 1-100 (70+ lively, 50-69 solid, 35-49 acceptable,',
    '# 1-34 obscure / only if needed). Banned words are absent. See data/README.md.',
    `# Sources: SCOWL (wordlist-english ${packageVersion(scowlDir)}, levels 10-70, english+american); ` +
      `WordNet ${wn.version || '3.1'} (wordnet-db ${packageVersion(path.dirname(wnDir))}); ` +
      `curated TSVs: ${curatedFileCount} file(s), ${curated.merged.size} words; banned.txt: ${bannedListed.size} words.`,
    `# Entries: ${words.length}`,
  ];
  const listText = `${header.join('\n')}\n${words.map((w) => `${w};${entries.get(w).score}`).join('\n')}\n`;
  writeFileAtomic(path.join(opts.outDir, 'wordlist.txt'), listText);

  // Curated clue bank (only words that made it into the list).
  const curatedClues = new Map();
  for (const [w, e] of curated.merged) {
    if (!entries.has(w) || !e.clues.length) continue;
    curatedClues.set(w, e.clues.filter((c) => !hasBannedToken(c, isBanned)));
  }
  writeFileAtomic(path.join(opts.outDir, 'clues-curated.json'), jsonLines(curatedClues));

  // Dictionary clue bank.
  const tClues = Date.now();
  const phraseLemmas = new Map();
  for (const [w, e] of entries) if (e.lemma) phraseLemmas.set(w, e.lemma);
  const phraseScores = new Map([...phrases].map(([w, { score }]) => [w, score]));
  const deriver = new ClueDeriver({ lex, isBanned, phraseLemmas, phraseScores });
  const dictClues = new Map();
  for (const w of words) {
    if (entries.get(w).score < DICTIONARY_MIN_SCORE) continue;
    const clues = deriver.cluesFor(w);
    if (clues.length) dictClues.set(w, clues);
  }
  writeFileAtomic(path.join(opts.outDir, 'clues-dictionary.json'), jsonLines(dictClues));
  const clueMs = Date.now() - tClues;

  const stats = {
    words: words.length,
    sources: countBy(words, (w) => entries.get(w).source),
    junk: Object.fromEntries(scowlScored.junk),
    inflections: scowlScored.inflections,
    properNouns: proper.size,
    phrases: phrases.size,
    curatedWords: curated.merged.size,
    curatedAdded,
    curatedBans,
    bannedRemoved,
    curatedClueWords: curatedClues.size,
    dictionaryClueWords: dictClues.size,
    warnings: curated.warnings,
    ms: Date.now() - t0,
    clueMs,
  };
  if (!opts.quiet) printSummary({ stats, entries, words, curatedClues, dictClues, opts, log });
  return stats;
}

function hasBannedToken(text, isBanned) {
  return (text.match(/[A-Za-z]+/g) || []).some((t) => t.length >= 3 && isBanned(t.toUpperCase()));
}

function countBy(items, keyFn) {
  const out = {};
  for (const it of items) {
    const k = keyFn(it);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function pct(n, d) {
  return d ? `${((100 * n) / d).toFixed(0)}%` : '-';
}

function printSummary({ stats, entries, words, curatedClues, dictClues, opts, log }) {
  log(`\nWrote ${path.relative(process.cwd(), opts.outDir) || '.'}/wordlist.txt (${stats.words} words), ` +
    `clues-curated.json (${stats.curatedClueWords}), clues-dictionary.json (${stats.dictionaryClueWords}) ` +
    `in ${(stats.ms / 1000).toFixed(1)} s (clues ${(stats.clueMs / 1000).toFixed(1)} s)`);
  log(`Sources (winning): ${Object.entries(stats.sources).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  log(`Candidates: proper nouns ${stats.properNouns}, phrases ${stats.phrases}, SCOWL inflections ${stats.inflections}; ` +
    `junk dropped: ${Object.entries(stats.junk).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  log(`Curated: ${stats.curatedWords} words (${stats.curatedAdded} new, ${stats.curatedBans} banned by score 0); ` +
    `banned.txt removed ${stats.bannedRemoved}`);
  for (const w of stats.warnings.slice(0, 10)) log(`  warning: ${w}`);
  if (stats.warnings.length > 10) log(`  … ${stats.warnings.length - 10} more warnings`);

  // Counts by length and score band.
  const lengths = [...new Set(words.map((w) => w.length))].sort((a, b) => a - b);
  const pad = (s, n) => String(s).padStart(n);
  log(`\nWords by length and score band:`);
  log(`${pad('len', 4)}${SCORE_BANDS.map(([, , name]) => pad(name, 8)).join('')}${pad('>=30', 8)}${pad('total', 8)}`);
  for (const L of lengths) {
    const ws = words.filter((w) => w.length === L);
    const bands = SCORE_BANDS.map(([lo, hi]) => ws.filter((w) => entries.get(w).score >= lo && entries.get(w).score <= hi).length);
    log(`${pad(L, 4)}${bands.map((n) => pad(n, 8)).join('')}${pad(ws.filter((w) => entries.get(w).score >= 30).length, 8)}${pad(ws.length, 8)}`);
  }

  // Clue coverage for fill-worthy words.
  log(`\nClue coverage for words scoring >= 30 (curated / dictionary only / none):`);
  let tc = 0; let td = 0; let tn = 0;
  for (const L of lengths) {
    const ws = words.filter((w) => w.length === L && entries.get(w).score >= 30);
    if (!ws.length) continue;
    const c = ws.filter((w) => curatedClues.get(w)?.length).length;
    const d = ws.filter((w) => !curatedClues.get(w)?.length && dictClues.has(w)).length;
    const n = ws.length - c - d;
    tc += c; td += d; tn += n;
    log(`${pad(L, 4)}  ${pad(c, 6)} ${pad(pct(c, ws.length), 4)}  ${pad(d, 6)} ${pad(pct(d, ws.length), 4)}  ${pad(n, 6)} ${pad(pct(n, ws.length), 4)}`);
  }
  const tot = tc + td + tn;
  log(` all  ${pad(tc, 6)} ${pad(pct(tc, tot), 4)}  ${pad(td, 6)} ${pad(pct(td, tot), 4)}  ${pad(tn, 6)} ${pad(pct(tn, tot), 4)}`);

  // Examples.
  const rnd = mulberry32(opts.seed);
  const dictWords = [...dictClues.keys()];
  const n = opts.samples || 8;
  log(`\nExample dictionary clues:`);
  for (let i = 0; i < n && dictWords.length; i++) {
    const w = dictWords[Math.floor(rnd() * dictWords.length)];
    log(`  ${w} (${entries.get(w).score}): ${dictClues.get(w).join(' | ')}`);
  }
}

/** True when the source packages (dev dependencies) are installed. */
function sourcesInstalled() {
  const require = createRequire(import.meta.url);
  try {
    for (const name of ['wordlist-english', 'wordnet-db']) require.resolve(`${name}/package.json`);
    return true;
  } catch {
    return false;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (!sourcesInstalled()) {
    console.error('Run npm install first — it\'s only needed to rebuild the word list and for tests.');
    process.exit(1);
  }
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (opts.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  } else {
    build(opts);
  }
}
