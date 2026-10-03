// On-screen QWERTY keyboard for touch devices (SPEC §6 "Input — mobile/touch").
// Keys react on pointerdown (no click delay, no focus change, no double-tap zoom); holding ⌫ repeats.

import { h } from './dom.js';
import { icon } from './icons.js';

const ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
const REPEAT_DELAY = 420;
const REPEAT_EVERY = 90;

export class OnScreenKeyboard {
  /** @param {{ onLetter: (ch:string) => void, onBackspace: () => void }} handlers */
  constructor({ onLetter, onBackspace }) {
    this.el = h('div', { class: 'keyboard', role: 'group', 'aria-label': 'Keyboard' });
    this.disabled = false;
    ROWS.forEach((row, r) => {
      const rowEl = h('div', { class: 'kb-row' });
      if (r === 1) rowEl.append(h('span', { class: 'kb-spacer' }));
      for (const ch of row) {
        rowEl.append(h('button', { type: 'button', class: 'kb-key', dataset: { key: ch }, tabindex: -1 }, ch));
      }
      if (r === 1) rowEl.append(h('span', { class: 'kb-spacer' }));
      if (r === 2) {
        rowEl.append(h('button', { type: 'button', class: 'kb-key kb-wide', dataset: { key: 'Backspace' }, tabindex: -1, 'aria-label': 'Backspace' }, icon('backspace', { size: 24 })));
      }
      this.el.append(rowEl);
    });

    let repeatTimer = null;
    const stopRepeat = () => { clearTimeout(repeatTimer); clearInterval(repeatTimer); repeatTimer = null; };
    const release = (key) => { key?.classList.remove('is-pressed'); stopRepeat(); };
    let pressed = null;

    this.el.addEventListener('pointerdown', (e) => {
      const key = e.target.closest('.kb-key');
      if (!key || this.disabled) return;
      e.preventDefault(); // no focus change, no text selection, no synthetic mouse events
      if (pressed) release(pressed);
      pressed = key;
      key.classList.add('is-pressed');
      try { key.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
      const k = key.dataset.key;
      if (k === 'Backspace') {
        onBackspace();
        repeatTimer = setTimeout(() => { repeatTimer = setInterval(onBackspace, REPEAT_EVERY); }, REPEAT_DELAY);
      } else {
        onLetter(k);
      }
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      this.el.addEventListener(type, () => { release(pressed); pressed = null; });
    }
    // Keyboard/assistive activation (no pointer): treat as a key press.
    this.el.addEventListener('click', (e) => {
      if (e.detail !== 0) return; // real pointer clicks were handled on pointerdown
      const key = e.target.closest('.kb-key');
      if (!key || this.disabled) return;
      if (key.dataset.key === 'Backspace') onBackspace();
      else onLetter(key.dataset.key);
    });
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setDisabled(disabled) {
    this.disabled = disabled;
    this.el.classList.toggle('is-disabled', disabled);
  }
}
