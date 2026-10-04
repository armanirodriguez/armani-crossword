// Fixture puzzles of several kinds on the same date (SPEC §8: Mini / Midi / Daily), for the player tests.
//
// They are NOT written into the shared e2e root (the build and builder specs count and number its puzzles):
// serveMultiKind(page) intercepts the player's requests and serves the root's own puzzles plus these, with an
// index rebuilt by buildIndex (numbers per kind). Puzzle numbers with every extra puzzle served:
//   Daily  #1 09-28 · #2 10-02 (TODAY) · #3 10-04 "Sunday Best" · #4 10-05 "From The Future" · #5 2099-12-31
//   Mini   #1 10-04 "Tiny Mini" · #2 10-05 "Monday Mini"
//   Midi   #1 10-03 "Middle Ground" (the only puzzle of Oct 3) · #2 10-04 "Midi Mix"

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildIndex, draftToPuzzle, makeDraft } from '../../../site/shared/puzzle.js';
import { FIXTURES, REPO, fixturePuzzle } from './root.js';

export const MULTI_DATE = '2026-10-04';

function square(date, kind, title, rows, clues) {
  const draft = makeDraft({ id: `e2e-${date}-${kind}`, width: 3, height: 3, title, author: 'E2E Bot', date, kind });
  draft.cells = rows.join('').split('');
  draft.clues = clues;
  draft.note = `A ${kind} for ${date}.`;
  return draft;
}

const sample = JSON.parse(readFileSync(path.join(REPO, 'tests/fixtures/sample-draft.json'), 'utf8'));

/** Extra drafts by published id. */
export const MULTI_FIXTURES = Object.freeze({
  '2026-10-03-midi': square('2026-10-03', 'midi', 'Middle Ground', ['CAT', 'ODE', 'WED'], {
    CAT: 'Purring pet', ODE: 'Poem of praise', WED: 'Tie the knot', COW: 'Dairy animal', ADE: 'Fruity drink', TED: 'Spread out to dry',
  }),
  '2026-10-04-mini': square('2026-10-04', 'mini', 'Tiny Mini', ['SPA', 'OAR', 'BYE'], {
    SPA: 'Place for a mud bath', OAR: 'Rowing blade', BYE: 'See you later!', SOB: 'Cry loudly', PAY: 'Wages', ARE: 'Exist',
  }),
  '2026-10-04-midi': square('2026-10-04', 'midi', 'Midi Mix', ['DAB', 'ERA', 'WET'], {
    DAB: 'Small amount', ERA: 'Historical period', WET: 'Like a rainy day', DEW: 'Morning moisture', ARE: 'Exist', BAT: 'Cave flier',
  }),
  '2026-10-04': { ...sample, id: 'e2e-sunday', date: '2026-10-04', kind: 'daily', title: 'Sunday Best', note: 'The daily for Oct 4.' },
  '2026-10-05-mini': square('2026-10-05', 'mini', 'Monday Mini', ['OWL', 'RYE', 'BED'], {
    OWL: 'Night hooter', RYE: 'Bread grain', BED: 'Place to sleep', ORB: 'Sphere', WYE: 'Y-shaped junction', LED: 'Guided',
  }),
});

/** Letters a solver types for an extra fixture, in reading order (blocks skipped). */
export function multiSolution(id) {
  return MULTI_FIXTURES[id].cells.filter((c) => c !== '#').join('');
}

/** Published JSON of an extra fixture. */
export function multiPuzzle(id) {
  const { puzzle, errors } = draftToPuzzle(MULTI_FIXTURES[id]);
  if (!puzzle) throw new Error(`Fixture ${id} is not publishable: ${errors.join('; ')}`);
  if (puzzle.id !== id) throw new Error(`Fixture ${id} publishes as ${puzzle.id}`);
  return { ...puzzle, publishedAt: '2026-09-01T12:00:00.000Z' };
}

/**
 * Serve the root's fixture puzzles plus the extra ones to `page`.
 * `state.hidden` (a Set of ids, may be changed during the test) leaves puzzles out of the index — a late deploy.
 * Returns the state object.
 */
export async function serveMultiKind(page, { hidden = [] } = {}) {
  const state = { hidden: new Set(hidden) };
  const extra = Object.fromEntries(Object.keys(MULTI_FIXTURES).map((id) => [id, multiPuzzle(id)]));
  const all = [...Object.keys(FIXTURES).map(fixturePuzzle), ...Object.values(extra)];
  await page.route('**/site/puzzles/index.json', (route) => route.fulfill({
    json: buildIndex(all.filter((p) => !state.hidden.has(p.id))),
  }));
  await page.route(/\/site\/puzzles\/\d{4}-\d{2}-\d{2}-(mini|midi)\.json$/, (route) => {
    const id = path.basename(new URL(route.request().url()).pathname, '.json');
    if (extra[id]) return route.fulfill({ json: extra[id] });
    return route.fulfill({ status: 404, body: 'Not found' });
  });
  await page.route(`**/site/puzzles/${MULTI_DATE}.json`, (route) => route.fulfill({ json: extra[MULTI_DATE] }));
  return state;
}
