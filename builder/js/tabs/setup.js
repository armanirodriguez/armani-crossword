// Setup tab: title, author (remembered), release date (with conflict warnings and a "next free date" helper),
// grid size, symmetry, note for solvers.

import { isSymmetric } from '../../../site/shared/grid.js';
import { formatDate, isValidDateId } from '../../../site/shared/puzzle.js';
import { h, icon } from '../dom.js';
import { confirmDialog } from '../dialogs.js';
import {
  MAX_BUILDER_SIZE, MIN_SIZE, SIZE_PRESETS, gridHasContent, gridOf, resizeDraft,
} from '../draft-utils.js';
import { setPref } from '../prefs.js';

const SYMMETRIES = [
  { id: 'rotational', label: 'Rotational', help: 'Standard: the grid looks the same upside down.' },
  { id: 'mirror', label: 'Mirror', help: 'Left and right halves mirror each other.' },
  { id: 'none', label: 'None', help: 'Free-form blocks.' },
];

export function mountSetup(container, ctx) {
  const { store, app } = ctx;
  const d = () => store.draft;
  const meta = (fn) => store.update(fn, { kind: 'meta' });

  // ---- fields ----
  const title = h('input', {
    type: 'text', id: 'f-title', maxLength: 80, value: d().title, placeholder: 'e.g. Spooky Season',
    oninput: () => meta((x) => { x.title = title.value; }),
  });
  const author = h('input', {
    type: 'text', id: 'f-author', maxLength: 80, value: d().author, placeholder: 'Your name (shown on the puzzle)',
    oninput: () => {
      meta((x) => { x.author = author.value; });
      setPref('author', author.value.trim());
    },
  });
  const date = h('input', {
    type: 'date', id: 'f-date', value: d().date,
    onchange: () => meta((x) => { x.date = isValidDateId(date.value) ? date.value : ''; }),
  });
  const dateInfo = h('div', { class: 'date-info' });
  const note = h('textarea', {
    id: 'f-note', rows: 3, maxLength: 600, value: d().note,
    placeholder: 'Optional. Shown on the intro screen before solvers start, e.g. “Happy Halloween! Circled letters spell a costume.”',
    oninput: () => meta((x) => { x.note = note.value; }),
  });

  const sizeGroup = h('div', { class: 'size-picks inline', role: 'radiogroup', 'aria-label': 'Grid size' });
  const customW = h('input', { type: 'number', min: MIN_SIZE, max: MAX_BUILDER_SIZE, class: 'num', 'aria-label': 'Custom width' });
  const customH = h('input', { type: 'number', min: MIN_SIZE, max: MAX_BUILDER_SIZE, class: 'num', 'aria-label': 'Custom height' });
  const customApply = h('button', { class: 'btn sm', type: 'button', onclick: () => applySize(Number(customW.value), Number(customH.value)) }, 'Apply');
  const sizeNote = h('p', { class: 'field-help' });

  const symGroup = h('div', { class: 'seg-cards', role: 'radiogroup', 'aria-label': 'Symmetry' });
  const symNote = h('p', { class: 'field-help' });

  container.append(h('div', { class: 'form-page' },
    h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, 'About this puzzle'),
      h('div', { class: 'form-grid' },
        field('Title', title, 'f-title', 'Shown to solvers and in the share text archive.'),
        field('Author', author, 'f-author', 'Remembered for your next puzzle.'),
        h('div', { class: 'field span-2' },
          h('label', { class: 'field-label', for: 'f-date' }, 'Release date'),
          h('div', { class: 'row gap-sm' }, date),
          dateInfo),
        h('div', { class: 'field span-2' },
          h('label', { class: 'field-label', for: 'f-note' }, 'Note for solvers'),
          note))),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, 'Grid'),
      h('div', { class: 'field' },
        h('span', { class: 'field-label' }, 'Size'),
        sizeGroup,
        h('div', { class: 'row gap-sm custom-size' },
          h('span', { class: 'muted' }, 'Custom'), customW, h('span', { class: 'muted' }, '×'), customH, customApply,
          h('span', { class: 'muted small' }, `${MIN_SIZE}–${MAX_BUILDER_SIZE} squares`)),
        sizeNote),
      h('div', { class: 'field' },
        h('span', { class: 'field-label' }, 'Symmetry'),
        symGroup,
        symNote)),
    h('div', { class: 'page-foot' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => ctx.goTab('theme') }, 'Next: Theme & Layout', icon('arrowRight')))));

  function field(label, control, id, help) {
    return h('div', { class: 'field' },
      h('label', { class: 'field-label', for: id }, label), control,
      help ? h('span', { class: 'field-help' }, help) : null);
  }

  // ---- size ----
  async function applySize(w, hgt) {
    if (!Number.isInteger(w) || !Number.isInteger(hgt) || w < MIN_SIZE || hgt < MIN_SIZE || w > MAX_BUILDER_SIZE || hgt > MAX_BUILDER_SIZE) {
      sizeNote.textContent = `Width and height must be whole numbers from ${MIN_SIZE} to ${MAX_BUILDER_SIZE}.`;
      sizeNote.classList.add('error');
      return;
    }
    const cur = d();
    if (w === cur.width && hgt === cur.height) return;
    if (gridHasContent(cur)) {
      const ok = await confirmDialog({
        title: 'Change the grid size?',
        message: `The ${cur.width}×${cur.height} grid will be replaced by an empty ${w}×${hgt} grid. Your clues and theme list are kept, and you can undo this.`,
        confirmLabel: 'Change size',
      });
      if (!ok) { renderSize(); return; }
    }
    store.update((x) => resizeDraft(x, w, hgt), { kind: 'grid', label: 'resize' });
    ctx.session.index = 0;
    ctx.session.layoutJob?.cancel(); // layouts for the old size are of no use
    ctx.session.layouts = null;
  }

  // Radios are built once and only their checked state is updated (rebuilding would steal keyboard focus).
  const sizeRadios = SIZE_PRESETS.map((p) => {
    const input = h('input', { type: 'radio', name: 'setup-size', value: p.w, onchange: () => applySize(p.w, p.h) });
    sizeGroup.append(h('label', { class: 'size-pick' }, input,
      h('span', { class: 'sp-box' },
        h('span', { class: 'sp-grid', style: { '--n': Math.min(p.w, 9) } }),
        h('strong', null, p.label), h('small', null, p.hint))));
    return { p, input };
  });

  function renderSize() {
    const cur = d();
    for (const { p, input } of sizeRadios) input.checked = cur.width === p.w && cur.height === p.h;
    if (document.activeElement !== customW && document.activeElement !== customH) {
      customW.value = cur.width;
      customH.value = cur.height;
    }
    sizeNote.classList.remove('error');
    sizeNote.textContent = gridHasContent(cur)
      ? 'Changing the size starts a new empty grid (undo with Ctrl+Z).'
      : 'Pick a size, then add theme words on the next step.';
  }

  // ---- symmetry ----
  const symRadios = SYMMETRIES.map((sym) => {
    const input = h('input', {
      type: 'radio', name: 'setup-sym', value: sym.id, onchange: () => meta((x) => { x.symmetry = sym.id; }),
    });
    symGroup.append(h('label', { class: 'seg-card' }, input,
      h('span', { class: 'sc-box' }, h('strong', null, sym.label), h('small', null, sym.help))));
    return { sym, input };
  });

  function renderSymmetry() {
    const cur = d();
    for (const { sym, input } of symRadios) input.checked = cur.symmetry === sym.id;
    const broken = cur.symmetry !== 'none' && cur.cells.includes('#') && !isSymmetric(gridOf(cur), cur.symmetry);
    symNote.textContent = broken
      ? `The current blocks are not ${cur.symmetry}-symmetric. New blocks will be mirrored; existing ones are left alone.`
      : 'Placing a block in the Grid tab also places its symmetric partner.';
    symNote.classList.toggle('warn', broken);
  }

  // ---- date ----
  function renderDate() {
    const cur = d();
    if (document.activeElement !== date) date.value = cur.date;
    const items = [];
    const today = app.today();
    const suggestion = app.suggestDate(cur.id);
    if (cur.date) {
      items.push(h('span', { class: 'muted' }, formatDate(cur.date)));
      const mine = app.publishedFor(cur);
      const clash = app.dateConflict(cur);
      if (clash) {
        items.push(h('p', { class: 'note warn' }, icon('alert', { size: 14 }),
          `#${clash.number} “${clash.title}” is already published on this date. Publishing will ask before replacing it.`));
      } else if (mine) {
        items.push(h('p', { class: 'note ok' }, icon('check', { size: 14 }), `Published as #${mine.number}. Publishing again updates it.`));
      }
      const pub = mine || clash;
      const other = app.drafts.find((x) => x.id !== cur.id && x.date === cur.date);
      if (other) items.push(h('p', { class: 'note info' }, `Another draft (“${other.title || 'Untitled'}”) is also planned for this date.`));
      if (cur.date < today && !pub) items.push(h('p', { class: 'note info' }, 'This date is in the past: the puzzle will appear in the archive right away.'));
    } else {
      items.push(h('p', { class: 'note warn' }, 'Pick the day this puzzle goes live (one puzzle per day).'));
    }
    if (suggestion !== cur.date) {
      items.push(h('button', {
        class: 'btn sm link', type: 'button',
        onclick: () => { meta((x) => { x.date = suggestion; }); },
      }, `Use next free date: ${formatDate(suggestion, 'short')}`));
    }
    dateInfo.replaceChildren(...items);
  }

  function render() {
    if (document.activeElement !== title) title.value = d().title;
    if (document.activeElement !== author) author.value = d().author;
    if (document.activeElement !== note) note.value = d().note;
    renderSize();
    renderSymmetry();
    renderDate();
  }
  render();

  return {
    update(detail) {
      if (detail.kind === 'clues') return;
      render();
    },
    destroy() {},
  };
}
