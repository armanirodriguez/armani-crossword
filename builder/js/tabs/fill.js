// Grid & Fill tab: the big grid editor plus a side panel with fill controls, candidate words for the selected
// entry, the theme-word palette, and stats & warnings.

import { BLOCK, entryPattern, isLetter } from '../../../site/shared/grid.js';
import { h, icon, plural, debounce, replaceChildren } from '../dom.js';
import { confirmDialog, toast, toastError } from '../dialogs.js';
import { applyUserWordOps } from '../user-words.js';
import {
  analyze, clearUnlocked, cluedWordsRefillWouldReplace, gridOf, gridStats, lockAll, placeWord, setLocked, slotsForWord, themeClues,
} from '../draft-utils.js';
import { GridEditor } from '../grid-editor.js';
import { getFillOptions, setPref } from '../prefs.js';
import { RECENT_WINDOWS, recentRepeats, usedLabel, usedSentence } from '../recent-answers.js';

const MODES = [
  { id: 'letters', label: 'Letters', help: 'Click to select, type to fill (typed letters are locked)' },
  { id: 'blocks', label: 'Blocks', help: 'Click to add/remove a block and its symmetric partner (or press “.”)' },
  { id: 'circles', label: 'Circles', help: 'Click squares to circle them (theme highlighting)' },
  { id: 'shaded', label: 'Shade', help: 'Click squares to shade them (theme highlighting)' },
];
const REASONS = {
  timeout: 'Ran out of time before finding a fill.',
  impossible: 'No fill exists with the current letters, blocks and minimum score.',
  invalid: 'The grid has a problem that prevents filling.',
  error: 'The fill engine reported an error.',
};
export function mountFill(container, ctx) {
  const { store, app, session } = ctx;
  const { engine } = app;
  const d = () => store.draft;
  const opts = getFillOptions();
  const saveOpts = () => setPref('fillOptions', opts);
  let fillJob = null;         // running engine job (fill or fit) { promise, cancel }
  let preparing = false;      // a fill / fit is being set up (e.g. waiting for the recent answers)
  let jobLabel = '';          // what the running job is doing, for the progress line
  let alive = true;           // false once the tab is destroyed
  let lastResult = null;      // { ok, message, problemEntry, stats, ms, reason }
  let sideTab = session.sideTab || 'words';
  let candToken = 0;
  let candidates = { entryId: null, list: [], loading: false, error: null, alternatives: false };
  const cand = { filter: '', minScore: 0 };

  // ---- layout ----
  const modeSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Click mode' });
  const modeInputs = MODES.map((m) => {
    const input = h('input', {
      type: 'radio', name: 'grid-mode', value: m.id,
      onchange: () => { editor.setMode(m.id); renderToolbar(); editor.focus(); },
    });
    modeSeg.append(h('label', { class: 'seg-item', title: m.help }, input, h('span', null, m.label)));
    return input;
  });
  const entryInfo = h('div', { class: 'entry-info' });
  const gridArea = h('div', { class: 'grid-area' });
  const statsBar = h('div', { class: 'grid-statusbar' });
  const modeHelp = h('span', { class: 'mode-help muted small' });

  const fillCard = h('section', { class: 'card fill-card' });
  const sideTabs = h('div', { class: 'side-tabs', role: 'tablist' });
  const sidePanel = h('div', { class: 'side-panel' });

  container.append(h('div', { class: 'fill-layout' },
    h('div', { class: 'fill-main' },
      h('div', { class: 'grid-toolbar' }, modeSeg, entryInfo,
        h('button', { class: 'btn sm ghost', type: 'button', onclick: clearGrid, title: 'Clear grid: remove all letters and blocks', 'aria-label': 'Clear grid' },
          icon('trash', { size: 14 }), h('span', { class: 'hide-narrow' }, 'Clear grid…'))),
      gridArea,
      h('div', { class: 'grid-legend' },
        h('span', { class: 'lgd lgd-locked' }, 'A'), h('span', null, 'locked (typed / theme)'),
        h('span', { class: 'lgd lgd-auto' }, 'A'), h('span', null, 'from autofill (can be refilled)'),
        modeHelp),
      statsBar),
    h('aside', { class: 'fill-side' },
      fillCard,
      h('div', { class: 'card side-card' }, sideTabs, sidePanel))));

  // Start on a white square (a fresh layout often has a block in the corner).
  if (d().cells[session.index] === BLOCK) {
    const firstWhite = d().cells.findIndex((c) => c !== BLOCK);
    if (firstWhite >= 0) session.index = firstWhite;
  }
  const editor = new GridEditor(gridArea, {
    store,
    session,
    // The fill card's "Lock word" / "Unlock word" depends on the selected entry, so it re-renders too.
    onSelect: () => { renderToolbar(); renderFillCard(); refreshCandidates(); if (sideTab === 'theme') renderSide(); },
  });

  // ---- toolbar & status bar ----
  function renderToolbar() {
    modeInputs.forEach((i) => { i.checked = i.value === session.mode; });
    modeHelp.textContent = MODES.find((m) => m.id === session.mode)?.help || '';
    const e = editor.currentEntry();
    const cur = d();
    if (!e) {
      entryInfo.replaceChildren(h('span', { class: 'muted' }, cur.cells[session.index] === BLOCK ? 'Block selected' : 'No word here'));
      return;
    }
    const pattern = entryPattern(gridOf(cur), e);
    const clue = e.answer ? cur.clues[e.answer] : '';
    replaceChildren(entryInfo,
      h('strong', null, `${e.num} ${e.dir === 'across' ? 'Across' : 'Down'}`),
      h('span', { class: 'pattern', text: pattern.replace(/\./g, '·') }),
      h('span', { class: 'muted' }, `${e.length} letters`),
      clue ? h('span', { class: 'entry-clue muted', text: `“${clue}”`, title: clue }) : null,
    );
  }

  function renderStats() {
    const cur = d();
    const s = gridStats(cur, app.wordIndex);
    const parts = [
      plural(s.words, 'word'),
      plural(s.blocks, 'block'),
      `avg ${s.avgLength.toFixed(1)} letters`,
      s.avgScore !== null ? `avg score ${Math.round(s.avgScore)}` : null,
      s.empty ? `${s.empty} empty` : 'filled',
    ].filter(Boolean);
    const problems = s.issues.filter((i) => i.severity === 'error').length + s.notInList.length + s.duplicates.length;
    const repeats = recentRepeats(cur, app.recentFor(cur));
    replaceChildren(statsBar,
      h('span', null, parts.join(' · ')),
      h('span', { class: 'status-checks' },
        repeats.length ? h('button', {
          class: 'btn sm link warn recent-link', type: 'button', onclick: () => setSideTab('checks'),
          title: `Answers that puzzles published within ${opts.recentDays} days of this one also use`,
        }, `${repeats.length} used recently`) : null,
        problems ? h('button', { class: 'btn sm link warn', type: 'button', onclick: () => setSideTab('checks') }, icon('alert', { size: 14 }), plural(problems, 'issue')) : h('span', { class: 'ok small' }, icon('check', { size: 14 }), 'No issues')),
    );
    return { ...s, repeats };
  }

  // ---- fill card ----
  function renderFillCard() {
    const cur = d();
    const running = Boolean(fillJob);
    const ready = engine.ready;
    const e = editor.currentEntry();
    const lockedSet = new Set(cur.locked);
    const entryLocked = e && e.cells.every((i) => lockedSet.has(i));
    const hasUnlocked = cur.cells.some((c, i) => isLetter(c) && !lockedSet.has(i));
    const btn = (label, iconName, onclick, { primary = false, disabled = false, title = '' } = {}) => h('button', {
      class: ['btn', primary && 'primary', 'sm'], type: 'button', onclick, disabled, title,
    }, iconName ? icon(iconName, { size: 14 }) : null, label);

    const body = [];
    body.push(h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, 'Fill'),
      !ready ? h('span', { class: ['pill', engine.status === 'unavailable' ? 'error' : 'info'] }, engine.status === 'unavailable' ? 'Engine unavailable' : 'Engine loading…') : null));
    if (running) {
      body.push(h('div', { class: 'fill-running' }, btn('Stop', 'stop', () => fillJob?.cancel(), { primary: true }),
        h('span', { class: 'progress-text muted small', id: 'fill-progress', role: 'status' }, `${jobLabel || 'Filling'}…`)),
      h('div', { class: 'progress', title: 'Time used of the time limit' }, h('div', { class: 'progress-bar', id: 'fill-bar' })));
    } else {
      body.push(h('div', { class: 'fill-main-btns' },
        btn('Autofill', 'wand', () => runFill(false), { primary: true, disabled: !ready, title: 'Fill the empty squares (keeps every letter already there)' }),
        btn('Refill', 'refresh', () => runFill(true), { disabled: !ready || !hasUnlocked, title: 'Replace all unlocked letters with a fresh fill' })));
      // Secondary actions as compact links.
      const link = (label, onclick, disabled, title) => h('button', { class: 'btn link sm', type: 'button', onclick, disabled, title }, label);
      body.push(h('div', { class: 'fill-links' },
        link('Clear unlocked', () => store.update((x) => clearUnlocked(x), { kind: 'grid', label: 'clear unlocked' }),
          !hasUnlocked, 'Remove letters that are not locked'),
        link(entryLocked ? 'Unlock word' : 'Lock word', () => {
          const target = editor.currentEntry(); // the selection at click time, not at render time
          if (!target) return;
          const lock = !target.cells.every((i) => new Set(d().locked).has(i));
          store.update((x) => setLocked(x, target.cells, lock), { kind: 'grid', label: lock ? 'lock word' : 'unlock word' });
        }, !e || !e.cells.some((i) => isLetter(cur.cells[i])), 'Locked letters are kept by Refill and Clear unlocked'),
        link('Ban word', () => banSelectedWord(), !e || !banTarget(cur, e),
          'Never use this word again: bans it, clears its unlocked squares and fills just that gap'),
        link('Lock all', () => store.update((x) => lockAll(x), { kind: 'grid', label: 'lock all' }), !hasUnlocked, 'Lock every letter in the grid'),
        link('Unlock all', () => store.update((x) => { x.locked = []; }, { kind: 'grid', label: 'unlock all' }), !cur.locked.length, 'Let Refill replace every letter')));
    }
    if (!running && !ready) {
      body.push(h('p', { class: 'note info small' }, engine.status === 'unavailable'
        ? `${engine.message} You can still build the grid by hand.`
        : 'The fill engine is starting. You can edit the grid meanwhile.'));
    }
    if (lastResult && !running) body.push(resultBox(lastResult));
    body.push(optionsBox());
    fillCard.replaceChildren(...body);
  }

  function optionsBox() {
    const minScore = h('input', {
      type: 'number', min: 0, max: 100, step: 5, value: opts.minScore, class: 'num',
      onchange: () => { opts.minScore = clamp(Number(minScore.value), 0, 100); saveOpts(); loadCandidates(); },
    });
    const randomness = h('input', {
      type: 'range', min: 0, max: 1, step: 0.05, value: opts.randomness,
      oninput: () => { opts.randomness = Number(randomness.value); saveOpts(); },
    });
    const time = h('select', { onchange: () => { opts.timeLimitSec = Number(time.value); saveOpts(); } },
      [5, 10, 20, 60, 120].map((s) => h('option', { value: s, selected: s === opts.timeLimitSec }, `${s} s`)));
    const avoidRecent = h('input', {
      type: 'checkbox', checked: opts.avoidRecent, id: 'fo-recent',
      onchange: () => { opts.avoidRecent = avoidRecent.checked; saveOpts(); },
    });
    const windows = RECENT_WINDOWS.includes(opts.recentDays) ? RECENT_WINDOWS : [...RECENT_WINDOWS, opts.recentDays].sort((a, b) => a - b);
    const recentDays = h('select', {
      'aria-label': 'Recent means within', title: 'Puzzles dated this many days before or after this one count as recent',
      onchange: () => { opts.recentDays = Number(recentDays.value); saveOpts(); renderSide(); },
    }, windows.map((n) => h('option', { value: n, selected: n === opts.recentDays }, `± ${n} days`)));
    const det = h('details', { class: 'fill-options', open: Boolean(session.fillOptionsOpen) },
      h('summary', null, 'Fill options'),
      h('div', { class: 'opt-grid' },
        h('label', { class: 'opt' }, h('span', null, 'Min word score', h('small', { class: 'muted' }, ' 0–100; higher = cleaner fill')), minScore),
        h('label', { class: 'opt' }, h('span', null, 'Variety', h('small', { class: 'muted' }, ' predictable ↔ varied')), randomness),
        h('label', { class: 'opt' }, h('span', null, 'Time limit'), time),
        h('div', { class: 'opt-recent' },
          h('div', { class: 'opt' },
            h('label', { class: 'opt-check', for: 'fo-recent' }, avoidRecent, h('span', null, 'Avoid repeating recent answers')),
            recentDays),
          h('small', { class: 'muted opt-note' }, 'Answers of puzzles dated that close to this one. Your theme words are never avoided.'))));
    det.addEventListener('toggle', () => { session.fillOptionsOpen = det.open; });
    return det;
  }

  function resultBox(r) {
    if (r.ok) {
      return h('p', { class: 'note ok small' }, icon('check', { size: 14 }),
        `Filled in ${r.ms < 1000 ? `${Math.max(1, Math.round(r.ms))} ms` : `${(r.ms / 1000).toFixed(1)} s`}`
        + (Number.isFinite(r.stats?.avgScore) ? ` · avg score ${Math.round(r.stats.avgScore)}` : '')
        + (Number.isFinite(r.stats?.minWordScore) ? ` · lowest ${r.stats.minWordScore}` : '')
        + (r.minScore !== undefined && r.minScore !== opts.minScore ? ` · min score ${r.minScore} for this fill only` : '')
        + (r.themeAdded?.length ? ` · theme words used: ${r.themeAdded.join(', ')}` : '')
        + (r.same ? ' · same as before: this grid has few good fills. Raise “Variety”, lower the min score or unlock more letters for a different one.' : ''));
    }
    if (r.reason === 'aborted') return h('p', { class: 'note info small' }, 'Stopped — the grid was not changed.');
    const cur = d();
    const { all } = analyze(cur);
    const problem = r.problemEntryId ? all.find((e) => e.id === r.problemEntryId) : null;
    const lockedSet = new Set(cur.locked);
    const tips = [];
    // Retries change the setting for that one run only: the saved Fill options (used by every draft and by layout
    // generation) stay as the user set them.
    const usedMin = r.minScore ?? opts.minScore;
    const usedSec = r.timeLimitSec ?? opts.timeLimitSec;
    if (r.reason !== 'invalid' && r.reason !== 'error') {
      // A lower minimum only helps if some word fits the stuck pattern at a lower score.
      if (usedMin > 0 && !r.noWordAtAll) {
        const lower = Math.max(0, usedMin - 10);
        tips.push(h('button', {
          class: 'btn sm', type: 'button', title: `Your Fill options keep min score ${opts.minScore}`,
          onclick: () => runFill(Boolean(r.refill), { minScore: lower, timeLimitSec: usedSec, confirmed: true }),
        }, `Retry once with min score ${lower}`));
      }
      if (r.reason === 'timeout') {
        const more = Math.min(120, usedSec * 2);
        if (more > usedSec) {
          tips.push(h('button', {
            class: 'btn sm', type: 'button', title: `Your Fill options keep ${opts.timeLimitSec} s`,
            onclick: () => runFill(Boolean(r.refill), { minScore: usedMin, timeLimitSec: more, confirmed: true }),
          }, `Retry once with ${more} s`));
        }
      }
    }
    if (problem && problem.cells.some((i) => lockedSet.has(i))) {
      tips.push(h('button', {
        class: 'btn sm', type: 'button',
        onclick: () => store.update((x) => setLocked(x, problem.cells, false), { kind: 'grid', label: `unlock ${problem.id}` }),
      }, icon('unlock', { size: 14 }), `Unlock ${problem.id}`));
    }
    if (r.reason !== 'error' && cur.cells.some((c, i) => isLetter(c) && !lockedSet.has(i))) {
      tips.push(h('button', { class: 'btn sm', type: 'button', onclick: () => runFill(true) }, 'Refill from scratch'));
    }
    if (r.reason !== 'error') {
      tips.push(h('button', {
        class: 'btn sm', type: 'button',
        onclick: () => { editor.setMode('blocks'); renderToolbar(); toast('Blocks mode: click a square to add a block (and its partner).'); editor.focus(); },
      }, 'Add blocks'));
    }
    return h('div', { class: ['note', 'warn', 'fill-fail'] },
      h('div', null, h('strong', null, 'Couldn’t fill the grid. '), REASONS[r.reason] || ''),
      problem ? h('div', { class: 'small' }, 'Stuck at ',
        h('button', { class: 'btn sm link inline', type: 'button', onclick: () => editor.selectEntry(problem, { focus: true }) },
          `${problem.num} ${problem.dir === 'across' ? 'Across' : 'Down'}`),
        r.problemPattern ? h('span', { class: 'pattern', text: ` ${r.problemPattern.replace(/\./g, '·')}` }) : null,
        r.explain ? h('span', null, ` — ${r.explain}`) : null)
        : (r.message ? h('div', { class: 'small', text: r.message }) : null),
      tips.length ? h('div', { class: 'btn-row' }, tips) : null);
  }

  /**
   * One-line explanation of why a fill got stuck at an entry, phrased for the builder (the engine's own message is
   * used for structural problems).
   */
  function explainProblem(reason, pattern, engineMessage, usedMinScore = opts.minScore) {
    if (reason === 'invalid' || reason === 'error' || !pattern) return { text: engineMessage || '', noWordAtAll: false };
    const cur = d();
    const re = new RegExp(`^${pattern}$`);
    const themeFits = cur.theme.some((t) => re.test(t.answer));
    const count = (minScore) => (app.wordIndex?.size ? app.wordIndex.match(pattern, { limit: 1, minScore }).length : 1);
    const minScore = Math.max(1, usedMinScore);
    if (!themeFits && !count(minScore)) {
      const noWordAtAll = minScore === 1 || !count(1);
      return {
        text: `no word in the list fits this pattern${minScore > 1 && !noWordAtAll ? ` with score ≥ ${minScore}` : ''}`,
        noWordAtAll,
      };
    }
    return {
      text: reason === 'timeout'
        ? 'the hardest spot to fill (no fill found in time)'
        : 'no word that fits here works with all of its crossing words',
      noWordAtAll: false,
    };
  }

  /**
   * Autofill (refill = false) or Refill (true). `minScore` / `timeLimitSec` override the Fill options for this run
   * only (the "Retry once with …" buttons). Refill asks first when it would replace words that have clues, unless
   * `confirmed`.
   */
  async function runFill(refill, { minScore = opts.minScore, timeLimitSec = opts.timeLimitSec, confirmed = false } = {}) {
    if (fillJob || preparing || !engine.ready) return;
    const cur = d();
    if (refill && !confirmed) {
      const clued = cluedWordsRefillWouldReplace(cur);
      if (clued.length) {
        const n = clued.length;
        const ok = await confirmDialog({
          title: `Replace ${n === 1 ? 'a word that has a clue' : `${n} words that have clues`}?`,
          message: [
            `Refill replaces every unlocked letter, including ${n === 1 ? 'a word' : `${n} words`} you already clued (${clued.slice(0, 8).join(', ')}${n > 8 ? ', …' : ''}).`,
            'Their clues stay saved with those words (they come back if the word does), and Ctrl+Z undoes the refill. To keep a word, select it and press “Lock word” first.',
          ],
          confirmLabel: 'Refill anyway',
        });
        if (!ok || fillJob || !alive || d() !== cur) return;
      }
    }
    const fresh = await prepareFreshness(cur);
    if (!fresh.ok) return;
    const startCells = cur.cells.slice();
    const before = cur.cells.join('|'); // to detect edits (e.g. undo) made while the engine works
    if (refill) {
      const locked = new Set(cur.locked);
      startCells.forEach((c, i) => { if (isLetter(c) && !locked.has(i)) startCells[i] = ''; });
    }
    if (!startCells.includes('')) {
      toast('There are no empty squares to fill. Use Refill to replace unlocked letters.');
      return;
    }
    const { all } = analyze({ ...cur, cells: startCells });
    const inGrid = new Set(all.map((e) => e.answer).filter(Boolean));
    const prefer = cur.theme.map((t) => t.answer).filter((a) => !inGrid.has(a));
    const options = {
      minScore,
      timeLimitMs: timeLimitSec * 1000,
      randomness: opts.randomness,
      seed: Math.floor(Math.random() * 2 ** 31),
      prefer,
      avoid: [],
      allowDuplicates: false,
      ...fresh.option,
    };
    const started = performance.now();
    let lastStats = null;
    try {
      fillJob = engine.fill({ width: cur.width, height: cur.height, cells: startCells }, options, (stats) => { lastStats = stats; });
    } catch (err) {
      toastError(err);
      return;
    }
    editor.readOnly = true;
    lastResult = null;
    editor.setMarks({});
    renderFillCard();
    const timer = setInterval(() => {
      const el = performance.now() - started;
      const bar = fillCard.querySelector('#fill-bar');
      const text = fillCard.querySelector('#fill-progress');
      if (bar) bar.style.width = `${Math.min(100, (el / options.timeLimitMs) * 100)}%`;
      if (text) {
        // `best` = most words placed at once so far (engine progress stats); a good sense of how close it is.
        text.textContent = `Filling… ${(el / 1000).toFixed(1)} s of ${timeLimitSec} s`
          + (Number.isFinite(lastStats?.best) && lastStats.total ? ` · best ${lastStats.best}/${lastStats.total} words` : '');
      }
    }, 150);
    let result;
    try {
      result = await fillJob.promise;
    } catch (err) {
      result = { ok: false, reason: /abort|cancel/i.test(String(err?.message)) ? 'aborted' : 'error', message: String(err?.message || err) };
    } finally {
      clearInterval(timer);
      fillJob = null;
      editor.readOnly = false;
    }
    const ms = performance.now() - started;
    if (!alive || d() !== cur) return; // tab closed or another draft opened meanwhile
    if (result?.ok && cur.cells.join('|') !== before) {
      toast('The grid changed while filling, so the fill was not applied. Try again.', { type: 'warn' });
      renderFillCard();
      return;
    }
    if (result?.ok && Array.isArray(result.cells) && result.cells.length === startCells.length) {
      // Only ever take letters for squares we asked to fill.
      const merged = startCells.map((c, i) => (c === '' && isLetter(result.cells[i]) ? result.cells[i] : c));
      const locked = new Set(cur.locked);
      // Theme words the fill used (they were preferred) are locked like placed theme answers.
      const themeSet = new Set(prefer);
      const themeEntries = analyze({ ...cur, cells: merged }).all.filter((e) => e.answer && themeSet.has(e.answer));
      store.update((x) => {
        x.cells = merged;
        x.locked = x.locked.filter((i) => isLetter(merged[i]) && locked.has(i));
        for (const e of themeEntries) setLocked(x, e.cells, true);
      }, { kind: 'grid', label: refill ? 'refill' : 'autofill' });
      const themeAdded = [...new Set(themeEntries.map((e) => e.answer))];
      const same = refill && merged.join('|') === before; // a tight grid can have a single good fill
      lastResult = { ok: true, ms: result.stats?.ms ?? ms, stats: result.stats || {}, themeAdded, same, minScore, timeLimitSec, refill };
      editor.setMarks({});
    } else {
      const p = result?.problem || null;
      const reason = result?.reason || 'error';
      lastResult = {
        ok: false, reason, message: p?.message || result?.message || '',
        problemEntryId: p?.entryId || null, problemPattern: p?.pattern || '', minScore, timeLimitSec, refill,
      };
      if (reason !== 'aborted') {
        const why = explainProblem(reason, p?.pattern || '', p?.message || '', minScore);
        lastResult.explain = why.text;
        lastResult.noWordAtAll = why.noWordAtAll;
      }
      if (reason === 'aborted') {
        editor.setMarks({});
      } else {
        const problem = p?.entryId ? analyze({ ...cur, cells: startCells }).all.find((e) => e.id === p.entryId) : null;
        editor.setMarks({ problem: problem ? problem.cells : (p?.cells || []) });
        if (problem) editor.selectEntry(problem);
      }
    }
    renderFillCard();
    renderToolbar();
  }

  /**
   * "Fit theme words": ask the engine to put the theme answers that are not in the grid yet into slots of the right
   * length, keeping blocks and locked letters and refilling everything else (engine/theme-fit.js).
   */
  async function runFitTheme() {
    if (fillJob || preparing || !engine.ready) return;
    const cur = d();
    const fresh = await prepareFreshness(cur);
    if (!fresh.ok) return;
    const before = cur.cells.join('|');
    const locked = new Set(cur.locked);
    const words = themeStatus().filter((t) => !t.placed && t.answer.length <= Math.max(cur.width, cur.height)).map((t) => t.answer);
    if (!words.length) return;
    const base = cur.cells.map((c, i) => (isLetter(c) && !locked.has(i) ? '' : c));
    const timeLimitMs = opts.timeLimitSec * 1000;
    const area = cur.width * cur.height;
    let job;
    try {
      job = engine.fitWords({ width: cur.width, height: cur.height, cells: base }, {
        words,
        filled: cur.cells.includes('') ? null : cur.cells.slice(),
        minScore: opts.minScore,
        timeLimitMs,
        tryMs: area <= 49 ? 300 : area <= 121 ? 600 : 1500,
        seed: Math.floor(Math.random() * 2 ** 31),
        ...fresh.option,
      });
    } catch (err) {
      toastError(err);
      return;
    }
    fillJob = job;
    jobLabel = 'Fitting theme words';
    editor.readOnly = true;
    lastResult = null;
    editor.setMarks({});
    renderFillCard();
    renderSide();
    const started = performance.now();
    const timer = setInterval(() => {
      const el = performance.now() - started;
      const bar = fillCard.querySelector('#fill-bar');
      const text = fillCard.querySelector('#fill-progress');
      if (bar) bar.style.width = `${Math.min(100, (el / timeLimitMs) * 100)}%`;
      if (text) text.textContent = `Fitting theme words… ${(el / 1000).toFixed(1)} s of ${opts.timeLimitSec} s`;
    }, 150);
    let result = null;
    let error = null;
    try {
      result = await job.promise;
    } catch (err) {
      error = err;
    } finally {
      clearInterval(timer);
      fillJob = null;
      jobLabel = '';
      editor.readOnly = false;
    }
    if (!alive || d() !== cur) return;
    renderFillCard();
    renderSide();
    if (error) {
      toastError(error, 'Could not fit theme words: ');
      return;
    }
    if (cur.cells.join('|') !== before) {
      toast('The grid changed meanwhile, so nothing was applied. Try again.', { type: 'warn' });
      return;
    }
    const added = result?.added || [];
    if (!added.length || !Array.isArray(result.filled)) {
      toast(result?.aborted
        ? 'Stopped — the grid was not changed.'
        : 'None of the remaining theme words fit. Every word crossing them must be a real word from the list (it never '
          + 'makes up crossings), and blocks and locked letters stay where they are. Unlock some letters, add or move '
          + 'blocks, or lower the min score, then try again.',
      { type: result?.aborted ? 'info' : 'warn', timeout: 10000 });
      return;
    }
    const filled = result.filled;
    const clues = themeClues(cur);
    store.update((x) => {
      // Only squares that were empty or unlocked may change.
      x.cells = x.cells.map((c, i) => (c === '' || (isLetter(c) && !locked.has(i)) ? (filled[i] || c) : c));
      x.locked = x.locked.filter((i) => isLetter(x.cells[i]));
      for (const a of added) {
        setLocked(x, a.cells, true);
        const clue = clues.get(a.answer);
        if (clue && !(x.clues[a.answer] && x.clueSources?.[a.answer] === 'user')) {
          x.clues[a.answer] = clue;
          x.clueSources = { ...(x.clueSources || {}), [a.answer]: 'theme' };
        }
      }
    }, { kind: 'grid', label: 'fit theme words' });
    const names = added.map((a) => a.answer).join(', ');
    toast(`Added ${names}. The other unlocked letters were refilled around ${added.length === 1 ? 'it' : 'them'}.`, {
      type: 'success', timeout: 7000,
    });
  }

  /**
   * Recently published answers for the engine to avoid (when that Fill option is on; usually cached already).
   * `ok` is false when the job should not start after all (another one started, the tab closed or the draft changed
   * while waiting); `option` is `{ penalize }` or {}.
   */
  async function prepareFreshness(cur) {
    preparing = true;
    let penalize = null;
    try {
      penalize = await app.freshnessPenalties(cur);
    } finally {
      preparing = false;
    }
    return { ok: !fillJob && alive && d() === cur && engine.ready, option: penalize ? { penalize } : {} };
  }

  async function clearGrid() {
    const ok = await confirmDialog({
      title: 'Clear the grid?',
      message: 'All letters, blocks, circles and shading will be removed. Clues are kept. You can undo this.',
      confirmLabel: 'Clear grid',
      danger: true,
    });
    if (!ok) return;
    store.update((x) => {
      x.cells = x.cells.map(() => '');
      x.locked = [];
      x.circles = [];
      x.shaded = [];
    }, { kind: 'grid', label: 'clear grid' });
  }

  // ---- side tabs ----
  function setSideTab(id) {
    sideTab = id;
    session.sideTab = id;
    renderSide();
  }

  function renderSideTabs(stats) {
    const issueCount = stats.issues.filter((i) => i.severity === 'error').length + stats.notInList.length + stats.duplicates.length;
    const unplaced = themeStatus().filter((t) => !t.placed).length;
    const tabs = [
      { id: 'words', label: 'Words' },
      { id: 'theme', label: 'Theme', badge: unplaced || '' },
      { id: 'checks', label: 'Checks', badge: issueCount || '', warn: issueCount > 0 },
    ];
    sideTabs.replaceChildren(...tabs.map((t) => h('button', {
      class: ['side-tab', sideTab === t.id && 'active'], type: 'button', role: 'tab', 'aria-selected': String(sideTab === t.id),
      onclick: () => setSideTab(t.id),
    }, t.label, t.badge ? h('span', { class: ['count', t.warn && 'warn'] }, String(t.badge)) : null)));
  }

  function renderSide() {
    const stats = renderStats();
    renderSideTabs(stats);
    if (sideTab === 'theme') renderThemePanel();
    else if (sideTab === 'checks') renderChecksPanel(stats);
    else renderCandidatesPanel();
  }

  // ---- candidates ----
  const refreshCandidates = debounce(() => loadCandidates(), 120);

  async function loadCandidates() {
    const e = editor.currentEntry();
    const token = ++candToken;
    if (!e) {
      candidates = { entryId: null, list: [], loading: false, error: null };
      if (sideTab === 'words') renderCandidatesPanel();
      return;
    }
    const cur = d();
    const locked = new Set(cur.locked);
    const complete = e.cells.every((i) => isLetter(cur.cells[i]));
    const allLocked = e.cells.every((i) => locked.has(i));
    candidates = { ...candidates, entryId: e.id, loading: true, error: null, complete, allLocked };
    if (sideTab === 'words') renderCandidatesPanel();
    if (!engine.ready) {
      candidates.loading = false;
      if (sideTab === 'words') renderCandidatesPanel();
      return;
    }
    // For a finished word, look for alternatives given only the LOCKED letters: the workflow is "pick a better
    // word here (it gets locked), then Refill", so crossings are judged on what a refill could still do.
    const cells = cur.cells.slice();
    let alternatives = false;
    if (complete && !allLocked) {
      cells.forEach((c, i) => { if (isLetter(c) && !locked.has(i)) cells[i] = ''; });
      alternatives = true;
    }
    try {
      const filter = cand.filter.toUpperCase().replace(/[^A-Z]/g, '');
      const grid = { width: cur.width, height: cur.height, cells };
      // Viability must count crossing words the way a fill would: at the Fill options' min score. The panel's own
      // "min" only decides which words are listed (a crossing that only junk below the fill's min score could
      // complete is a dead end for Autofill / Refill).
      const fillMin = opts.minScore;
      const [listed, atFillMin] = await Promise.all([
        engine.candidates(grid, e.id, { minScore: cand.minScore, limit: 200, filter }),
        cand.minScore === fillMin ? null : engine.candidates(grid, e.id, { minScore: fillMin, limit: Infinity, filter }),
      ]);
      if (token !== candToken) return;
      let list = Array.isArray(listed) ? listed : [];
      if (Array.isArray(atFillMin)) list = withFillViability(list, atFillMin);
      if (filter) list = list.filter((c) => c.word.includes(filter));
      candidates = { entryId: e.id, list, loading: false, error: null, complete, allLocked, alternatives, current: complete ? entryPattern(gridOf(cur), e) : null };
    } catch (err) {
      if (token !== candToken) return;
      candidates = { entryId: e.id, list: [], loading: false, error: err.message || String(err), complete, allLocked };
    }
    if (sideTab === 'words') renderCandidatesPanel();
  }

  /**
   * Replace each listed word's viability by the one computed at the fill's min score. Words below that score are
   * not in `atFillMin`; theirs stays as listed (marked `approx`). Re-sorted like the engine: dead ends last.
   */
  function withFillViability(list, atFillMin) {
    const v = new Map(atFillMin.map((c) => [c.word, c.viability]));
    return list
      .map((c) => (v.has(c.word) ? { ...c, viability: v.get(c.word) } : { ...c, approx: true }))
      .sort((a, b) => (a.viability === 0) - (b.viability === 0) || b.score - a.score
        || (b.viability ?? 0) - (a.viability ?? 0) || (a.word < b.word ? -1 : 1));
  }

  function renderCandidatesPanel() {
    editor.clearHover(); // the hovered row (if any) is about to be replaced
    const e = editor.currentEntry();
    const cur = d();
    const nodes = [];
    if (!e) {
      nodes.push(emptyHint('Select a word', 'Click a square in the grid to see words that fit there.'));
      sidePanel.replaceChildren(...nodes);
      return;
    }
    const filter = h('input', {
      type: 'search', placeholder: 'Contains…', value: cand.filter, class: 'grow', 'aria-label': 'Filter candidates (letters the word must contain)',
      oninput: debounce(() => { cand.filter = filter.value; loadCandidates(); }, 200),
    });
    const minScore = h('input', {
      type: 'number', min: 0, max: 100, step: 5, value: cand.minScore, class: 'num', title: 'Minimum word score', 'aria-label': 'Minimum word score',
      onchange: () => { cand.minScore = clamp(Number(minScore.value), 0, 100); loadCandidates(); },
    });
    nodes.push(h('div', { class: 'cand-head' },
      h('div', null, h('strong', null, `${e.num} ${e.dir === 'across' ? 'Across' : 'Down'} `),
        h('span', { class: 'pattern', text: entryPattern(gridOf(cur), e).replace(/\./g, '·') })),
      h('div', { class: 'row gap-sm' }, filter, h('label', { class: 'row gap-xs small muted' }, 'min', minScore))));

    if (!engine.ready) {
      nodes.push(h('p', { class: 'note info small' }, engine.status === 'unavailable'
        ? 'Word suggestions need the fill engine, which is not available. You can still type words yourself.'
        : 'Word suggestions appear when the fill engine has loaded…'));
    } else if (candidates.entryId === e.id && candidates.allLocked && candidates.complete) {
      nodes.push(h('div', { class: 'note info small' }, h('span', null, 'This word is locked. ',
        h('button', {
          class: 'btn sm link inline', type: 'button',
          onclick: () => store.update((x) => setLocked(x, e.cells, false), { kind: 'grid', label: 'unlock word' }),
        }, 'Unlock it'), ' to see alternatives.')));
    } else if (candidates.loading && candidates.entryId === e.id && !candidates.list.length) {
      nodes.push(h('p', { class: 'muted small' }, h('span', { class: 'spinner' }), ' Finding words…'));
    } else if (candidates.error) {
      nodes.push(h('p', { class: 'note warn small' }, candidates.error));
    } else if (candidates.entryId === e.id) {
      if (candidates.alternatives) {
        nodes.push(h('p', { class: 'muted small' }, 'Alternatives that fit the locked letters. After placing one, press Refill to redo the crossing words.'));
      }
      if (!candidates.list.length) {
        nodes.push(emptyHint('No words fit', `Nothing in the word list matches${cand.minScore ? ` with score ≥ ${cand.minScore}` : ''}. Change a crossing letter, add a block, or add your own word in the Word list.`));
      } else {
        nodes.push(candidateList(e));
      }
    }
    sidePanel.replaceChildren(...nodes);
  }

  function candidateList(e) {
    const listEl = h('ul', { class: 'cand-list', role: 'listbox', 'aria-label': `Words for ${e.id}` });
    const cur = d();
    const recent = app.recentFor(cur);
    const date = app.freshnessDate(cur);
    for (const c of candidates.list) {
      const v = c.viability;
      const dead = v === 0;
      const width = v === null || v === undefined ? 0 : Math.min(100, Math.round((Math.log10(v + 1) / 3) * 100));
      const isCurrent = candidates.current === c.word;
      const used = recent?.get(c.word) || null;
      const usedText = used ? `${usedSentence(used, date)}${opts.avoidRecent ? ' (autofill avoids it)' : ''}.` : '';
      const li = h('li', { class: ['cand', dead && 'dead', isCurrent && 'current', used && 'recent'], role: 'option' },
        h('button', {
          class: 'cand-main', type: 'button',
          title: [dead ? `Dead end: a crossing word would have no options with score ≥ ${opts.minScore}` : `Place ${c.word}`, usedText].filter(Boolean).join('\n'),
          onmouseenter: () => editor.setPreview(e, c.word),
          onmouseleave: () => editor.setPreview(null),
          onfocus: () => editor.setPreview(e, c.word),
          onblur: () => editor.setPreview(null),
          onclick: () => {
            const replacing = candidates.alternatives;
            editor.setPreview(null);
            store.update((x) => placeWord(x, e, c.word, { lock: true }), { kind: 'grid', label: `place ${c.word}` });
            editor.focus();
            if (replacing && engine.ready) {
              const placedIn = d();
              toast(`${c.word} placed and locked. Refill to redo the crossing words.`, {
                action: { label: 'Refill now', onClick: () => { if (alive && d() === placedIn) runFill(true); } },
              });
            }
          },
        },
        h('span', { class: 'cand-wordcell' },
          h('span', { class: 'cand-word', text: c.word }),
          used ? h('span', { class: 'cand-recent', text: usedLabel(used, date) }) : null),
        h('span', { class: 'cand-score', text: String(c.score) }),
        h('span', {
          class: 'via',
          title: v === null || v === undefined ? 'No crossings'
            : `${v} option(s) for the tightest crossing${c.approx ? ` (counting words below the fill’s min score ${opts.minScore})` : ` (score ≥ ${opts.minScore}, like a fill)`}`,
        },
          h('span', { class: ['via-bar', dead ? 'bad' : v !== null && v !== undefined && v < 5 ? 'low' : 'good'], style: { width: `${dead ? 100 : width}%` } }))),
        h('button', {
          class: 'icon-btn sm cand-ban', type: 'button', title: `Never use ${c.word}`, 'aria-label': `Ban ${c.word}`,
          onclick: () => banWord(c.word),
        }, icon('ban', { size: 14 })));
      listEl.append(li);
    }
    return listEl;
  }

  /** The selected entry's word if it is complete and not a theme answer (theme words are removed on Theme & Layout). */
  function banTarget(cur, entry) {
    if (!entry || !entry.cells.every((i) => isLetter(cur.cells[i]))) return null;
    const word = entry.cells.map((i) => cur.cells[i]).join('');
    return cur.theme.some((t) => t.answer === word) ? null : word;
  }

  /** "Ban word" on the fill card: ban the selected word, clear its unlocked squares and autofill only that gap. */
  async function banSelectedWord() {
    const target = editor.currentEntry(); // the selection at click time, not at render time
    const word = banTarget(d(), target);
    if (!word || !(await banWord(word))) return;
    const locked = new Set(d().locked);
    if (target.cells.every((i) => locked.has(i))) return; // fully locked: banned for future fills, left in place
    store.update((x) => { for (const i of target.cells) if (!locked.has(i)) x.cells[i] = ''; }, { kind: 'grid', label: `ban ${word}` });
    if (engine.ready && !fillJob) runFill(false);
  }

  async function banWord(word) {
    try {
      await applyUserWordOps(app, { ban: [word] });
      toast(`${word} banned — it won’t be used in fills.`, {
        action: {
          label: 'Undo',
          onClick: () => applyUserWordOps(app, { unban: [word] }).then(() => loadCandidates(), (err) => toastError(err)),
        },
      });
      loadCandidates();
      return true;
    } catch (err) {
      toastError(err, 'Could not ban the word: ');
      return false;
    }
  }

  // ---- theme palette ----
  function themeStatus() {
    const cur = d();
    const { all } = analyze(cur);
    return cur.theme.map((t) => {
      const at = all.filter((e) => e.answer === t.answer);
      return { ...t, placed: at.length > 0, at, slots: at.length ? [] : slotsForWord(cur, t.answer, all) };
    });
  }

  function renderThemePanel() {
    editor.clearHover();
    const list = themeStatus();
    if (!list.length) {
      sidePanel.replaceChildren(emptyHint('No theme words', 'Add theme words on the Theme & Layout step, then place them here or generate a layout.'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => ctx.goTab('theme') }, 'Go to Theme & Layout'));
      return;
    }
    const clues = themeClues(d());
    const ul = h('ul', { class: 'theme-list' });
    for (const t of list) {
      const li = h('li', { class: ['theme-item', t.placed && 'placed'] },
        h('div', { class: 'ti-head' },
          h('span', { class: 'answer', text: t.answer }),
          h('span', { class: 'muted small' }, String(t.answer.length)),
          t.placed
            ? h('button', { class: 'pill ok', type: 'button', onclick: () => editor.selectEntry(t.at[0], { focus: true }) }, icon('check', { size: 11 }), t.at.map((e) => e.id).join(', '))
            : h('span', { class: 'pill warn' }, 'Not placed')),
        !t.placed ? slotButtons(t, clues.get(t.answer)) : null);
      ul.append(li);
    }
    const cur = d();
    const fittable = list.filter((t) => !t.placed && t.answer.length <= Math.max(cur.width, cur.height)).length;
    const fitBox = fittable ? h('div', { class: 'fit-box' },
      h('button', {
        class: 'btn sm primary', type: 'button', disabled: !engine.ready || Boolean(fillJob), onclick: runFitTheme,
        title: 'Keeps blocks and locked letters; refills the other squares around the theme words it places',
      }, icon('wand', { size: 14 }), `Fit ${fittable === 1 ? 'it' : 'them'} in for me`),
      h('span', { class: 'muted small' }, 'Tries every slot of the right length and refills around it; crossing words must stay real words.')) : null;
    sidePanel.replaceChildren(...[fitBox, h('p', { class: 'muted small' }, `${fitBox ? 'Or h' : 'H'}over a slot to preview, click to place (locked).`), ul].filter(Boolean));
  }

  function slotButtons(t, clue) {
    const cur = d();
    if (t.answer.length > Math.max(cur.width, cur.height)) {
      return h('p', { class: 'small muted' }, `Too long for a ${cur.width}×${cur.height} grid.`);
    }
    if (!t.slots.length) {
      return h('p', { class: 'small muted' }, `No ${t.answer.length}-letter slot fits. Change blocks (Blocks mode) or unlock letters.`);
    }
    return h('div', { class: 'slot-row' }, t.slots.slice(0, 12).map(({ entry, replaced }) => h('button', {
      class: 'slot-btn', type: 'button',
      title: replaced ? `Replaces ${replaced} unlocked letter(s)` : 'Fits exactly',
      onmouseenter: () => { editor.setMark('hint', entry.cells); editor.setPreview(entry, t.answer); },
      onmouseleave: () => editor.clearHover(),
      onclick: () => {
        editor.clearHover();
        store.update((x) => {
          placeWord(x, entry, t.answer, { lock: true });
          if (clue && !(x.clues[t.answer] && x.clueSources?.[t.answer] === 'user')) {
            x.clues[t.answer] = clue;
            x.clueSources = { ...(x.clueSources || {}), [t.answer]: 'theme' };
          }
        }, { kind: 'grid', label: `place ${t.answer}` });
        editor.selectEntry(entry);
      },
    }, entry.id, replaced ? h('small', null, ` −${replaced}`) : null)));
  }

  // ---- checks ----
  function renderChecksPanel(s) {
    editor.clearHover();
    const nodes = [];
    nodes.push(h('dl', { class: 'stat-grid' },
      stat('Words', s.words), stat('Blocks', s.blocks), stat('Avg length', s.avgLength.toFixed(1)),
      stat('Avg score', s.avgScore === null ? '—' : Math.round(s.avgScore)), stat('Empty', s.empty)));
    const items = [];
    for (const issue of s.issues) {
      items.push(issueItem(issue.severity, issue.message, issue.cells));
    }
    for (const e of s.notInList) {
      items.push(issueItem('warning', `${e.answer} (${e.id}) is not in the word list`, e.cells, e));
    }
    for (const list of s.duplicates) {
      items.push(issueItem('warning', `${list[0].answer} is used ${list.length} times (${list.map((e) => e.id).join(', ')})`, list.flatMap((e) => e.cells), list[1]));
    }
    nodes.push(h('h3', { class: 'panel-title' }, 'Problems'));
    nodes.push(items.length ? h('ul', { class: 'issue-list' }, items) : h('p', { class: 'note ok small' }, icon('check', { size: 14 }), 'No problems found.'));
    if (s.repeats.length) {
      // Not errors: a short, common answer repeating now and then is normal. Shown so it is a choice.
      const date = app.freshnessDate(d());
      const showAlternatives = (entry) => { setSideTab('words'); editor.selectEntry(entry, { focus: true }); };
      nodes.push(h('h3', { class: 'panel-title' }, `Used recently (± ${opts.recentDays} days)`));
      nodes.push(h('ul', { class: 'issue-list recent-list' }, s.repeats.map((r) => issueItem('warning',
        `${r.answer} (${r.entries.map((e) => e.id).join(', ')}${r.theme ? ', theme' : ''}) — ${usedSentence(r.dates, date).replace(/^Used/, 'used')}`,
        r.entries.flatMap((e) => e.cells), r.entries[0], showAlternatives))));
      nodes.push(h('p', { class: 'muted small' }, `${opts.avoidRecent ? 'Autofill avoids recent answers when it can. ' : ''}Click a word to see alternatives.`));
    }
    if (s.lowest.length) {
      nodes.push(h('h3', { class: 'panel-title' }, 'Weakest words'));
      nodes.push(h('ul', { class: 'weak-list' }, s.lowest.map((x) => h('li', null, h('button', {
        class: 'weak', type: 'button', onclick: () => { setSideTab('words'); editor.selectEntry(x.entry, { focus: true }); },
      }, h('span', { class: 'cand-word', text: x.word }), h('span', { class: 'muted small' }, x.entry.id), h('span', { class: ['score', x.score < 35 ? 'low' : ''] }, String(x.score)))))));
      nodes.push(h('p', { class: 'muted small' }, 'Click a word to see alternatives.'));
    }
    if (!app.wordIndex) nodes.push(h('p', { class: 'muted small' }, 'Loading the word list for scores…'));
    sidePanel.replaceChildren(...nodes);
  }

  function issueItem(severity, message, cells, entry = null, onPick = null) {
    return h('li', null, h('button', {
      class: ['issue', severity], type: 'button',
      onmouseenter: () => editor.setMark('issue', cells),
      onmouseleave: () => editor.setMark('issue'),
      onclick: () => {
        if (entry && onPick) onPick(entry);
        else if (entry) editor.selectEntry(entry, { focus: true });
        else if (cells[0] !== undefined) editor.select(cells[0]);
      },
    }, icon(severity === 'error' ? 'x' : 'alert', { size: 14 }), h('span', { text: message })));
  }

  const stat = (label, value) => h('div', { class: 'stat' }, h('dt', null, label), h('dd', null, String(value)));
  const emptyHint = (title, text) => h('div', { class: 'empty-hint' }, h('strong', null, title), h('span', null, text));

  // ---- updates ----
  function renderAll() {
    editor.render();
    renderToolbar();
    renderFillCard();
    renderSide();
  }
  renderAll();
  refreshCandidates();
  // Focus the grid so typing works immediately (unless a dialog / input has focus).
  requestAnimationFrame(() => { if (!document.activeElement || document.activeElement === document.body) editor.focus(); });

  return {
    update(detail) {
      if (detail.kind === 'clues') return;
      if (detail.kind === 'grid' || detail.kind === 'load') {
        if (lastResult && !lastResult.ok && detail.kind === 'grid') editor.setMarks({});
        renderAll();
        refreshCandidates();
        return;
      }
      if (detail.kind === 'external') {
        renderFillCard();
        renderSide();
        if (detail.what === 'status' || detail.what === 'wordindex') refreshCandidates();
        return;
      }
      renderToolbar();
      renderSide();
    },
    destroy() {
      alive = false;
      fillJob?.cancel();
      refreshCandidates.cancel();
      editor.destroy();
    },
  };
}

function clamp(n, lo, hi) {
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
}
