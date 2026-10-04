// Setup tab: title, author (remembered), kind (Mini / Midi / Daily), release date (with conflict warnings and a
// "next free date" helper, both per kind), grid size, symmetry, note for solvers.

import { isSymmetric } from '../../../site/shared/grid.js';
import { formatDate, isValidDateId } from '../../../site/shared/puzzle.js';
import { h, icon } from '../dom.js';
import { confirmDialog } from '../dialogs.js';
import {
  MAX_BUILDER_SIZE, MIN_SIZE, SIZE_PRESETS, gridHasContent, gridOf, resizeDraft,
} from '../draft-utils.js';
import { setPref } from '../prefs.js';
import {
  KINDS, KIND_HELP, draftKind, draftPuzzleId, kindLabel, numberLabel, puzzleKind, recordedPuzzleId, suggestKind,
} from '../kinds.js';

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
  const kindGroup = h('div', { class: 'seg-cards kind-picks', role: 'radiogroup', 'aria-label': 'Kind of puzzle' });
  const kindNote = h('p', { class: 'field-help' });
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
          h('span', { class: 'field-label', id: 'f-kind-label' }, 'Kind'),
          kindGroup,
          kindNote),
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
    store.update((x) => {
      resizeDraft(x, w, hgt);
      // The kind follows the size until the user picks one (never for a published draft: that would move it).
      if (followsSize(x)) x.kind = suggestKind(w, hgt);
    }, { kind: 'grid', label: 'resize' });
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

  // ---- kind ----
  /** True while the kind is the size's default rather than the user's choice. */
  function followsSize(x) {
    return x.kindSource !== 'user' && !x.publishedAt;
  }

  const kindRadios = KINDS.map((k) => {
    const input = h('input', {
      type: 'radio', name: 'setup-kind', value: k,
      onchange: () => meta((x) => {
        // Pin down where it was published before the kind changes (older drafts only recorded the date).
        if (x.publishedAt && !x.publishedId && recordedPuzzleId(x)) x.publishedId = recordedPuzzleId(x);
        x.kind = k;
        x.kindSource = 'user';
      }),
    });
    kindGroup.append(h('label', { class: 'seg-card', 'data-kind': k }, input,
      h('span', { class: 'sc-box' }, h('strong', null, kindLabel(k)), h('small', null, KIND_HELP[k]))));
    return { k, input };
  });

  function renderKind() {
    const cur = d();
    const kind = draftKind(cur);
    for (const { k, input } of kindRadios) input.checked = kind === k;
    const suggested = suggestKind(cur.width, cur.height);
    const recorded = cur.publishedAt ? recordedPuzzleId(cur) : null;
    const pub = recorded ? app.publishedById().get(recorded) : null;
    kindNote.classList.remove('warn');
    if (pub && recorded !== draftPuzzleId(cur) && cur.date === pub.date) {
      // Same day, other kind: publishing puts it in the other slot (Review asks whether to remove the old one).
      kindNote.textContent = `Published as ${numberLabel(pub)}. Publishing it as a ${kindLabel(kind)} adds a new puzzle; you will be asked whether to remove the ${kindLabel(puzzleKind(pub))}.`;
      kindNote.classList.add('warn');
    } else if (followsSize(cur) && kind === suggested) {
      kindNote.textContent = `Follows the grid size (${cur.width}×${cur.height} → ${kindLabel(suggested)}) until you pick one. Each day can have one Mini, one Midi and one Daily.`;
    } else {
      kindNote.textContent = `Each day can have one Mini, one Midi and one Daily.${kind !== suggested ? ` (A ${cur.width}×${cur.height} grid is usually a ${kindLabel(suggested)}.)` : ''}`;
    }
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
    const kind = draftKind(cur);
    const label = kindLabel(kind);
    const items = [];
    const today = app.today();
    const suggestion = app.suggestDate(cur.id, kind);
    if (cur.date) {
      items.push(h('span', { class: 'muted' }, formatDate(cur.date)));
      const mine = app.publishedFor(cur);
      const clash = app.dateConflict(cur);
      if (clash) {
        items.push(h('p', { class: 'note warn' }, icon('alert', { size: 14 }),
          `${numberLabel(clash)} “${clash.title}” is already published on this date. Publishing will ask before replacing it.`));
      } else if (mine) {
        items.push(h('p', { class: 'note ok' }, icon('check', { size: 14 }), `Published as ${numberLabel(mine)}. Publishing again updates it.`));
      }
      const pub = mine || clash;
      const other = app.drafts.find((x) => x.id !== cur.id && x.date === cur.date && draftKind(x) === kind);
      if (other) items.push(h('p', { class: 'note info' }, `Another ${label} draft (“${other.title || 'Untitled'}”) is also planned for this date.`));
      // The other kinds of that day are fine (one of each per day); mention them so the day's line-up is clear.
      const sameDay = app.publishedOn(cur.date).filter((p) => p !== pub);
      if (sameDay.length) {
        items.push(h('p', { class: 'note info small' },
          `Also on this day: ${sameDay.map((p) => `${numberLabel(p)} “${p.title}”`).join(', ')}.`));
      }
      if (cur.date < today && !pub) items.push(h('p', { class: 'note info' }, 'This date is in the past: the puzzle will appear in the archive right away.'));
    } else {
      items.push(h('p', { class: 'note warn' }, 'Pick the day this puzzle goes live (each day has room for one Mini, one Midi and one Daily).'));
    }
    if (suggestion !== cur.date) {
      items.push(h('button', {
        class: 'btn sm link', type: 'button',
        onclick: () => { meta((x) => { x.date = suggestion; }); },
      }, `Use next free date for a ${label}: ${formatDate(suggestion, 'short')}`));
    }
    dateInfo.replaceChildren(...items);
  }

  function render() {
    if (document.activeElement !== title) title.value = d().title;
    if (document.activeElement !== author) author.value = d().author;
    if (document.activeElement !== note) note.value = d().note;
    renderSize();
    renderKind();
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
