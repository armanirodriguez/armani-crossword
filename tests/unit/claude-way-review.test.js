// Editor's checks of the Claude's way CLI (scripts/claude-way.mjs): review hints printed after build / refill /
// publish. They never block publishing; these tests pin down what they catch and what they leave alone.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { computeEntries } from '../../site/shared/grid.js';
import { isUnpleasant, reviewBuild, reviewClues } from '../../scripts/claude-way.mjs';

/** A build-like result ({ grid: rows, entries }) from rows, with `themeIds` marked as theme answers. */
function buildResult(rows, themeIds) {
  const cells = rows.join('').split('');
  const { all } = computeEntries({ width: rows[0].length, height: rows.length, cells });
  const entries = all.map((e) => ({ id: e.id, answer: e.cells.map((i) => cells[i]).join(''), isTheme: themeIds.includes(e.id), flags: [] }));
  return { grid: rows, entries };
}

describe('isUnpleasant (breakfast test hint)', () => {
  test('flags unpleasant entries the word list lets through', () => {
    for (const w of ['PEDERAST', 'ABORTIVE', 'POISONER', 'HEROIN', 'RAPE', 'KILLER']) assert.equal(isUnpleasant(w), true, w);
  });
  test('leaves look-alike innocent words alone', () => {
    for (const w of ['HEROINE', 'THERAPIST', 'PIMPLE', 'METHOD', 'GRAPE', 'SKILL', 'ESSEX', 'ANALOG']) assert.equal(isUnpleasant(w), false, w);
  });
});

describe('reviewBuild', () => {
  const rows = ['CAMERAS', 'ORATION', 'MARINER', 'PRESETS', 'OSTRICH', 'SENATOR', 'ESTATES'];

  test('a theme answer opposite a fill entry is reported (that slot reads as theme)', () => {
    const hints = reviewBuild(buildResult(rows, ['1A']));
    const last = buildResult(rows, []).entries.filter((e) => e.id.endsWith('A')).at(-1);
    assert.ok(hints.some((h) => h.includes('1A CAMERAS sits opposite') && h.includes(`${last.id} ${last.answer}`)), hints.join('\n'));
    assert.ok(hints.some((h) => h.includes('fill as long as a theme answer')));
  });

  test('symmetric theme answers are fine', () => {
    const last = buildResult(rows, []).entries.filter((e) => e.id.endsWith('A')).at(-1);
    const hints = reviewBuild(buildResult(rows, ['1A', last.id]));
    assert.equal(hints.some((h) => h.includes('sits opposite')), false, hints.join('\n'));
  });

  test('flags breakfast-test fill but not theme answers', () => {
    const r = { grid: ['CAT'], entries: [{ id: '1A', answer: 'PEDERAST', isTheme: false }, { id: '2A', answer: 'POISONIVY', isTheme: true }] };
    const hints = reviewBuild(r);
    assert.equal(hints.length, 1);
    assert.match(hints[0], /1A PEDERAST: breakfast test/);
  });

  test('short theme answers (minis) do not trigger the length check', () => {
    const r = buildResult(['#DRAT', 'AROMA', 'LILAC', 'ELLEN', 'SLY##'].map((x) => x), []);
    const theme = r.entries.find((e) => e.answer === 'DRILL');
    assert.ok(theme);
    theme.isTheme = true;
    assert.deepEqual(reviewBuild(r), []);
    // A 5-letter theme row off the centre has a 5-letter fill row opposite: normal for a Mini, not reported.
    const mini = buildResult(['CAMEO', 'ARENA', 'BASIL', 'IDLED', 'NEEDS'], ['6A']);
    assert.deepEqual(reviewBuild(mini), []);
  });
});

describe('reviewClues', () => {
  test('a clue containing a crossing answer is reported', () => {
    const hints = reviewClues([
      { id: '60A', answer: 'CRITIC', clue: 'Movie reviewer' },
      { id: '61D', answer: 'ICU', clue: 'Hospital unit for critical patients: Abbr.' },
    ]);
    assert.ok(hints.some((h) => h.startsWith('61D ICU') && h.includes('"critical"') && h.includes('60A CRITIC')), hints.join('\n'));
  });

  test('a clue word that is part of a theme answer is reported', () => {
    const clues = [
      { id: '20A', answer: 'APPLEPICKING', clue: 'Orchard outing that fills a bushel basket' },
      { id: '34D', answer: 'NYC', clue: 'The Big Apple, for short' },
      { id: '58A', answer: 'PLANETICKET', clue: 'It might get you a window seat' },
      { id: '30A', answer: 'SEATTLE', clue: 'Space Needle city' },
    ];
    const hints = reviewClues(clues, { themeAnswers: ['APPLEPICKING', 'PLANETICKET'] });
    assert.ok(hints.some((h) => h.startsWith('34D NYC') && h.includes('APPLEPICKING')), hints.join('\n'));
    // SEATTLE is fill: "seat" in another clue is a coincidence, not an echo.
    assert.equal(hints.some((h) => h.includes('SEATTLE')), false, hints.join('\n'));
  });

  test('repeated content words across clues are reported, filler words are not', () => {
    const hints = reviewClues([
      { id: '17A', answer: 'FORMAL', clue: 'Like a black-tie dinner' },
      { id: '16A', answer: 'HAM', clue: 'Easter dinner meat' },
      { id: '1D', answer: 'SPF', clue: 'Sunscreen rating, for short' },
      { id: '2D', answer: 'CEO', clue: 'Corner office big shot, for short' },
    ]);
    assert.ok(hints.some((h) => h.includes('"dinner" appears in 2 clues (17A, 16A)')), hints.join('\n'));
    assert.equal(hints.some((h) => h.includes('"short"')), false, hints.join('\n'));
  });

  test('common short answers used as ordinary clue words are not reported', () => {
    const hints = reviewClues([
      { id: '1A', answer: 'THE', clue: 'Definite article' },
      { id: '2A', answer: 'TOAD', clue: 'Warty hopper in the garden' },
    ]);
    assert.deepEqual(hints, []);
  });
});
