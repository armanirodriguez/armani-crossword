// Review & Publish tab: checklist (from draftToPuzzle), summary, publish (with overwrite confirmation),
// and a live preview of the real player in an iframe.

import { draftToPuzzle, formatDate, isValidDateId } from '../../../site/shared/puzzle.js';
import { h, icon, plural } from '../dom.js';
import { confirmDialog, openModal, toast, toastError } from '../dialogs.js';
import { api, fetchStatic } from '../api.js';
import {
  LONG_CLUE_CHARS, analyze, autoClueCount, draftFingerprint, longClues, puzzleFingerprint, staleThemeClues,
} from '../draft-utils.js';
import { getFillOptions } from '../prefs.js';
import { recentRepeats, shortDate } from '../recent-answers.js';
import { PREVIEW_URL, writePreview, siteUrlFor } from '../preview.js';

export function mountReview(container, ctx) {
  const { store, app, session } = ctx;
  const d = () => store.draft;
  let alive = true;
  let publishing = false;
  let live = { date: null, fp: '' }; // fingerprint of the puzzle file that is published on the draft's date
  let lastPublish = session.lastPublish || null; // { date, number, url, replaced }
  let device = session.previewDevice || 'desktop';

  const checklist = h('div', { class: 'checklist' });
  const summary = h('dl', { class: 'summary' });
  const publishBox = h('div', { class: 'publish-box' });
  const previewNotes = h('div', { class: 'preview-notes' });
  const frameWrap = h('div', { class: 'frame-wrap' });
  const iframe = h('iframe', { class: 'preview-frame', title: 'Player preview', loading: 'lazy' });
  const deviceSeg = h('div', { class: 'seg sm', role: 'radiogroup', 'aria-label': 'Preview size' },
    [['desktop', 'monitor', 'Desktop'], ['phone', 'phone', 'Phone']].map(([id, ic, label]) => h('label', { class: 'seg-item', title: label },
      h('input', { type: 'radio', name: 'pv-device', value: id, checked: device === id, onchange: () => { device = id; session.previewDevice = id; frameWrap.dataset.device = id; } }),
      h('span', null, icon(ic, { size: 14 }), label))));
  frameWrap.dataset.device = device;
  frameWrap.append(iframe);

  container.append(h('div', { class: 'review-layout' },
    h('div', { class: 'review-left' },
      h('section', { class: 'card' }, h('h2', { class: 'card-title' }, 'Checklist'), checklist),
      h('section', { class: 'card' }, h('h2', { class: 'card-title' }, 'Summary'), summary),
      h('section', { class: 'card' }, publishBox)),
    h('section', { class: 'card review-preview' },
      h('div', { class: 'card-head' },
        h('h2', { class: 'card-title' }, 'Preview'),
        h('div', { class: 'row gap-sm' }, deviceSeg,
          h('button', { class: 'btn sm', type: 'button', onclick: () => refreshPreview(true) }, icon('refresh', { size: 14 }), 'Refresh'),
          h('button', { class: 'btn sm', type: 'button', onclick: openInTab }, icon('external', { size: 14 }), 'Open in new tab'))),
      previewNotes,
      frameWrap)));

  // ---- checklist ----
  function targetTab(message) {
    if (/clue/i.test(message)) return 'clues';
    if (/date|title/i.test(message)) return 'setup';
    return 'grid';
  }

  /** Is the published copy behind the draft? (Known from the published file, else from the publish record.) */
  function unpublishedChanges(cur) {
    if (!app.publishedFor(cur)) return false;
    const fp = live.date === cur.date && live.fp ? live.fp : cur.publishedFingerprint;
    return Boolean(fp) && draftFingerprint(cur) !== fp;
  }

  async function loadLive() {
    const cur = d();
    if (!cur || !app.publishedFor(cur)) { live = { date: null, fp: '' }; return; }
    const { date } = cur;
    live = { date, fp: live.date === date ? live.fp : '' };
    try {
      const file = await fetchStatic(`site/puzzles/${date}.json`, 'json');
      if (!alive || d()?.date !== date) return;
      live = { date, fp: file ? puzzleFingerprint(file) : '' };
      render();
    } catch { /* keep what we know */ }
  }

  function render() {
    const cur = d();
    if (!alive || !cur) return;
    const { errors, warnings } = draftToPuzzle(cur);
    // Only words that are in the grid now (a Refill can leave clues behind for words that are gone).
    const autoCount = autoClueCount(cur);
    const pub = app.dateConflict(cur);
    const items = [];
    // Many "needs a clue" errors read better as one line.
    const clueErrors = errors.filter((e) => /needs a clue$/.test(e));
    const otherErrors = errors.filter((e) => !/needs a clue$/.test(e));
    for (const e of otherErrors) items.push(item('error', e, targetTab(e)));
    if (clueErrors.length > 2) {
      const ids = clueErrors.map((e) => e.split(' ')[0]);
      items.push(item('error', `${clueErrors.length} words need a clue (${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ', …' : ''})`, 'clues'));
    } else {
      for (const e of clueErrors) items.push(item('error', e, 'clues'));
    }
    if (autoCount) items.push(item('warn', `${plural(autoCount, 'clue')} suggested automatically still need${autoCount === 1 ? 's' : ''} a look`, 'clues'));
    const staleTheme = staleThemeClues(cur);
    if (staleTheme.length) {
      items.push(item('warn', `${plural(staleTheme.length, 'theme clue')} differ${staleTheme.length === 1 ? 's' : ''} from your theme list (${staleTheme.map((x) => `${x.answer}: “${x.themeClue}”`).join(', ')})`, 'clues'));
    }
    const long = longClues(cur);
    if (long.length) {
      items.push(item('warn', `${long.length === 1 ? `The clue for ${long[0].id} is` : `${long.length} clues are`} long — may wrap on small phones `
        + `(over ${LONG_CLUE_CHARS} characters${long.length > 1 ? `: ${long.slice(0, 8).map((x) => x.id).join(', ')}${long.length > 8 ? ', …' : ''}` : ''})`, 'clues'));
    }
    const repeats = recentRepeats(cur, app.recentFor(cur));
    if (repeats.length) {
      // A warning, not an error: common short answers repeat now and then.
      const date = app.freshnessDate(cur);
      const list = repeats.slice(0, 8).map((r) => `${r.answer} (${r.dates.map((x) => shortDate(x, date)).join(', ')})`).join(', ');
      items.push(item('warn', `${plural(repeats.length, 'answer')} also in puzzles within ${getFillOptions().recentDays} days: ${list}${repeats.length > 8 ? ', …' : ''}`,
        'grid', { sideTab: 'checks' }));
    }
    if (unpublishedChanges(cur)) {
      items.push(item('warn', `Changes since publishing are not live yet — press “Publish update” to send them to solvers`, null));
    }
    for (const w of warnings) items.push(item('warn', w, targetTab(w)));
    if (pub) items.push(item('warn', `#${pub.number} “${pub.title}” is already published on ${formatDate(cur.date, 'short')} — publishing will ask to replace it`, 'setup'));
    if (!errors.length) items.unshift(item('ok', 'Ready to publish', null));
    checklist.replaceChildren(h('ul', { class: 'check-list' }, items));

    // Summary
    const { all } = analyze(cur);
    const number = predictedNumber(cur.date);
    const rows = [
      ['Title', cur.title || '—'],
      ['Author', cur.author || '—'],
      ['Release', isValidDateId(cur.date) ? `${formatDate(cur.date)}${number ? ` · #${number}` : ''}` : 'No date'],
      ['Size', `${cur.width}×${cur.height} · ${plural(all.length, 'word')} · ${cur.cells.filter((c) => c === '#').length} blocks`],
      ['Theme', themeSummary(cur, all)],
    ];
    summary.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', { text: v })]));
    renderPublish(errors);
  }

  function themeSummary(cur, all) {
    if (!cur.theme.length) return '—';
    const inGrid = new Set(all.map((e) => e.answer).filter(Boolean));
    const placed = cur.theme.filter((t) => inGrid.has(t.answer)).length;
    return `${cur.theme.map((t) => t.answer).join(', ')} (${placed} of ${cur.theme.length} in the grid)`;
  }

  /** A checklist row; `tab` makes it a link to that step (`sideTab`: which Grid & Fill side panel to show). */
  function item(level, text, tab, { sideTab = null } = {}) {
    const ic = { error: 'x', warn: 'alert', ok: 'check' }[level];
    const content = [icon(ic, { size: 14 }), h('span', { text })];
    const go = () => {
      if (sideTab) session.sideTab = sideTab;
      ctx.goTab(tab);
    };
    return h('li', { class: ['check', level] }, tab
      ? h('button', { class: 'check-btn', type: 'button', title: 'Go there', onclick: go }, ...content, icon('arrowRight', { size: 12 }))
      : h('div', { class: 'check-btn' }, ...content));
  }

  /** The "#N" this puzzle will get: its position in date order among published puzzles. */
  function predictedNumber(date) {
    if (!isValidDateId(date)) return null;
    const dates = new Set((app.published?.puzzles || []).map((p) => p.date));
    dates.add(date);
    return [...dates].sort().indexOf(date) + 1;
  }

  // ---- publish ----
  function renderPublish(errors) {
    const cur = d();
    // Publishing on a new date shifts the numbers of puzzles dated after it; replacing a date does not.
    const later = app.publishedByDate().has(cur.date) ? 0 : (app.published?.puzzles || []).filter((p) => p.date > cur.date).length;
    const nodes = [h('h2', { class: 'card-title' }, 'Publish')];
    const own = app.publishedFor(cur);
    const behind = unpublishedChanges(cur);
    if (lastPublish && lastPublish.date === cur.date && cur.publishedAt) {
      // A scheduled puzzle is locked for solvers until its day: open it in preview mode instead of "No peeking!".
      const future = cur.date > app.today();
      const url = siteUrlFor(cur.date, app.today());
      nodes.push(h('div', { class: 'note ok publish-done' },
        icon('check', { size: 16 }),
        h('div', null,
          h('strong', null, `Published as #${lastPublish.number ?? '?'} for ${formatDate(cur.date, 'short')}.`),
          h('div', { class: 'small' },
            cur.date > app.today() ? `Solvers will see it on ${formatDate(cur.date)}. ` : 'It is live in your local site now. ',
            'Commit and push site/puzzles/ to put it online.'),
          h('div', { class: 'row gap-sm' },
            h('a', {
              class: 'btn sm', href: url, target: '_blank', rel: 'noopener',
              title: future ? `Solvers can open it from ${formatDate(cur.date)}; this opens a preview` : 'Open it in the player',
            }, icon('external', { size: 14 }), future ? 'Preview in the site' : 'Open in the site'),
            h('a', { class: 'btn sm', href: '#/schedule' }, icon('calendar', { size: 14 }), 'View schedule')))));
    }
    if (isValidDateId(cur.date)) {
      nodes.push(h('p', { class: 'muted small' },
        `Writes site/puzzles/${cur.date}.json and updates the index.`
        + (later ? ` ${plural(later, 'puzzle')} dated later will be renumbered.` : '')));
    }
    if (own && !errors.length) {
      nodes.push(behind
        ? h('p', { class: 'note warn small publish-state' }, icon('alert', { size: 14 }), `You changed this puzzle after publishing it. Solvers still get the published version of #${own.number} until you publish the update.`)
        : (live.fp || cur.publishedFingerprint)
          ? h('p', { class: 'muted small publish-state' }, icon('check', { size: 14 }), ` The published #${own.number} is up to date with this draft.`)
          : null);
    }
    nodes.push(h('div', { class: 'row gap-sm' },
      h('button', {
        class: 'btn primary', type: 'button', disabled: errors.length > 0 || publishing, onclick: publish,
        title: errors.length ? 'Fix the errors in the checklist first' : '',
      }, publishing ? h('span', { class: 'spinner' }) : icon('send', { size: 14 }), own ? 'Publish update' : 'Publish'),
      errors.length ? h('span', { class: 'muted small' }, `${plural(errors.length, 'error')} to fix first`) : null));
    publishBox.replaceChildren(...nodes);
  }

  async function publish() {
    if (publishing) return;
    const cur = d();
    const { id } = cur;
    // The user may open another draft while this runs (requests and dialogs take time): everything below works
    // on THIS draft, never on whatever happens to be open when a request comes back.
    const isOpen = () => store.draft?.id === id;
    const latest = () => (isOpen() ? store.draft : cur);
    // Decide up front whether this replaces a published puzzle, so the server only refuses (409) in a race. The
    // index is re-read first: another tab (or a teammate's commit) may have published meanwhile.
    await app.refreshPublished();
    if (!isOpen()) return;
    const own = app.publishedFor(cur);
    const other = app.dateConflict(cur);
    let overwrite = false;
    if (other) {
      if (!(await confirmReplace(other, cur.date))) return;
      overwrite = true;
    } else if (own) {
      if (cur.date <= app.today() && !(await confirmDialog({
        title: 'Update the live puzzle?',
        message: [`#${own.number} is already out (${formatDate(cur.date)}).`, 'Friends who already started it will see your changes the next time they open it.'],
        confirmLabel: 'Publish update',
      }))) return;
      overwrite = true;
    }
    // Published before under another date? Offer to move it rather than leaving a copy behind.
    const movedFrom = await previousCopy(cur);
    let unpublishOld = false;
    if (movedFrom) {
      const choice = await askMove(movedFrom, cur.date);
      if (!choice) return;
      unpublishOld = choice === 'move';
    }
    if (!isOpen()) return; // switched drafts while a dialog was up: publish nothing
    publishing = true;
    render();
    try {
      await store.flush();
      const draft = latest();
      let res;
      try {
        res = await api.publish(draft, overwrite);
      } catch (err) {
        if (err.status !== 409) throw err;
        // Someone published this date in the meantime (another tab): ask now.
        if (!(await confirmReplace(err.body?.existing || {}, draft.date))) return;
        res = await api.publish(draft, true);
      }
      if (unpublishOld) {
        try {
          await api.unpublish(movedFrom.date);
        } catch (err) {
          toastError(err, `Published, but the copy on ${formatDate(movedFrom.date, 'short')} could not be removed: `);
        }
      }
      lastPublish = { date: res.puzzle.date, number: res.number, url: res.url, replaced: res.replaced };
      session.lastPublish = lastPublish;
      const record = {
        publishedAt: res.puzzle.publishedAt,
        publishedDate: res.puzzle.date,
        publishedFingerprint: puzzleFingerprint(res.puzzle), // to notice later edits that are not published
      };
      if (isOpen()) {
        store.update((x) => { Object.assign(x, record); }, { kind: 'meta' });
      } else {
        await recordPublish(id, record);
      }
      live = { date: res.puzzle.date, fp: record.publishedFingerprint };
      await app.refreshPublished();
      app.clueBank.load(true); // your clues now include this puzzle's
      // The number may have changed if an earlier copy was removed.
      const number = app.publishedByDate().get(res.puzzle.date)?.number ?? res.number;
      lastPublish.number = number;
      toast(`Published ${isOpen() ? '' : `“${res.puzzle.title}” as `}#${number} · ${formatDate(res.puzzle.date, 'short')}${unpublishOld ? ` (removed from ${formatDate(movedFrom.date, 'short')})` : ''}`, { type: 'success' });
      for (const w of res.serverWarnings || []) toast(w, { type: 'warn', timeout: 10000 });
      for (const w of res.warnings || []) console.info('Publish warning:', w);
    } catch (err) {
      if (err.status === 422 && err.body?.errors) {
        toast(`Not published: ${err.body.errors[0]}`, { type: 'error', timeout: 8000 });
      } else {
        toastError(err, 'Publish failed: ');
      }
    } finally {
      publishing = false;
      render();
    }
  }

  /**
   * Note a finished publish on a draft that is no longer open (the user switched drafts while it ran): a
   * version-checked save of just these fields onto the draft as it is on disk.
   */
  async function recordPublish(id, record) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const saved = await api.getDraft(id);
        await api.saveDraft({ ...saved, ...record }, { ifMatch: saved.updatedAt || null });
        await app.refreshDrafts();
        return;
      } catch (err) {
        if (err.status === 409) continue; // saved elsewhere meanwhile: read it again
        toastError(err, 'Published, but the draft could not record it: ');
        return;
      }
    }
  }

  /** Ask before replacing another puzzle on `date`. `ex`: { title, author?, number? }. */
  function confirmReplace(ex, date) {
    return confirmDialog({
      title: 'Replace the published puzzle?',
      message: [
        `${ex.number ? `#${ex.number} ` : ''}“${ex.title || 'A puzzle'}”${ex.author ? ` by ${ex.author}` : ''} is already published for ${formatDate(date)}.`,
        'Publishing replaces it. Anyone who already started it will see the new puzzle.',
      ],
      confirmLabel: 'Replace it',
      danger: true,
    });
  }

  /**
   * The copy this draft published earlier on a different date, if it is still there (and was not replaced by
   * another puzzle since): { date, number, title } or null.
   */
  async function previousCopy(cur) {
    const old = cur.publishedDate;
    if (!old || old === cur.date || !cur.publishedAt) return null;
    const entry = app.publishedByDate().get(old);
    if (!entry) return null;
    try {
      const pub = await fetchStatic(`site/puzzles/${old}.json`, 'json');
      return pub && pub.publishedAt === cur.publishedAt ? { date: old, number: entry.number, title: entry.title } : null;
    } catch {
      return null;
    }
  }

  /** 'move' | 'keep' | undefined (cancel). */
  function askMove(from, to) {
    return openModal({
      title: 'Move the published puzzle?',
      className: 'modal-confirm',
      build: (close) => h('div', null,
        h('p', { text: `This puzzle is already published as #${from.number} on ${formatDate(from.date)}. You are now publishing it for ${formatDate(to)}.` }),
        h('p', { class: 'muted', text: 'Move it (remove it from the old date), or keep it on both dates?' }),
        h('div', { class: 'modal-actions' },
          h('button', { class: 'btn', type: 'button', onclick: () => close(undefined) }, 'Cancel'),
          h('button', { class: 'btn', type: 'button', onclick: () => close('keep') }, 'Keep both'),
          h('button', { class: 'btn primary', type: 'button', onclick: () => close('move') }, `Move to ${formatDate(to, 'short')}`))),
    });
  }

  // ---- preview ----
  let siteChecked = null;
  async function siteExists() {
    if (siteChecked === null) {
      try {
        const res = await fetch('/site/index.html', { method: 'HEAD', cache: 'no-store' });
        siteChecked = res.ok;
      } catch {
        siteChecked = false;
      }
    }
    return siteChecked;
  }

  async function refreshPreview(force = false) {
    const { ok, notes } = writePreview(d(), app.today());
    previewNotes.replaceChildren(...notes.map((n) => h('p', { class: 'note info small' }, n)));
    if (!ok) {
      frameWrap.hidden = true;
      return;
    }
    if (!(await siteExists())) {
      frameWrap.hidden = true;
      previewNotes.append(h('p', { class: 'note warn small' }, 'The player site (site/index.html) is not available yet, so there is nothing to preview.'));
      return;
    }
    frameWrap.hidden = false;
    if (!iframe.getAttribute('src')) iframe.src = PREVIEW_URL;
    else if (force) {
      try { iframe.contentWindow.location.reload(); } catch { iframe.src = PREVIEW_URL; }
    }
  }

  function openInTab() {
    const { ok, notes } = writePreview(d(), app.today());
    if (!ok) { toast(notes[0] || 'Nothing to preview yet', { type: 'warn' }); return; }
    window.open(PREVIEW_URL, '_blank', 'noopener');
  }

  // Keep the preview in sync with edits made while this tab is open (e.g. undo), without reloading on every key.
  let previewTimer = null;
  function refreshPreviewSoon() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => refreshPreview(true), 1200);
  }

  render();
  refreshPreview();
  loadLive();

  return {
    update(detail) {
      render();
      if (detail.kind === 'grid' || detail.kind === 'clues' || detail.kind === 'meta') refreshPreviewSoon();
      const cur = d();
      if (cur && ((detail.kind === 'external' && detail.what === 'published') || detail.kind === 'load' || live.date !== (app.publishedFor(cur) ? cur.date : null))) {
        if (!publishing) loadLive();
      }
    },
    destroy() {
      alive = false;
      clearTimeout(previewTimer);
    },
  };
}
