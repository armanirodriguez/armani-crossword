// The solving view: header (timer, hints, share), grid, clue lists / clue bar, on-screen keyboard,
// pause overlay, completion. Wires the Game (logic), ActivityTimer (time) and the views together and
// persists progress.

import { h, mq, setClass } from '../dom.js';
import { icon } from '../icons.js';
import { Game } from '../game.js';
import { ActivityTimer } from '../timer.js';
import { createBrowserActivity } from '../activity.js';
import { GridView } from '../grid-view.js';
import { ClueLists, ClueBar } from '../clues-view.js';
import { OnScreenKeyboard } from '../keyboard.js';
import { confirmDialog, isOverlayOpen, openMenu, openModal, openSheet, toast } from '../ui.js';
import { confetti } from '../confetti.js';
import { hintSummary, shareDate } from '../share.js';
import { ProgressSync } from '../progress.js';
import { KIND_LABELS, formatDuration, puzzleKind } from '../../shared/puzzle.js';
import { CLAUDE, CLAUDE_TITLE, archiveHref, seriesOf } from '../series.js';
import { shareNow, shareTextFor } from './share-action.js';
import { claudeMark } from './common.js';

/** Touch layout (custom keyboard + clue bar) for coarse pointers or narrow windows. */
export const TOUCH_QUERY = '(pointer: coarse), (max-width: 699px)';
/** Portrait tablets (touch layout): clue lists below the grid — keep in sync with styles.css. */
const TABLET_PORTRAIT_QUERY = '(min-width: 768px) and (min-height: 600px) and (orientation: portrait)';

const pluralize = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * @param {object} o
 * @param {object} o.ctx       app context ({ config, storage, preview, inIframe, ... })
 * @param {object} o.raw       published puzzle JSON
 * @param {object} o.loaded    loadPuzzle(raw)
 * @param {object|null} o.entry index entry (number)
 * @param {() => void} o.onBack  show the intro card again (or today's puzzles, when Play came from there)
 * @param {string} [o.backLabel]   accessible name of the back button
 * @returns {{ el, enter(), leave(), destroy(), sync(), get progress() }}
 *
 * Progress is loaded here (not passed in) so this view knows exactly which stored version it started from:
 * other tabs of the same puzzle may save too, and every save/pull merges with them (ProgressSync).
 */
export function createPlayView({ ctx, raw, loaded, entry, onBack, backLabel = 'Back to puzzle info' }) {
  const kind = puzzleKind(raw);
  const series = seriesOf(raw);
  const claude = series === CLAUDE;
  // "Mini #1" for a mini, "#2" for a daily (SPEC §8); Claude's way always names the kind: "Daily #3" (SPEC §9).
  const numLabel = [(kind !== 'daily' || claude) && KIND_LABELS[kind], entry?.number && `#${entry.number}`].filter(Boolean).join(' ');
  const store = new ProgressSync({ storage: ctx.storage, puzzleId: raw.id, puzzle: loaded, checksum: raw.checksum });
  const progress = store.load();
  const game = new Game(loaded, progress);
  const record = { started: progress.started, solvedAt: progress.solvedAt, finish: progress.finish };
  let active = false; // the view is on screen
  let destroyed = false;
  let sheet = null;
  let saveWarned = false;
  let adopting = false; // applying a record from another tab: don't save while half-applied

  // ---------------------------------------------------------------- persistence
  let timer = null;
  function snapshot(elapsedMs = timer ? timer.elapsedMs : progress.elapsedMs) {
    return {
      v: 1,
      ...game.toProgress(),
      elapsedMs: Math.round(elapsedMs),
      started: record.started,
      solved: game.solved,
      solvedAt: game.solved ? record.solvedAt : null,
      finish: game.solved ? record.finish || 'solved' : null,
      checksum: raw.checksum,
    };
  }
  function persist(elapsedMs) {
    if (adopting) return;
    const { ok, record: saved, merged } = store.save(snapshot(elapsedMs));
    if (merged) adopt(saved); // another tab saved meanwhile: what was written includes their changes
    if (!ok && !saveWarned && ctx.storage.persistent) {
      saveWarned = true;
      toast("Couldn't save your progress in this browser (storage is full or blocked).", { tone: 'warn', duration: 4500 });
    }
  }

  /** Take over a record that folds in another tab's progress (letters, hints, time, a finished solve). */
  function adopt(rec) {
    if (destroyed) return;
    const wasSolved = game.solved;
    adopting = true;
    try {
      game.restore(rec);
      record.started = record.started || rec.started;
      if (rec.solved) {
        record.solvedAt = rec.solvedAt ?? record.solvedAt;
        record.finish = rec.finish || 'solved';
      }
      timer.setElapsed(rec.elapsedMs);
      if (game.solved && !wasSolved) {
        timer.setSolved(true);
        sheet?.close();
        if (active) {
          toast(record.finish === 'revealed' ? 'This puzzle was revealed in another tab.' : 'You finished this puzzle in another tab.', { duration: 4000 });
        }
      }
    } finally {
      adopting = false;
    }
    updateHeader();
    queueRender();
  }

  /** Pick up whatever another tab saved since this view last read or wrote the record. */
  function syncFromStorage() {
    if (destroyed) return;
    const res = store.pull(snapshot());
    if (!res) return;
    adopt(res.record);
    if (res.needsWrite) persist(); // this tab had unsaved changes (e.g. a few seconds of time) on top
  }

  // ---------------------------------------------------------------- header
  const timerText = h('span', { class: 'timer-text' }, formatDuration(progress.elapsedMs));
  const timerIcon = h('span', { class: 'timer-icon' }, icon('pause', { size: 16 }));
  const timerBtn = h('button', { type: 'button', class: 'timer-btn', 'aria-label': 'Pause' }, timerIcon, timerText);
  const hintsBtn = h('button', { type: 'button', class: 'icon-btn hints-btn', 'aria-label': 'Hints: check or reveal', 'aria-haspopup': 'menu', title: 'Check / Reveal' },
    icon('bulb', { size: 22 }), h('span', { class: 'btn-label' }, 'Hints'));
  const cluesBtn = h('button', { type: 'button', class: 'icon-btn clues-btn', 'aria-label': 'All clues', title: 'All clues' }, icon('list', { size: 22 }));
  const shareBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm share-btn', hidden: true }, icon('share', { size: 18 }), h('span', null, 'Share'));
  const backBtn = h('button', { type: 'button', class: 'icon-btn back-btn', 'aria-label': backLabel, title: 'Back' }, icon('chevronLeft', { size: 24 }));
  const archiveLink = h('a', { class: 'icon-btn archive-link', href: archiveHref(series), 'aria-label': 'Archive', title: 'Archive' }, icon('calendar', { size: 21 }));

  const header = h('header', { class: ['play-header', claude && 'series-claude'] },
    backBtn,
    h('div', { class: 'play-title' },
      h('span', { class: 'play-title-main' }, raw.title || 'Untitled'),
      // Separate parts so very narrow phones can drop the date and keep the puzzle number.
      h('span', { class: ['play-title-sub', numLabel && 'has-num'] }, [
        h('span', { class: 'sub-date' }, shareDate(raw.date)),
        // "#2" for a daily, "Mini #1" for a mini (SPEC §8); "Claude’s way · Mini #3" (SPEC §9).
        // (Narrow phones keep just the spark of the series: "✳ Mini #3".)
        numLabel && h('span', { class: 'sub-num' },
          claude && claudeMark(11), claude && h('span', { class: 'sub-series' }, `${CLAUDE_TITLE} · `), numLabel),
        ctx.preview && h('span', { class: 'sub-preview' }, 'Preview'),
      ])),
    h('div', { class: 'play-actions' }, timerBtn, hintsBtn, shareBtn, cluesBtn, archiveLink));

  // ---------------------------------------------------------------- views
  const canPlay = () => active && !destroyed && !(timer && timer.state.paused);

  const gridView = new GridView(game, {
    label: raw.title || 'Crossword',
    onCell: (i) => { if (canPlay()) game.tapCell(i); },
  });
  const lists = new ClueLists(game, {
    onSelect: (e) => { if (!canPlay()) return; game.selectEntry(e); gridView.focus(); },
  });
  const clueBar = new ClueBar(game, {
    onPrev: () => canPlay() && game.stepEntry(-1),
    onNext: () => canPlay() && game.stepEntry(1),
    onToggle: () => canPlay() && game.toggleDir(),
  });
  const keyboard = new OnScreenKeyboard({
    onLetter: (ch) => canPlay() && game.type(ch),
    onBackspace: () => canPlay() && game.backspace(),
  });

  const pauseTitle = h('h2', { class: 'pause-title' }, 'Paused');
  const pauseText = h('p', { class: 'pause-text' });
  const resumeBtn = h('button', { type: 'button', class: 'btn btn-primary btn-xl' }, icon('play', { size: 20 }), h('span', null, 'Resume'));
  const pauseOverlay = h('div', { class: 'pause-overlay', hidden: true },
    h('div', { class: 'pause-card', role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Paused' },
      h('div', { class: 'pause-badge' }, icon('pause', { size: 28 })),
      pauseTitle, pauseText, resumeBtn));

  const boardArea = h('div', { class: 'board-area' }, gridView.board);
  const barArea = h('div', { class: 'area-bar' }, clueBar.el);
  const kbArea = h('div', { class: 'area-kb' }, keyboard.el);
  const body = h('div', { class: 'play-body' },
    barArea,
    boardArea,
    h('aside', { class: 'area-lists' }, lists.el),
    kbArea,
    pauseOverlay);

  const root = h('div', { class: 'screen screen-play', dataset: { input: mq(TOUCH_QUERY) ? 'touch' : 'desktop' } }, header, body);

  // ---------------------------------------------------------------- rendering
  let renderQueued = false;
  function render() {
    renderQueued = false;
    if (destroyed) return;
    gridView.render();
    lists.render();
    clueBar.render();
  }
  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(render);
  }

  let wasSolvedLayout = game.solved;
  function updateHeader() {
    const solved = game.solved;
    setClass(root, 'is-solved', solved);
    hintsBtn.hidden = solved;
    shareBtn.hidden = !solved;
    timerBtn.disabled = solved;
    timerBtn.classList.toggle('is-final', solved);
    // The solved grid is read-only: the on-screen keyboard is hidden (CSS) and inert, and the grid gets its room.
    keyboard.setDisabled(solved || Boolean(active && timer?.state.paused));
    if (solved !== wasSolvedLayout) {
      wasSolvedLayout = solved;
      requestAnimationFrame(fit);
    }
    const st = timer?.state;
    const manual = st?.reason === 'manual';
    timerIcon.replaceChildren(icon(solved ? 'check' : manual ? 'play' : 'pause', { size: 16, strokeWidth: solved ? 3 : 2 }));
    const finalLabel = record.finish === 'revealed' ? `Puzzle revealed at ${timerText.textContent}` : `Solved in ${timerText.textContent}`;
    timerBtn.setAttribute('aria-label', solved ? finalLabel : manual ? 'Resume timer' : 'Pause timer');
  }

  function showTime(ms) {
    const s = formatDuration(ms);
    if (timerText.textContent !== s) timerText.textContent = s;
  }

  // ---------------------------------------------------------------- timer
  const activity = createBrowserActivity({ ignoreFocus: Boolean(ctx.preview && ctx.inIframe) });
  timer = new ActivityTimer({
    elapsedMs: progress.elapsedMs,
    started: false, // set when the view is entered
    solved: game.solved,
    activity,
    onTick: showTime,
    onPersist: (ms) => persist(ms),
    onStateChange: applyTimerState,
  });

  function applyTimerState(state) {
    if (destroyed) return;
    const paused = active && state.paused;
    pauseOverlay.hidden = !paused;
    setClass(root, 'is-paused', paused);
    if (paused) {
      pauseText.textContent = state.reason === 'manual'
        ? 'Your clock is stopped. Take a breather.'
        : 'The timer stops while this page isn’t in front.';
      sheet?.close();
    }
    showTime(state.elapsedMs);
    updateHeader();
  }

  timerBtn.addEventListener('click', () => {
    if (game.solved) return;
    if (timer.manuallyPaused) resumeTimer();
    else timer.pause();
  });
  function resumeTimer() {
    try { window.focus(); } catch { /* ignore */ }
    timer.resume();
    gridView.focus();
  }
  resumeBtn.addEventListener('click', resumeTimer);

  // ---------------------------------------------------------------- hints
  function doCheck(scope) {
    const { checked, wrong } = game.check(scope);
    if (!checked) toast(scope === 'square' ? 'Type a letter first, then check it.' : 'Nothing to check yet.');
    else if (!wrong) toast(scope === 'square' ? 'That square is right ✓' : scope === 'word' ? 'That word is right so far ✓' : 'Everything so far is right ✓', { tone: 'success' });
    else toast(`${pluralize(wrong, 'square')} ${wrong === 1 ? 'is' : 'are'} wrong`, { tone: 'warn' });
    persist();
  }
  async function doReveal(scope) {
    if (scope === 'puzzle') {
      const ok = await confirmDialog({
        title: 'Reveal the whole puzzle?',
        message: 'Every square will be filled in and your solve will end. This can’t be undone.',
        confirmLabel: 'Reveal puzzle',
        cancelLabel: 'Keep solving',
        danger: true,
      });
      if (!ok || destroyed) { gridView.focus(); return; }
    }
    const { revealed, confirmed } = game.reveal(scope);
    if (game.solved) { /* the completion modal says it all */ }
    else if (confirmed) {
      // Nothing to reveal, but it just confirmed letters the solver typed: that counts as a check.
      toast(scope === 'square' ? 'That square is already right ✓ (counts as a check)' : 'Already right ✓ (counts as a check)', { tone: 'success' });
    } else if (!revealed) toast(scope === 'square' ? 'That square is already revealed.' : 'Nothing left to reveal.');
    else if (scope !== 'puzzle') toast(`Revealed ${pluralize(revealed, 'square')}`);
    persist();
    gridView.focus();
  }
  hintsBtn.addEventListener('click', () => {
    if (!canPlay() || game.solved) return;
    const scopeItems = (fn) => [
      { label: 'Square', hint: 'the selected square', onSelect: () => { fn('square'); gridView.focus(); } },
      { label: 'Word', hint: 'the selected word', onSelect: () => { fn('word'); gridView.focus(); } },
      { label: 'Puzzle', hint: 'every square', onSelect: () => { fn('puzzle'); gridView.focus(); } },
    ];
    openMenu(hintsBtn, [
      { title: 'Check', items: scopeItems(doCheck) },
      { title: 'Reveal', items: scopeItems(doReveal).map((it) => ({ ...it, danger: it.label === 'Puzzle' })) },
    ], { label: 'Hints' });
  });

  // ---------------------------------------------------------------- clue sheet (touch)
  cluesBtn.addEventListener('click', () => {
    if (!canPlay()) return;
    const sheetLists = new ClueLists(game, {
      className: 'in-sheet',
      onSelect: (e) => { game.selectEntry(e); sheet?.close(); },
    });
    sheetLists.render({ scroll: false });
    sheet = openSheet({ title: 'Clues', content: sheetLists.el, className: 'clue-sheet', onClose: () => { sheet = null; } });
    requestAnimationFrame(() => sheetLists.revealActiveIn(sheet?.el.querySelector('.sheet-body')));
  });

  // ---------------------------------------------------------------- share & completion
  function result() {
    return { elapsedMs: timer.elapsedMs, checks: game.checks, reveals: game.reveals, marks: game.marks, everWrong: game.everWrong };
  }
  function share() {
    shareNow(shareTextFor(ctx, raw, entry, loaded, result()));
  }
  shareBtn.addEventListener('click', share);

  function showSolvedModal({ revealedAll }) {
    if (destroyed || !active) return;
    const r = result();
    const hero = h('div', { class: ['solved-hero', revealedAll && 'is-revealed'] }, icon(revealedAll ? 'eye' : 'check', { size: 38, strokeWidth: 2.6 }));
    openModal({
      title: revealedAll ? 'Puzzle revealed' : 'Solved!',
      hero,
      className: claude ? 'modal-solved series-claude' : 'modal-solved',
      body: [
        h('p', { class: 'solved-time' }, formatDuration(r.elapsedMs)),
        h('p', { class: 'solved-hints' }, hintSummary(r.checks, r.reveals)),
        h('p', { class: 'solved-puzzle' }, (claude
          ? [CLAUDE_TITLE, numLabel, raw.title || 'Untitled', shareDate(raw.date)]
          : [kind !== 'daily' && KIND_LABELS[kind], raw.title || 'Untitled', shareDate(raw.date)]).filter(Boolean).join(' · ')),
      ],
      actions: [
        { label: 'View puzzle', value: 'view' },
        { label: 'Share', icon: 'share', primary: true, onClick: () => { share(); return false; } },
      ],
    });
  }

  function onSolved({ source }) {
    record.solvedAt = new Date().toISOString();
    record.finish = source === 'reveal-puzzle' ? 'revealed' : 'solved';
    timer.setSolved(true);
    showTime(timer.elapsedMs);
    persist();
    updateHeader();
    const revealedAll = source === 'reveal-puzzle';
    if (!revealedAll) {
      gridView.celebrate();
      confetti();
    }
    setTimeout(() => showSolvedModal({ revealedAll }), revealedAll ? 250 : 700);
  }

  game.on((type, detail) => {
    if (type === 'letters' || type === 'select') queueRender();
    if (type === 'letters') persist();
    if (type === 'solved') onSolved(detail);
    if (type === 'filled-wrong') toast('Almost — something’s not quite right', { tone: 'warn', duration: 3200 });
  });

  // ---------------------------------------------------------------- hardware keyboard
  function onKeyDown(e) {
    if (!active || destroyed || isOverlayOpen() || e.defaultPrevented) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (!canPlay()) return;
    const onControl = t instanceof HTMLElement && Boolean(t.closest('button, a')) && !t.closest('.grid');
    const k = e.key;
    let handled = true;
    if (/^[a-z]$/i.test(k)) game.type(k);
    else if (k === 'Backspace') game.backspace();
    else if (k === 'Delete') game.del();
    else if (k === 'ArrowLeft') game.move(0, -1);
    else if (k === 'ArrowRight') game.move(0, 1);
    else if (k === 'ArrowUp') game.move(-1, 0);
    else if (k === 'ArrowDown') game.move(1, 0);
    else if (k === 'Tab' && !onControl) game.stepEntry(e.shiftKey ? -1 : 1);
    else if ((k === ' ' || k === 'Enter') && !onControl) game.toggleDir();
    else handled = false;
    if (handled) {
      e.preventDefault();
      if (onControl) gridView.focus();
    }
  }

  // ---------------------------------------------------------------- layout
  function fit() {
    if (!active || destroyed) return;
    clueBar.fitText();
    const touch = root.dataset.input === 'touch';
    if (!touch) {
      fitDesktop();
      return;
    }
    root.classList.remove('lists-stacked');
    body.style.removeProperty('--grid-px');
    const cs = getComputedStyle(gridView.board);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    if (mq(TABLET_PORTRAIT_QUERY)) {
      // Lists go under the grid: give the grid the full width and whatever height leaves the lists room.
      const total = body.clientHeight - barArea.offsetHeight - kbArea.offsetHeight;
      const listsMin = Math.max(180, Math.round(total * 0.24));
      const w = body.clientWidth - padX;
      const hgt = total - listsMin - padY;
      if (w <= 0 || hgt <= 0) return;
      const cell = gridView.fit(w, hgt, { minCell: 15, maxCell: 110 });
      const boardH = `${Math.ceil(Math.min(GridView.gridSize(loaded.height, cell) + padY, total - listsMin))}px`;
      if (body.style.getPropertyValue('--board-h') !== boardH) body.style.setProperty('--board-h', boardH);
      return;
    }
    body.style.removeProperty('--board-h');
    const w = boardArea.clientWidth - padX;
    const hgt = boardArea.clientHeight - padY;
    if (w <= 0 || hgt <= 0) return;
    gridView.fit(w, hgt, { minCell: 15, maxCell: 110 });
  }

  /**
   * Desktop: the grid column is exactly as wide as the grid, so the clue bar matches it and the clue
   * lists sit right beside it. Size the grid from the whole body box minus room for the lists.
   */
  function fitDesktop() {
    const cs = getComputedStyle(body);
    const W = body.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const H = body.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (W <= 0 || H <= 0) return;
    const gapX = parseFloat(cs.columnGap) || 32;
    const gapY = parseFloat(cs.rowGap) || 14;
    const barH = clueBar.el.offsetHeight || 58;
    const listsW = W >= 1080 ? 520 : W >= 860 ? 360 : 280;
    root.classList.toggle('lists-stacked', listsW < 440);
    const cell = gridView.fit(W - gapX - listsW, H - barH - gapY, { minCell: 18, maxCell: 92 });
    const gridPx = Math.min(GridView.gridSize(loaded.width, cell), W - gapX - listsW);
    body.style.setProperty('--grid-px', `${gridPx}px`);
    body.style.setProperty('--lists-w', `${Math.max(listsW, Math.min(560, W - gapX - gridPx))}px`);
  }

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
  ro?.observe(boardArea);
  ro?.observe(body);
  const onWinResize = () => fit();
  window.addEventListener('resize', onWinResize);
  let touchMql = null;
  const onModeChange = () => {
    root.dataset.input = mq(TOUCH_QUERY) ? 'touch' : 'desktop';
    requestAnimationFrame(fit);
  };
  try {
    touchMql = window.matchMedia(TOUCH_QUERY);
    touchMql.addEventListener?.('change', onModeChange);
  } catch { /* old browsers: mode fixed at load */ }

  const onPageHide = () => persist();
  window.addEventListener('pagehide', onPageHide);

  // Other tabs of this puzzle: pick up their saves as they happen (storage events), and again whenever this
  // page comes back to the front (a frozen background tab may get its events late).
  const onStorage = (e) => {
    if (e.key === store.key || e.key === null) syncFromStorage();
  };
  const onActivate = () => {
    if (document.visibilityState !== 'hidden') syncFromStorage();
  };
  window.addEventListener('storage', onStorage);
  document.addEventListener('visibilitychange', onActivate);
  document.addEventListener('resume', onActivate);
  window.addEventListener('focus', onActivate);
  window.addEventListener('pageshow', onActivate);

  backBtn.addEventListener('click', () => onBack());

  // ---------------------------------------------------------------- lifecycle
  function enter() {
    if (destroyed) return;
    active = true;
    syncFromStorage(); // another tab may have moved on since this view was last on screen
    record.started = true;
    document.addEventListener('keydown', onKeyDown);
    document.documentElement.classList.add('is-playing');
    timer.setStarted(true);
    timer.resume();
    timer.startTicking();
    updateHeader();
    render();
    fit();
    requestAnimationFrame(() => { fit(); lists.render(); gridView.focus(); });
    applyTimerState(timer.state);
    persist();
    // A full, correct grid that isn't marked solved (e.g. the puzzle was re-published with a fixed answer that
    // the solver already had) finishes now instead of leaving them stuck with a running clock.
    game.completeIfSolved('restore');
  }

  function leave() {
    if (!active) return;
    if (!game.solved) timer.pause();
    timer.stopTicking();
    persist();
    active = false;
    sheet?.close();
    document.removeEventListener('keydown', onKeyDown);
    document.documentElement.classList.remove('is-playing');
  }

  function destroy() {
    if (destroyed) return;
    leave();
    persist();
    destroyed = true;
    timer.dispose();
    ro?.disconnect();
    window.removeEventListener('resize', onWinResize);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('storage', onStorage);
    document.removeEventListener('visibilitychange', onActivate);
    document.removeEventListener('resume', onActivate);
    window.removeEventListener('focus', onActivate);
    window.removeEventListener('pageshow', onActivate);
    touchMql?.removeEventListener?.('change', onModeChange);
  }

  return {
    el: root,
    enter,
    leave,
    destroy,
    get progress() { return snapshot(); },
    get game() { return game; },
    get timer() { return timer; },
    sync: syncFromStorage,
    share,
  };
}
