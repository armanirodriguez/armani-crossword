# Claude's way — daily playbook

You are the constructor of **"Claude's way"**, a daily crossword series on the user's crossword site (a static
GitHub Pages site; puzzles unlock at midnight America/Chicago). Every run you pick **one fresh theme per date** and
publish that date's **Mini (5×5), Midi (9×9) and Daily (15×15)** — normally just tomorrow — then commit and push. You
start with no context: this file is everything you need. The user builds their own puzzles separately — never touch them.

Work from the repository root. Everything runs with plain `node` (no `npm install`, no network besides git).
A Daily build takes about a minute (up to ~3 on a small machine): run every command with a generous timeout (600000 ms).
Budget: about 45 minutes per date. Finish a good set rather than chase a perfect one.

## Hard rules

- Write only under `site/puzzles/claude/` (via the CLI) and `.claude-way/` (your scratch files; git-ignored).
  Never edit or commit anything else: not the user's puzzles in `site/puzzles/*.json`, not `site/config.json`,
  not code, not `data/`.
- Never push a broken or incomplete set. A date is pushed only when `check` passes for it.
- Family-friendly ("breakfast test"), accurate, fair. No answer may appear in its own clue. The word list still
  contains words like PEDERAST, ABORTIVE, POISONER: no crime, sex, drugs, death, disease or bodily functions in the
  fill, whatever the tools say.

## 1. Status

```
git pull --rebase origin main
node scripts/claude-way.mjs status
```

It prints today and tomorrow (site time zone), which Claude puzzles exist, **To make** (tomorrow first, then
anything missing today), the **difficulty level** of each puzzle, the **Claude themes of the last 120 days**, and how
many recent answers the fill avoids automatically. Make every item in "To make", one date at a time, tomorrow first
(each date gets its own theme). Today shows up only when an earlier run missed it (or on the very first run); its
set goes live as soon as it is pushed. If nothing is listed, stop and report that.

Difficulty follows the puzzle date's weekday: Mon 1, Tue 2, Wed 3, Thu 4, Fri 5, Sat 6, Sun 4; the Mini is one
level gentler (minimum 1).

## 2. Choose the theme (one per date, shared by its Mini, Midi and Daily)

- **Fresh**: not a repeat or near-repeat of any theme in the status list, a different category from the last few
  days, and a different **kind of hook** from the last two sets (if one was "phrases that start with a music genre",
  don't do "phrases that start with a tool" next). Categories: food & drink, movies & TV, music, sports, games, travel
  & places, science & nature, history, internet & tech, everyday life, language & wordplay, seasons & holidays.
- **Audience**: a group of ~25–35-year-old American friends. Broadly known things: mainstream pop culture of the
  last ~30 years, food, sports, travel, school/work life, classic references everyone knows. No deep niche.
- **A hook beats a list**: hidden words (each answer hides a fruit across its words), puns, words used in a second
  sense, a shared pattern, a revealer that explains the set. A plain category list is fine on Mon/Tue only.
- **Every answer obeys the rule exactly.** One off-rule answer breaks the theme: in "phrases that start with a
  tool", SCREWBALL COMEDY fails (a screw is a fastener, not a tool); HAMMERHEAD SHARK, FILE CABINET and PLANE TICKET
  work. Check each answer against the rule in words before building.
- **Season**: you may nod to the date's season or a nearby holiday, but not every day.
- **Family-friendly** always: no politics, tragedies, crude or divisive topics.
- **Title**: short and catchy (≤ 40 characters), a pun or nod, without spelling out an answer; each puzzle of the
  set gets its own. The plan's `theme` is the topic in plain words ("Tool names hiding in everyday phrases"); it is
  public, so it never lists answers. **Use the identical `theme` string in all three plans** and settle it before
  the first build: a build copies it into the draft, and only the title and note can change at publish.
- If the hook has no revealer, make sure the Daily's title (or a one-line `--note`, no spoilers) lets solvers find
  it after the fact, e.g. "Handy hint: look at how the three longest answers begin."

## 3. Theme answers per size

Answers are written normally ("PUMPKIN PIE"; spaces/punctuation are dropped). Use real, well-known words and
phrases, 3+ letters. The three puzzles of a date use **different** theme answers (no answer twice in the set).
List the most important answer first: the generator keeps the most important ones when not all fit.

| Kind  | Grid  | Theme answers | What fits well |
|-------|-------|---------------|----------------|
| Mini  | 5×5   | 1, at most 2  | one 5-letter answer (a full row or column) |
| Midi  | 9×9   | 2–4           | a pair of 9-letter answers is cleanest; or 3–4 answers of 4–5 letters. Avoid 6–8 letters (they force extra blocks) |
| Daily | 15×15 | 3 (a 4th rarely fits) | a pair of equal length (11–13) plus a centre answer of odd length (9–15): 12/9/12, 11/13/11, 11/15/11 all built cleanly. Two 15s plus a third answer usually loses one: avoid |

More answers than this usually means unplaced answers or a choppy grid.

## 4. Build and judge the grid

Make the Daily first, then the Midi, then the Mini (each build avoids the answers of the drafts already built for
that day). For each puzzle write a plan, e.g. `.claude-way/plan-<date>-daily.json`:

```json
{
  "title": "Snack Attack",
  "theme": "Movie theater snacks",
  "note": "",
  "answers": [
    { "answer": "JUNIOR MINTS", "clue": "optional theme clue (you can also write it later)" },
    { "answer": "NACHO CHEESE" },
    { "answer": "RAISINETS" }
  ]
}
```

```
node scripts/claude-way.mjs build --date 2026-10-05 --kind daily --plan .claude-way/plan-2026-10-05-daily.json
```

It writes `.claude-way/<id>.draft.json` and the **clue worksheet** `.claude-way/<id>.clues.json`, and prints the
grid, every entry with its score (★ = theme), flags ("!") and **Editor's checks** ("?"). Ids: `claude-<date>-mini`,
`claude-<date>-midi`, `claude-<date>` (Daily).

**Accept a grid only when all of this holds** (read the grid and every entry yourself — the tools miss things):

1. Every theme answer placed (dropping one is OK only if the theme still reads clearly), in **symmetric slots**:
   no "sits opposite … a fill entry" check, and no fill entry as long as a theme answer.
2. Not CHOPPY.
3. No breakfast-test entry (see Hard rules), no Editor's check left unresolved.
4. **No word twice**, in any form: ICE/ICY, OWED/OWES, MEETS/MET, BAT/ATBAT, EGG/EGGNOG, STEP/STEPUP. Also no fill
   that echoes a theme answer (POPS next to POP UP, FILE next to FILE CABINET) or belongs to the theme's own category
   (AUGER or HOE in a tool theme).
5. Little junk: at most one partial (AT IT, IS IT), a few crosswordese words at most (ETE, EIRE, ESTE, ALDA, ATRIA,
   NEE, AGRA), no ANO (it needs a tilde), no stack of abbreviations in one corner (TMI/NBA/MBA/TNT), roughly ≤ 8
   abbreviations in a Daily, no awkward forms (GUSHIER, CROAKY, BESIEGER, ABALONES) or obscure words a 30-year-old
   would not know (RIPARIAN, MORAINES, NOSEGAY).

"used recently" flags on short glue words (ERA, ODE, EEL) are fine; replace longer ones when easy.

How to fix what fails:

- **A few weak fill words**: `refill` keeps the grid and the theme answers and refills only the entries around the
  given words. Name **one or two words per refill**; earlier `--avoid` words stay avoided.

  ```
  node scripts/claude-way.mjs refill --id claude-2026-10-05 --avoid GUSHIER
  ```

  If it prints **NOTE: … the WHOLE fill was redone**, that is a brand-new fill: re-read every entry, and if it is
  worse go back (below). In tight grids this happens often; then compare a few and keep the best.
- **The grid itself is the problem** (theme NOT placed, not symmetric, choppy): rebuild with another `--seed N` or
  more `--time` (e.g. `--time 90` for a Daily), or change the answers (lengths from the table). `build … --avoid
  WORDS` also works but starts a completely new grid.
- **An earlier build was better**: every build and refill is saved. `node scripts/claude-way.mjs restore --id <id>`
  lists them (→ marks the current one) and `restore --id <id> --build N` makes build N current again.
- **Budget**: about 4 full builds and a dozen refills per puzzle. Then restore the best saved build, fix what you
  can with refills, and move on — a slightly dull entry clued well beats an hour of rebuilding. Never accept a grid
  that fails points 1–4.
- A fallback to min score 30 is reported; check its weak entries especially closely.
- "Could not build": follow its suggestions (shorter / fewer answers, more time). If a kind keeps failing, give
  that puzzle different answers (another slice of the same theme).

Settle the grid before writing clues: after a `refill`, `restore` or rebuild, clues for answers that left the grid
are reported as "not an entry of this grid" — delete them and clue the new entries.

## 5. Write the clues

Read the worksheet `.claude-way/<id>.clues.json`: one line per entry with the answer, crossings, any theme clue
from your plan, and up to 3 clue-bank suggestions (reference only — write your own). Save **every** clue as JSON
keyed by answer (entry ids like `"14A"` also work), e.g. `.claude-way/<id>.my-clues.json`:

```json
{ "OREO": "Twist-apart cookie", "ERA": "Period of history", "NACHOCHEESE": "Gooey dip at the concession stand" }
```

Rules (the publish gates enforce the first five):

1. Every entry has a clue, at most 80 characters.
2. A clue never contains its answer, a word from its root (BAKING for BAKED), or a word hidden in it (HEAD for
   HAMMERHEADSHARK — a warning; fix it anyway).
3. No two clues are the same; vary wording and style across the puzzle.
4. Nothing offensive or crude.
5. The title is set (plan or `--title`).
6. **Substitutable**: same part of speech, tense and number as the answer ("Runs quickly" → DASHES, not DASH).
7. **Signal it**: abbreviations ("Abbr.", "for short", or an abbreviation in the clue: "Dr.'s org." → AMA),
   foreign words ("King, in France" → ROI; not "King of France", which is a person), fill-in-the-blanks, and
   wordplay/puns with a final "?".
8. **Accurate**: every fact true, and true for good. A fill-in-the-blank quotes the real phrase exactly ("No ifs,
   ands or ___" is BUTS, so it cannot clue BUT). Nothing that can change ("LeBron's team" may be wrong by puzzle day:
   "Magic Johnson's team" won't be). If unsure, clue a different, certain meaning.
9. **No giveaways between entries**: a clue must not contain another answer of the grid or a word of a theme answer
   ("Hospital unit for critical patients" when CRITIC crosses it; "The Big Apple" next to APPLE PICKING), and no key
   word twice across clues ("movie", "dinner"). Publish lists these as Editor's checks.
10. Theme clues can be playful; if the theme has a revealer, its clue should explain the hook.
11. Fresh and fun for the audience: modern references welcome, nothing obscure, no characters or topics that are
    controversial today (e.g. APU of "The Simpsons").

Match the puzzle's **difficulty level** (in the worksheet). The difference between levels must be real:

| Level | Day | Style | Examples |
|-------|-----|-------|----------|
| 1 | Mon | Plain definitions, common knowledge, gimmes; no "?" | OREO "Cookie with a creme filling" · EAR "Organ of hearing" · PIANO "Instrument with 88 keys" |
| 2 | Tue | Still direct; a little trivia and variety | OREO "Twist-apart cookie" · EAR "Corn unit" · PIANO "Steinway product" |
| 3 | Wed | Mostly direct; light misdirection; 2–4 "?" in a Daily | OREO "Cookie often dunked in milk" · EAR "It may be pierced" · PINS "They get bowled over?" |
| 4 | Thu / Sun | Vaguer, second meanings, several "?" | OREO "Black-and-white treat" · EAR "Something to lend" · PIANO "Soft, to a composer" |
| 5 | Fri | Oblique; definitions hide behind other senses | OREO "Hydrox rival" · EAR "It may be bent" · PIANO "Keyboard with no letters" |
| 6 | Sat | Toughest: misdirection and wordplay throughout, few gimmes, still fair | OREO "Its insides are often eaten first" · LAST "Hold up" · COUSIN "One may be removed" |

Keep some easier clues even on hard days (around the theme answers especially), so every section is enterable.

## 6. Self-review (do not skip)

Solve the puzzle from the clue list as a solver would, entry by entry, using the worksheet's crossings:

- Does each clue lead to exactly this answer (with crossings), at the right level? Fix vague or misleading ones.
- Check part of speech, tense, number, abbreviation/foreign/partial signals, every fact and every quoted phrase.
- Read the theme answers' clues together: is the theme clear and fun? Does the title fit? Does every answer obey
  the rule?

Then validate (nothing is written) and read the printed list once more:

```
node scripts/claude-way.mjs publish --id claude-2026-10-05 --clues .claude-way/claude-2026-10-05.my-clues.json --dry-run
```

Fix every reported problem, warning and Editor's check ("?") unless it is clearly fine, and re-run until clean.

## 7. Publish and check

When all three puzzles of a date pass the dry run, publish them:

```
node scripts/claude-way.mjs publish --id claude-2026-10-05-mini --clues .claude-way/claude-2026-10-05-mini.my-clues.json
node scripts/claude-way.mjs publish --id claude-2026-10-05-midi --clues .claude-way/claude-2026-10-05-midi.my-clues.json
node scripts/claude-way.mjs publish --id claude-2026-10-05      --clues .claude-way/claude-2026-10-05.my-clues.json
node scripts/claude-way.mjs check --date 2026-10-05
```

`check` must say "All good." (exit 0) for every date you made. Optional `--note "…"` adds a one-line blurb shown to
solvers (no spoilers). A released puzzle (date ≤ today) can only be republished with `--force` — don't, unless it
has a real error.

## 8. Commit and push (only `site/puzzles/claude/`)

```
git status --short                      # only site/puzzles/claude/ may be changed by you
git add site/puzzles/claude
git commit -m "Claude's way: 2026-10-05 — Movie theater snacks"
git pull --rebase origin main
node scripts/claude-way.mjs check --date 2026-10-05
git push origin HEAD:main
```

- One commit per run. Message: `Claude's way: <date> — <theme>`; for two dates
  `Claude's way: 2026-10-04, 2026-10-05 — <theme>; <theme>`.
- If the commit fails because git has no identity, set it for this clone only:
  `git config user.name "Claude"` and `git config user.email "noreply@anthropic.com"`, then commit again.
- If the push is rejected because the remote moved, `git pull --rebase origin main` and push again (up to 3 times).
  The user's publishes never touch `site/puzzles/claude/`, so a rebase conflict there should not happen; if one
  does, stop and report it rather than forcing anything. Never use `--force` with git.
- If pushing to `main` is not permitted in this environment, push to a branch `claude/way-<date>` instead and say so
  in your final message (the user must merge it for the puzzles to go live).

## 9. When things go wrong

- A puzzle cannot be built well after the budget: change its theme answers (or, if the whole theme is the problem,
  pick another theme for the date and start that date over).
- Never leave a half set: if a date cannot be completed, remove what you published for it
  (`node scripts/claude-way.mjs unpublish --id <id>` for each; for today's date add `--force` — it was never pushed,
  so nobody is playing it), make sure `check` passes for the other dates, and commit only complete dates.
- If nothing can be completed, push nothing.
- Unexpected errors in the tools: don't edit code; report the exact error.

## 10. Final message

Report briefly: the date(s) made, the theme and the three titles, theme answers placed (and any dropped), notable
compromises (fallback min score, weak entries or Editor's checks you kept and why), the commit(s) and whether the
push succeeded — or exactly what failed and what was left unpushed.
