// "New puzzle" dialog: a name and a size are all that is needed to start; everything else has good defaults
// (author remembered, release date = next free day).

import { formatDate } from '../../site/shared/puzzle.js';
import { h } from './dom.js';
import { openModal, toastError } from './dialogs.js';
import { SIZE_PRESETS } from './draft-utils.js';
import { getPref, setPref } from './prefs.js';

export async function openNewDraftDialog(app, { date = null } = {}) {
  let size = getPref('lastSize', 9);
  if (!SIZE_PRESETS.some((p) => p.w === size)) size = 9;
  const when = date || app.suggestDate();

  const result = await openModal({
    title: 'New puzzle',
    className: 'modal-new',
    initialFocus: 'input[name="title"]',
    build: (close) => {
      const title = h('input', { name: 'title', type: 'text', placeholder: 'e.g. Spooky Season', maxLength: 80, autocomplete: 'off' });
      const sizes = h('div', { class: 'size-picks', role: 'radiogroup', 'aria-label': 'Grid size' },
        SIZE_PRESETS.map((p) => h('label', { class: 'size-pick' },
          h('input', { type: 'radio', name: 'size', value: p.w, checked: p.w === size }),
          h('span', { class: 'sp-box' },
            h('span', { class: 'sp-grid', style: { '--n': Math.min(p.w, 9) } }),
            h('strong', null, p.label),
            h('small', null, p.hint)))));
      const form = h('form', {
        class: 'stack',
        onsubmit: (e) => {
          e.preventDefault();
          const picked = Number(form.querySelector('input[name="size"]:checked')?.value || 9);
          close({ title: title.value.trim(), size: picked });
        },
      },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Puzzle title'), title,
        h('span', { class: 'field-help' }, 'You can change everything later.')),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Grid size'), sizes,
        h('span', { class: 'field-help' }, 'Minis (5×5) are quick to make and solve. 15×15 is the classic daily size.')),
      h('p', { class: 'muted small' }, `Release date: ${formatDate(when)} (next free day — change it in Setup).`),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => close(undefined) }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'submit' }, 'Create puzzle')));
      return form;
    },
  });
  if (!result) return;
  setPref('lastSize', result.size);
  try {
    await app.createDraft({ title: result.title, width: result.size, height: result.size, date: when });
  } catch (err) {
    toastError(err, 'Could not create the draft: ');
  }
}
