# Word data

Everything the builder needs to fill grids and suggest clues. The player site never loads these files.

| File | What it is | Edited by |
| --- | --- | --- |
| `wordlist.txt` | **Generated.** ~144k scored fill words, `WORD;SCORE` per line, sorted, `#` header comments | `npm run wordlist` |
| `clues-curated.json` | **Generated.** `{ "WORD": ["clue", …] }` — crossword-style clues from `curated/*.tsv` | `npm run wordlist` |
| `clues-dictionary.json` | **Generated.** `{ "WORD": ["clue", …] }` — up to 3 WordNet-derived clues per word (score ≥ 25) | `npm run wordlist` |
| `curated/*.tsv` | Hand-curated scores and clues (the strongest evidence; see below) | people |
| `banned.txt` | Words never allowed in fills or generated clues | people |
| `user-words.txt` | *Optional.* Your own additions and bans, applied by the builder at runtime on top of `wordlist.txt` | the builder's Word list page |
| `user-clues.json` | *Optional.* Clues you have published before (most recent first) | the dev server, on publish |
| `LICENSES.md` | Attribution and license texts for SCOWL and WordNet — keep it with the generated files | — |

Builder clue suggestions are offered in the order **user → curated → dictionary**. No clue in either generated bank
contains its answer (letters compared with spaces and punctuation ignored, the same check the builder uses).

## Rebuilding

```sh
npm run wordlist                       # reads node_modules + data/curated + data/banned.txt, writes data/ (~7 s)
node scripts/build-wordlist.mjs --help
node scripts/build-wordlist.mjs --out-dir /tmp/try --curated-dir data/curated --banned data/banned.txt --samples 40
```

Rebuild after editing `curated/*.tsv` or `banned.txt`. Outputs are written atomically (temp file + rename), so a running
builder never reads a half-written file. The build prints counts by length and score band, clue coverage, and sample
clues (`--samples N` prints more, `--seed N` picks a different sample, `--quiet` prints nothing).

## Scores

`SCORE` is 1–100; higher means better fill. Banned words are simply absent. The fill engine's default minimum is 30.

| Band | Meaning | Typical sources |
| --- | --- | --- |
| 70–100 | lively, great fill | curated only |
| 50–69 | solid everyday words | common SCOWL words, famous proper nouns, lively phrases |
| 35–49 | acceptable: crosswordese, inflections, moderate proper nouns and phrases | |
| 1–34 | obscure / ugly — used only when nothing else fits | rare dictionary words, unknown names |

How a score is computed (`scripts/build-wordlist.mjs` and `scripts/data/*.mjs`):

1. **SCOWL words** (`wordlist-english`, levels 10–70, English + American spellings) start from their frequency level:
   10 → 60, 20 → 56, 35 → 51, 40 → 48, 50 → 44, 55 → 40, 60 → 35, 70 → 26.
   - Words WordNet knows get **+3**, plus up to **+5** more for corpus frequency (sense-tagged occurrences).
   - Words WordNet doesn't know at all (not even via their base form) at level ≥ 50 get **−6** (slang, rare coinages).
   - **Plain inflections** (plurals, -S/-ED/-ING verb forms, -ER/-EST) that are not dictionary entries in their own right
     score **5 below their base form** (ABANDON 64 → ABANDONS 59). Irregular forms (RAN, MICE) count too.
   - **Junk** is dropped: no vowel (CSC), abbreviations (KCAL, TANH), Roman numerals (XIV), letter runs (ABC, QWERTY),
     tripled letters, generator artefacts like HIMS / WHATS, and anything outside 3–21 letters.
2. **Proper nouns** from WordNet (places, people, deities, months, languages …; never genus names or acronyms):
   `26 + 5·log2(1 + mentions) (+6 if corpus-tagged) (+8 countries, US states, capitals, months, planets, major gods;
   +3 cities, rivers, biblical and mythological figures …) (−8 trade names)`, capped at 55, where *mentions* counts
   how many other WordNet definitions name it ("a city in Ohio"). PARIS 55, OHIO 55, ODIN 51, ESAU 41, obscure names < 30.
3. **Multi-word phrases** from WordNet whose parts are all common words (ICECREAM, GIVEUP, ATALOSS, XRAY, PERSE):
   scored 10–62, favouring idiomatic phrases (GLASS CEILING) over compositional ones (FILM COMPANY), phrasal verbs
   with lively particles (CUT OFF), corpus frequency and several senses; partial phrases (OUT TO) are penalised.
   WordNet-only entries scoring below 20 are left out.
4. The same word from several sources keeps its **best** score.
5. **Curated TSV scores are authoritative**: they replace the computed score (up or down) and add missing words.
6. Everything in **`banned.txt`** is removed last — even curated words.

## Customizing

**Your own words** — use the builder's *Word list* page, which edits `user-words.txt` (format: `WORD;SCORE` adds or
overrides a word, `-WORD` bans it, `#` comments). It is applied at runtime; no rebuild needed.

**Curated TSVs** — `curated/*.tsv`, any file name, tab-separated:

```text
# comment
OREO	68	Twist-off cookie	Black-and-white treat
ESNE	0
```

`WORD<TAB>SCORE<TAB>clue 1[<TAB>clue 2 …]`. Words are normalised to A–Z (spaces and punctuation dropped). When several
rows or files mention a word: any score `0` bans it, otherwise the highest score wins, and clues are concatenated in
file-name order without duplicates. A clue that contains its own answer is dropped with a warning. Run
`npm run wordlist` afterwards.

**Banning** — add a line to `banned.txt` (one word per line, `#` comments). Plural / 3rd-person "-S" forms are banned
automatically; list -ED/-ING forms explicitly. Words containing an unambiguous offensive root (see `BANNED_ROOTS` in
`scripts/data/banned.mjs`) are always excluded. The list targets slurs, profanity, crude sexual or bodily terms and drug
slang; ambiguous everyday words (POT, WEED, SCREW, COCKPIT) are deliberately allowed — ban them per puzzle in the
builder if you prefer.

## Dictionary clues

`clues-dictionary.json` has up to three clues for each listed word scoring ≥ 25 that WordNet can explain, best first,
drawn from its most frequent senses:

- **Synonyms** — ABANDON: "Vacate" (with "Forsake, leave behind"); DESERT: "Abandon", "Forsake"; OHIO: "Buckeye State".
- **Shortened definitions** — first clause, leading article dropped, capitalised, ≤ 60 characters, cut at a natural
  boundary or skipped; subject labels become suffixes ("God of love, in Greek myth"); "United States" → "U.S.".
- **Inflected forms** are clued from their base word with matching inflection: SQUIDS "Widely distributed fast-moving
  ten-armed cephalopod mollusks", ABOLISHED "Did away with", PALMED "Handled". When the inflection can't be done
  safely the clue is skipped — fewer, correct clues beat many wrong ones.
- **Fill-in-the-blank** from WordNet phrases — ERIE "Lake ___", MEIR "Golda ___", FAR "So ___".
- **"Kind of …"** from the word's category when nothing better exists — ICECREAM "Kind of frozen dessert".

Guarantees: never the answer, its base word, a word sharing its stem, or a part of a compound answer
(HUBCAP gets no clue mentioning a cap); no banned words; offensive, vulgar, slang and drug senses are skipped.
These are machine-made: treat them as suggestions and polish them in the builder.
