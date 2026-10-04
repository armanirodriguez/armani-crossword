// Claude's way fixtures (SPEC §9) for the player tests: a second series served from puzzles/claude/.
//
// Like support/multi.js they are NOT written into the shared e2e root (the root has no puzzles/claude/ at all, which is
// also how a site looks before the first Claude run: the index 404s and the player shows no Claude section).
// serveClaude(page) intercepts the player's requests for puzzles/claude/* instead. Numbers per kind (buildIndex):
//   2026-10-01  Mini #1 "Night Shift"  · Midi #1 "Purr-fect"  · Daily #1 "Thursday Thoughts" (5×5)
//   2026-10-02  Mini #2 "Spa Day"      · Midi #2 "Rainy Day"  · Daily #2 "Day Off" (5×5)        <- TODAY
//   2026-10-05  Mini #3 "Monday Mini"                                                             (locked until then)

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildIndex, draftToPuzzle, makeDraft } from '../../../site/shared/puzzle.js';
import { REPO } from './root.js';

const sample = JSON.parse(readFileSync(path.join(REPO, 'tests/fixtures/sample-draft.json'), 'utf8'));

const NOTE = 'A fresh theme every day.';

function square(date, kind, title, rows, clues) {
  const draft = makeDraft({ id: `claude-way-${date}-${kind}`, width: 3, height: 3, title, author: 'Claude', date, kind, series: 'claude' });
  draft.cells = rows.join('').split('');
  draft.clues = clues;
  draft.note = NOTE;
  return draft;
}

function daily(date, title) {
  return { ...sample, id: `claude-way-${date}`, date, kind: 'daily', series: 'claude', title, author: 'Claude', note: NOTE };
}

const SPA = { SPA: 'Place for a mud bath', OAR: 'Rowing blade', BYE: 'See you later!', SOB: 'Cry loudly', PAY: 'Wages', ARE: 'Exist' };
const CAT = { CAT: 'Purring pet', ODE: 'Poem of praise', WED: 'Tie the knot', COW: 'Dairy animal', ADE: 'Fruity drink', TED: 'Spread out to dry' };
const DAB = { DAB: 'Small amount', ERA: 'Historical period', WET: 'Like a rainy day', DEW: 'Morning moisture', ARE: 'Exist', BAT: 'Cave flier' };
const OWL = { OWL: 'Night hooter', RYE: 'Bread grain', BED: 'Place to sleep', ORB: 'Sphere', WYE: 'Y-shaped junction', LED: 'Guided' };

/** Claude's drafts by published id. */
export const CLAUDE_FIXTURES = Object.freeze({
  'claude-2026-10-01-mini': square('2026-10-01', 'mini', 'Night Shift', ['OWL', 'RYE', 'BED'], OWL),
  'claude-2026-10-01-midi': square('2026-10-01', 'midi', 'Purr-fect', ['CAT', 'ODE', 'WED'], CAT),
  'claude-2026-10-01': daily('2026-10-01', 'Thursday Thoughts'),
  'claude-2026-10-02-mini': square('2026-10-02', 'mini', 'Spa Day', ['SPA', 'OAR', 'BYE'], SPA),
  'claude-2026-10-02-midi': square('2026-10-02', 'midi', 'Rainy Day', ['DAB', 'ERA', 'WET'], DAB),
  'claude-2026-10-02': daily('2026-10-02', 'Day Off'),
  'claude-2026-10-05-mini': square('2026-10-05', 'mini', 'Monday Mini', ['CAT', 'ODE', 'WED'], CAT),
});

/** Letters a solver types for a Claude fixture, in reading order (blocks skipped). */
export function claudeSolution(id) {
  return CLAUDE_FIXTURES[id].cells.filter((c) => c !== '#').join('');
}

/** Published JSON of a Claude fixture. */
export function claudePuzzle(id) {
  const { puzzle, errors } = draftToPuzzle(CLAUDE_FIXTURES[id]);
  if (!puzzle) throw new Error(`Claude fixture ${id} is not publishable: ${errors.join('; ')}`);
  if (puzzle.id !== id) throw new Error(`Claude fixture ${id} publishes as ${puzzle.id}`);
  return { ...puzzle, publishedAt: '2026-09-30T20:00:00.000Z' };
}

/** The ids of one date's Claude set. */
export const claudeSet = (date) => Object.keys(CLAUDE_FIXTURES).filter((id) => id.startsWith(`claude-${date}`));

/**
 * Serve Claude's index and puzzle files to `page`. `state.hidden` (a Set of ids, may change during the test) leaves
 * puzzles out of the index — a run that has not been deployed yet. `index` replaces the index response
 * (e.g. `{ body: '{oops' }` for a damaged one). Returns the state object.
 */
export async function serveClaude(page, { hidden = [], index = null } = {}) {
  const state = { hidden: new Set(hidden) };
  const all = Object.fromEntries(Object.keys(CLAUDE_FIXTURES).map((id) => [id, claudePuzzle(id)]));
  await page.route('**/site/puzzles/claude/index.json', (route) => (index
    ? route.fulfill({ contentType: 'application/json', ...index })
    : route.fulfill({ json: buildIndex(Object.values(all).filter((p) => !state.hidden.has(p.id))) })));
  await page.route(/\/site\/puzzles\/claude\/claude-[0-9a-z-]+\.json$/, (route) => {
    const id = path.basename(new URL(route.request().url()).pathname, '.json');
    if (all[id]) return route.fulfill({ json: all[id] });
    return route.fulfill({ status: 404, body: 'Not found' });
  });
  return state;
}
