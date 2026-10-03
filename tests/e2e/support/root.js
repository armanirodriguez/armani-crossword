// Throwaway copies of the repo state for the end-to-end suite.
//
// The e2e tests never touch the real site/puzzles, site/config.json, drafts/ or data/user-* files: the dev server
// (started by playwright.config.js) serves a temporary root prepared here. The code (site/, builder/, engine/) and
// data (word list, clue banks, drafts) are copied from the repo as they are; the published puzzles and the site
// config are then REPLACED by a small fixed set, so the tests do not depend on what the user has published.
//
// Fixture puzzles (index numbers are by date):
//   #1 2026-09-28  "Tiny Three"       3×3, released (an archive puzzle)
//   #2 2026-10-02  "Warm-Up"          5×5, tests/fixtures/sample-draft.json — "today" in the player tests
//   #3 2026-10-05  "From The Future"  3×3, three days after TODAY (locked in the player tests)
//   #4 2099-12-31  "Far Future"       3×3, never released (used by the build test)

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildIndex, draftToPuzzle, makeDraft } from '../../../site/shared/puzzle.js';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The player tests' "today" (the browser clock is faked to noon UTC on this date). */
export const TODAY = '2026-10-02';

/** Default site config (SPEC §2.5); the share-text assertions rely on these values. */
export const SITE_CONFIG = Object.freeze({
  siteName: 'Crossword Club',
  tagline: 'A daily crossword for friends',
  timeZone: null,
  shareUrl: '',
  shareGrid: true,
});

const sampleDraft = JSON.parse(readFileSync(path.join(REPO, 'tests/fixtures/sample-draft.json'), 'utf8'));

/** A tiny all-white 3×3 draft from three across rows and a clue per answer. */
function wordSquare(date, title, rows, clues) {
  const draft = makeDraft({ id: `e2e-${date}`, width: 3, height: 3, title, author: 'E2E Bot', date });
  draft.cells = rows.join('').split('');
  draft.clues = clues;
  draft.note = `Fixture puzzle for ${date}.`;
  return draft;
}

/** The fixture drafts, keyed by date. `solution` is the row-major letter string (blocks as '#'). */
export const FIXTURES = Object.freeze({
  '2026-09-28': wordSquare('2026-09-28', 'Tiny Three', ['SPA', 'OAR', 'BYE'], {
    SPA: 'Place for a mud bath', OAR: 'Rowing blade', BYE: 'See you later!',
    SOB: 'Cry loudly', PAY: 'Wages', ARE: 'Exist',
  }),
  [TODAY]: sampleDraft,
  '2026-10-05': wordSquare('2026-10-05', 'From The Future', ['DAB', 'ERA', 'WET'], {
    DAB: 'Small amount', ERA: 'Historical period', WET: 'Like a rainy day',
    DEW: 'Morning moisture', ARE: 'Exist', BAT: 'Cave flier',
  }),
  '2099-12-31': wordSquare('2099-12-31', 'Far Future', ['OWL', 'RYE', 'BED'], {
    OWL: 'Night hooter', RYE: 'Bread grain', BED: 'Place to sleep',
    ORB: 'Sphere', WYE: 'Y-shaped junction', LED: 'Guided',
  }),
});

/** Letters a solver types for a fixture puzzle, in reading order (blocks skipped). */
export function solutionLetters(date) {
  return FIXTURES[date].cells.filter((c) => c !== '#').join('');
}

/** The published puzzle JSON for a fixture date (what the dev server serves). */
export function fixturePuzzle(date) {
  const { puzzle, errors } = draftToPuzzle(FIXTURES[date]);
  if (!puzzle) throw new Error(`Fixture ${date} is not publishable: ${errors.join('; ')}`);
  return { ...puzzle, publishedAt: '2026-09-01T12:00:00.000Z' };
}

/** Write the fixture puzzles + index into `<siteDir>/puzzles` (replacing whatever is there). */
export function writeFixturePuzzles(siteDir) {
  const dir = path.join(siteDir, 'puzzles');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const puzzles = Object.keys(FIXTURES).map(fixturePuzzle);
  for (const p of puzzles) writeFileSync(path.join(dir, `${p.id}.json`), `${JSON.stringify(p, null, 2)}\n`);
  writeFileSync(path.join(dir, 'index.json'), `${JSON.stringify(buildIndex(puzzles), null, 2)}\n`);
}

/**
 * Create (or recreate) a temp root at `root` with copies of `dirs` from the repo, then install the fixture
 * puzzles and the default site config.
 */
export function prepareRoot(root, { dirs = ['site', 'builder', 'engine', 'data', 'drafts'] } = {}) {
  if (!root || path.resolve(root) === REPO) throw new Error(`Refusing to prepare e2e root at ${root}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const dir of dirs) {
    try {
      cpSync(path.join(REPO, dir), path.join(root, dir), {
        recursive: true,
        // Skip half-written atomic-write temp files the dev server may have left behind.
        filter: (src) => !path.basename(src).endsWith('.tmp'),
      });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      mkdirSync(path.join(root, dir), { recursive: true }); // e.g. no drafts/ yet
    }
  }
  writeFixturePuzzles(path.join(root, 'site'));
  writeFileSync(path.join(root, 'site', 'config.json'), `${JSON.stringify(SITE_CONFIG, null, 2)}\n`);
  return root;
}
