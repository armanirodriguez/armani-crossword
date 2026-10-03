// Theme & Layout tab: type theme words (one per line, optional "| clue"), see them parsed live, generate
// candidate grids that hold them (EngineClient.layouts) and load one into the draft.
//
// A generation run lives in the draft's session (session.layoutJob), not in this tab: looking at another step
// meanwhile does not stop it, and coming back shows its progress or its results. Leaving the draft cancels it.
// A cancelled run only keeps layouts that were proven fillable.

import { isLetter } from '../../../site/shared/grid.js';
import { draftEntries } from '../../../site/shared/puzzle.js';
import { h, icon, plural } from '../dom.js';
import { confirmDialog, toast } from '../dialogs.js';
import { gridHasContent, parseThemeText, syncThemeClues, themeCapacity } from '../draft-utils.js';
import { miniGrid } from '../mini-grid.js';
import { getFillOptions, getPrefObject, setPref } from '../prefs.js';

const DENSITIES = [
  { id: 'low', label: 'Fewer blocks', help: 'Longer words, harder to fill' },
  { id: 'medium', label: 'Balanced', help: 'A good default' },
  { id: 'high', label: 'More blocks', help: 'Shorter words, easiest to fill' },
];
/** Layouts the generator is asked for (the gallery shows only the ones proven fillable, so maybe fewer). */
const LAYOUT_COUNT = 6;
const BUDGETS = [
  { ms: 10000, label: 'Quick (10 s)' },
  { ms: 20000, label: 'Normal (20 s)' },
  { ms: 60000, label: 'Try harder (60 s)' },
];
const PLACEHOLDER = [
  "Jack o' lantern | Carved October decoration",
  'Trick or treat',
  'Haunted house | Spooky residence',
  'Candy corn',
].join('\n');

export function mountTheme(container, ctx) {
  const { store, app, session } = ctx;
  const { engine } = app;
  const d = () => store.draft;
  const opts = getPrefObject('layoutOptions', { density: 'medium', timeLimitMs: 20000 });
  let progressTimer = null;
  let preparing = false; // generate() is waiting for the recent answers before starting the engine
  const running = () => session.layoutJob || null; // { cancel, key, total, started, timeLimitMs, last, … }

  // ---- theme input ----
  const textarea = h('textarea', {
    class: 'theme-input', rows: 9, spellcheck: false, placeholder: PLACEHOLDER, value: d().themeText || '',
    'aria-label': 'Theme words, one per line',
    oninput: () => {
      const text = textarea.value;
      const { theme } = parse(text);
      store.update((x) => {
        x.themeText = text;
        x.theme = theme;
        // Clues copied from this list (source 'theme') follow it, so the Clues step never keeps a stale one.
        syncThemeClues(x);
      }, { kind: 'theme' });
    },
  });
  const parsedEl = h('div', { class: 'theme-parsed' });
  const summaryEl = h('p', { class: 'theme-summary muted small' });

  // ---- generator ----
  const densitySeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Block density' });
  const densityInputs = DENSITIES.map((x) => {
    const input = h('input', {
      type: 'radio', name: 'density', value: x.id, checked: opts.density === x.id,
      onchange: () => { opts.density = x.id; setPref('layoutOptions', opts); },
    });
    densitySeg.append(h('label', { class: 'seg-item', title: x.help }, input, h('span', null, x.label)));
    return input;
  });
  const budget = h('select', {
    'aria-label': 'Time budget',
    onchange: () => { opts.timeLimitMs = Number(budget.value); setPref('layoutOptions', opts); },
  }, BUDGETS.map((b) => h('option', { value: b.ms, selected: b.ms === opts.timeLimitMs }, b.label)));
  const genBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => generate() }, icon('wand'), 'Generate layouts');
  const cancelBtn = h('button', {
    class: 'btn', type: 'button', hidden: true, title: 'Stop searching and keep the layouts proven fillable so far',
    onclick: () => { const run = running(); if (run) { run.userCancelled = true; run.cancel(); } },
  }, icon('stop'), 'Stop');
  const progressEl = h('div', { class: 'progress-line', hidden: true },
    h('div', { class: 'progress' }, h('div', { class: 'progress-bar' })),
    h('span', { class: 'progress-text muted small' }));
  const runHint = h('p', { class: 'muted small run-hint', hidden: true },
    'It keeps looking for the whole time budget while some theme words don’t fit yet. Stop keeps the layouts proven so far.');
  const engineNote = h('div', { class: 'engine-note' });
  const gallery = h('div', { class: 'gallery' });

  container.append(h('div', { class: 'theme-layout' },
    h('section', { class: 'card theme-words' },
      h('h2', { class: 'card-title' }, 'Theme words'),
      h('p', { class: 'card-help' },
        'One per line, most important first — put your favourite answers at the top (when not all of them fit, those ',
        'are placed first). Spaces and punctuation are dropped (“Jack o’ lantern” → JACKOLANTERN). ',
        'Add a clue after a “|” if you already have one.'),
      textarea,
      summaryEl,
      parsedEl),
    h('section', { class: 'card theme-gen' },
      h('div', { class: 'card-head' },
        h('h2', { class: 'card-title' }, 'Generate a grid'),
        h('a', { class: 'btn sm link', href: `#/draft/${d().id}/grid` }, 'I’ll place them myself', icon('arrowRight', { size: 14 }))),
      h('p', { class: 'card-help' }, 'Creates symmetric grids that contain your theme words and fills the rest with good words. Pick the one you like; you can tweak everything afterwards.'),
      h('div', { class: 'gen-options' },
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Blocks'), densitySeg),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Time budget'), budget)),
      h('p', { class: 'field-help gen-help' },
        'A layout may use more blocks than you picked when that fits more theme words. Only grids proven fillable are shown, so there may be fewer than six.'),
      h('div', { class: 'row gap-sm' }, genBtn, cancelBtn),
      progressEl,
      runHint,
      engineNote,
      gallery)));

  function parse(text) {
    const cur = d();
    return parseThemeText(text, { width: cur.width, height: cur.height, wordIndex: app.wordIndex });
  }

  // ---- rendering ----
  function renderParsed() {
    const cur = d();
    const { items, theme } = parse(cur.themeText || '');
    parsedEl.replaceChildren();
    const size = `${cur.width}×${cur.height}`;
    const capacity = themeCapacity(cur.width, cur.height);
    if (!items.length) {
      summaryEl.textContent = '';
      parsedEl.append(h('div', { class: 'empty-hint' },
        h('strong', null, `A ${size} grid usually holds ${capacity.text} theme answers.`),
        h('span', null, ` Long ones are the stars of the puzzle (up to ${Math.max(cur.width, cur.height)} letters here). Listing a few more is fine: the generator places as many as it can, top ones first.`)));
      return;
    }
    const placed = placedAnswers(cur);
    const tooLong = items.filter((it) => it.problems.some((p) => p.text.startsWith('Too long'))).length;
    summaryEl.textContent = `${plural(theme.length, 'theme word')}`
      + (tooLong ? ` · ${tooLong} too long for this grid` : '')
      + (placed.size ? ` · ${placed.size} in the grid` : '')
      + ` · a ${size} usually holds ${capacity.text}${theme.length > capacity.max ? ', so the top ones get placed first' : ''}`;
    const list = h('ul', { class: 'theme-parsed-list' }, items.map((it) => {
      const worst = it.problems.find((p) => p.level === 'error') || it.problems.find((p) => p.level === 'warn') || it.problems[0];
      return h('li', { class: ['tp-row', worst?.level === 'error' && 'row-error'] },
        h('div', { class: 'tp-main' },
          h('span', { class: 'answer', text: it.answer || '—' }),
          h('span', { class: 'tp-len muted small' }, it.length ? String(it.length) : ''),
          h('span', { class: 'tp-flags' },
            placed.has(it.answer) ? h('span', { class: 'pill ok', title: 'In the grid' }, icon('check', { size: 11 }), 'in grid') : null,
            worst ? h('span', { class: ['pill', worst.level], text: worst.text, title: worst.title || '' }) : null)),
        it.clue ? h('div', { class: 'tp-clue small muted', text: it.clue, title: it.clue }) : null);
    }));
    parsedEl.append(list);
  }

  /** Theme answers that currently appear as complete entries in the grid. */
  function placedAnswers(cur) {
    const answers = new Set(cur.theme.map((t) => t.answer));
    if (!answers.size || !cur.cells.some(isLetter)) return new Set();
    return new Set(draftEntries(cur).all.map((e) => e.answer).filter((a) => a && answers.has(a)));
  }

  function renderEngine() {
    const st = engine.status;
    genBtn.disabled = st !== 'ready' || Boolean(running());
    engineNote.replaceChildren();
    if (st === 'loading' || st === 'idle') {
      engineNote.append(h('p', { class: 'note info' }, h('span', { class: 'spinner' }), engine.message || 'Starting the fill engine…'));
    } else if (st === 'unavailable') {
      engineNote.append(h('div', { class: 'note warn' },
        icon('alert', { size: 14 }),
        h('span', null, `${engine.message} You can still build the grid by hand.`),
        h('button', { class: 'btn sm', type: 'button', onclick: () => engine.restart() }, 'Retry')));
    }
  }

  function layoutKey(cur) {
    return JSON.stringify([cur.width, cur.height, cur.symmetry, cur.theme.map((t) => t.answer)]);
  }

  function renderGallery() {
    const cur = d();
    gallery.replaceChildren();
    const cache = session.layouts;
    if (!cache) {
      if (!running()) {
        gallery.append(h('div', { class: 'empty-hint big' },
          icon('grid', { size: 28 }),
          h('strong', null, 'No layouts yet'),
          h('span', null, cur.theme.length
            ? 'Press “Generate layouts” to see grids that hold your theme words.'
            : 'Add theme words on the left — or generate a plain grid without a theme.')));
      }
      return;
    }
    if (cache.width !== undefined && (cache.width !== cur.width || cache.height !== cur.height)) {
      gallery.append(h('p', { class: 'note info' }, 'The grid size changed since these layouts were generated. Generate again for the new size.'));
      return;
    }
    const stale = cache.key !== layoutKey(cur);
    const { result } = cache;
    if (stale) {
      gallery.append(h('p', { class: 'note info' }, 'Your theme words or grid settings changed since these were generated. Generate again to update them.'));
    }
    if (!result.layouts.length) {
      gallery.append(cache.aborted
        ? h('div', { class: 'empty-hint big' },
          icon('alert', { size: 28 }),
          h('strong', null, 'Stopped before a layout was proven fillable'),
          h('span', null, cache.droppedUnproven
            ? `${plural(cache.droppedUnproven, 'unfinished candidate')} ${cache.droppedUnproven === 1 ? 'was' : 'were'} left out because ${cache.droppedUnproven === 1 ? 'it' : 'they'} might not fill. Generate again and let it run.`
            : 'Generate again and let it run.'))
        : h('div', { class: 'empty-hint big' },
          icon('alert', { size: 28 }),
          h('strong', null, 'No layout found'),
          h('span', null, 'Try “Try harder”, fewer or shorter theme words, “More blocks”, or a bigger grid.')));
      return;
    }
    const allProven = result.layouts.every((l) => l.filled);
    gallery.append(h('p', { class: 'muted small gallery-meta' },
      `${plural(result.layouts.length, 'layout')} from ${result.attempts ?? '?'} attempts in ${((result.ms || 0) / 1000).toFixed(1)} s. `,
      cache.aborted && cache.droppedUnproven
        ? `Stopped early: ${plural(cache.droppedUnproven, 'unproven candidate')} left out. ` : null,
      !cache.aborted && allProven && result.layouts.length < LAYOUT_COUNT ? 'Only grids proven fillable are listed. ' : null,
      h('button', { class: 'btn sm link', type: 'button', disabled: !engine.ready || Boolean(running()), onclick: () => generate() }, icon('refresh', { size: 14 }), 'Show me different ones')));
    const grid = h('div', { class: 'gallery-grid' });
    result.layouts.forEach((layout, k) => grid.append(layoutCard(layout, k, cache.total)));
    gallery.append(grid);
  }

  function layoutCard(layout, k, total) {
    const cur = d();
    const cells = layout.filled || layout.cells;
    const placedCount = (layout.placements || []).length;
    const s = layout.stats || {};
    const quality = Number.isFinite(s.fillAvgScore) ? Math.round(s.fillAvgScore) : null;
    return h('article', { class: 'layout-card' },
      h('div', { class: 'lc-grid' }, miniGrid({ width: cur.width, height: cur.height, cells }, {
        cellSize: 12, letters: true, highlight: new Set(layout.locked || []), label: `Layout option ${k + 1}`,
      })),
      h('div', { class: 'lc-body' },
        h('div', { class: 'lc-title' }, h('strong', null, `Option ${k + 1}`),
          total ? h('span', { class: ['pill', placedCount === total ? 'ok' : 'warn'] }, `${placedCount}/${total} theme`) : null),
        h('div', { class: 'lc-stats muted small' },
          `${plural(s.blocks ?? cells.filter((c) => c === '#').length, 'block')} · ${s.words ?? '?'} words`
          + (Number.isFinite(s.avgLength) ? ` · avg ${s.avgLength.toFixed(1)} letters` : '')),
        h('div', { class: 'lc-stats small' }, layout.filled
          ? h('span', null, 'Fill quality ', h('strong', null, quality ?? '—'), quality !== null ? h('span', { class: 'muted' }, ' / 100') : null)
          : h('span', { class: 'pill warn', title: 'The generator ran out of time before proving this grid can be filled. It may not fill.' }, 'Not verified — may not fill')),
        layout.unplaced?.length ? h('div', { class: 'lc-missing small', title: layout.unplaced.join(', ') }, `Missing: ${layout.unplaced.join(', ')}`) : null,
        h('button', { class: 'btn primary sm block', type: 'button', onclick: () => useLayout(layout) }, 'Use this layout')));
  }

  // ---- actions ----
  async function generate() {
    if (running() || preparing || !engine.ready) return;
    const cur = d();
    // Recently published answers for the fill proofs to avoid (when that Fill option is on; usually cached).
    preparing = true;
    genBtn.disabled = true;
    let penalize = null;
    try {
      penalize = await app.freshnessPenalties(cur);
    } finally {
      preparing = false;
    }
    if (running() || !engine.ready || d() !== cur) {
      renderEngine();
      return;
    }
    const maxLen = Math.max(cur.width, cur.height);
    const theme = cur.theme.filter((t) => t.answer.length <= maxLen);
    const timeLimitMs = opts.timeLimitMs;
    const params = {
      width: cur.width,
      height: cur.height,
      symmetry: cur.symmetry,
      theme: theme.map((t) => ({ answer: t.answer })),
      count: LAYOUT_COUNT,
      timeLimitMs,
      density: opts.density,
      seed: Math.floor(Math.random() * 2 ** 31),
      minScore: getFillOptions().minScore,
      fillPreview: true,
      ...(penalize ? { penalize } : {}),
    };
    const run = {
      key: layoutKey(cur), total: theme.length, width: cur.width, height: cur.height, draftId: cur.id,
      started: performance.now(), timeLimitMs, last: null, userCancelled: false, cancel: () => {},
    };
    let job;
    try {
      job = engine.layouts(params, (p) => { run.last = p; });
    } catch (err) {
      toast(err.message, { type: 'error' });
      return;
    }
    run.cancel = () => job.cancel();
    session.layoutJob = run;
    showRunning();
    renderGallery();
    let outcome = 'done';
    try {
      const result = await job.promise;
      const size = run.width * run.height;
      const layouts = Array.isArray(result?.layouts) ? result.layouts.filter((l) => Array.isArray(l.cells) && l.cells.length === size) : [];
      const aborted = result?.reason === 'aborted';
      // A stopped run may hold candidates that were never proven fillable (often they are not): leave them out.
      const kept = aborted ? layouts.filter((l) => Array.isArray(l.filled) && l.filled.length === size) : layouts;
      session.layouts = {
        key: run.key, total: run.total, width: run.width, height: run.height,
        aborted, droppedUnproven: layouts.length - kept.length, result: { ...result, layouts: kept },
      };
      if (aborted) outcome = 'aborted';
    } catch (err) {
      outcome = 'error';
      if (!/abort|cancel/i.test(String(err?.message || err))) toast(`Layout generation failed: ${err?.message || err}`, { type: 'error' });
    } finally {
      if (session.layoutJob === run) session.layoutJob = null;
    }
    // This tab may have been left (and come back) meanwhile: tell whoever shows the gallery now.
    if (session.onLayoutsDone) session.onLayoutsDone(run, outcome);
    else if (outcome === 'done' && app.store.draft?.id === run.draftId) {
      const n = session.layouts?.result.layouts.length || 0;
      toast(n ? `${plural(n, 'layout')} ready.` : 'No layout found for your theme words.', {
        type: n ? 'success' : 'warn',
        action: { label: 'Show', onClick: () => { if (app.store.draft?.id === run.draftId) ctx.goTab('theme'); } },
      });
    }
  }

  /** Progress line + Cancel while a run (possibly started before this tab was opened) is going. */
  function showRunning() {
    const run = running();
    clearInterval(progressTimer);
    if (!run) {
      progressEl.hidden = true;
      cancelBtn.hidden = true;
      runHint.hidden = true;
      renderEngine();
      return;
    }
    const tick = () => {
      const el = (performance.now() - run.started) / 1000;
      progressEl.querySelector('.progress-bar').style.width = `${Math.min(100, (el * 1000 / run.timeLimitMs) * 100)}%`;
      const found = run.last?.found ?? run.last?.layouts?.length ?? run.last?.count;
      const attempts = run.last?.attempts;
      progressEl.querySelector('.progress-text').textContent = `Searching… ${el.toFixed(1)} s of ${Math.round(run.timeLimitMs / 1000)} s`
        + (attempts !== undefined ? ` · ${attempts} attempts` : '')
        + (found !== undefined ? ` · ${found} found` : '');
    };
    progressEl.hidden = false;
    cancelBtn.hidden = false;
    runHint.hidden = false;
    genBtn.disabled = true;
    progressTimer = setInterval(tick, 200);
    tick();
  }

  // Results of a run land here while this tab is open (whether or not it started the run).
  const onLayoutsDone = (run, outcome) => {
    showRunning();
    renderGallery();
    if (outcome === 'aborted' && run.userCancelled) {
      const kept = session.layouts?.result.layouts.length || 0;
      toast(kept ? `Stopped — kept ${plural(kept, 'proven layout')}.` : 'Stopped', { timeout: 2500 });
    }
  };
  session.onLayoutsDone = onLayoutsDone;

  async function useLayout(layout) {
    const cur = d();
    if (gridHasContent(cur)) {
      const ok = await confirmDialog({
        title: 'Replace the current grid?',
        message: 'The grid will be replaced by this layout. Clues you wrote are kept (they are stored by answer), and you can undo this.',
        confirmLabel: 'Use this layout',
      });
      if (!ok) return;
    }
    const cells = (layout.filled || layout.cells).slice();
    const unproven = !layout.filled;
    store.update((x) => {
      x.cells = cells;
      x.locked = [...new Set(layout.locked || [])].filter((i) => isLetter(cells[i])).sort((a, b) => a - b);
      x.circles = [];
      x.shaded = [];
      // Theme clues → draft clues (never overwrite a clue the user wrote).
      const placed = new Set((layout.placements || []).map((p) => p.answer));
      for (const t of x.theme) {
        if (!t.clue || !placed.has(t.answer)) continue;
        if (x.clues[t.answer] && x.clueSources?.[t.answer] === 'user') continue;
        x.clues[t.answer] = t.clue;
        x.clueSources = { ...(x.clueSources || {}), [t.answer]: 'theme' };
      }
    }, { kind: 'grid', label: 'use layout' });
    session.index = 0;
    const draftId = cur.id;
    toast(unproven
      ? 'Layout loaded. It was not proven fillable: press Autofill to check (theme words are locked).'
      : 'Layout loaded. Theme words are locked; the other letters can be refilled.', {
      type: 'success',
      // Only undo in the same draft (the toast can outlive a switch to another draft).
      action: { label: 'Undo', onClick: () => { if (store.draft?.id === draftId) store.undo(); } },
    });
    ctx.goTab('grid');
  }

  renderParsed();
  renderEngine();
  showRunning();
  renderGallery();
  densityInputs.forEach((i) => { i.checked = i.value === opts.density; });

  return {
    update(detail) {
      if (detail.kind === 'theme' || detail.kind === 'grid' || detail.kind === 'load' || detail.kind === 'external' || detail.kind === 'meta') {
        if (document.activeElement !== textarea && textarea.value !== (d().themeText || '')) textarea.value = d().themeText || '';
        renderParsed();
        if (detail.kind !== 'theme') renderEngine();
        if (!running()) renderGallery();
      }
    },
    destroy() {
      // A running generation keeps going (see the top of this file); only this tab's display stops.
      clearInterval(progressTimer);
      if (session.onLayoutsDone === onLayoutsDone) session.onLayoutsDone = null;
    },
  };
}
