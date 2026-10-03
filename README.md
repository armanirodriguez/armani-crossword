# Armani Crossword

Make a themed crossword for your friends every day. Type a handful of words that fit your idea, let the toolkit
build a symmetric grid around them and fill the rest with good everyday words, polish the clues, and publish. Your
friends open a link, solve it on their phone or computer, and share a Wordle-style result.

- **Builder** — a local toolkit you run on your computer (`npm run dev`).
- **Site** — a plain static website (`site/`) you host anywhere for free. No login, no accounts, no server.

```
🧩 Armani Crossword #12 · Sat, Oct 3
⏱️ 4:32 · ✨ no hints
⬛🟩🟩🟩🟩
🟩🟩🟩🟩🟩
🟩🟩🟨🟩🟩
🟩🟩🟩🟩🟪
🟩🟩🟩🟩⬛
https://you.github.io/crosswords/
```

---

## Quick start: your first puzzle

You need [Node.js](https://nodejs.org) 20 or newer (tested on 22).

```bash
npm install        # only needed for tests and for rebuilding the word list
npm run dev
```

Open **http://localhost:5173/builder/** (the player site is at http://localhost:5173/site/).

1. **New puzzle** → give it a title and pick a size (5×5 mini up to 15×15; custom sizes up to 21×21 in **Setup**).
   It gets the next free release date; change the date in **Setup**.
2. **Theme & Layout** → type your theme words, one per line, **most important first**. Add a clue after a `|` if you
   like: `Jack o' lantern | Carved October decoration`. Spaces and punctuation are dropped (`TRICKORTREAT`); spell
   numbers out. Click **Generate layouts**, compare the options and click **Use this layout**.
   Expect roughly 1–2 theme answers in a 5×5, 2–3 in a 9×9 and 3–5 in a 15×15 — long answers need room.
3. **Grid & Fill** → the grid arrives already filled. Fine-tune it: click a word to see alternatives (with a
   "will its crossings still work?" bar), lock words you like, **Refill** the rest, and ban words you never want
   (**Ban word** replaces the selected word; in the alternatives list, hover a word and click ⊘). Clicking the
   selected square again switches between Across and Down. Toggle blocks or circles; undo/redo with Ctrl+Z /
   Ctrl+Shift+Z.
4. **Clues** → **Suggest all missing** fills empty clues from the clue bank (your own past clues first, then
   a curated bank of crossword-style clues for ~26,000 words, then dictionary-derived clues). Rewrite anything that isn't fun; auto-suggested clues
   are flagged for review. Words the bank doesn't know (often theme words) stay empty for you to write.
5. **Review & Publish** → check the list, play it in the preview (desktop and phone sizes), then **Publish**.

Publishing writes `site/puzzles/<date>.json`. It is only on your computer until you deploy (below).

There is a sample draft, **Warm-Up**, in the sidebar if you want to try the flow on a finished mini.

---

## Putting the site online (GitHub Pages, free)

1. Create a repository on GitHub and push this folder:
   ```bash
   git init           # harmless if the folder is already a git repository
   git add -A
   git commit -m "Armani Crossword"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. On GitHub: **Settings → Pages → Source: GitHub Actions**. The run started by your first push may have failed
   because Pages wasn't on yet: in the **Actions** tab, open **Deploy site to GitHub Pages** and click **Run
   workflow** (or wait for the next hourly run).
3. The included workflow (`.github/workflows/deploy.yml`) publishes the site to
   `https://<you>.github.io/<repo>/`. Put that address in the builder's **Site settings → Share URL** so share
   texts link to it.
4. After publishing a puzzle (or changing **Site settings**) in the builder, commit and push:
   ```bash
   git add site/puzzles site/config.json && git commit -m "Puzzle for 2026-10-05" && git push
   ```

**Scheduling ahead works.** The workflow runs every hour and only deploys puzzles that are due within the next few
hours, so you can publish a week of puzzles at once; each goes online shortly before midnight and unlocks for
everyone at midnight in your site's time zone. GitHub pauses scheduled workflows after 60 days without commits —
re-enable it under the repository's **Actions** tab if that happens.

**Privacy notes.**
- On a free GitHub plan the repository must be public for Pages. Your drafts (`drafts/`) and clue memory
  (`data/user-clues.json`) contain plain answers, so they are git-ignored by default; scheduled puzzles in
  `site/puzzles/` are committed in obfuscated form — a determined friend could decode them from the repo. If that
  matters, keep the repo private and host elsewhere (below), or publish each puzzle on its day.
- The live site gets each puzzle about 3 hours before it unlocks. The site hides it until midnight, but someone
  fetching the file directly could peek. Answers are obfuscated, not encrypted — it's a friendly game.
- `data/user-words.txt` (your added and banned words) is committed; it holds no answers.

### Other hosts

`npm run build -- --released-only` writes a ready-to-upload `dist/` folder containing only puzzles that are due
today. Upload it to any static host (Netlify, Cloudflare Pages, a web server…). Re-run it whenever you publish or
when a scheduled puzzle comes due — `npm run build -- --released-only --lead-hours 3` also includes a puzzle due
within the next 3 hours, so you can upload in the evening and it still unlocks at midnight. Plain `npm run build` includes scheduled puzzles too (the site still hides them
until their day). `--out <folder>` changes the output folder.

---

## For your friends

Send them the link. That's it:

- No login or name — progress and times are saved in their browser on that device.
- The timer only runs while the page is open, visible and focused; switching tabs or apps pauses it (and hides the
  grid). There's also a Pause button.
- Check and Reveal (square / word / puzzle) are under the lightbulb button; they show up in the share result.
- **Share** opens the phone's share sheet, or copies the result on a computer.
- On a day without a new puzzle the site shows the latest one; older puzzles are in the archive (calendar button).
- On phones, "Add to Home Screen" makes it feel like an app.

---

## Settings that matter

**Site settings** in the builder edit `site/config.json`:

| Setting | What it does |
|---|---|
| Site name / tagline | Shown on the site and in share texts |
| Time zone | When the daily puzzle changes — midnight in this zone for everyone (set to `America/Chicago`) |
| Share URL | The link at the bottom of share texts |
| Share grid | Include the emoji grid in share texts |

**Word list** in the builder lets you add words (with a 1–100 score) and ban words; it edits
`data/user-words.txt` and takes effect immediately. Fill options include a minimum word score (default 30) and
**Avoid repeating recent answers**, which steers the filler away from answers used in puzzles within 30 days.

---

## Where things live

| Path | What |
|---|---|
| `drafts/*.json` | Your puzzle drafts (git-ignored) |
| `site/` | The website you deploy |
| `site/puzzles/` | Published puzzles + `index.json` |
| `site/config.json` | Site settings |
| `data/wordlist.txt` | Scored word list used by the filler (~144k words) |
| `data/clues-*.json` | Clue banks used for suggestions |
| `data/user-words.txt` | Your word additions and bans |
| `data/user-clues.json` | Clues you've published before (git-ignored) |
| `data/curated/` | Curated word scores and clues (source for `npm run wordlist`) — see `data/README.md` |
| `builder/`, `engine/`, `scripts/` | The toolkit |
| `SPEC.md` | Technical design and contracts |

---

## Testing on your phone

```bash
npm run dev -- --lan
```

The banner prints a Network address your phone can open (same Wi-Fi). Other devices only get the read-only player
site; the builder and its API stay private to your computer. On WSL2, the Windows firewall and NAT networking may
block it — enable [mirrored networking](https://learn.microsoft.com/windows/wsl/networking#mirrored-mode-networking)
or test on the deployed site instead.

---

## Development

```bash
npm test                 # unit tests (node:test)
npx playwright install chromium         # once
sudo npx playwright install-deps chromium   # once, on Linux (system libraries for the browser)
npm run test:e2e         # end-to-end tests: player on desktop/iPhone/Pixel, builder, build
npm run wordlist         # rebuild data/ from data/curated/*.tsv, SCOWL and WordNet (~7 s)
node scripts/bench-engine.mjs --quick   # fill/layout benchmarks (takes 5+ minutes)
```

Other ports: `PORT=5174 npm run dev`. Everything is plain JavaScript modules with no runtime dependencies; the
site needs no build step.

Word data: SCOWL (via `wordlist-english`) and WordNet 3.1 (via `wordnet-db`); licenses in `data/LICENSES.md`.
