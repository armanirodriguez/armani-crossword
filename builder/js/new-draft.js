// "New puzzle" dialog: a name, a size and a kind (Mini / Midi / Daily) are all that is needed to start; everything
// else has good defaults (author remembered, release date = the next day without a puzzle of that kind).
// The kind follows the size until the user picks one.

import { formatDate } from '../../site/shared/puzzle.js';
import { h } from './dom.js';
import { openModal, toastError } from './dialogs.js';
import { SIZE_PRESETS } from './draft-utils.js';
import { getPref, setPref } from './prefs.js';
import { KINDS, kindLabel, numberLabel, puzzleKind, suggestKind } from './kinds.js';

/**
 * Options: date — plan the puzzle for this day (from the Schedule / Home "Plan" buttons); kind — start with this
 * kind picked (e.g. the first free kind of that day).
 */
export async function openNewDraftDialog(app, { date = null, kind = null } = {}) {
  let size = getPref('lastSize', 9);
  if (!SIZE_PRESETS.some((p) => p.w === size)) size = 9;
  let chosenKind = KINDS.includes(kind) ? kind : null; // null = follow the size
  const kindNow = () => chosenKind || suggestKind(size, size);
  const whenFor = (k) => date || app.suggestDate(null, k);

  const result = await openModal({
    title: 'New puzzle',
    className: 'modal-new',
    initialFocus: 'input[name="title"]',
    build: (close) => {
      const title = h('input', { name: 'title', type: 'text', placeholder: 'e.g. Spooky Season', maxLength: 80, autocomplete: 'off' });
      const sizes = h('div', { class: 'size-picks', role: 'radiogroup', 'aria-label': 'Grid size' },
        SIZE_PRESETS.map((p) => h('label', { class: 'size-pick' },
          h('input', {
            type: 'radio', name: 'size', value: p.w, checked: p.w === size,
            onchange: () => { size = p.w; renderKind(); },
          }),
          h('span', { class: 'sp-box' },
            h('span', { class: 'sp-grid', style: { '--n': Math.min(p.w, 9) } }),
            h('strong', null, p.label),
            h('small', null, p.hint)))));
      const kindInputs = KINDS.map((k) => h('input', {
        type: 'radio', name: 'kind', value: k,
        onchange: () => { chosenKind = k; renderKind(); },
      }));
      const kinds = h('div', { class: 'seg kind-seg', role: 'radiogroup', 'aria-label': 'Kind of puzzle' },
        KINDS.map((k, i) => h('label', { class: 'seg-item' }, kindInputs[i], h('span', null, kindLabel(k)))));
      const kindHelp = h('span', { class: 'field-help' });
      const when = h('p', { class: 'muted small new-when' });

      function renderKind() {
        const k = kindNow();
        kindInputs.forEach((input, i) => { input.checked = KINDS[i] === k; });
        kindHelp.textContent = chosenKind
          ? 'Each day can have one Mini, one Midi and one Daily.'
          : `Follows the size (${size}×${size} → ${kindLabel(k)}) until you pick one. Each day can have one of each.`;
        const day = whenFor(k);
        const taken = date ? app.publishedOn(date).find((p) => puzzleKind(p) === k) : null;
        when.classList.toggle('warn-text', Boolean(taken));
        when.textContent = taken
          ? `Release date: ${formatDate(day)} — ${numberLabel(taken)} “${taken.title}” is already published that day (pick another kind, or change the date in Setup).`
          : `Release date: ${formatDate(day)} (${date ? 'change it in Setup' : `next free day for a ${kindLabel(k)} — change it in Setup`}).`;
      }
      renderKind();

      const form = h('form', {
        class: 'stack',
        onsubmit: (e) => {
          e.preventDefault();
          close({ title: title.value.trim(), size, kind: kindNow(), kindChosen: Boolean(chosenKind) });
        },
      },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Puzzle title'), title,
        h('span', { class: 'field-help' }, 'You can change everything later.')),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Grid size'), sizes,
        h('span', { class: 'field-help' }, 'Minis (5×5) are quick to make and solve. 15×15 is the classic daily size.')),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Kind'), kinds, kindHelp),
      when,
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => close(undefined) }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'submit' }, 'Create puzzle')));
      return form;
    },
  });
  if (!result) return;
  setPref('lastSize', result.size);
  try {
    await app.createDraft({
      title: result.title, width: result.size, height: result.size, kind: result.kind, kindChosen: result.kindChosen,
      date: whenFor(result.kind),
    });
  } catch (err) {
    toastError(err, 'Could not create the draft: ');
  }
}
