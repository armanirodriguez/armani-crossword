// Site settings: edits site/config.json through the API (site name, tagline, time zone, share URL, share grid), plus
// a "Claude" card showing whether Ask Claude (Clues step) is connected on this computer.
// There is deliberately no login / passcode / player-name setting: friends just open the site and play.

import { formatDate, todayISO } from '../../../site/shared/puzzle.js';
import { h } from '../dom.js';
import { openModal, toast, toastError } from '../dialogs.js';
import { api } from '../api.js';
import { claudeStatusCard } from '../claude-clues.js';

const FALLBACK_ZONES = [
  'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'America/Sao_Paulo',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Africa/Johannesburg', 'Asia/Kolkata', 'Asia/Singapore',
  'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland', 'UTC',
];

function zones() {
  try {
    const list = Intl.supportedValuesOf('timeZone');
    return list.includes('UTC') ? list : ['UTC', ...list];
  } catch {
    return FALLBACK_ZONES;
  }
}

export function mountSettings(container, app) {
  const cfg = { ...app.config };
  const siteName = h('input', { type: 'text', id: 's-name', maxLength: 80 });
  const tagline = h('input', { type: 'text', id: 's-tag', maxLength: 160 });
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zoneList = zones();
  const tz = h('select', { id: 's-tz' },
    h('option', { value: '' }, 'Each solver’s own local date'),
    zoneList.map((z) => h('option', { value: z }, z.replace(/_/g, ' '))));
  const tzHelp = h('span', { class: 'field-help tz-help' });
  const useMyZone = h('button', {
    class: 'btn sm', type: 'button', hidden: true,
    onclick: () => { tz.value = localZone; renderDynamic(); tz.focus(); },
  }, `Use my time zone (${localZone.replace(/_/g, ' ')})`);
  const shareUrl = h('input', { type: 'url', id: 's-url', maxLength: 500, placeholder: 'https://you.github.io/crossword/' });
  const shareGrid = h('input', { type: 'checkbox', id: 's-grid' });
  const shareLink = h('input', { type: 'checkbox', id: 's-link' });
  const sample = h('pre', { class: 'share-sample' });
  const sampleNote = h('p', { class: 'muted small share-sample-note' });
  const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Save settings');
  const statusEl = h('span', { class: 'muted small' });

  const form = h('form', { class: 'page form-page', onsubmit: (e) => { e.preventDefault(); save(); } },
    h('header', { class: 'page-head' },
      h('h1', null, 'Site settings'),
      h('p', { class: 'muted' }, 'Saved to site/config.json. Anyone with the link can play — there is no login, and progress is kept in each player’s browser.')),
    h('section', { class: 'card' },
      h('div', { class: 'form-grid' },
        field('Site name', siteName, 's-name', 'Shown in the header and in share text.'),
        field('Tagline', tagline, 's-tag', 'A short line under the name.'),
        h('div', { class: 'field span-2' }, h('label', { class: 'field-label', for: 's-tz' }, 'When does the daily puzzle change?'),
          h('div', { class: 'row gap-sm tz-row' }, tz, useMyZone), tzHelp),
        h('div', { class: 'field span-2' },
          h('label', { class: 'field-label', for: 's-url' }, 'Share URL'), shareUrl,
          h('span', { class: 'field-help' }, 'Added to the end of the share text. Leave empty to use the page’s own address.')),
        h('label', { class: 'check-field span-2' }, shareGrid,
          h('span', null, h('strong', null, 'Include the emoji grid in share text'), h('span', { class: 'field-help' }, ' (shows which squares needed help — never the letters)'))),
        h('label', { class: 'check-field span-2' }, shareLink,
          h('span', null, h('strong', null, 'Include the site link in share text'))))),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, 'Share text example'),
      sample,
      sampleNote),
    h('div', { class: 'page-foot' }, statusEl, saveBtn),
    claudeStatusCard());
  container.append(form);

  function field(label, control, id, help) {
    return h('div', { class: 'field' }, h('label', { class: 'field-label', for: id }, label), control, h('span', { class: 'field-help' }, help));
  }

  function fill() {
    siteName.value = cfg.siteName || '';
    tagline.value = cfg.tagline || '';
    tz.value = cfg.timeZone || '';
    shareUrl.value = cfg.shareUrl || '';
    shareGrid.checked = cfg.shareGrid !== false;
    shareLink.checked = cfg.shareLink !== false;
    renderDynamic();
  }

  function current() {
    return {
      siteName: siteName.value.trim(),
      tagline: tagline.value.trim(),
      timeZone: tz.value || null,
      shareUrl: shareUrl.value.trim(),
      shareGrid: shareGrid.checked,
      shareLink: shareLink.checked,
    };
  }

  function dirty() {
    const c = current();
    return Object.keys(c).some((k) => (c[k] ?? null) !== (app.config?.[k] ?? (k === 'shareGrid' || k === 'shareLink' ? true : k === 'timeZone' ? null : '')));
  }

  function renderDynamic() {
    const c = current();
    const today = todayISO(c.timeZone);
    tzHelp.textContent = c.timeZone
      ? 'The new puzzle unlocks at midnight in this zone for everyone; the hosted site picks it up within an hour if you '
        + `use the included GitHub Pages workflow. It is ${formatDate(today)} in ${c.timeZone.replace(/_/g, ' ')} now.`
      : 'Each solver gets the new puzzle at their own midnight, so friends in other time zones are on different puzzles '
        + 'for part of the day. Pick a zone to switch everyone at the same moment.';
    useMyZone.hidden = Boolean(c.timeZone) || !zoneList.includes(localZone);
    const lines = [`🧩 ${c.siteName || 'Armani Crossword'} #12 · Sat, Oct 3`, '⏱️ 4:32 · 🔍 1 checked'];
    if (c.shareGrid) lines.push('⬛🟩🟩🟩🟩', '🟩🟩🟩🟩🟩', '🟩🟩🟨🟩🟩', '🟩🟩🟩🟩🟩', '🟩🟩🟩🟩⬛');
    // With no share URL the player uses the address friends opened, i.e. the live site, never this dev server.
    if (c.shareLink) lines.push(c.shareUrl || 'https://your-site-address/');
    sample.textContent = lines.join('\n');
    sampleNote.textContent = c.shareUrl
      ? ''
      : 'The last line will be your site’s real address (e.g. https://you.github.io/crossword/), filled in automatically on the live site.';
    statusEl.textContent = dirty() ? 'Unsaved changes' : '';
  }
  for (const el of [siteName, tagline, tz, shareUrl, shareGrid, shareLink]) {
    el.addEventListener('input', renderDynamic);
    el.addEventListener('change', renderDynamic);
  }

  /** Resolves true when saved. */
  async function save() {
    const c = current();
    if (c.shareUrl && !/^https?:\/\/\S+$/i.test(c.shareUrl)) {
      toast('The share URL must start with http:// or https://', { type: 'warn' });
      shareUrl.focus();
      return false;
    }
    saveBtn.disabled = true;
    try {
      app.config = await api.saveConfig(c);
      Object.assign(cfg, app.config);
      app.emit('config');
      // site/config.json reaches the live site when it is put online (commit + push).
      toast('Settings saved', {
        type: 'success',
        action: app.goLive?.status?.ready ? { label: 'Put it online', onClick: () => app.goLive.run({ announce: true }) } : null,
      });
      fill();
      return true;
    } catch (err) {
      toastError(err, 'Could not save: ');
      return false;
    } finally {
      saveBtn.disabled = false;
    }
  }

  /** Leaving with unsaved edits: Save / Discard / Stay. Resolves true when it is OK to leave. */
  async function canLeave() {
    if (!dirty()) return true;
    const choice = await openModal({
      title: 'Unsaved settings',
      className: 'modal-confirm',
      build: (close) => h('div', null,
        h('p', { text: 'You changed the site settings but did not save them.' }),
        h('div', { class: 'modal-actions' },
          h('button', { class: 'btn danger-ghost', type: 'button', onclick: () => close('discard') }, 'Discard changes'),
          h('button', { class: 'btn', type: 'button', onclick: () => close('stay') }, 'Stay here'),
          h('button', { class: 'btn primary', type: 'button', onclick: () => close('save') }, 'Save settings'))),
    });
    if (choice === 'discard') return true;
    if (choice === 'save') return save();
    return false;
  }

  fill();
  return { canLeave, isDirty: dirty };
}
