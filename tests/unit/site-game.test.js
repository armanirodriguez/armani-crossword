// Unit tests for the player's input/hint/completion logic (site/js/game.js).
//
// Sample 5×5 (tests/fixtures/sample-puzzle.json):
//   # G A S P        1A GASP  5A DELTA  6A ENTER  7A BREAK  8A TERM
//   D E L T A        1D GENRE 2D ALTER  3D STEAM  4D PARK   5D DEBT
//   E N T E R
//   B R E A K
//   T E R M #
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Game } from '../../site/js/game.js';
import { loadPuzzle } from '../../site/shared/puzzle.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/sample-puzzle.json', import.meta.url), 'utf8'));
const SOLUTION = '#GASPDELTAENTERBREAKTERM#';
const newGame = (progress) => new Game(loadPuzzle(fixture), progress);
const at = (r, c) => r * 5 + c;
const typeAll = (g, s) => { for (const ch of s) g.type(ch); };

test('starts on the first empty square of 1-Across', () => {
  const g = newGame();
  assert.equal(g.cell, 1);
  assert.equal(g.dir, 'across');
  assert.equal(g.entry.id, '1A');
  assert.equal(g.crossEntry.id, '1D');
});

test('typing fills and advances; a full word jumps to the next unfinished word', () => {
  const g = newGame();
  typeAll(g, 'GAS');
  assert.equal(g.cell, 4);
  g.type('P');
  assert.equal(g.entry.id, '5A');
  assert.equal(g.cell, 5);
  assert.deepEqual(g.letters.slice(1, 5), ['G', 'A', 'S', 'P']);
});

test('advance skips filled squares and wraps inside the word', () => {
  const g = newGame();
  g.select(3); // S of GASP
  g.type('S');
  assert.equal(g.cell, 4);
  g.type('P');
  assert.equal(g.cell, 1, 'wraps to the first empty square of the same word');
  g.type('G');
  assert.equal(g.cell, 2);
});

test('overwriting inside a complete word steps square by square', () => {
  const g = newGame();
  typeAll(g, 'GASP');
  g.select(1, 'across');
  g.type('X');
  assert.equal(g.cell, 2);
  g.type('Y');
  assert.equal(g.cell, 3);
});

test('clicking the active cell toggles direction; space-like toggle; unchecked direction falls back', () => {
  const g = newGame();
  g.tapCell(1);
  assert.equal(g.dir, 'down');
  g.tapCell(1);
  assert.equal(g.dir, 'across');
  g.tapCell(at(2, 2));
  assert.equal(g.cell, 12);
  assert.equal(g.dir, 'across');
  g.toggleDir();
  assert.equal(g.entry.id, '2D');
});

test('arrows: perpendicular switches direction first, then moves and skips blocks', () => {
  const g = newGame();
  g.select(at(1, 0), 'across');
  g.move(-1, 0); // up: first switch to down
  assert.equal(g.dir, 'down');
  assert.equal(g.cell, at(1, 0));
  g.move(-1, 0); // (0,0) is a block and the edge follows -> stay
  assert.equal(g.cell, at(1, 0));
  g.select(at(4, 3), 'across');
  g.move(0, 1); // (4,4) is a block -> nothing beyond
  assert.equal(g.cell, at(4, 3));
  g.select(at(1, 1), 'across');
  g.move(0, -1);
  assert.equal(g.cell, at(1, 0));
});

test('backspace clears, then moves back; at a word start it goes to the previous word', () => {
  const g = newGame();
  typeAll(g, 'GASP'); // now at 5A
  typeAll(g, 'DE');
  assert.equal(g.cell, 7);
  g.backspace(); // empty -> move back to 6 and clear E
  assert.equal(g.cell, 6);
  assert.equal(g.letters[6], '');
  g.backspace();
  assert.equal(g.cell, 5);
  assert.equal(g.letters[5], '');
  g.backspace(); // start of 5A -> last square of 1A, cleared
  assert.equal(g.entry.id, '1A');
  assert.equal(g.cell, 4);
  assert.equal(g.letters[4], '');
  g.type('P');
  g.select(2);
  g.del();
  assert.equal(g.letters[2], '');
  assert.equal(g.cell, 2);
});

test('Tab order: across then down, wrapping', () => {
  const g = newGame();
  g.selectEntry(g.p.across.at(-1));
  g.stepEntry(1);
  assert.equal(g.entry.id, '1D');
  g.stepEntry(-1);
  assert.equal(g.entry.id, '8A');
  g.selectEntry(g.p.down.at(-1));
  g.stepEntry(1);
  assert.equal(g.entry.id, '1A');
});

test('check marks wrong letters, records everWrong, counts check actions', () => {
  const g = newGame();
  typeAll(g, 'GXSP');
  assert.deepEqual(g.check('square'), { checked: 0, wrong: 0 }, 'active square (5A start) is empty');
  assert.equal(g.checks, 0);
  g.select(2);
  assert.deepEqual(g.check('word'), { checked: 4, wrong: 1 });
  assert.equal(g.marks[2], 'wrong');
  assert.equal(g.checks, 1);
  g.type('A'); // fixing clears the slash but remembers it was wrong
  assert.equal(g.marks[2], '');
  assert.deepEqual([...g.everWrong], [2]);
});

test('reveal fills, marks, locks and counts squares', () => {
  const g = newGame();
  g.select(at(1, 0), 'across');
  assert.deepEqual(g.reveal('word'), { revealed: 5, confirmed: 0 });
  assert.equal(g.reveals, 5);
  assert.deepEqual(g.letters.slice(5, 10), [...'DELTA']);
  assert.ok(g.marks.slice(5, 10).every((m) => m === 'revealed'));
  g.select(5);
  g.type('Z');
  assert.equal(g.letters[5], 'D', 'revealed squares are locked');
  g.select(5);
  g.backspace();
  assert.equal(g.letters[5], 'D');
  g.select(5, 'across');
  assert.deepEqual(g.reveal('word'), { revealed: 0, confirmed: 0 }, 'nothing left to reveal');
  assert.equal(g.checks, 0, 'revealed squares tell the solver nothing new: not a check');
});

test('completion: wrong fill emits filled-wrong; correct fill solves and becomes read-only', () => {
  const g = newGame();
  const events = [];
  g.on((type) => { if (type === 'solved' || type === 'filled-wrong') events.push(type); });
  const answer = SOLUTION.replace(/#/g, '');
  // Fill everything correctly except the last square, then a wrong letter, then fix it.
  g.selectEntry(g.p.across[0]);
  typeAll(g, answer.slice(0, -1));
  g.type('X');
  assert.deepEqual(events, ['filled-wrong']);
  assert.equal(g.solved, false);
  g.select(at(4, 3), 'across');
  g.type('M');
  assert.deepEqual(events, ['filled-wrong', 'solved']);
  assert.equal(g.solved, true);
  g.select(1);
  g.type('Q');
  g.backspace();
  assert.equal(g.letters[1], 'G', 'solved grid is read-only');
});

test('reveal puzzle solves with source reveal-puzzle', () => {
  const g = newGame();
  let source = null;
  g.on((type, d) => { if (type === 'solved') source = d.source; });
  g.reveal('puzzle');
  assert.equal(g.solved, true);
  assert.equal(source, 'reveal-puzzle');
  assert.equal(g.reveals, 23);
});

test('restores progress and resumes at the first unfinished word', () => {
  const letters = [...SOLUTION].map((ch) => (ch === '#' ? '' : ch));
  for (const i of [5, 6, 7, 8, 9]) letters[i] = ''; // 5A empty
  const g = newGame({ letters, marks: new Array(25).fill(''), everWrong: [3], checks: 1, reveals: 0 });
  assert.equal(g.entry.id, '5A');
  assert.equal(g.cell, 5);
  assert.deepEqual(g.toProgress().everWrong, [3]);
  assert.equal(g.toProgress().checks, 1);
});

// -- regression tests (review findings) -------------------------------------------------------------------------

const fullLetters = () => [...SOLUTION].map((ch) => (ch === '#' ? '' : ch));

test('reveal on letters that are already right counts as a check (never a free check)', () => {
  const g = newGame();
  typeAll(g, 'GXS'); // G and S right, X wrong
  g.select(1); // G (typed, right)
  assert.deepEqual(g.reveal('square'), { revealed: 0, confirmed: 1 });
  assert.equal(g.checks, 1);
  assert.equal(g.reveals, 0);
  assert.equal(g.marks[1], '', 'a confirmed square is not marked revealed');
  // A word with a wrong letter: that square is revealed (a reveal, not an extra check).
  g.select(2, 'across');
  assert.deepEqual(g.reveal('word'), { revealed: 2, confirmed: 0 }); // X -> A and the empty P
  assert.equal(g.checks, 1);
  assert.equal(g.reveals, 2);
  // Reveal on a square that was itself revealed tells nothing new.
  g.select(2);
  assert.deepEqual(g.reveal('square'), { revealed: 0, confirmed: 0 });
  assert.equal(g.checks, 1);
});

test('a full, correct grid that is not marked solved completes (re-published answer fix)', () => {
  // The solver typed the intended answer under a typo'd solution; after the re-publish the restored grid is
  // full and correct but not solved.
  const restored = { letters: fullLetters(), marks: new Array(25).fill(''), everWrong: [23], checks: 1, reveals: 0, solved: false };
  let g = newGame(restored);
  const events = [];
  g.on((type, d) => { if (type === 'solved') events.push(d.source); });
  assert.equal(g.isFull() && g.isCorrect(), true);
  assert.equal(g.solved, false);
  assert.equal(g.completeIfSolved('restore'), true);
  assert.equal(g.solved, true);
  assert.deepEqual(events, ['restore']);
  assert.equal(g.completeIfSolved('restore'), false, 'only once');

  // Retyping the same letter on such a grid finishes it too.
  g = newGame(restored);
  events.length = 0;
  g.on((type, d) => { if (type === 'solved') events.push(d.source); });
  g.select(at(4, 3), 'across');
  g.type('M');
  assert.equal(g.solved, true);
  assert.deepEqual(events, ['type']);

  // So do Check and Reveal when they find nothing to change.
  for (const hint of [(x) => x.check('puzzle'), (x) => x.reveal('word')]) {
    const h = newGame(restored);
    let solved = 0;
    h.on((type) => { if (type === 'solved') solved++; });
    hint(h);
    assert.equal(h.solved, true);
    assert.equal(solved, 1);
  }
});

test('a full grid with a wrong letter is not completed by completeIfSolved', () => {
  const letters = fullLetters();
  letters[1] = 'X';
  const g = newGame({ letters });
  assert.equal(g.completeIfSolved('restore'), false);
  assert.equal(g.solved, false);
});

test('restore() adopts another tab’s state without firing solved, and moves off a square filled meanwhile', () => {
  const g = newGame();
  const events = [];
  g.on((type) => events.push(type));
  assert.equal(g.cell, 1);
  const letters = new Array(25).fill('');
  letters[1] = 'G'; letters[2] = 'A';
  const marks = new Array(25).fill('');
  marks[2] = 'revealed';
  g.restore({ letters, marks, everWrong: [3], checks: 2, reveals: 1, solved: false });
  assert.deepEqual(g.letters.slice(1, 4), ['G', 'A', '']);
  assert.equal(g.marks[2], 'revealed');
  assert.deepEqual([...g.everWrong], [3]);
  assert.equal(g.checks, 2);
  assert.equal(g.reveals, 1);
  assert.equal(g.cell, 3, 'the active square was filled elsewhere: continue at the next empty one');
  assert.ok(events.includes('letters'));
  assert.ok(!events.includes('solved'));

  g.restore({ letters: fullLetters(), marks: new Array(25).fill(''), everWrong: [], checks: 0, reveals: 0, solved: true });
  assert.equal(g.solved, true, 'a solve from another tab makes this view read-only');
  g.select(1);
  g.type('Q');
  assert.equal(g.letters[1], 'G');
});
