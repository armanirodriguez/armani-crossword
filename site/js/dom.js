// Tiny DOM helpers. All text goes through textContent / text nodes — never innerHTML — because clues,
// titles and notes are untrusted text (SPEC §0).

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * h('button', { class: 'btn', type: 'button', onclick: fn, dataset: { x: 1 }, 'aria-label': 'Go' }, 'Text', child)
 *  - `class` may be a string or an array (falsy entries dropped)
 *  - `on<event>` keys become event listeners; `dataset` / `style` objects are applied
 *  - `hidden`, `disabled` etc. booleans set properties; null/false/undefined attributes are skipped
 *  - children: strings/numbers become text nodes; arrays are flattened; null/false skipped
 */
export function h(tag, props = null, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

/** Same as h() but creates SVG elements. */
export function svg(tag, props = null, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props, true);
  append(el, children);
  return el;
}

function applyProps(el, props, isSvg = false) {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') {
      const cls = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
      if (cls) el.setAttribute('class', cls);
    } else if (key === 'dataset') {
      for (const [k, v] of Object.entries(value)) if (v != null) el.dataset[k] = v;
    } else if (key === 'style' && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (k.startsWith('--')) el.style.setProperty(k, v);
        else el.style[k] = v;
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'text') {
      el.textContent = value;
    } else if (!isSvg && (key === 'hidden' || key === 'disabled' || key === 'checked' || key === 'value' || key === 'tabIndex')) {
      el[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Remove all children. */
export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

/** Toggle a class only when it changes (avoids needless style recalcs in hot paths). */
export function setClass(el, cls, on) {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

/** Match a media query safely. */
export function mq(query) {
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

export const prefersReducedMotion = () => mq('(prefers-reduced-motion: reduce)');
