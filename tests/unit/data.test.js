// Word data pipeline (scripts/build-wordlist.mjs + scripts/data/*): unit tests of the helpers, an end-to-end build
// into a temp directory against small fixture curated/banned files, and sanity checks of the real data/ outputs.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeAnswer } from '../../site/shared/puzzle.js';
import { parseCuratedTsv, mergeCurated } from '../../scripts/data/curated.mjs';
import { analyze, inflect } from '../../scripts/data/morphology.mjs';
import { shortenGloss, clueLeaks, cutToLength } from '../../scripts/data/gloss.mjs';
import { junkReason } from '../../scripts/data/junk.mjs';
import { parseWordList, expandBanned, makeBannedPredicate, BANNED_ROOTS } from '../../scripts/data/banned.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'data');
const DATA = path.join(ROOT, 'data');

/** Parse wordlist.txt text into { header: string[], entries: Map<WORD, score>, lines: string[] }. */
function parseWordlist(text) {
  const header = [];
  const lines = [];
  const entries = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.startsWith('#')) { header.push(line); continue; }
    lines.push(line);
    const [w, s] = line.split(';');
    entries.set(w, Number(s));
  }
  return { header, entries, lines };
}

// ---------------------------------------------------------------------------------------------------------------
describe('curated TSV parsing and merging', () => {
  test('parses rows, skips comments/blank lines, warns on bad rows', () => {
    const { rows, warnings } = parseCuratedTsv('# c\nZebra\t40\tStriped animal\t\n\nBAD\tx\tclue\nAB\t50\nOK WORD\t7\n', 't.tsv');
    assert.deepEqual(rows.map((r) => [r.word, r.score, r.clues]), [['ZEBRA', 40, ['Striped animal']], ['OKWORD', 7, []]]);
    assert.equal(warnings.length, 2);
  });

  test('any 0 bans; otherwise max score; clues concatenated and deduped; clues containing the answer dropped', () => {
    const a = parseCuratedTsv('ZEBRA\t40\tStriped animal\nQUIRK\t60\tOddity\nDOG\t50\tHot dog topping?\n').rows;
    const b = parseCuratedTsv('ZEBRA\t75\tstriped animal\tCrosswalk namesake\nQUIRK\t0\n').rows;
    const { merged, warnings } = mergeCurated([{ name: 'a', rows: a }, { name: 'b', rows: b }]);
    assert.deepEqual(merged.get('ZEBRA'), { score: 75, banned: false, clues: ['Striped animal', 'Crosswalk namesake'], sources: ['a', 'b'] });
    assert.equal(merged.get('QUIRK').banned, true);
    assert.equal(merged.get('QUIRK').score, 0);
    assert.deepEqual(merged.get('DOG').clues, []);
    assert.equal(warnings.length, 1);
  });
});

describe('morphology', () => {
  const words = new Set(['stopped', 'visited', 'traveled', 'referred', 'knives', 'roofs', 'potatoes', 'happiest',
    'bigger', 'panicked', 'carried', 'dying', 'running', 'gives']);
  const isWord = (w) => words.has(w);
  const lemmas = { v: new Set(['stop', 'visit', 'run', 'take', 'die', 'go', 'feed', 'fee', 'be', 'abandon']),
    n: new Set(['knife', 'mouse', 'leaf', 'leave', 'tiger']), a: new Set(['big', 'happy', 'good']), r: new Set() };
  const has = (l, p) => lemmas[p].has(l);

  test('analyze finds verified base forms, incl. irregulars and consonant doubling', () => {
    const forms = (w) => analyze(w, has).map((a) => `${a.base}/${a.form}`).sort();
    assert.deepEqual(forms('stopped'), ['stop/ed']);
    assert.deepEqual(forms('running'), ['run/ing']);
    assert.deepEqual(forms('dying'), ['die/ing']);
    assert.deepEqual(forms('ran'), ['run/past']);
    assert.deepEqual(forms('taken'), ['take/pp']);
    assert.deepEqual(forms('mice'), ['mouse/pl']);
    assert.deepEqual(forms('knives'), ['knife/pl']);
    assert.deepEqual(forms('bigger'), ['big/er']);
    assert.deepEqual(forms('better'), ['good/er']);
    assert.deepEqual(forms('bed'), []); // not "be" + d
    assert.deepEqual(forms('sing'), []);
  });

  test('inflect picks the attested spelling and refuses to guess', () => {
    assert.equal(inflect('stop', 'ed', isWord), 'stopped');
    assert.equal(inflect('visit', 'ed', isWord), 'visited');
    assert.equal(inflect('refer', 'ed', isWord), 'referred');
    assert.equal(inflect('knife', 'pl', isWord), 'knives');
    assert.equal(inflect('roof', 'pl', isWord), 'roofs');
    assert.equal(inflect('potato', 'pl', isWord), 'potatoes');
    assert.equal(inflect('happy', 'est', isWord), 'happiest');
    assert.equal(inflect('enormous', 'er', isWord), 'more enormous');
    assert.equal(inflect('give', 's', isWord), 'gives');
    assert.equal(inflect('forsake', 'pp', isWord), 'forsaken');
    assert.equal(inflect('forsake', 'ed', isWord), 'forsook'); // -ED answers are clued in the simple past
    assert.equal(inflect('information', 'pl', isWord), null);
  });
});

describe('gloss shortening and leak checks', () => {
  test('shortens WordNet glosses into clue text', () => {
    assert.equal(shortenGloss('the capital and largest city of Norway; "Oslo is lovely"'), 'Capital and largest city of Norway');
    assert.equal(shortenGloss('(Greek mythology) god of love; son of Aphrodite'), 'God of love, in Greek myth');
    assert.equal(shortenGloss('United States inventor who manufactured the first elevator with a safety device (1811-1861)'),
      'U.S. inventor who manufactured the first elevator');
    assert.equal(shortenGloss('change the plans for the use of (land)'), 'Change the plans for the use of land');
    assert.equal(shortenGloss('having a tendency (to); often used in combination'), 'Having a tendency (to)');
    for (const g of ['a frankfurter served hot on a bun', 'the act of running quickly over a long distance without stopping at all']) {
      const s = shortenGloss(g);
      assert.ok(s && s.length <= 60, s);
    }
  });

  test('cuts never leave a dangling function word or a too-short fragment', () => {
    const cut = cutToLength('a system of coordinated measures for apprehending criminals or other individuals in the area', 60);
    assert.ok(cut.length <= 60 && !/\b(of|for|or|the|in)$/.test(cut), cut);
    assert.equal(cutToLength('x '.repeat(40).trim(), 20), null);
  });

  test('clueLeaks catches answers, stems, hidden words and variant spellings', () => {
    assert.ok(clueLeaks('Hot dog topping', 'DOG'));
    assert.ok(clueLeaks('Square measure', 'ARE')); // letters across a word boundary, like the builder's own check
    assert.ok(clueLeaks('Gave up abandonment', 'ABANDON'));
    assert.ok(clueLeaks('Run quickly', 'RUNNING', ['run']));
    assert.ok(clueLeaks('Constructed', 'RECONSTRUCTED'));
    assert.ok(clueLeaks('Disfranchise', 'DISENFRANCHISE'));
    assert.ok(clueLeaks('Frozen dessert containing cream', 'ICECREAM', ['ice', 'cream']));
    assert.ok(!clueLeaks('Subject of the talk', 'THEME'));
    assert.ok(!clueLeaks('Desert', 'ABANDON'));
  });
});

describe('junk and banned words', () => {
  test('junk rules', () => {
    const known = (w) => ['mix', 'myth'].includes(w);
    for (const w of ['csc', 'brrr', 'xiv', 'abc', 'hims', 'kcal', 'ab']) assert.ok(junkReason(w, known), w);
    for (const w of ['mix', 'myth', 'ifs', 'zebra']) assert.equal(junkReason(w, known), null, w);
  });

  test('ban list parsing, plural expansion and roots without false positives', () => {
    const set = expandBanned(parseWordList('# comment\nSlur  # trailing comment\nrape\n\n'));
    const banned = makeBannedPredicate(set);
    for (const w of ['SLUR', 'SLURS', 'RAPE', 'RAPES', 'BULLSHIT', 'MOTHERFUCKERS']) assert.ok(banned(w), w);
    for (const w of ['GRAPE', 'THERAPIST', 'SWANKY', 'COCKPIT', 'WRISTWATCH', 'NIGGLE', 'TITTER', 'ANI']) {
      assert.ok(!banned(w), w);
    }
    assert.ok(BANNED_ROOTS.length > 10);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('build-wordlist end to end (fixture curated files, temp out dir)', () => {
  let out;
  let list;
  let curated;
  let dictionary;
  before(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'xw-data-test-'));
    execFileSync(process.execPath, [
      path.join(ROOT, 'scripts', 'build-wordlist.mjs'), '--quiet', '--out-dir', out,
      '--curated-dir', path.join(FIXTURES, 'curated'), '--banned', path.join(FIXTURES, 'banned.txt'),
    ], { stdio: 'pipe', timeout: 120000 });
    list = parseWordlist(fs.readFileSync(path.join(out, 'wordlist.txt'), 'utf8'));
    curated = JSON.parse(fs.readFileSync(path.join(out, 'clues-curated.json'), 'utf8'));
    dictionary = JSON.parse(fs.readFileSync(path.join(out, 'clues-dictionary.json'), 'utf8'));
  });
  after(() => fs.rmSync(out, { recursive: true, force: true }));

  test('writes all three outputs atomically (no temp files left behind)', () => {
    assert.deepEqual(fs.readdirSync(out).sort(), ['clues-curated.json', 'clues-dictionary.json', 'wordlist.txt']);
  });

  test('wordlist.txt is well-formed, sorted, unique, with a # header', () => {
    assert.ok(list.header.length >= 3 && list.header.some((h) => /SCOWL/.test(h) && /WordNet/.test(h)));
    for (const line of list.lines) assert.match(line, /^[A-Z]{3,21};(100|[1-9]\d?)$/);
    const words = list.lines.map((l) => l.split(';')[0]);
    assert.deepEqual(words, [...words].sort());
    assert.equal(new Set(words).size, words.length);
    assert.ok(words.length > 80000 && words.length < 160000, `size ${words.length}`);
  });

  test('curated merge semantics: max score, 0 bans, authoritative override, clue concatenation', () => {
    assert.equal(list.entries.get('ZEBRA'), 75);
    assert.ok(!list.entries.has('QUIRKY'), 'score 0 in one file bans the word');
    assert.equal(list.entries.get('CAT'), 20, 'curated score overrides the computed one, even downwards');
    assert.equal(list.entries.get('FIXTUREWORD'), 55, 'curated words not in the sources are added');
    assert.deepEqual(curated.ZEBRA, ['Striped animal', 'Savanna grazer', 'Crosswalk namesake']);
    assert.deepEqual(curated.FIXTUREWORD, ['Test-only entry', 'Another test clue']);
    assert.deepEqual(curated.DOG, ['Loyal companion'], 'clue containing its answer is dropped');
    assert.ok(!('QUIRKY' in curated) && !('BADSCORE' in curated));
    assert.deepEqual(Object.keys(curated), Object.keys(curated).sort());
  });

  test('banned words (and their plurals) are absent everywhere, even when curated', () => {
    for (const w of ['PIZZA', 'PIZZAS', 'SPACEDOUT']) {
      assert.ok(!list.entries.has(w), w);
      assert.ok(!(w in curated) && !(w in dictionary), w);
    }
    for (const w of list.entries.keys()) for (const r of BANNED_ROOTS) assert.ok(!w.includes(r.toUpperCase()), w);
  });

  test('known words get sane scores', () => {
    const s = (w) => list.entries.get(w);
    for (const w of ['DOG', 'AREA', 'ABANDON', 'MOTHER', 'GARDEN']) assert.ok(s(w) >= 55, `${w} ${s(w)}`);
    assert.ok(s('ABANDONS') < s('ABANDON') && s('ABANDONS') >= 45, 'plain inflections slightly below the base');
    assert.ok(s('PARIS') >= 45 && s('OHIO') >= 45 && s('JUNE') >= 45, 'famous proper nouns are moderate');
    assert.ok(s('GIVEUP') >= 40 && s('ICECREAM') >= 30, 'common collocations are included');
    assert.ok(s('AERODYNE') < 30, 'obscure dictionary words stay below the default fill threshold');
    for (const w of ['CSC', 'HIMS', 'XIV', 'TANH']) assert.ok(!list.entries.has(w), `junk ${w}`);
  });

  test('dictionary clues: well-formed, short, and never contain their answer', () => {
    const entries = Object.entries(dictionary);
    assert.ok(entries.length > 50000, `${entries.length} words with dictionary clues`);
    for (const [word, clues] of entries) {
      assert.ok(list.entries.get(word) >= 25, `${word} must be a listed word scoring >= 25`);
      assert.ok(Array.isArray(clues) && clues.length >= 1 && clues.length <= 3, word);
      for (const c of clues) {
        assert.ok(typeof c === 'string' && c.trim() === c && c.length > 0 && c.length <= 60, `${word}: "${c}"`);
        assert.ok(!normalizeAnswer(c).includes(word), `${word}: "${c}"`);
      }
    }
    assert.ok(dictionary.ABANDON?.length >= 2, 'ABANDON has clues');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('real data/ outputs (when built)', () => {
  const have = (f) => fs.existsSync(path.join(DATA, f));

  test('data/wordlist.txt is well-formed and contains no banned word', { skip: !have('wordlist.txt') }, () => {
    const { entries, lines } = parseWordlist(fs.readFileSync(path.join(DATA, 'wordlist.txt'), 'utf8'));
    for (const line of lines) assert.match(line, /^[A-Z]{3,21};(100|[1-9]\d?)$/);
    const banned = makeBannedPredicate(expandBanned(parseWordList(fs.readFileSync(path.join(DATA, 'banned.txt'), 'utf8'))));
    const bad = [...entries.keys()].filter((w) => banned(w));
    assert.deepEqual(bad, []);
  });

  test('no clue in data/clues-*.json contains its answer (all entries)', { skip: !have('clues-dictionary.json') }, () => {
    for (const file of ['clues-dictionary.json', 'clues-curated.json']) {
      if (!have(file)) continue;
      const bank = JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8'));
      const leaks = [];
      for (const [word, clues] of Object.entries(bank)) {
        for (const c of clues) if (normalizeAnswer(c).includes(word)) leaks.push(`${word}: ${c}`);
      }
      assert.deepEqual(leaks, [], file);
    }
  });
});
