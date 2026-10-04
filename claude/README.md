# Claude's way

A second crossword series on your site, made by Claude: every day it picks a theme and publishes a **Mini (5×5),
Midi (9×9) and Daily (15×15)**. It shows up on the site as its own "Claude's way" section next to your puzzles.
Your own builder flow is unchanged.

## How it works

- A scheduled **cloud Claude session** runs every afternoon and follows [`PLAYBOOK.md`](PLAYBOOK.md): it checks what
  is missing (`node scripts/claude-way.mjs status`), picks a fresh theme (it sees the last 120 days of its themes),
  builds the grids with the same engine as your builder (`build`), writes every clue itself at the weekday's
  difficulty (Mon easiest → Sat hardest; Sun ≈ Thu; the Mini one level gentler), runs the quality gates
  (`publish`), verifies the set (`check`) and pushes **only** `site/puzzles/claude/` to `main`.
- Puzzles are made for **tomorrow** (and today if it is missing), so the hourly deploy picks them up and they unlock
  at midnight America/Chicago like yours.
- Files: `site/puzzles/claude/claude-<date>[-mini|-midi].json` + `site/puzzles/claude/index.json`. Working drafts
  (with plain answers) live in `.claude-way/`, which is git-ignored.
- It never touches your puzzles, config, word list or drafts, and its answers avoid repeating answers from either
  series within ±30 days.

## Setting up the daily run

Create a scheduled cloud routine (in Claude Code: `/schedule`, or claude.ai/code → Routines) with:

- **Repository**: this repo, with permission to push to `main` (enable unrestricted branch pushes for it; otherwise
  Claude pushes to a `claude/way-<date>` branch that you would have to merge).
- **Schedule**: daily in the afternoon, e.g. 3 pm America/Chicago (cron `0 20 * * *` UTC while on daylight time).
- **Model**: Opus. **Prompt**:

  > You are running the daily "Claude's way" crossword routine for this repository. Read `claude/PLAYBOOK.md` and
  > follow it exactly from start to finish: make every puzzle `node scripts/claude-way.mjs status` lists under
  > "To make", publish them, verify with `check`, commit only `site/puzzles/claude/` and push to `main`. End with
  > the short report the playbook asks for.

## Doing it by hand

```
node scripts/claude-way.mjs status
node scripts/claude-way.mjs build --date 2026-10-05 --kind mini --plan plan.json
node scripts/claude-way.mjs refill --id claude-2026-10-05-mini --avoid ODDWORD   # keep the grid, swap a fill word
node scripts/claude-way.mjs restore --id claude-2026-10-05-mini                  # list builds; --build N brings one back
node scripts/claude-way.mjs publish --id claude-2026-10-05-mini --clues my-clues.json --dry-run
node scripts/claude-way.mjs check --date 2026-10-05
```

`node scripts/claude-way.mjs --help` lists every option; the playbook explains the whole flow.

## Pausing or undoing

- Pause: disable the routine. Nothing else depends on it.
- Remove a Claude puzzle: `node scripts/claude-way.mjs unpublish --id claude-2026-10-05-mini` (a puzzle that is
  already released needs `--force`), then commit and push `site/puzzles/claude/`.
- Your "Put it online" button first pulls in Claude's daily pushes, so you can keep publishing as usual.
