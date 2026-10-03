// Overlays: toasts, modal dialogs, confirm, popover menus and bottom sheets.
//
// Open overlays form a stack; Escape dismisses the top one, Tab is trapped inside it, and focus returns to
// where it was when it closes. The game's keyboard handler asks isOverlayOpen() before acting on keys.

import { h, prefersReducedMotion } from './dom.js';
import { icon } from './icons.js';

const stack = [];

export function isOverlayOpen() {
  return stack.length > 0;
}

/** Close every open modal/menu/sheet (e.g. on navigation). */
export function closeAllOverlays() {
  for (const layer of [...stack].reverse()) layer.close(null);
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function onKeyDown(e) {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    if (top.dismissible) top.close(null);
    return;
  }
  if (e.key === 'Tab') {
    const items = [...top.el.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const inside = top.el.contains(document.activeElement);
    if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
  }
}

function pushLayer(layer) {
  if (!stack.length) document.addEventListener('keydown', onKeyDown, true);
  stack.push(layer);
}

function removeLayer(layer) {
  const i = stack.indexOf(layer);
  if (i >= 0) stack.splice(i, 1);
  if (!stack.length) document.removeEventListener('keydown', onKeyDown, true);
}

/** Remove `el` after its exit transition (immediately with reduced motion). */
function animateOut(el, ms = 180) {
  el.classList.add('is-leaving');
  el.classList.remove('is-open');
  if (prefersReducedMotion()) { el.remove(); return; }
  setTimeout(() => el.remove(), ms);
}

function animateIn(el) {
  document.body.append(el);
  // Next frame so the transition runs from the initial state.
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-open')));
}

/** Generic layer: backdrop + panel, closes with a value. */
function createLayer({ className, panel, dismissible = true, onClose, labelledBy, role = 'dialog', closeOnBackdrop = dismissible }) {
  const restoreFocus = document.activeElement;
  const root = h('div', { class: ['layer', className] });
  const backdrop = h('div', { class: 'layer-backdrop' });
  panel.setAttribute('role', role);
  if (role === 'dialog') panel.setAttribute('aria-modal', 'true');
  if (labelledBy) panel.setAttribute('aria-labelledby', labelledBy);
  root.append(backdrop, panel);
  let resolve;
  const result = new Promise((r) => { resolve = r; });
  let closed = false;
  const layer = {
    el: panel,
    root,
    dismissible,
    result,
    close(value = null) {
      if (closed) return;
      closed = true;
      removeLayer(layer);
      animateOut(root);
      onClose?.(value);
      resolve(value);
      try { restoreFocus?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
    },
  };
  if (closeOnBackdrop) backdrop.addEventListener('pointerdown', (e) => { e.preventDefault(); layer.close(null); });
  pushLayer(layer);
  animateIn(root);
  return layer;
}

let idSeq = 0;
const nextId = (p) => `${p}-${++idSeq}`;

/**
 * Modal dialog.
 * @param {object} o
 * @param {string} o.title
 * @param {Node|string|Array} [o.body]
 * @param {Array<{label:string, value:any, primary?:boolean, danger?:boolean, icon?:string, onClick?:Function}>} [o.actions]
 * @param {boolean} [o.dismissible=true]
 * @param {Node} [o.hero] decorative element above the title
 * @returns layer with .close(value) and .result (Promise of the chosen value, null when dismissed)
 */
export function openModal({ title, body = null, actions = [], dismissible = true, hero = null, className = '' }) {
  const titleId = nextId('modal-title');
  const actionsEl = h('div', { class: 'modal-actions' });
  const panel = h('div', { class: ['modal', className] },
    dismissible && h('button', { class: 'icon-btn modal-close', type: 'button', 'aria-label': 'Close' }, icon('close', { size: 20 })),
    hero,
    h('h2', { class: 'modal-title', id: titleId }, title),
    body && h('div', { class: 'modal-body' }, body),
    actions.length ? actionsEl : null,
  );
  const layer = createLayer({ className: 'layer-modal', panel, dismissible, labelledBy: titleId });
  panel.querySelector('.modal-close')?.addEventListener('click', () => layer.close(null));
  for (const a of actions) {
    const btn = h('button', {
      type: 'button',
      class: ['btn', a.primary ? 'btn-primary' : 'btn-secondary', a.danger && 'btn-danger'],
    }, a.icon && icon(a.icon, { size: 20 }), h('span', null, a.label));
    btn.addEventListener('click', (e) => {
      if (a.onClick) {
        const keepOpen = a.onClick(e, layer) === false;
        if (keepOpen) return;
      }
      layer.close(a.value);
    });
    actionsEl.append(btn);
  }
  // Focus the primary action (or the first button) once visible.
  const focusTarget = actionsEl.querySelector('.btn-primary') || panel.querySelector('button');
  setTimeout(() => focusTarget?.focus({ preventScroll: true }), 30);
  return layer;
}

/** Confirmation dialog -> Promise<boolean>. */
export function confirmDialog({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  const layer = openModal({
    title,
    body: h('p', null, message),
    actions: [
      { label: cancelLabel, value: false },
      { label: confirmLabel, value: true, primary: true, danger },
    ],
    className: 'modal-confirm',
  });
  // Default focus on Cancel for destructive actions.
  if (danger) setTimeout(() => layer.el.querySelector('.btn-secondary')?.focus({ preventScroll: true }), 40);
  return layer.result.then((v) => v === true);
}

/** Shows the text in a selectable textarea when copying is impossible. */
export function showCopyFallback(text, title = 'Copy your result') {
  const ta = h('textarea', { class: 'copy-fallback', readonly: true, rows: Math.min(12, text.split('\n').length + 1), 'aria-label': 'Result text' });
  ta.value = text;
  const layer = openModal({
    title,
    body: [h('p', { class: 'muted' }, 'Select the text below and copy it.'), ta],
    actions: [{ label: 'Done', value: true, primary: true }],
  });
  setTimeout(() => { ta.focus(); ta.select(); }, 60);
  return layer;
}

/**
 * Popover menu anchored to a button (a bottom sheet on narrow screens).
 * sections: [{ title, items: [{ label, hint?, icon?, danger?, disabled?, onSelect }] }]
 */
export function openMenu(anchor, sections, { label = 'Menu' } = {}) {
  // Narrow screens and short ones (phones in landscape) get the bottom sheet: an anchored popover would run
  // off the bottom of a ~340 px tall screen.
  const narrow = window.innerWidth < 560 || window.innerHeight < 500;
  const panel = h('div', { class: ['menu', narrow && 'menu-sheet'], 'aria-label': label });
  for (const section of sections) {
    const group = h('div', { class: 'menu-section', role: 'group', 'aria-label': section.title });
    if (section.title) group.append(h('div', { class: 'menu-heading' }, section.title));
    for (const item of section.items) {
      const btn = h('button', { type: 'button', role: 'menuitem', class: ['menu-item', item.danger && 'is-danger'], disabled: item.disabled },
        item.icon && icon(item.icon, { size: 18 }),
        h('span', { class: 'menu-label' }, item.label),
        item.hint && h('span', { class: 'menu-hint' }, item.hint));
      btn.addEventListener('click', () => { layer.close('select'); item.onSelect?.(); });
      group.append(btn);
    }
    panel.append(group);
  }
  const layer = createLayer({ className: ['layer-menu', narrow && 'layer-menu-sheet'].filter(Boolean).join(' '), panel, role: 'menu' });
  anchor?.setAttribute('aria-expanded', 'true');
  layer.result.then(() => anchor?.setAttribute('aria-expanded', 'false'));
  if (!narrow && anchor) {
    // Position below the anchor, right-aligned to it, kept inside the viewport.
    const r = anchor.getBoundingClientRect();
    const top = Math.round(r.bottom + 8);
    panel.style.top = `${top}px`;
    panel.style.maxHeight = `${Math.max(160, window.innerHeight - top - 8)}px`; // scrolls rather than overflow
    const right = Math.max(8, window.innerWidth - r.right);
    panel.style.right = `${Math.round(right)}px`;
  }
  setTimeout(() => panel.querySelector('button:not([disabled])')?.focus({ preventScroll: true }), 30);
  return layer;
}

/** Bottom sheet with a title and scrollable content. */
export function openSheet({ title, content, className = '', onClose }) {
  const titleId = nextId('sheet-title');
  const panel = h('div', { class: ['sheet', className] },
    h('div', { class: 'sheet-header' },
      h('h2', { class: 'sheet-title', id: titleId }, title),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close' }, icon('close', { size: 20 }))),
    h('div', { class: 'sheet-body' }, content));
  const layer = createLayer({ className: 'layer-sheet', panel, labelledBy: titleId, onClose });
  panel.querySelector('.sheet-header .icon-btn').addEventListener('click', () => layer.close(null));
  return layer;
}

// ---------------------------------------------------------------------------
// Toasts

let toastHost = null;

/** Show a short message. Identical messages already on screen are refreshed instead of stacked. */
export function toast(message, { duration = 2600, tone = 'info' } = {}) {
  if (!toastHost || !toastHost.isConnected) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  let el = [...toastHost.children].find((c) => c.dataset.message === message && !c.classList.contains('is-leaving'));
  if (!el) {
    el = h('div', { class: ['toast', `toast-${tone}`], dataset: { message } }, message);
    toastHost.append(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-open')));
  }
  clearTimeout(el._timer);
  el._timer = setTimeout(() => animateOut(el, 220), duration);
  return el;
}
