#!/usr/bin/env node
// Claude's way (SPEC §9) — the generator a scheduled Claude session drives every day (see claude/PLAYBOOK.md):
// pick a theme, build tomorrow's Mini (5×5), Midi (9×9) and Daily (15×15) with the engine, write the clues, publish
// them to site/puzzles/claude/ and verify the set. Zero dependencies: plain `node` in a fresh clone, no network.
//
// Usage: node scripts/claude-way.mjs <command> [options]            (add --json for machine-readable output)
//
//   status  [--date D]
//       Today and tomorrow in the site's time zone (site/config.json), which Claude puzzles exist for them, each
//       kind's difficulty (weekday ramp: Mon 1 … Sat 6, Sun 4; the Mini one gentler), what to make next, the Claude
//       themes of the last 120 days (pick a different one) and how many recent answers the fill will avoid.
//
//   build   --date D --kind mini|midi|daily --plan plan.json [--seed N] [--time SECONDS] [--avoid W1,W2]
//           [--min-score N] [--max-blocks N] [--tries N]
//       plan.json = { "title": "...", "theme": "topic (no answers)", "note": "optional",
//                     "answers": [{ "answer": "PUMPKIN PIE", "clue": "optional" }, ...] }   most important first.
//       Generates layouts that hold the theme answers (leftovers are preferred in the fill), fills the best one
//       (min score 35 by default, 30 as an automatic fallback; answers of both series within ±30 days avoided),
//       writes .claude-way/<id>.draft.json and .claude-way/<id>.clues.json (the clue worksheet: every entry with
//       its crossings and clue-bank suggestions) and prints the grid with flagged entries. --avoid bans words for
//       this build (rebuild to replace an iffy entry). Grids with too many blocks, 2×2 block squares or long block
//       runs rank lower ("choppy"; --max-blocks N moves the block limit, default 6 / 16 / 44). --tries N layout
//       searches (seeds) run in parallel worker threads when there are cores (default 2 / 3 / 3); --time is per
//       search (default 6 / 20 / 45 s). The chosen fill is then polished (refilled avoiding its iffy entries).
//       Exit 1 when the theme cannot be fitted. Every build is also saved as a numbered snapshot
//       (.claude-way/builds/), so a worse rebuild never loses a better earlier one (see restore).
//
//   refill  --id ID --avoid W1,W2 [--seed N]
//       Replaces a few fill words of the current build while keeping its grid and theme answers: only the entries
//       crossing the avoided words are refilled (then a wider ring, then all the fill if needed). Takes seconds;
//       prefer it to a full rebuild when the grid is good and only some entries are weak. Saved as a new build.
//
//   restore --id ID [--build N]
//       Lists the saved builds of a puzzle (theme answers placed, blocks, fill average, flagged entries); with
//       --build N makes build N the current draft + worksheet again (then write clues and publish as usual).
//
//   publish --id ID --clues clues.json [--title T] [--note N] [--dry-run] [--force]
//       clues.json = { "PIE": "Thanksgiving dessert", "14A": "...", ... } (keys: answers or entry ids).
//       Quality gates (any failure: nothing is written, every problem listed): every entry clued, clues ≤ 80
//       characters, no clue containing its answer or its root, no duplicate clues, no banned words, a title, and
//       the puzzle validates. Writes site/puzzles/claude/<id>.json (author "Claude", series "claude") and rebuilds
//       site/puzzles/claude/index.json. A released puzzle (date ≤ today) is only replaced with --force.
//
//   unpublish --id ID [--force]
//       Removes a Claude puzzle file and rebuilds the index (e.g. to roll back a set that cannot be completed).
//       A released puzzle (date ≤ today) needs --force.
//
//   check   [--date D[,D2…]] [--kind K]
//       Verifies the full set (mini, midi, daily) for the dates (default: today and tomorrow): present, valid,
//       clues pass the gates, index consistent. Exit 1 otherwise.
//
// build, refill and publish also print "Editor's checks" (never blocking; `review` in --json): breakfast-test fill,
// theme answers whose symmetric slot holds fill, fill as long as a theme answer, clues that contain another answer
// or a theme word, and words repeated across clues. `restore` marks the current build with →.
//
// Common options: --root DIR (work on another checkout; default: this repository), --json, --today D (pretend
// today is D, for testing), --quiet (no progress lines).

import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { KINDS, KIND_LABELS, addDays } from '../site/shared/puzzle.js';
import { BLOCK, computeEntries } from '../site/shared/grid.js';
import { CliError, REPO_ROOT, assertSeriesSupport, draftFile, drawGrid, paths, readJson, siteToday } from './claude-way/common.mjs';
import { buildPuzzle, refillPuzzle, restoreBuild } from './claude-way/build.mjs';
import { checkSets, publishPuzzle, unpublishPuzzle } from './claude-way/publish.mjs';
import { getStatus } from './claude-way/status.mjs';
import { textWords } from './claude-way/gates.mjs';

const VALUE_OPTS = new Set(['root', 'date', 'kind', 'plan', 'seed', 'time', 'avoid', 'min-score', 'max-blocks', 'id', 'clues', 'title', 'note', 'today', 'tries', 'build']);
const FLAG_OPTS = new Set(['json', 'dry-run', 'force', 'help', 'quiet']);

export function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      opts._.push(a);
      continue;
    }
    let [name, value] = a.slice(2).split(/=(.*)/s, 2);
    if (FLAG_OPTS.has(name)) {
      opts[name] = true;
      continue;
    }
    if (!VALUE_OPTS.has(name)) throw new CliError(`Unknown option --${name} (see --help)`, { code: 2 });
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new CliError(`--${name} needs a value`, { code: 2 });
    }
    if (name === 'date' || name === 'avoid') (opts[name] ||= []).push(...value.split(',').map((s) => s.trim()).filter(Boolean));
    else opts[name] = value;
  }
  return opts;
}

function intOpt(opts, name) {
  if (opts[name] === undefined) return undefined;
  const n = Number(opts[name]);
  if (!Number.isFinite(n)) throw new CliError(`--${name} must be a number`, { code: 2 });
  return n;
}

function usage() {
  return `Claude's way generator — node scripts/claude-way.mjs <command> [options]

  status  [--date D]                         what to make next, difficulty, recent themes
  build   --date D --kind mini|midi|daily --plan plan.json [--seed N] [--time SECONDS] [--avoid W1,W2]
          [--min-score N] [--max-blocks N] [--tries N]
  publish --id ID --clues clues.json [--title T] [--note N] [--dry-run] [--force]
  refill  --id ID --avoid W1,W2 [--seed N]    keep the grid, replace just those fill words (seconds)
  restore --id ID [--build N]                 list saved builds / bring build N back as the current draft
  check   [--date D[,D2]] [--kind K]          verify the full set for the dates (default today + tomorrow)
  unpublish --id ID [--force]                 remove a Claude puzzle (roll back an incomplete set)

Options: --root DIR, --json, --quiet. Full instructions: claude/PLAYBOOK.md (and the header of this file).`;
}

/** The command prefix for "next step" hints (with --root when not this repository). */
function cmdPrefix(P) {
  const abs = path.join(REPO_ROOT, 'scripts', 'claude-way.mjs');
  const relative = path.relative(process.cwd(), abs);
  const script = relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : abs;
  return `node ${script}${P.root !== REPO_ROOT ? ` --root ${P.root}` : ''}`;
}

// ---------------------------------------------------------------------------
// Editor's checks: review hints printed after build / refill / publish. Never blocking (the gates in
// claude-way/gates.mjs decide what may be published); they point the session at problems an editor would catch.

/**
 * Entry prefixes / whole entries that fail the "breakfast test" more often than not. The word list holds legitimate
 * but unpleasant words (crime, sex, drugs, death, bodily functions) that data/banned.txt does not ban, e.g. PEDERAST.
 */
const UNPLEASANT_PREFIXES = [
  'ABORT', 'PEDERAS', 'PEDOPH', 'INCEST', 'RAPIST', 'MOLEST', 'GROPE', 'SODOMI', 'ORGASM', 'ORGIES', 'EROTIC', 'NUDIST',
  'STRIPPER', 'SEXUAL', 'HOOKER', 'BROTHEL', 'SUICID', 'GENOCID', 'MURDER', 'HOMICID', 'MASSACR', 'TORTUR', 'CORPSE',
  'CADAVER', 'POISON', 'OVERDOS', 'COCAIN', 'OPIOID', 'NARCOTIC', 'NAZI', 'HITLER', 'TERRORIS', 'JIHAD', 'ENEMA',
  'URINA', 'FECES', 'FECAL', 'VOMIT', 'DIARRH', 'HEMORRH', 'LAXATIV', 'GONORR', 'SYPHIL', 'HERPES', 'RETARD', 'MIDGET',
  'SPASTIC', 'EXECUTIONER',
];
const UNPLEASANT_WORDS = new Set([
  'ORGY', 'NUDE', 'NUDES', 'SEX', 'SEXY', 'RAPE', 'RAPES', 'RAPED', 'PIMP', 'PIMPS', 'METH', 'HEROIN', 'URINE', 'ANAL',
  'ANUS', 'PENIS', 'TESTES', 'KILL', 'KILLS', 'KILLED', 'KILLER', 'KILLERS',
]);

/** True when an entry fails the breakfast test more often than not (a hint: POISONIVY is fine). */
export function isUnpleasant(answer) {
  const w = String(answer).toUpperCase();
  return UNPLEASANT_WORDS.has(w) || UNPLEASANT_PREFIXES.some((p) => w.startsWith(p));
}

/** Entries of a grid given as rows of letters and '#'. */
function entriesOfRows(rows) {
  const width = rows[0]?.length || 0;
  const cells = rows.join('').split('').map((ch) => (ch === BLOCK ? BLOCK : ch));
  const { all } = computeEntries({ width, height: rows.length, cells });
  return all.map((e) => ({ ...e, answer: e.cells.map((i) => cells[i]).join('') }));
}

/**
 * Editor's checks for a built grid (r = a build / refill result): unpleasant entries, fill entries as long as the
 * theme answers, and theme answers (7+ letters) whose symmetric partner slot holds fill (solvers read that slot as
 * theme too).
 * @returns string[]
 */
export function reviewBuild(r) {
  const hints = [];
  const byId = new Map((r.entries || []).map((e) => [e.id, e]));
  for (const e of r.entries || []) {
    if (!e.isTheme && isUnpleasant(e.answer)) hints.push(`${e.id} ${e.answer}: breakfast test? Replace it (refill --avoid ${e.answer}) unless it is clearly innocent.`);
  }
  const theme = (r.entries || []).filter((e) => e.isTheme);
  if (!theme.length || !Array.isArray(r.grid) || !r.grid.length) return hints;
  const shortest = Math.min(...theme.map((e) => e.answer.length));
  if (shortest >= 7) {
    for (const e of r.entries) {
      if (!e.isTheme && e.answer.length >= shortest) hints.push(`${e.id} ${e.answer}: fill as long as a theme answer (${e.answer.length} letters) — solvers may take it for one; replace it if it is not obviously unrelated.`);
    }
  }
  const all = entriesOfRows(r.grid);
  const n = r.grid.length * r.grid[0].length;
  const key = (cells) => [...cells].sort((a, b) => a - b).join(',');
  const byCells = new Map(all.map((e) => [`${e.dir}:${key(e.cells)}`, e]));
  // Only long theme answers stand out as theme (in a Mini every row is a 5-letter word).
  for (const t of theme.filter((x) => x.answer.length >= 7)) {
    const ent = all.find((e) => e.id === t.id);
    if (!ent) continue;
    const mate = byCells.get(`${ent.dir}:${key(ent.cells.map((i) => n - 1 - i))}`);
    if (!mate || mate.id === ent.id) continue;
    if (!byId.get(mate.id)?.isTheme) {
      hints.push(`${t.id} ${t.answer} sits opposite ${mate.id} ${mate.answer}, a fill entry: theme answers are not in symmetric slots, so ${mate.answer} reads as a theme answer. Prefer another build (restore) or rebuild.`);
    }
  }
  return hints;
}

/** Common clue words that say nothing about the answer (not worth flagging when repeated). */
const FILLER_WORDS = new Set([
  'ABBR', 'SHORT', 'BRIEFLY', 'FAMILIARLY', 'INFORMALLY', 'LIKE', 'KIND', 'SORT', 'OFTEN', 'PERHAPS', 'MAYBE', 'SOMETHING',
  'THING', 'THINGS', 'ONES', 'EACH', 'ALSO', 'JUST', 'VERY', 'MORE', 'MOST', 'MUCH', 'MANY', 'WITH', 'THAT', 'THIS', 'FROM',
  'INTO', 'ONTO', 'WHAT', 'WHEN', 'WHERE', 'WHICH', 'WHOSE', 'SOME', 'THEY', 'THEM', 'THAN', 'THEN', 'BEEN', 'HAVE', 'WERE',
  'WILL', 'YOUR', 'ABOUT', 'AFTER', 'BEFORE', 'OVER', 'UNDER', 'ONLY', 'EVEN', 'STILL', 'SUCH', 'THEIR', 'THERE', 'THESE',
  'THOSE', 'MAKE', 'MAKES', 'MADE', 'COULD', 'WOULD', 'MIGHT',
]);
/** Short answers that are everyday clue words too (THE, AND …): not flagged when a clue uses them. */
const COMMON_SHORT = new Set(['THE', 'AND', 'FOR', 'BUT', 'NOT', 'ARE', 'WAS', 'ONE', 'HAS', 'HAD', 'ITS', 'YOU', 'CAN', 'MAY', 'OUT', 'ALL', 'ANY', 'HOW', 'WHO', 'WHY', 'OFF', 'OWN', 'SAY', 'SEE', 'USE', 'GET', 'NEW', 'OLD', 'NOW', 'TWO', 'TOO', 'WAY', 'DAY', 'MAN']);

/** Rough word key for spotting repeats: lower-case, simple plural / -ed / -ing endings removed. */
function wordKey(w) {
  let k = w.toUpperCase();
  for (const [suf, rep] of [['IES', 'Y'], ['ING', ''], ['ED', ''], ['ES', ''], ['S', '']]) {
    if (k.endsWith(suf) && k.length - suf.length >= 4) {
      k = k.slice(0, -suf.length) + rep;
      break;
    }
  }
  return k;
}

/**
 * Editor's checks for a clue list ([{ id, answer, clue }]): clues that contain another answer of the grid (CRITICAL in
 * the ICU clue crossing CRITIC) or a word of a theme answer ("Big Apple" next to APPLEPICKING; without
 * `themeAnswers`, answers of 9+ letters count as theme), and content words repeated across clues.
 * @returns string[]
 */
export function reviewClues(clues, { themeAnswers = null } = {}) {
  const hints = [];
  const list = (clues || []).filter((c) => c && c.clue);
  const themeSet = themeAnswers ? new Set(themeAnswers) : null;
  const isThemeLike = (A) => (themeSet ? themeSet.has(A) : A.length >= 9);
  for (const c of list) {
    const words = textWords(c.clue);
    for (const o of list) {
      if (o.id === c.id) continue;
      const A = o.answer;
      if (A.length < 3 || (A.length === 3 && COMMON_SHORT.has(A))) continue;
      const hit = words.find((w) => w === A || (A.length >= 4 && w.length > A.length && w.startsWith(A))
        || (isThemeLike(A) && w.length >= 4 && !FILLER_WORDS.has(w) && (A.startsWith(w) || A.endsWith(w))));
      if (hit) hints.push(`${c.id} ${c.answer}: the clue word "${hit.toLowerCase()}" gives away or echoes ${o.id} ${o.answer} — reword it.`);
    }
  }
  const seen = new Map();
  for (const c of list) {
    for (const w of new Set(textWords(c.clue).filter((x) => x.length >= 4 && !FILLER_WORDS.has(x)).map(wordKey))) {
      if (!seen.has(w)) seen.set(w, []);
      seen.get(w).push(c.id);
    }
  }
  for (const [w, ids] of seen) {
    if (ids.length > 1) hints.push(`"${w.toLowerCase()}" appears in ${ids.length} clues (${ids.join(', ')}) — vary the wording.`);
  }
  return hints;
}

function printHints(out, hints) {
  if (!hints.length) return;
  out.push('');
  out.push("Editor's checks (not blocking — fix each one unless it is clearly fine):");
  for (const h of hints) out.push(`  ? ${h}`);
}

// ---------------------------------------------------------------------------
// Human-readable printers

function printStatus(s, P) {
  const out = [];
  out.push(`Claude's way — status (site time zone: ${s.timeZone || 'local'})`);
  for (const d of s.dates) {
    const label = d.label ? `${d.label[0].toUpperCase()}${d.label.slice(1)}` : 'Date';
    out.push('');
    out.push(`${label}: ${d.weekday} ${d.date}`);
    for (const kind of KINDS) {
      const k = d.kinds[kind];
      const state = k.published ? `published "${k.title}"${k.theme ? ` — theme: ${k.theme}` : ''}` : k.draft ? 'built, not published' : 'missing';
      out.push(`  ${KIND_LABELS[kind].padEnd(5)} ${`${k.size}×${k.size}`.padEnd(5)}  level ${k.level}  ${k.id.padEnd(23)} ${state}`);
    }
  }
  out.push('');
  if (s.todo.length) {
    out.push(`To make (${s.todo.length}):`);
    for (const t of s.todo) out.push(`  ${t.date} ${t.kind.padEnd(5)} ${t.size.padEnd(5)} level ${t.level}${t.draft ? '  (draft exists)' : ''}`);
  } else out.push('Nothing to make: every puzzle for these dates is published.');
  out.push('');
  out.push('Difficulty levels:');
  for (const [lv, text] of Object.entries(s.levels)) out.push(`  ${lv}  ${text}`);
  out.push('');
  if (s.history.length) {
    out.push(`Claude themes since ${addDays(s.today, -120)} (newest first) — choose something different:`);
    for (const h of s.history) {
      const titles = KINDS.filter((k) => h.titles[k]).map((k) => `${KIND_LABELS[k]} "${h.titles[k]}"`).join(', ');
      out.push(`  ${h.date}  ${h.themes.join(' / ') || '(no theme recorded)'} — ${titles}`);
    }
  } else out.push('No Claude puzzles yet: any theme is fresh.');
  out.push('');
  out.push(`Freshness: ${s.freshness.answers} answers used within ±${s.freshness.days} days of ${s.freshness.date} (both series) are avoided automatically.`);
  if (s.todo.length) out.push(`Next: pick the theme, write a plan, then ${cmdPrefix(P)} build --date ${s.todo[0].date} --kind ${s.todo[0].kind} --plan <plan.json>`);
  return out.join('\n');
}

function printBuild(r, P) {
  const out = [];
  out.push(`${r.refill ? 'Refilled' : 'Built'} ${r.id} — ${KIND_LABELS[r.kind]} ${r.size}×${r.size} for ${r.weekday} ${r.date} (difficulty ${r.level})`);
  if (r.refill) {
    out.push(`Kept the grid of build ${r.refill.from ?? '?'}; refilled ${r.refill.cleared}. Changed: ${r.refill.changed.join(', ') || 'nothing'}`);
    if (r.refill.cleared === 'all the fill' && r.refill.changed.length) {
      out.push(`NOTE: no local fix existed, so the WHOLE fill was redone (${r.refill.changed.length} entries changed). Treat this as a new fill: read every entry again, and if it is worse, bring back build ${r.refill.from ?? 'N'} with restore --id ${r.id} --build ${r.refill.from ?? 'N'}.`);
    }
  }
  out.push(`Title: "${r.title || '(none yet — add one to the plan or pass --title to publish)'}"   Theme: ${r.theme}`);
  const placed = r.placed.map((p) => `${p.answer} (${p.id})`).join(', ');
  out.push(`Theme answers placed ${r.placed.length}/${r.placed.length + r.unplaced.length}: ${placed || 'none'}`);
  if (r.unplaced.length) out.push(`NOT placed: ${r.unplaced.join(', ')} — rebuild with another --seed, more --time, shorter answers, or drop them`);
  const st = r.structure;
  out.push(`Grid: ${st.blocks} blocks, ${st.words} entries, average length ${st.avgLength}${st.choppy.length ? ` — CHOPPY: ${st.choppy.join(', ')}` : ` (tidy: ≤ ${st.limits.blocks} blocks, no long block runs)`}`);
  out.push(`Fill: min score ${r.minScore}${r.fellBack ? ` (fallback from ${r.requestedMinScore})` : ''}, average ${r.stats.fillAvg}, lowest ${r.stats.fillMin}; seed ${r.seed}; ${(r.stats.ms / 1000).toFixed(1)} s`);
  out.push('');
  out.push(drawGrid(r.grid));
  for (const dir of ['across', 'down']) {
    out.push('');
    out.push(dir === 'across' ? 'Across' : 'Down');
    for (const e of r.entries.filter((x) => x.id.endsWith(dir === 'across' ? 'A' : 'D'))) {
      const score = e.isTheme ? '★ theme' : String(e.score ?? '?');
      out.push(`  ${e.id.padEnd(4)} ${e.answer.padEnd(r.size + 1)} ${score}${e.flags.length ? `   ! ${e.flags.join('; ')}` : ''}`);
    }
  }
  out.push('');
  if (r.flags.length) {
    out.push('Check these entries (replace a weak one: refill --id ID --avoid WORD[,WORD] keeps the grid; build … --avoid rebuilds it):');
    for (const f of r.flags) out.push(`  ! ${f}`);
  } else out.push('No flagged entries.');
  printHints(out, r.review || reviewBuild(r));
  if (r.warnings.length) {
    out.push('');
    out.push('Warnings:');
    for (const w of r.warnings) out.push(`  - ${w}`);
  }
  out.push('');
  out.push(`Wrote ${r.files.draft} and ${r.files.worksheet} (worksheet: every entry with crossings and clue-bank suggestions).`);
  if (r.build > 1) out.push(`This is build ${r.build} of ${r.id}. If an earlier build was better: ${cmdPrefix(P)} restore --id ${r.id}  (lists them; add --build N to bring one back)`);
  if (r.flags.length) out.push(`To replace a weak fill word but keep this grid: ${cmdPrefix(P)} refill --id ${r.id} --avoid WORD[,WORD]`);
  out.push(`Next: write all clues as JSON { "ANSWER": "clue", ... } at level ${r.level}, then`);
  out.push(`  ${cmdPrefix(P)} publish --id ${r.id} --clues <your-clues.json> --dry-run`);
  return out.join('\n');
}

function printPublish(r, P) {
  const out = [];
  out.push(r.dryRun ? `Dry run OK — ${r.id} passes every gate (nothing written).` : `Published ${r.id}${r.replaced ? ' (replaced the previous version)' : ''} → ${r.file}${r.number ? `  (${KIND_LABELS[r.kind]} #${r.number})` : ''}`);
  out.push(`Title: "${r.title}"   Theme: ${r.theme}${r.note ? `   Note: ${r.note}` : ''}`);
  out.push('');
  for (const c of r.clues) out.push(`  ${c.id.padEnd(4)} ${c.answer.padEnd(16)} ${c.clue}`);
  if (r.warnings.length) {
    out.push('');
    out.push('Warnings (not blocking — fix if they are real):');
    for (const w of r.warnings) out.push(`  - ${w}`);
  }
  printHints(out, r.review || reviewClues(r.clues));
  if (!r.dryRun) {
    out.push('');
    out.push(`Index rebuilt: ${r.index}. When the set is done: ${cmdPrefix(P)} check --date ${r.date}`);
  }
  return out.join('\n');
}

function printRestore(r, P) {
  const out = [];
  if (!r.builds.length) return `No saved builds of ${r.id} yet.`;
  out.push(`Saved builds of ${r.id}:`);
  for (const b of r.builds) {
    const s = b.summary;
    const sum = s
      ? `theme ${s.placed}/${s.of}, ${s.blocks} blocks${s.choppy ? ' (choppy)' : ''}, fill avg ${s.fillAvg} (min score ${s.minScore})${s.flagged.length ? `, flagged: ${s.flagged.join(', ')}` : ', nothing flagged'}`
      : '(no summary)';
    const current = (r.restored ?? r.current) === b.build;
    out.push(`  ${current ? '→' : ' '} build ${b.build}: ${sum}${b.avoid.length ? `; --avoid ${b.avoid.join(',')}` : ''}${current ? '   (current)' : ''}`);
  }
  if (r.restored) {
    out.push('');
    out.push(`Restored build ${r.restored} as ${r.files.draft} and ${r.files.worksheet}:`);
    out.push(drawGrid(r.grid));
    out.push('');
    out.push(`Next: write the clues from ${r.files.worksheet}, then ${cmdPrefix(P)} publish --id ${r.id} --clues <your-clues.json> --dry-run`);
  } else out.push(`Bring one back with: ${cmdPrefix(P)} restore --id ${r.id} --build N`);
  return out.join('\n');
}

function printCheck(r) {
  const out = [];
  for (const d of r.dates) {
    out.push(`${d.date}: ${d.ok ? 'OK' : 'NOT OK'}`);
    for (const [kind, k] of Object.entries(d.kinds)) {
      out.push(`  ${k.ok ? '✓' : '✗'} ${KIND_LABELS[kind].padEnd(5)} ${k.id}${k.title ? ` "${k.title}"` : ''}`);
      for (const p of k.problems) out.push(`      ✗ ${p}`);
      for (const w of k.warnings) out.push(`      ! ${w}`);
    }
  }
  out.push(`Index: ${r.index.ok ? 'OK' : 'NOT OK'}`);
  for (const p of r.index.problems) out.push(`  ✗ ${p}`);
  if (r.warnings.length) {
    out.push('Warnings:');
    for (const w of r.warnings) out.push(`  ! ${w}`);
  }
  out.push(r.ok ? 'All good.' : 'Problems found (exit 1): do not push until they are fixed.');
  return out.join('\n');
}

// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  let opts = { _: [] };
  const write = (text) => process.stdout.write(`${text}\n`);
  try {
    opts = parseArgs(argv);
    const [command] = opts._;
    if (opts.help || !command || command === 'help') {
      write(usage());
      return command || opts.help ? 0 : 2;
    }
    assertSeriesSupport();
    const P = paths(opts.root ? path.resolve(opts.root) : REPO_ROOT);
    const log = opts.json || opts.quiet ? () => {} : (msg) => process.stderr.write(`${msg}\n`);
    const emit = (result, printer) => write(opts.json ? JSON.stringify(result, null, 2) : printer(result, P));

    if (command === 'status') {
      if ((opts.date || []).length > 1) throw new CliError('status takes one --date', { code: 2 });
      const s = await getStatus({ P, date: opts.date?.[0] || null, today: opts.today || null });
      emit(s, printStatus);
      return 0;
    }
    if (command === 'build') {
      if (!opts.date?.length || opts.date.length > 1) throw new CliError('build needs one --date YYYY-MM-DD', { code: 2 });
      if (!opts.kind) throw new CliError('build needs --kind mini|midi|daily', { code: 2 });
      if (!opts.plan) throw new CliError('build needs --plan <plan.json>', { code: 2 });
      const plan = await readJson(path.resolve(opts.plan));
      const r = await buildPuzzle({
        P, date: opts.date[0], kind: opts.kind, plan, seed: intOpt(opts, 'seed'), timeSec: intOpt(opts, 'time'),
        avoid: opts.avoid || [], minScore: intOpt(opts, 'min-score'), maxBlocks: intOpt(opts, 'max-blocks'), tries: intOpt(opts, 'tries'), today: opts.today || null, log,
      });
      r.review = reviewBuild(r);
      emit(r, printBuild);
      return 0;
    }
    if (command === 'publish') {
      if (!opts.id) throw new CliError('publish needs --id <puzzle id> (e.g. claude-2026-10-05-mini)', { code: 2 });
      const r = await publishPuzzle({
        P, id: opts.id, cluesFile: opts.clues, title: opts.title, note: opts.note, dryRun: !!opts['dry-run'], force: !!opts.force,
        today: opts.today || null,
      });
      const draft = await readJson(draftFile(P, opts.id), null).catch(() => null);
      const themeAnswers = Array.isArray(draft?.theme) ? draft.theme.map((t) => String(t.answer || '').toUpperCase().replace(/[^A-Z]/g, '')) : null;
      r.review = reviewClues(r.clues, { themeAnswers });
      emit(r, printPublish);
      return 0;
    }
    if (command === 'refill') {
      if (!opts.id) throw new CliError('refill needs --id <puzzle id>', { code: 2 });
      const r = await refillPuzzle({ P, id: opts.id, avoid: opts.avoid || [], seed: intOpt(opts, 'seed'), log });
      r.review = reviewBuild(r);
      emit(r, printBuild);
      return 0;
    }
    if (command === 'restore') {
      if (!opts.id) throw new CliError('restore needs --id <puzzle id>', { code: 2 });
      const r = await restoreBuild({ P, id: opts.id, build: intOpt(opts, 'build') ?? null });
      if (!r.restored) {
        // Mark the build the current draft came from (the one publish would use).
        const draft = await readJson(draftFile(P, opts.id), null).catch(() => null);
        r.current = Number.isInteger(draft?.build?.number) ? draft.build.number : null;
      }
      emit(r, printRestore);
      return 0;
    }
    if (command === 'unpublish') {
      if (!opts.id) throw new CliError('unpublish needs --id <puzzle id>', { code: 2 });
      const r = await unpublishPuzzle({ P, id: opts.id, force: !!opts.force, today: opts.today || null });
      emit(r, (x) => `Removed ${x.removed}; index rebuilt (${x.remaining} Claude puzzle(s) left).`);
      return 0;
    }
    if (command === 'check') {
      const today = await siteToday(P, opts.today || null);
      const dates = opts.date?.length ? opts.date : [today, addDays(today, 1)];
      const kinds = opts.kind ? [opts.kind] : KINDS;
      if (!kinds.every((k) => KINDS.includes(k))) throw new CliError('--kind must be mini, midi or daily', { code: 2 });
      const r = await checkSets({ P, dates, kinds });
      emit(r, printCheck);
      return r.ok ? 0 : 1;
    }
    throw new CliError(`Unknown command "${command}"\n\n${usage()}`, { code: 2 });
  } catch (err) {
    if (!(err instanceof CliError)) {
      process.stderr.write(`${err.stack || err}\n`);
      if (opts.json) write(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2));
      return 1;
    }
    if (opts.json) {
      write(JSON.stringify({ ok: false, error: err.message, details: err.details, ...(err.data || {}) }, null, 2));
    } else {
      process.stderr.write(`${err.message}\n${err.details.map((d) => `  - ${d}`).join('\n')}${err.details.length ? '\n' : ''}`);
      const warnings = err.data?.warnings || [];
      if (warnings.length) process.stderr.write(`Warnings:\n${warnings.map((w) => `  - ${w}`).join('\n')}\n`);
    }
    return err.exitCode;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
