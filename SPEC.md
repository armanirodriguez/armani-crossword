# Armani Crossword — Architecture & Contracts

A toolkit for making a daily themed crossword for a group of friends, plus the static website they play it on.

- **Builder** (`builder/`, run locally with `npm run dev`): enter theme words → auto-generate a symmetric grid that
  holds them → auto-fill the rest with scored filler words → hand-tune the grid → write/fine-tune clues → preview →
  publish to `site/puzzles/`.
- **Player site** (`site/`): a pure static website (no backend, **no login, no names**). Friends open the page, solve the day's
  puzzle, a timer runs only while the page is visible and focused, a success screen shows their time, and a Share
  button produces a Wordle-style text summary.

Everything is vanilla JavaScript ES modules — no frameworks, no bundler, no runtime dependencies, no build step needed
to run. Node ≥ 20 for scripts/tests. `"type": "module"` in package.json.

## 0. Ground rules for all code

- Plain ES modules (`.js` in browser code, `.mjs` for Node scripts). No TypeScript, no npm runtime deps.
  Dev deps available: `wordlist-english` (SCOWL word lists by frequency level), `wordnet-db` (WordNet 3.1 dict files),
  `@playwright/test` 1.63 (Chromium installed).
- `site/` must work when hosted at any sub-path (e.g. GitHub Pages `https://user.github.io/repo/`): only relative URLs.
- Never inject user/puzzle text with `innerHTML`; use `textContent` (clues are untrusted text).
- `site/shared/grid.js` and `site/shared/puzzle.js` are the shared core (already written & tested —
  `tests/unit/shared.test.js`). **Do not change their existing exports' behaviour.** If you need a helper, put it in
  your own module. If you find a genuine bug in them, fix it minimally and add a test.
- Unit tests: `node:test` files at `tests/unit/*.test.js` (run with `npm test`). E2E: Playwright at `tests/e2e/`.
- Keep files reasonably modular (split big UIs into several modules), readable, commented where non-obvious.

## 1. Repository layout & ownership

```
SPEC.md                    this file
package.json               scripts: dev, wordlist, build, test, test:e2e
site/                      THE STATIC WEBSITE (deployable as-is)
  index.html, app.js, styles.css, js/*.js   player app            (owner: player-site)
  shared/grid.js, shared/puzzle.js          shared core            (done)
  config.json                               site settings          (player-site creates; builder edits via API)
  puzzles/index.json, puzzles/YYYY-MM-DD.json   published puzzles (written by the builder's publish API)
engine/                    fill engine, layout generator, worker   (owner: engine)
builder/                   builder toolkit UI                      (owner: builder)
scripts/server.mjs         dev server + builder API                (owner: builder)
scripts/build-site.mjs     copies site/ -> dist/ (optionally only released puzzles) (owner: builder)
scripts/build-wordlist.mjs builds data/ from sources               (owner: data)
data/wordlist.txt          generated scored word list              (owner: data)
data/clues-curated.json    generated: crossword-style clue bank    (owner: data)
data/clues-dictionary.json generated: WordNet-derived clues        (owner: data)
data/curated/*.tsv         hand-curated word scores + clues (input to build-wordlist; written by curation agents)
data/banned.txt            words never allowed in fills            (owner: data)
data/user-words.txt        the user's own additions/bans (edited from the builder; may not exist)
data/user-clues.json       memory of clues the user has published (written by server on publish; may not exist; git-ignored)
drafts/*.json              builder drafts (not deployed; git-ignored because they hold plaintext answers)
tests/unit/                node:test unit tests
tests/e2e/                 Playwright tests
tests/fixtures/            sample-draft.json, sample-puzzle.json
```

## 2. Data formats

### 2.1 Grid (in-memory)
`{ width, height, cells }`, row-major; cell = `'#'` block, `''` empty white, `'A'..'Z'` letter.
See `site/shared/grid.js`: `computeEntries(grid)` returns `{ numbers, across, down, all, acrossAt, downAt }`;
Entry = `{ id: '1A'|'1D', num, dir: 'across'|'down', row, col, length, cells: number[] }`.
Entries are runs of ≥ 2 white cells; standard numbering. `validateGrid`, `symmetricIndex(grid, i, 'rotational'|'mirror'|'none')`, etc.

### 2.2 Draft (builder) — `drafts/<id>.json`
```jsonc
{
  "format": "crossword-draft/1",
  "id": "spooky-a1b2",            // slug: /^[a-z0-9][a-z0-9-]{0,63}$/
  "title": "Spooky Season", "author": "Armani", "note": "optional blurb shown to solvers",
  "date": "2026-10-31",           // release date YYYY-MM-DD ('' until chosen) — becomes the published id
  "width": 9, "height": 9,
  "symmetry": "rotational",       // 'rotational' | 'mirror' | 'none' (block toggling mirrors accordingly)
  "cells": ["#", "P", "", ...],   // grid cells
  "locked": [3, 4, 5],            // cell indices autofill must not change and "clear fill" keeps
  "circles": [], "shaded": [],    // optional cell decorations (theme highlighting)
  "theme": [{ "answer": "PUMPKIN", "clue": "Jack-o'-lantern base", "raw": "pumpkin" }],
  "clues": { "PUMPKIN": "Jack-o'-lantern base", "ERA": "Period of history" },   // keyed by ANSWER (robust to renumbering)
  "clueSources": { "ERA": "auto" },  // optional: 'auto' (accepted suggestion, needs review) | 'user' | 'theme'
  "themeText": "pumpkin | Jack-o'-lantern base\n...",   // raw theme textarea (theme clues follow it until the user edits them)
  "publishedAt": "...", "publishedDate": "2026-10-31", "publishedFingerprint": "...",  // set on publish; edits after it show "Changes not published"
  "createdAt": "...", "updatedAt": "..."
}
```
`makeDraft`, `draftEntries`, `draftToPuzzle` in `site/shared/puzzle.js`.

### 2.3 Published puzzle — `site/puzzles/<date>.json`
Produced only by `draftToPuzzle(draft)` (which validates). Fields: `format: "crossword/1"`, `id` (= date),
`date`, `title`, `author`, `note`, `width`, `height`, `layout` (rows of `#`/`.`), `circles`, `shaded`
(flat indices), `solution` (obfuscated with `encodeSolution(plain, id)`; decode with `decodeSolution`),
`checksum`, `clues: { across: [{num, clue}], down: [{num, clue}] }`, optional `publishedAt`.
Player uses `validatePuzzle(p)` then `loadPuzzle(p)` (entries with `.clue`, `solution[]`, `isBlock[]`, …).

### 2.4 Index — `site/puzzles/index.json`
`buildIndex(puzzles)` → `{ "format": "crossword-index/1", "puzzles": [{ id, date, title, author, width, height, number }] }`
sorted by date; `number` = 1-based position in date order (the "#12" in share text).

### 2.5 Site config — `site/config.json`
```jsonc
{
  "siteName": "Armani Crossword",
  "tagline": "",
  "timeZone": "America/Chicago", // IANA zone that decides when the daily puzzle flips for everyone (null = each solver's local date)
  "shareUrl": "",            // URL appended to share text ('' = the page's own URL without hash/query)
  "shareGrid": true          // include the emoji grid in share text
}
```

### 2.6 Word list — `data/wordlist.txt`
UTF-8 lines `WORD;SCORE` — WORD is `A-Z` only (3–21 letters; multi-word phrases are joined, e.g. `ICECREAM`),
SCORE an integer 1–100 (higher = better fill; banned words are omitted entirely). Lines starting with `#` are
comments. ~144k entries; ~27k carry curated scores (see data/README.md).
Score bands (guidance used by curation and fill defaults):
`70–100` lively/great · `50–69` solid everyday · `35–49` acceptable/crosswordese/inflections · `1–34` ugly/obscure
(only if needed) · `0` never use. Fill default `minScore` = 30.

### 2.7 User words — `data/user-words.txt` (optional, user-editable via builder)
`WORD;SCORE` adds or overrides a word; `-WORD` bans it; `#` comments. Applied at runtime on top of wordlist.txt.

### 2.8 Clue banks
- `data/clues-curated.json`: `{ "WORD": ["clue", "clue", ...] }` crossword-style clues from `data/curated/*.tsv`.
- `data/clues-dictionary.json`: `{ "WORD": ["clue", ...] }` derived from WordNet (synonyms, shortened glosses).
- `data/user-clues.json`: `{ "WORD": ["clue", ...] }` clues the user published before (most recent first).
Builder suggestion priority: user → curated → dictionary. Clues never contain their answer.

### 2.9 Curated TSV — `data/curated/*.tsv`
`WORD<TAB>SCORE<TAB>clue 1[<TAB>clue 2[<TAB>clue 3]]`; `#` comment lines; score 0 = ban. When several files
mention a word: any 0 bans it, else the max score wins and clues are concatenated (deduped).

## 3. Engine (`engine/`) — runs in a Web Worker in the builder and in Node for tests

### 3.1 `engine/wordlist.js`
```js
export class WordList {
  static fromText(text)                 // parse wordlist.txt format
  load(text)                            // add more lines
  applyUserWords(text)                  // user-words.txt format (adds/overrides/bans)
  add(word, score = 50)                 // normalises to A–Z; overrides existing score
  ban(word) / unban(word)
  has(word) -> boolean                  // false if banned or absent
  score(word) -> number | undefined
  get size()
  match(pattern, { minScore = 0, limit = Infinity, exclude = null /* Set */ }) -> [{ word, score }]
      // pattern: letters + '.' wildcards, e.g. 'C.T'; sorted by score desc, then alphabetically
  count(pattern, { minScore = 0 }) -> number
  // also: isBanned(w), lengths(), lexicon(L). Score 0 = never use (has() false). add() un-bans. Lengths 2–25.
  // Patterns accept '.', '?', '_' and space as wildcards, case-insensitive.
}
```
Must be fast: per-length position×letter bitset (or equivalent) index; `count`/`match` for a 15-letter pattern in
well under 1 ms on 100k words.

### 3.2 `engine/fill.js`
```js
export async function fillGrid(grid, wordlist, options) -> FillResult
// options: { minScore = 30, timeLimitMs = 8000, seed, randomness = 0.25 /* 0..1 */, avoid = [] /* words not to use */,
//            prefer = [] /* words to use if they fit: treated as top score; added to the list if missing */,
//            allowDuplicates = false, onProgress(stats) /* ≤ every ~200 ms */, signal /* {aborted:boolean} */,
//            penalize /* {WORD: points} | Map | [[w,p]]: lowers value-ordering score only (minScore eligibility unchanged;
//                        prefer words never penalized; capped at MAX_PENALTY = 1000) — used for answer freshness */,
//            verifyComplete, allowComplete /* when set, already-complete entries must also be listed words ≥ minScore,
//                        prefer words or in allowComplete, and not duplicates (used by layout proofs) */ }
// FillResult: { ok, cells /* filled cells or null */, reason /* 'timeout'|'impossible'|'aborted'|'invalid' */,
//               stats: { ms, nodes, backtracks, restarts, avgScore, minWordScore },
//               problem /* when !ok: { entryId, pattern, message } — the entry that blocked the fill */ }
```
Requirements: never change non-empty cells; only fill `''` cells; EVERY entry of the result (including entries
completed implicitly by crossings) must be a word in the list (except entries that were already complete in the
input — user-forced words are allowed as-is); no duplicate words unless allowed; deterministic per seed; yields to
the event loop regularly (so cancel messages are processed). Use a proper CSP: most-constrained-entry first,
forward checking / arc consistency on crossing letters, score-weighted value ordering with seeded randomness,
restarts or backjumping. Targets with the default list: 5×5 mini < 300 ms; typical 9×9 < 3 s; typical 15×15
(~36–40 blocks, minScore 30) usually < 15 s. Never throws on malformed input (returns reason 'invalid').
Entries that can still take a prefer word are chosen first, so penalties on crossings cannot squeeze a theme word out.
Extra exports: `checkFillable`, `FILL_TUNING`, `penaltiesOption`, `MAX_PENALTY`.

### 3.3 `engine/layout.js` — theme-driven grid generation
```js
export async function generateLayouts({ width, height, symmetry = 'rotational', theme /* [{answer}] in priority order */,
  wordlist, count = 6, timeLimitMs = 20000, density = 'medium' /* 'low'|'medium'|'high' */, seed, minScore = 30,
  fillPreview = true, penalize, onProgress, signal }) -> { layouts, attempts, ms }
// layout: { cells /* blocks + theme letters, rest '' */, filled /* fully filled cells or null */,
//           placements: [{ answer, row, col, dir }], unplaced: [answer], locked: number[] /* theme cells */,
//           stats: { blocks, words, avgLength, fillAvgScore }, score }
```
Each layout: block pattern symmetric under `symmetry`; every entry ≥ 3 letters; every white cell checked (in both an
across and a down entry); white cells connected; each theme answer occupies an entire entry; as many theme answers
placed as possible (in priority order); with `fillPreview` the layout is proven fillable (`filled`) using
`prefer = unplaced theme answers`. Distinct layouts, best first. Minis (≤ 7×7) use few or no blocks.
Behaviour as built: uses the whole `timeLimitMs` while some theme answer that fits the grid is still unplaced (ends
early when it stops finding new shapes); may return layouts denser than requested when that fits more theme words;
may return fewer than `count` (drops layouts holding < half the best layout's theme words); ranks by `themeScore`
(length and list order of placed answers, so "most important first" matters); never returns a proof-failed layout
(unproven `filled: null` layouts only when nothing could be proven in time). Blank (theme-less) patterns come from
`randomPattern({ …, wordlist, minScore })`, which only returns patterns that pass a fill-freedom estimate
(`engine/fillability.js`), mapping an unfillable density to the nearest fillable one.
`engine/theme-fit.js` `fitWords({ grid, filled?, words, wordlist, minScore, timeLimitMs, penalize, signal })` places
leftover theme words into an existing grid without creating non-word crossings ("Fit them in for me").

### 3.4 `engine/candidates.js`
```js
export function rankCandidates(grid, entryId, wordlist, { minScore = 0, limit = 200, filter = '', penalize }) ->
  [{ word, score, viability, penalized? }]   // viability = min over crossing entries of #matches after placing word (0 = dead end; null = no crossings)
```
`filter` is a substring match (leading `^` = prefix); words already in the grid are excluded; dead ends sort last;
malformed input returns `[]`.

### 3.5 `engine/worker.js` + `engine/client.js`
Worker messages (`postMessage` objects):
```
→ { type:'init', wordlistText, userWordsText }          ← { type:'ready', size }
→ { type:'fill', id, grid, options }                    ← { type:'progress', id, stats }* then { type:'result', id, result }
→ { type:'layouts', id, params }                        ← { type:'progress', id, ... }* then { type:'result', id, result }
→ { type:'candidates', id, grid, entryId, options }     ← { type:'result', id, result }
→ { type:'cancel', id }                                 (running job resolves with reason 'aborted')
→ { type:'fitWords', id, grid, options }                ← { type:'result', id, result }
→ { type:'words', add: [[word, score]], ban: [word], unban: [word] }   ← { type:'ok', size }
← { type:'error', id, message }
```
`engine/client.js` exports `class EngineClient` wrapping the worker with promises:
`new EngineClient(workerUrl?)`, `await init(wordlistText, userWordsText)`, `fill(grid, options, onProgress) → { promise, cancel }`,
`layouts(params, onProgress) → { promise, cancel }`, `fitWords(grid, options) → { id, promise, cancel }`,
`candidates(grid, entryId, options) → Promise`, `updateWords({add, ban, unban})`, `terminate()`.
Worker is a module worker: `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`.

## 4. Dev server & builder API (`scripts/server.mjs`, zero dependencies)
`npm run dev` → listens on `PORT` (default 5173) on **127.0.0.1 only**; `--lan` (or `HOST=0.0.0.0`) also listens
on the network, where other devices get only the read-only player site (`/site/`, future puzzles hidden) and
everything else is 403. API writes must be same-origin JSON (`Content-Type: application/json`, else 415; foreign
`Origin`/`Sec-Fetch-Site: cross-site` → 403); the Host header must be a local name/IP (extra: `XW_ALLOWED_HOSTS`).
Options: `--port`, `--root <dir>` / `XW_ROOT` (serve and write state under another root — used by tests), `--host`, `--quiet`.
Serves the repo root statically (correct MIME types incl. `.mjs`, `.json`, `.svg`, `.webmanifest`; `Cache-Control: no-store`),
`/` redirects to `/builder/`. Path traversal must be impossible; only serve `builder/ engine/ site/ data/` (+ `/node_modules` not needed).
JSON API (all bodies JSON; errors `{ error }` with 4xx/5xx):
```
GET    /api/drafts                 -> [{ id, title, date, width, height, updatedAt }]
GET    /api/drafts/:id             -> draft
PUT    /api/drafts/:id             -> save draft (validates id + basic shape) -> { ok, updatedAt }
                                      If-Match: "<updatedAt>" → 409 { conflict: 'changed'|'deleted', updatedAt } when stale;
                                      If-None-Match: * = create only. GET sends an ETag.
DELETE /api/drafts/:id
POST   /api/publish   body {draft, overwrite?:bool}
                                   -> draftToPuzzle; 422 { errors, warnings } if invalid; 409 if date taken and !overwrite;
                                      writes site/puzzles/<date>.json (+publishedAt), rebuilds index.json,
                                      merges its clues into data/user-clues.json -> { ok, puzzle, warnings, number, replaced,
                                      serverWarnings?, url: '/site/#/puzzle/<date>' }; 409 includes existing:{id,date,title,author,publishedAt}
GET    /api/published              -> site/puzzles/index.json content
DELETE /api/published/:date        -> remove file, rebuild index
GET    /api/config  / PUT /api/config      (site/config.json)
GET    /api/user-words / PUT /api/user-words   (text/plain body of data/user-words.txt)
PATCH  /api/user-words  {add:[[w,s]], ban, unban, remove} -> { ok, text }
GET    /api/user-clues                       (data/user-clues.json or {}; a damaged file is set aside with a warning)
GET    /api/recent-answers?date=YYYY-MM-DD&days=N -> { date, days, answers: { WORD: [dates] } }  (published puzzles
                                      within ±N days of date, excluding date itself; used for answer freshness)
GET    /api/go-live                -> { git, branch, remote, upstream: bool, pending: [{ path, change: 'added'|'modified'|'deleted' }],
                                      ahead, siteUrl /* config.shareUrl or null */, pagesUrl /* github.io guess from origin */,
                                      busy, ready, problem: { code, error, hint } | null }   (local git only, no network)
POST   /api/go-live  body {}        -> "Put it online": commit + push the published content -> { ok, upToDate, committed,
                                      pushed, commit: { sha, message, files } | null, branch, remote, siteUrl, pagesUrl };
                                      errors { error, hint, code, detail?, committed?, commit? }; 409 { busy: true } while one runs
```
All file writes are atomic (write temp + rename).

**Put it online** (`/api/go-live`, git run in the root with `child_process.spawn` and an argument array — never a shell):
- Allow-list: `site/puzzles/`, `site/config.json`, `data/user-words.txt` (`GO_LIVE_PATHS`). Only changed allow-listed
  paths are staged (`git add -A -- <paths>`, `*.tmp` excluded) and committed with `git commit -m <msg> -- <paths>`, so
  anything else the user staged stays out of the commit; drafts/ and data/user-clues.json are never staged, even when
  un-ignored. Message from the changes: "Publish puzzle 2026-10-05", "Publish puzzles 2026-10-05, 2026-10-06",
  "Update puzzle …", "Unpublish 2026-10-04", "Update site settings", "Update word list", joined with "; ". The repo's
  own git identity is used. The commit runs under the server's write lock (no half-written publish is committed).
- Then `git push` (or `git push -u origin <branch>` without an upstream); with nothing to commit but `ahead > 0` it only
  pushes; with nothing at all -> `{ ok: true, upToDate: true }`. A failed push keeps the commit (`committed: true`).
- Never prompts: `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, empty `GIT_ASKPASS`/`SSH_ASKPASS`, its own session on
  POSIX (no controlling terminal for ssh), `GIT_CEILING_DIRECTORIES` = the root's parent (a root inside another
  repository is "not a git repository"); timeouts 90 s for push, 15 s otherwise, killing git's whole process group.
- One at a time (second POST -> 409 `{ busy: true }`). Error `code`s (with friendly `error` + `hint`): `not-git`,
  `no-commits`, `detached`, `no-remote`, `no-git`, `unsafe`, `identity`, `locked`, `auth` (hint: `gh auth login`),
  `ssh-host`, `repo-not-found`, `rejected` (GitHub has commits we lack; hint: `git pull --rebase`), `protected`,
  `network`, `timeout`, `commit-failed`, `push-failed`, `git-failed`. Credentials are stripped from every URL / git
  message before they reach a response or the log.

`scripts/build-site.mjs`: copies `site/` → `dist/` (`--out <dir>`); with `--released-only` drops puzzles dated after
the date in `config.timeZone` at (now + `--lead-hours N`) (null zone: the earliest zone, UTC+14) and rewrites
`dist/puzzles/index.json`. Writes a `.xw-build` marker and refuses to replace a non-empty folder without it (unless
`--force`) or any repo folder. Rewrites `<title>`, description/og tags and the web manifest from config.json.
`.github/workflows/deploy.yml` (GitHub Pages) runs hourly, on push to main/master and manually, building with
`--released-only --lead-hours 3`: each puzzle is deployed a few hours before midnight in the site's zone and the
player unlocks it at midnight.

## 5. Builder UX (`builder/`, desktop-first, works at ≥ 1024 px; must not break on tablets)
Single page app at `/builder/`. Sidebar: drafts list (+ New, Duplicate, Delete), links to Schedule, Word list, Site settings.
Draft editor with steps/tabs: **Setup · Theme & Layout · Grid & Fill · Clues · Review & Publish**. Autosave
(debounced ~800 ms) to the server with a visible "Saved" indicator; undo/redo for grid edits (Ctrl+Z / Ctrl+Shift+Z).

- **Setup**: title, author (remembered), release date (warn if already published that date; suggest next free date),
  size presets (5×5 Mini, 7×7, 9×9, 11×11, 13×13, 15×15, custom up to 21×21), symmetry, note.
- **Theme & Layout**: textarea, one theme entry per line, optional clue after `|` (e.g. `Jack o' lantern | Carved
  October decoration`); live parse shows normalized answer + length + warnings (too long for the grid, duplicates).
  "Generate layouts" → `EngineClient.layouts` with progress + cancel → gallery of candidate grids (mini previews with
  theme cells highlighted, X/Y theme words placed, block count, fill quality) → "Use this layout" loads it into the
  draft (theme cells locked, filled letters unlocked, theme clues copied into `draft.clues` with source 'theme').
  Options: density, time budget ("Try harder"), more options (new seed). Also "I'll place them myself" → Grid tab.
- **Grid & Fill**: big editable grid. Modes: Letters (typing; typed letters become locked), Blocks (click toggles a
  block + its symmetric partner), Circles, Shade. Player-like navigation (arrows, Tab, Space toggles direction,
  Backspace, `.` toggles block). Selected entry highlighted. Side panel:
  - Candidates for the selected entry (`EngineClient.candidates`): score, viability bar (dead ends red), text
    filter, min-score; hover previews the word in the grid; click places it (locked); 🚫 bans a word (persisted to
    user-words via API and pushed to the worker).
  - Theme words palette: unplaced theme answers, highlighting slots where each fits.
  - Fill: Autofill (fills empty cells), Refill (clear unlocked letters then fill), Clear unlocked, Lock/unlock entry,
    Lock all/Unlock all, Stop; options (min score, randomness, time limit); progress; on failure show the reason
    and highlight `problem.entryId` with suggestions (lower min score, unlock, add blocks).
  - Stats & warnings: word count, blocks, avg word length, avg score, lowest-scoring words (click to select),
    `validateGrid` issues (short entries, unchecked cells, disconnected, asymmetric), words not in the word list,
    duplicates.
- **Clues**: Across and Down lists. Row = number, answer (theme badge), clue input, suggestions dropdown (user →
  curated → dictionary, labelled by source), length counter, status (missing / contains answer / auto-needs-review).
  Enter moves to next clue; selecting a row highlights the entry in a small grid. "Suggest all missing" fills empty
  clues with the top suggestion (source 'auto').
- **Review & Publish**: checklist from `draftToPuzzle` errors/warnings + auto-clue count; live preview of the real
  player in an iframe (and "open in new tab"); Publish (handles 409 → confirm overwrite) → success with link.
- **Schedule**: published puzzles by date (number, title, size), unpublish, open draft, gaps in the next 14 days.
- **Word list**: search a word (score / banned / user-added), add words with scores, ban/unban, edit raw user-words.
- **Site settings**: edit config.json (site name, tagline, time zone, share URL, share grid).
- **Put it online** (`builder/js/go-live.js`, one shared `app.goLive` controller over `/api/go-live`): a primary
  "Put it online" button in the Review & Publish success box (after Publish) and in the Schedule header (with the
  number of pending changes; unpublishing also offers it in its toast). While running: spinner + "Putting it
  online…"; success: "Online — your site updates in about a minute" (future date: "Online — it unlocks at midnight on
  <date>") with an "Open your site" link (shareUrl, else the github.io guess); failure: the friendly error + hint.
  Sidebar footer status line: "Online ✓" / "N changes to put online" (click runs it) / "Couldn’t put it online" /
  "GitHub not set up" (title + custom dialog point to README "Putting the site online") / "Restart npm run dev" (the
  running dev server predates the endpoint: 404). Refreshed after publish / unpublish / settings saves, on
  navigation and when the window regains focus — never polled. Custom dialogs only.

Answer freshness: Fill options "Avoid repeating recent answers" (default on, ±30 days) fetches
`/api/recent-answers` and passes `penalize` (30 points per recent answer, never theme answers) to fill, layouts and
fitWords; candidates show "used <date>" tags; repeats are listed as warnings in Checks and Review.
Multi-tab safety: saves carry If-Match; on 409 the builder pauses autosave and asks (load theirs / keep mine);
tabs notify each other through a BroadcastChannel.

Preview contract: the builder writes the published-format puzzle (from `draftToPuzzle`, or a lenient conversion when
clues are missing — fill missing clues with "(no clue yet)") to `localStorage['xw:preview']` and loads
`/site/index.html?preview=1`.

## 6. Player site (`site/`) — static, mobile-first, polished

Files: `index.html`, `styles.css`, `app.js` (+ `js/*.js` modules), `config.json`, `favicon.svg`,
`manifest.webmanifest`, icons. Loads `config.json` and `puzzles/index.json` (fetch with `cache: 'no-cache'`).
Hash routes: `#/` today's puzzle, `#/puzzle/YYYY-MM-DD`, `#/archive`. Browser back works.

**No login (decided by the user)**: there is NO login, NO display name, NO player profiles and NO passcode anywhere.
Opening the site goes straight to today's puzzle intro. Progress is per device/browser. localStorage keys (wrap all
access in try/catch; work without storage): `xw:v1:progress:<puzzleId>` = `{ v:1, letters: string[], marks: string[] /* per cell: '' | 'wrong' (currently flagged by a check) | 'revealed' */, everWrong: number[] /* cells ever flagged wrong */, elapsedMs, started, solved, finish: 'solved'|'revealed'|null, solvedAt, checks, reveals, checksum /* detects a re-published puzzle */, updatedAt }`.
Several tabs of the same puzzle merge their progress (a solve is never undone; time adds up; only the focused tab's
timer runs). The app re-checks the date every 30 s and on focus, so an open page rolls over at midnight; a date
with no puzzle shows "No puzzle that day". While today's puzzle is missing from the index (a late deploy), an open
page re-fetches the index at most every 5 minutes and switches to it once it appears.

**Daily selection**: today = `todayISO(config.timeZone)`. Today's puzzle = date == today, else the latest dated
before today (labelled "Latest puzzle"). Puzzles dated after today are hidden from the archive and a direct link
shows "Unlocks on <date>". Preview mode (`?preview=1`) bypasses date locks and never persists progress.

**Intro**: before starting, show title, author, date, puzzle #, size, note, and a Play (or "Resume · 2:13") button;
the grid is hidden until play.

**Timer**: elapsed time accumulates ONLY while: started && !solved && `document.visibilityState === 'visible'` &&
`document.hasFocus()` && not manually paused (preview inside an iframe ignores focus). Use `performance.now()`
deltas; persist elapsed at least every 5 s and on `visibilitychange`/`pagehide`/blur. When inactive, cover the grid and
clues with a "Paused" overlay (so time can't be gained by looking while paused); auto-resume when the page becomes
active again unless the user pressed Pause (then a Resume button). Header shows `m:ss`. Reloading resumes from saved
elapsed time (time while closed never counts).

**Input — desktop**: click cell selects, clicking the selected cell toggles direction; letters fill and advance to the
next empty cell of the entry, and when the entry is full jump to the next incomplete entry; Backspace clears or moves
back; arrows move (perpendicular arrow first switches direction); Tab/Shift+Tab next/prev entry; Space toggles
direction; Delete clears. Clue lists (Across | Down) beside the grid with active/crossing clue highlight and
auto-scroll; clicking a clue selects it.
**Input — mobile/touch** (coarse pointer or narrow): no native keyboard; custom on-screen QWERTY keyboard with ⌫
(responsive, `pointerdown`, no double-tap zoom, `touch-action: manipulation`), clue bar above it showing the active
clue with ‹ › to move between clues (tap the bar toggles direction); grid scales to fit width and available height
(`100dvh`); clue list available in a sheet. Hardware keyboards still work.
**Hints**: Check (square / word / puzzle) marks wrong letters (and records them as checked); Reveal (square / word /
puzzle — puzzle reveal asks for confirmation in a custom dialog) fills correct letters, marks them revealed and locks them.
**Completion**: when every cell is filled: if all correct → solved: stop timer, save, confetti (respect
`prefers-reduced-motion`), modal "Solved!" with time, hint summary, Share button (no names). If filled but wrong →
toast "Almost — something's not quite right" (no time stop). Solved grid stays viewable (read-only).

**Share** (button in modal and header after solving): `navigator.share({ text })` on touch devices when available,
else clipboard (`navigator.clipboard`, then `execCommand('copy')` fallback, then a selectable textarea). Text:
```
🧩 Armani Crossword #12 · Sat, Oct 3
⏱️ 4:32 · ✨ no hints
⬛🟩🟩🟩🟩
🟩🟩🟩🟩🟩
🟩🟩🟨🟩🟩
🟩🟩🟩🟩🟪
🟩🟩🟩🟩⬛
https://friends.example/crossword/
```
Hint line: `✨ no hints`, or e.g. `🔍 2 checked · 💡 1 revealed`. Cells: ⬛ block, 🟩 solved unaided,
🟨 was marked wrong by a check (then fixed), 🟪 revealed. Grid omitted when `config.shareGrid` is false.
URL line = `config.shareUrl` or the page URL without hash/query.

**Archive**: available puzzles newest first with #, title, date, size and this device's status (New / In progress
m:ss / ✓ Solved m:ss).

**Look & feel**: clean, friendly, NYT-like crossword styling; light + dark (prefers-color-scheme); system font
stack; clear selection colours (active cell, active word, crossing word); numbers top-left of cells; circles and
shaded cells rendered; revealed cells show a small corner marker; wrong cells show a red slash. Accessible contrast,
focus styles, `aria-label`s. Works from 320 px phones to desktops; no horizontal page scroll.
PWA niceties: `manifest.webmanifest`, theme-color, apple-touch-icon (no service worker).

## 7. Testing expectations
- `npm test`: shared (exists), engine (fill correctness: no dup, every entry in list incl. crossings, locked cells
  untouched, determinism, timeouts/aborts honored; layout validity), server API (temp dirs), data pipeline sanity.
- `npm run test:e2e`: Playwright — desktop + mobile viewports for the player (play, timer pause on
  hidden/blur, solve, share text), builder smoke (create draft, generate/fill, clue, publish → visible in site).
