// Claude's way generator (SPEC §9, scripts/claude-way.mjs): the clue gates and helpers, and the CLI end to end on a
// temporary root (status → build a Mini → publish with failing / passing clues → check → unpublish), plus a full
// Mini + Midi + Daily set for `check`. The real site/puzzles/ is never touched.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildIndex, hash32, makeDraft, validatePuzzle, loadPuzzle } from '../../site/shared/puzzle.js';
import { computeEntries } from '../../site/shared/grid.js';
import { checkClues, clueHint, clueLeak, stems } from '../../scripts/claude-way/gates.mjs';
import { difficulty, draftAnswers, loadBanned, paths } from '../../scripts/claude-way/common.mjs';
import { choppyReasons, compoundOf, evaluateFill, normalizePlan, structureOf, worksheetJson } from '../../scripts/claude-way/build.mjs';
import { WordList } from '../../engine/wordlist.js';
import { resolveClues } from '../../scripts/claude-way/publish.mjs';
import { parseArgs } from '../../scripts/claude-way.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(REPO, 'scripts', 'claude-way.mjs');

/** Run the CLI; resolves { code, stdout, stderr, json } (json = parsed stdout when it is JSON). */
function run(args, { cwd = REPO } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, maxBuffer: 1 << 24, timeout: 120000 }, (err, stdout, stderr) => {
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        // human output
      }
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr, json });
    });
  });
}

// ---------------------------------------------------------------------------
// Pure helpers

describe('gates', () => {
  test('stems: plural, -ed, -ing (with doubled consonants), -er, -ies', () => {
    assert.ok(stems('BAKED').has('BAKE'));
    assert.ok(stems('RUNNING').has('RUN'));
    assert.ok(stems('PARTIES').has('PARTY'));
    assert.ok(stems('BAKERS').has('BAKER'));
    assert.ok(stems('EATS').has('EAT'));
    assert.deepEqual([...stems('SEED')], ['SEED']); // SE is too short to be a root
  });

  test('clueLeak: whole word, letters-only substring for 4+ letters, shared roots', () => {
    assert.match(clueLeak('Pie a la mode', 'PIE'), /contains its answer PIE/);
    assert.equal(clueLeak('Thanksgiving dessert', 'PIE'), null);
    assert.equal(clueLeak('Piece of cake', 'PIE'), null); // 3 letters: whole words only
    assert.match(clueLeak('Ice-cream treat', 'ICECREAM'), /contains its answer/);
    assert.match(clueLeak('Greatly', 'GREAT'), /contains its answer/);
    // Letters running through words by coincidence, not from a word start, are not a leak.
    assert.equal(clueLeak('President after Theodore Roosevelt', 'TAFT'), null);
    assert.equal(clueLeak('Body part for hearing', 'EAR'), null);
    assert.match(clueLeak('Where to ice-skate', 'ICESKATE'), /contains its answer/);
    assert.match(clueLeak('Did some baking', 'BAKED'), /shares the root BAK/);
    assert.match(clueLeak('Run fast', 'RUNS'), /shares the root RUN/);
    assert.match(clueLeak('One-eyed', 'ONES'), /root ONE/);
    assert.equal(clueLeak('Ate', 'EATEN'), null);
    assert.equal(clueLeak('Has dinner', 'EATS'), null);
  });

  test('clueHint: a clue word hidden in a long answer (warning only)', () => {
    assert.match(clueHint('Spooky house attraction', 'HAUNTEDHOUSE'), /"house" is part of the answer/);
    assert.match(clueHint('Wheel cover cap', 'HUBCAP'), /"cap"/);
    assert.equal(clueHint('The scariest stop on the block', 'HAUNTEDHOUSE'), null);
  });

  test('checkClues lists every problem', () => {
    const isBanned = (w) => (w === 'ZONK' ? 'test ban' : null);
    const entries = [
      { id: '1A', answer: 'PIE', clue: 'Pie chart' },
      { id: '4A', answer: 'GOODY', clue: '' },
      { id: '5A', answer: 'ERA', clue: 'Period' },
      { id: '6A', answer: 'EPOCH', clue: 'period.' },
      { id: '1D', answer: 'ZONK', clue: 'Knock out' },
      { id: '2D', answer: 'TEN', clue: 'x'.repeat(81) },
      { id: '3D', answer: 'ACE', clue: 'Zonk card' },
    ];
    const { errors } = checkClues({ entries, isBanned, title: ' ' });
    const text = errors.join('\n');
    assert.match(text, /needs a title/);
    assert.match(text, /1A PIE: clue contains its answer/);
    assert.match(text, /4A GOODY: missing clue/);
    assert.match(text, /6A EPOCH: same clue as 5A ERA/);
    assert.match(text, /1D ZONK: banned answer/);
    assert.match(text, /2D TEN: clue is 81 characters/);
    assert.match(text, /3D ACE: clue uses a banned word \(zonk\)/);
    const ok = checkClues({ entries: [{ id: '1A', answer: 'PIE', clue: 'Thanksgiving dessert' }], isBanned, title: 'T' });
    assert.deepEqual(ok, { errors: [], warnings: [] });
  });

  test('loadBanned: banned.txt words, their plurals, banned roots and user-words bans', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xw-claude-banned-'));
    try {
      await fsp.mkdir(path.join(dir, 'data'));
      await fsp.writeFile(path.join(dir, 'data', 'banned.txt'), '# test\nzonk\nwitch\n');
      await fsp.writeFile(path.join(dir, 'data', 'user-words.txt'), 'GOOD;60\n-blah\n');
      const { isBanned } = loadBanned(paths(dir));
      assert.ok(isBanned('ZONK'));
      assert.ok(isBanned('zonks'));
      assert.ok(isBanned('WITCHES'));
      assert.ok(isBanned('BLAH'));
      assert.ok(isBanned('BULLSHIT'));
      assert.equal(isBanned('GOOD'), null);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('helpers', () => {
  test('difficulty: weekday ramp (Sun ≈ Thu), Mini one level gentler', () => {
    // 2026-10-05 is a Monday … 2026-10-11 a Sunday.
    const days = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    assert.deepEqual(days.map((d) => difficulty(d, 'daily')), [1, 2, 3, 4, 5, 6, 4]);
    assert.deepEqual(days.map((d) => difficulty(d, 'midi')), [1, 2, 3, 4, 5, 6, 4]);
    assert.deepEqual(days.map((d) => difficulty(d, 'mini')), [1, 1, 2, 3, 4, 5, 3]);
  });

  test('normalizePlan: normalises answers, rejects ones too long for the grid, drops duplicates', () => {
    const plan = normalizePlan({ title: 'T', theme: 'Fall', answers: ['Apple pie!', { answer: 'cider', clue: 'Fall drink' }, 'CIDER'] }, 'midi');
    assert.deepEqual(plan.answers.map((a) => a.answer), ['APPLEPIE', 'CIDER']);
    assert.equal(plan.answers[1].clue, 'Fall drink');
    assert.match(plan.warnings.join(' '), /CIDER is listed twice/);
    assert.throws(() => normalizePlan({ title: 'T', theme: 'Fall', answers: ['PUMPKIN'] }, 'mini'), (err) => {
      assert.match(err.details.join(' '), /PUMPKIN has 7 letters but the mini grid is 5×5 — use answers of at most 5 letters/);
      return true;
    });
    assert.throws(() => normalizePlan({ title: 'T', answers: [] }, 'mini'), /plan has problems/);
  });

  test('structureOf / choppyReasons', () => {
    const cells = [...'##PIE##NIPCIDERACE##RED##'];
    const st = structureOf(5, 5, cells);
    assert.equal(st.blocks, 8);
    assert.equal(st.clumps, 2);
    assert.deepEqual(choppyReasons(st, 'mini'), ['8 blocks (tidy ≤ 6)', '2 2×2 block square(s)']);
    assert.deepEqual(choppyReasons(structureOf(5, 5, [...'#CAGE#AURACIDERARIA#TOOT#']), 'mini'), []);
    assert.equal(structureOf(5, 5, [...'###AB', ...'CDEFG', ...'HIJKL', ...'MNOPQ', ...'RS###']).run, 3);
  });

  test('evaluateFill flags low scores, obscure words, recent repeats, shared roots and same-day echoes', () => {
    const wordlist = WordList.fromText('CAT;50\nARE;30\nTEN;60\nEAT;45\nTOES;45');
    const recent = new Map([['TEN', [{ id: '2026-10-01', date: '2026-10-01' }]]]);
    const clueBank = { has: (w) => w !== 'ARE' };
    const grid = { width: 3, height: 3, cells: [...'CAT', ...'ARE', ...'TEN'] };
    const ev = evaluateFill(grid, { wordlist, themeSet: new Set(['CAT']), recent, clueBank, date: '2026-10-05' });
    const flags = Object.fromEntries(ev.entries.map((e) => [e.id, e.flags.join('; ')]));
    assert.equal(ev.entries.find((e) => e.id === '1A').isTheme, true);
    assert.match(flags['4A'], /low score 30/);
    assert.match(flags['4A'], /obscure/);
    assert.match(flags['5A'], /used recently: 2026-10-01/);
    assert.equal(ev.low, 2); // ARE across and down
    assert.ok(ev.quality < ev.avg);
    // EATS (theme) across; EAT down echoes it; TOES shares a root with TOE from the same day's Midi draft.
    const grid2 = { width: 4, height: 4, cells: [...'EATS', ...'A#O#', ...'TOES', ...'##S#'] };
    const recent2 = new Map([['TOE', [{ id: 'claude-2026-10-05-midi', date: '2026-10-05', draft: true }]]]);
    const ev2 = evaluateFill(grid2, { wordlist, themeSet: new Set(['EATS']), recent: recent2, clueBank, date: '2026-10-05' });
    const f2 = Object.fromEntries(ev2.entries.map((e) => [e.id, e.flags.join('; ')]));
    assert.match(f2['1D'], /echoes theme answer EATS/);
    assert.match(f2['3A'], /shares a root with TOE in claude-2026-10-05-midi draft/);
  });

  test('compoundOf / evaluateFill: the same word twice (BAT, ATBAT; EGG, EGGNOG) and fill making a theme answer (POPS, POPUP)', () => {
    const wordlist = WordList.fromText('EGG;50\nNOG;40\nEGGNOG;50\nTEE;45\nTEETER;45\nPOPS;50\nPOPUP;50\nCAT;50');
    assert.equal(compoundOf('BAT', 'ATBAT'), 'BAT'); // a particle: no word list needed
    assert.equal(compoundOf('BONEUP', 'BONE'), 'BONE');
    assert.equal(compoundOf('EGG', 'EGGNOG'), null); // another word only counts with a word list
    assert.equal(compoundOf('EGGNOG', 'EGG', wordlist), 'EGG');
    assert.equal(compoundOf('TEE', 'TEETER', wordlist), null); // TER is not a word
    assert.equal(compoundOf('AT', 'ATBAT'), null); // too short to matter
    // EGG + EGGNOG in one grid: flagged for review ("repeat?") without lowering the fill's ranking.
    const g1 = { width: 6, height: 3, cells: [...'EGGNOG', ...'######', ...'EGG#CAT'.slice(0, 6)] };
    const ev1 = evaluateFill(g1, { wordlist, themeSet: new Set(), recent: new Map(), clueBank: null });
    const f1 = Object.fromEntries(ev1.entries.map((e) => [e.answer, e.flags.join('; ')]));
    assert.match(f1.EGG, /repeat\? 1A EGGNOG/);
    assert.equal(ev1.echoes, 0);
    // POPS echoes the theme answer POPUP (POP + UP).
    const g2 = { width: 5, height: 3, cells: [...'POPUP', ...'#####', ...'POPS#'] };
    const ev2 = evaluateFill(g2, { wordlist, themeSet: new Set(['POPUP']), recent: new Map(), clueBank: null });
    assert.match(ev2.entries.find((e) => e.answer === 'POPS').flags.join(';'), /echoes theme answer POPUP/);
  });

  test('draftAnswers reads across and down words of a cell array', () => {
    assert.deepEqual(draftAnswers({ width: 3, height: 3, cells: [...'CAT', ...'ARE', ...'TEN'] }).sort(), ['ARE', 'ARE', 'CAT', 'CAT', 'TEN', 'TEN']);
  });

  test('worksheetJson writes one line per entry and stays valid JSON', () => {
    const ws = { id: 'x', grid: ['AB'], entries: [{ id: '1A', answer: 'AB' }, { id: '1D', answer: 'AC' }] };
    const text = worksheetJson(ws);
    assert.deepEqual(JSON.parse(text), ws);
    assert.match(text, /\n {4}\{"id":"1A","answer":"AB"\},\n/);
  });

  test('resolveClues: by answer, by id (14A / 14-Across), worksheet format; unknown keys are errors', () => {
    const entries = [{ id: '1A', answer: 'PIE' }, { id: '14D', answer: 'CIDER' }];
    let r = resolveClues({ pie: 'Dessert', '14-Down': 'Drink' }, entries);
    assert.deepEqual([...r.byId], [['1A', 'Dessert'], ['14D', 'Drink']]);
    assert.deepEqual(r.errors, []);
    r = resolveClues({ entries: [{ id: '1A', clue: ' Dessert ' }] }, entries);
    assert.deepEqual([...r.byId], [['1A', 'Dessert']]);
    r = resolveClues({ PIES: 'x', '2A': 'y' }, entries);
    assert.equal(r.errors.length, 2);
    assert.match(resolveClues([], entries).errors[0], /must be a JSON object/);
  });

  test('parseArgs: values, flags, repeated / comma-separated dates', () => {
    const o = parseArgs(['check', '--date', '2026-10-05,2026-10-06', '--date=2026-10-07', '--json']);
    assert.deepEqual(o._, ['check']);
    assert.deepEqual(o.date, ['2026-10-05', '2026-10-06', '2026-10-07']);
    assert.equal(o.json, true);
    assert.throws(() => parseArgs(['build', '--bogus', '1']), /Unknown option --bogus/);
  });
});

// ---------------------------------------------------------------------------
// CLI end to end on a temporary root

describe('CLI on a temporary root', () => {
  let root;
  const TODAY = '2026-10-04'; // a Sunday; tomorrow 2026-10-05 is a Monday
  const DATE = '2026-10-05';
  const MINI = `claude-${DATE}-mini`;
  const clueFile = (name) => path.join(root, name);

  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'xw-claude-way-test-'));
    await fsp.mkdir(path.join(root, 'data'), { recursive: true });
    await fsp.mkdir(path.join(root, 'site', 'puzzles'), { recursive: true });
    for (const f of ['wordlist.txt', 'clues-curated.json']) await fsp.copyFile(path.join(REPO, 'data', f), path.join(root, 'data', f));
    await fsp.writeFile(path.join(root, 'data', 'banned.txt'), '# test list\nzonk\n');
    await fsp.writeFile(path.join(root, 'site', 'config.json'), JSON.stringify({ siteName: 'T', timeZone: 'America/Chicago' }));
    // The user's series: the sample puzzle (fixture, never the real site/puzzles).
    const sample = JSON.parse(await fsp.readFile(path.join(REPO, 'tests', 'fixtures', 'sample-puzzle.json'), 'utf8'));
    await fsp.writeFile(path.join(root, 'site', 'puzzles', `${sample.id}.json`), JSON.stringify(sample));
    await fsp.writeFile(path.join(root, 'site', 'puzzles', 'index.json'), JSON.stringify(buildIndex([sample])));
  });

  after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const cli = (...args) => run([...args, '--root', root, '--today', TODAY]);

  test('status: dates, difficulty, what to make (tomorrow first), freshness from the main series', async () => {
    const r = await cli('status', '--json');
    assert.equal(r.code, 0, r.stderr);
    const s = r.json;
    assert.equal(s.today, TODAY);
    assert.equal(s.tomorrow, DATE);
    assert.equal(s.timeZone, 'America/Chicago');
    assert.deepEqual(s.todo.slice(0, 3).map((t) => t.id), [`claude-${DATE}`, `claude-${DATE}-midi`, MINI]); // build order
    assert.equal(s.todo.length, 6);
    assert.deepEqual(['mini', 'midi', 'daily'].map((k) => s.dates[0].kinds[k].level), [3, 4, 4]); // Sunday
    assert.deepEqual(['mini', 'midi', 'daily'].map((k) => s.dates[1].kinds[k].level), [1, 1, 1]); // Monday
    assert.ok(s.freshness.answers > 0, 'the sample puzzle (2026-10-02) is within ±30 days');
    assert.deepEqual(s.history, []);
    const human = await cli('status');
    assert.match(human.stdout, /To make \(6\)/);
  });

  test('build: a too-long theme answer is refused with a clear message', async () => {
    await fsp.writeFile(clueFile('long-plan.json'), JSON.stringify({ title: 'T', theme: 'Fall', answers: ['PUMPKIN'] }));
    const r = await cli('build', '--date', DATE, '--kind', 'mini', '--plan', clueFile('long-plan.json'), '--json');
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.match(r.json.details.join(' '), /at most 5 letters/);
  });

  let built;
  test('build a Mini: theme answer placed, draft + worksheet written, nothing published', async () => {
    const plan = { title: 'Orchard Run', theme: 'Apple picking', answers: [{ answer: 'Cider', clue: 'Fall drink pressed from apples' }] };
    await fsp.writeFile(clueFile('plan.json'), JSON.stringify(plan));
    const r = await cli('build', '--date', DATE, '--kind', 'mini', '--plan', clueFile('plan.json'), '--seed', '7', '--time', '3', '--json');
    assert.equal(r.code, 0, r.stderr + r.stdout);
    built = r.json;
    assert.equal(built.id, MINI);
    assert.equal(built.level, 1);
    assert.deepEqual(built.placed.map((p) => p.answer), ['CIDER']);
    assert.equal(built.grid.length, 5);
    assert.ok(built.minScore >= 30);
    const words = built.entries.map((e) => e.answer);
    assert.equal(new Set(words).size, words.length, 'no repeated answers');
    for (const e of built.entries) if (!e.isTheme) assert.ok(e.score >= built.minScore, `${e.answer} scores ${e.score}`);

    const draft = JSON.parse(await fsp.readFile(path.join(root, '.claude-way', `${MINI}.draft.json`), 'utf8'));
    assert.equal(draft.series, 'claude');
    assert.equal(draft.kind, 'mini');
    assert.equal(draft.author, 'Claude');
    assert.equal(draft.themeTopic, 'Apple picking');
    assert.equal(draft.clues.CIDER, 'Fall drink pressed from apples');
    const ws = JSON.parse(await fsp.readFile(path.join(root, '.claude-way', `${MINI}.clues.json`), 'utf8'));
    assert.equal(ws.entries.length, built.entries.length);
    const cider = ws.entries.find((e) => e.answer === 'CIDER');
    assert.equal(cider.isTheme, true);
    assert.equal(cider.clue, 'Fall drink pressed from apples');
    assert.equal(cider.crossings.length, 5);
    assert.ok(ws.entries.every((e) => Array.isArray(e.suggestions) && e.suggestions.length <= 3));
    await assert.rejects(fsp.access(path.join(root, 'site', 'puzzles', 'claude')));
  });

  test('build --avoid keeps a fill word out of the rebuilt grid', async () => {
    const word = built.entries.find((e) => !e.isTheme).answer;
    const r = await cli('build', '--date', DATE, '--kind', 'mini', '--plan', clueFile('plan.json'), '--seed', '7', '--time', '3', '--avoid', word, '--json');
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.ok(!r.json.entries.some((e) => e.answer === word), `${word} should be avoided`);
    assert.deepEqual(r.json.avoid, [word]);
    built = r.json;
  });

  test('refill keeps the grid and theme answer and replaces the avoided word; restore lists builds and brings one back', async () => {
    const before = built;
    const target = before.entries.find((e) => !e.isTheme).answer;
    const r = await cli('refill', '--id', MINI, '--avoid', target, '--json');
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(r.json.build, 3);
    assert.ok(!r.json.entries.some((e) => e.answer === target), `${target} should be replaced`);
    assert.ok(r.json.refill.changed.some((c) => c.includes(` ${target} → `)), r.json.refill.changed.join(', '));
    const blocks = (rows) => rows.map((row) => row.replace(/[A-Z]/g, '.')).join('/');
    assert.equal(blocks(r.json.grid), blocks(before.grid), 'same block pattern');
    assert.deepEqual(r.json.placed, before.placed, 'theme answer kept in place');
    assert.deepEqual(r.json.avoid, [...before.avoid, target], 'earlier --avoid words stay avoided');
    const unknown = await cli('refill', '--id', `claude-${DATE}-midi`, '--avoid', 'ERA', '--json');
    assert.equal(unknown.code, 1);
    assert.match(unknown.json.error, /No draft/);

    const list = await cli('restore', '--id', MINI, '--json');
    assert.equal(list.code, 0, list.stderr);
    assert.deepEqual(list.json.builds.map((b) => b.build), [1, 2, 3]);
    assert.equal(list.json.builds[2].summary.refillOf, 2);
    assert.equal(list.json.restored, null);
    const back = await cli('restore', '--id', MINI, '--build', '2', '--json');
    assert.equal(back.code, 0, back.stderr);
    assert.deepEqual(back.json.grid, before.grid);
    const draft = JSON.parse(await fsp.readFile(path.join(root, '.claude-way', `${MINI}.draft.json`), 'utf8'));
    assert.equal(draft.build.number, 2);
    const ws = JSON.parse(await fsp.readFile(path.join(root, '.claude-way', `${MINI}.clues.json`), 'utf8'));
    assert.deepEqual(ws.grid, before.grid);
    const missing = await cli('restore', '--id', MINI, '--build', '9', '--json');
    assert.equal(missing.code, 1);
    assert.match(missing.json.details.join(' '), /Saved builds: 1, 2, 3/);
  });

  /** Unique, non-leaking clues for every entry ("No. 3"), except the theme clue from the plan. */
  const goodClues = () => Object.fromEntries(built.entries.filter((e) => !e.isTheme).map((e, i) => [e.id, `No. ${i + 1}`]));

  test('publish refuses bad clues, lists every problem and writes nothing', async () => {
    const fill = built.entries.filter((e) => !e.isTheme);
    const clues = goodClues();
    delete clues[fill[0].id]; // missing
    clues[fill[1].id] = `All about ${fill[1].answer.toLowerCase()}`; // contains its answer
    clues[fill[2].id] = clues[fill[3].id]; // duplicate
    clues[fill[4].id] = 'A zonk of a clue'; // banned word
    await fsp.writeFile(clueFile('bad.json'), JSON.stringify(clues));
    const r = await cli('publish', '--id', MINI, '--clues', clueFile('bad.json'), '--json');
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    const text = r.json.details.join('\n');
    assert.match(text, new RegExp(`${fill[0].id} ${fill[0].answer}: missing clue`));
    assert.match(text, new RegExp(`${fill[1].id} ${fill[1].answer}: clue contains its answer`));
    assert.match(text, new RegExp(`same clue as`));
    assert.match(text, /banned word \(zonk\)/);
    await assert.rejects(fsp.access(path.join(root, 'site', 'puzzles', 'claude')));

    // Unknown keys (e.g. clues written for an older grid) are refused too, as is a missing title.
    await fsp.writeFile(clueFile('stale.json'), JSON.stringify({ ...goodClues(), NOTANANSWER: 'x' }));
    const stale = await cli('publish', '--id', MINI, '--clues', clueFile('stale.json'), '--title', ' ', '--json');
    assert.equal(stale.code, 1);
    assert.match(stale.json.details.join('\n'), /"NOTANANSWER" is not an entry of this grid/);
    assert.match(stale.json.details.join('\n'), /needs a title/);
  });

  test('publish --dry-run validates without writing; publish writes the puzzle and the Claude index', async () => {
    await fsp.writeFile(clueFile('good.json'), JSON.stringify(goodClues()));
    const dry = await cli('publish', '--id', MINI, '--clues', clueFile('good.json'), '--dry-run', '--json');
    assert.equal(dry.code, 0, dry.stderr + dry.stdout);
    assert.equal(dry.json.dryRun, true);
    await assert.rejects(fsp.access(path.join(root, 'site', 'puzzles', 'claude')));

    const r = await cli('publish', '--id', MINI, '--clues', clueFile('good.json'), '--note', 'Fresh from the orchard.', '--json');
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(r.json.number, 1);
    const p = JSON.parse(await fsp.readFile(path.join(root, 'site', 'puzzles', 'claude', `${MINI}.json`), 'utf8'));
    assert.equal(p.id, MINI);
    assert.equal(p.series, 'claude');
    assert.equal(p.kind, 'mini');
    assert.equal(p.author, 'Claude');
    assert.equal(p.title, 'Orchard Run');
    assert.equal(p.theme, 'Apple picking');
    assert.equal(p.note, 'Fresh from the orchard.');
    assert.deepEqual(validatePuzzle(p), { ok: true, errors: [] });
    const solved = loadPuzzle(p);
    assert.deepEqual(solved.solution.join(''), built.grid.join(''));
    const index = JSON.parse(await fsp.readFile(path.join(root, 'site', 'puzzles', 'claude', 'index.json'), 'utf8'));
    assert.deepEqual(index.puzzles.map((e) => [e.id, e.kind, e.series, e.number, e.theme]), [[MINI, 'mini', 'claude', 1, 'Apple picking']]);
    // The user's series is untouched.
    const main = JSON.parse(await fsp.readFile(path.join(root, 'site', 'puzzles', 'index.json'), 'utf8'));
    assert.deepEqual(main.puzzles.map((e) => e.id), ['2026-10-02']);
    // status now records the theme.
    const s = await cli('status', '--json');
    assert.deepEqual(s.json.history, [{ date: DATE, themes: ['Apple picking'], titles: { mini: 'Orchard Run' } }]);
    assert.equal(s.json.dates[1].kinds.mini.published, true);
  });

  test('check: exit 1 while the set is incomplete; a single kind can be checked', async () => {
    const r = await cli('check', '--date', DATE, '--json');
    assert.equal(r.code, 1);
    assert.equal(r.json.dates[0].kinds.mini.ok, true);
    assert.match(r.json.dates[0].kinds.midi.problems.join(' '), /missing/);
    assert.equal(r.json.index.ok, true);
    const mini = await cli('check', '--date', DATE, '--kind', 'mini');
    assert.equal(mini.code, 0, mini.stdout);
    assert.match(mini.stdout, /All good/);
  });

  test('a released puzzle is not replaced without --force', async () => {
    const r = await run(['publish', '--id', MINI, '--clues', clueFile('good.json'), '--root', root, '--today', DATE, '--json']);
    assert.equal(r.code, 1);
    assert.match(r.json.details.join(' '), /already published and released/);
    const again = await cli('publish', '--id', MINI, '--clues', clueFile('good.json'), '--json');
    assert.equal(again.code, 0, again.stdout);
    assert.equal(again.json.replaced, true);
  });

  /**
   * A complete, valid draft for a kind without running the engine: a fixed symmetric block pattern with
   * deterministic letters (from a small alphabet that spells no banned root), so a Midi and a Daily publish in ms.
   */
  async function writeSyntheticDraft(date, kind, rows) {
    const size = rows.length;
    const id = kind === 'daily' ? `claude-${date}` : `claude-${date}-${kind}`;
    const alphabet = 'ABDEGKLMOPRTVY';
    const layout = rows.join('').split('');
    const { all } = computeEntries({ width: size, height: size, cells: layout.map((ch) => (ch === '#' ? '#' : '')) });
    let cells;
    for (let salt = 0; salt < 100; salt++) { // the first salt whose grid repeats no word
      cells = layout.map((ch, i) => (ch === '#' ? '#' : alphabet[hash32(`${kind}:${salt}:${i}`) % alphabet.length]));
      const words = all.map((e) => e.cells.map((i) => cells[i]).join(''));
      if (new Set(words).size === words.length) break;
    }
    const draft = { ...makeDraft({ id, width: size, height: size, title: `Synthetic ${kind}`, author: 'Claude', date, kind, series: 'claude' }), cells, themeTopic: 'Test topic' };
    await fsp.mkdir(path.join(root, '.claude-way'), { recursive: true });
    await fsp.writeFile(path.join(root, '.claude-way', `${id}.draft.json`), JSON.stringify(draft));
    const clues = Object.fromEntries(all.map((e, i) => [e.id, `No. ${i + 1}`]));
    await fsp.writeFile(clueFile(`${id}.clues.json`), JSON.stringify(clues));
    return id;
  }

  test('check passes for a full set; unpublish rolls a puzzle back', async () => {
    const midi = await writeSyntheticDraft(DATE, 'midi', [
      '....#....', '....#....', '.........', '...#.....', '###...###', '.....#...', '.........', '....#....', '....#....',
    ]);
    const daily = await writeSyntheticDraft(DATE, 'daily', [
      '....#.....#....', '....#.....#....', '...............', '...#....#......', '###....#....###',
      '......#....#...', '.....#.....#...', '....#.....#....', '...#.....#.....', '...#....#......',
      '###....#....###', '......#....#...', '...............', '....#.....#....', '....#.....#....',
    ]);
    for (const id of [midi, daily]) {
      const r = await cli('publish', '--id', id, '--clues', clueFile(`${id}.clues.json`), '--json');
      assert.equal(r.code, 0, r.stdout + r.stderr);
    }
    const ok = await cli('check', '--date', DATE, '--json');
    assert.equal(ok.code, 0, JSON.stringify(ok.json, null, 2));
    assert.equal(ok.json.ok, true);
    const index = JSON.parse(await fsp.readFile(path.join(root, 'site', 'puzzles', 'claude', 'index.json'), 'utf8'));
    assert.deepEqual(index.puzzles.map((e) => e.id), [MINI, midi, daily]);

    // A hand-edited index is caught.
    const indexFile = path.join(root, 'site', 'puzzles', 'claude', 'index.json');
    await fsp.writeFile(indexFile, JSON.stringify({ ...index, puzzles: index.puzzles.slice(1) }));
    const stale = await cli('check', '--date', DATE, '--json');
    assert.equal(stale.code, 1);
    assert.match(stale.json.index.problems.join(' '), new RegExp(`does not list ${MINI}`));
    await fsp.writeFile(indexFile, JSON.stringify(index));

    const un = await cli('unpublish', '--id', daily, '--json');
    assert.equal(un.code, 0, un.stdout);
    await assert.rejects(fsp.access(path.join(root, 'site', 'puzzles', 'claude', `${daily}.json`)));
    const after = await cli('check', '--date', DATE, '--json');
    assert.equal(after.code, 1);
    assert.match(after.json.dates[0].kinds.daily.problems.join(' '), /missing/);
    assert.equal(after.json.index.ok, true);
  });

  test('usage errors exit 2', async () => {
    assert.equal((await cli('build', '--kind', 'mini')).code, 2);
    assert.equal((await cli('publish', '--id', '2026-10-05-mini', '--clues', 'x.json')).code, 2); // not a Claude id
    assert.equal((await cli('frobnicate')).code, 2);
  });
});
