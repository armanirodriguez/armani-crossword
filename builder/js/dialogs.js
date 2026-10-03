// Custom modal dialogs and toasts (the builder never uses window.confirm / alert / prompt).

import { h, icon } from './dom.js';

/**
 * Open a modal <dialog>. `build(close)` returns the dialog body; call `close(value)` to resolve.
 * Escape / backdrop click resolve with `undefined`. Focus returns to the previously focused element.
 */
export function openModal({ title, className = '', build, initialFocus = null }) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const dlg = h('dialog', { class: ['modal', className], 'aria-label': title });
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      dlg.close();
      dlg.remove();
      if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus();
      resolve(value);
    };
    dlg.append(
      h('header', { class: 'modal-head' },
        h('h2', { text: title }),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => close(undefined) }, icon('x'))),
      h('div', { class: 'modal-body' }, build(close)),
    );
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(undefined); });
    dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) close(undefined); });
    document.body.appendChild(dlg);
    dlg.showModal();
    const focusEl = initialFocus ? dlg.querySelector(initialFocus) : dlg.querySelector('[autofocus], .modal-actions .btn.primary, .modal-actions .btn.danger');
    focusEl?.focus();
  });
}

/**
 * Ask a yes/no question. Resolves true only when the confirm button is pressed.
 *   await confirmDialog({ title: 'Delete draft?', message: '…', confirmLabel: 'Delete', danger: true })
 */
export async function confirmDialog({ title, message, details = null, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  const result = await openModal({
    title,
    className: 'modal-confirm',
    build: (close) => h('div', null,
      ...(Array.isArray(message) ? message : [message]).map((m) => h('p', { text: m })),
      details,
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => close(false) }, cancelLabel),
        h('button', { class: ['btn', danger ? 'danger' : 'primary'], type: 'button', onclick: () => close(true) }, confirmLabel))),
  });
  return result === true;
}

// ---------------------------------------------------------------------------
// Toasts

let toastHost = null;

/**
 * Show a transient message. Options: { type: 'info'|'success'|'error'|'warn', action: { label, onClick }, timeout }.
 * Returns a function that dismisses it.
 */
export function toast(message, { type = 'info', action = null, timeout = action ? 7000 : 3500 } = {}) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const el = h('div', { class: ['toast', `toast-${type}`] }, h('span', { class: 'toast-msg', text: message }));
  const dismiss = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 180);
  };
  if (action) {
    el.appendChild(h('button', {
      class: 'toast-action',
      type: 'button',
      onclick: () => { dismiss(); action.onClick(); },
    }, action.label));
  }
  el.appendChild(h('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss', onclick: dismiss }, icon('x', { size: 14 })));
  toastHost.appendChild(el);
  if (timeout) setTimeout(dismiss, timeout);
  return dismiss;
}

/** Report an error from an async action as a toast (and console). */
export function toastError(err, prefix = '') {
  console.error(err);
  toast(`${prefix}${err?.message || err}`, { type: 'error', timeout: 8000 });
}
