// Puzzle series on the player site (SPEC §9): the user's own puzzles ('main') and "Claude's way" ('claude'), a
// second set of daily Mini / Midi / Daily puzzles made by a scheduled Claude session.
//
//   main     ids "2026-10-05", "2026-10-05-mini", …     files puzzles/<id>.json        index puzzles/index.json
//   claude   ids "claude-2026-10-05", "claude-…-mini", … files puzzles/claude/<id>.json index puzzles/claude/index.json
//
// Ids, labels and file paths come from shared/puzzle.js; this module adds the player's display strings and routes.
// Progress keys stay xw:v1:progress:<id>.

import { SERIES_LABELS, parsePuzzleId, puzzleFilePath, puzzleSeries, seriesIndexPath } from '../shared/puzzle.js';

export const MAIN = 'main';
export const CLAUDE = 'claude';

/** The series label used in share text: "Claude's way". */
export const CLAUDE_LABEL = SERIES_LABELS.claude;
/** The same label for display (typographic apostrophe, like the rest of the UI: "Today’s puzzle"). */
export const CLAUDE_TITLE = CLAUDE_LABEL.replace("'", '’');
/** One line under the section heading on the home page. */
export const CLAUDE_TAGLINE = 'A fresh theme every day, made by Claude';

/** 'claude' for a Claude puzzle / index entry / route, else 'main' (a missing or unknown series is the user's). */
export function seriesOf(p) {
  return puzzleSeries(p) === CLAUDE ? CLAUDE : MAIN;
}

/** Where a series' index lives, relative to the site root. */
export function indexPath(series = MAIN) {
  return `puzzles/${seriesIndexPath(series === CLAUDE ? CLAUDE : MAIN)}`;
}

/** Where a puzzle file lives, by its id, relative to the site root ("puzzles/claude/claude-2026-10-05-mini.json"). */
export function puzzlePath(id) {
  return `puzzles/${puzzleFilePath(id) || `${id}.json`}`;
}

/** The series of a puzzle id ('main' for anything that is not a Claude id). */
export function idSeries(id) {
  return parsePuzzleId(id)?.series === CLAUDE ? CLAUDE : MAIN;
}

/** The archive route of a series. */
export function archiveHref(series = MAIN) {
  return series === CLAUDE ? '#/archive/claude' : '#/archive';
}
