// Shared screen chrome: the site header, the brand mark, and full-page message states
// (loading, empty, locked, errors).

import { h, svg } from '../dom.js';
import { icon } from '../icons.js';

/** The little crossword logo (matches favicon.svg). */
export function brandMark(size = 28) {
  const cell = (x, y, cls) => svg('rect', { x, y, width: 6, height: 6, rx: 1.2, class: cls });
  return svg('svg', { class: 'brand-mark', viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true' },
    svg('rect', { x: 0, y: 0, width: 24, height: 24, rx: 6, class: 'bm-bg' }),
    cell(3, 3, 'bm-active'), cell(9, 3, 'bm-word'), cell(15, 3, 'bm-word'),
    cell(3, 9, 'bm-cell'), cell(15, 9, 'bm-cell'),
    cell(3, 15, 'bm-cell'), cell(9, 15, 'bm-cell'), cell(15, 15, 'bm-cell'));
}

/**
 * Site header for intro / archive / message screens.
 * @param {object} ctx  app context
 * @param {'today'|'archive'|null} active
 */
export function siteHeader(ctx, active = null) {
  const link = (href, label, name, ic) => h('a', {
    href,
    class: ['nav-link', active === name && 'is-current'],
    'aria-current': active === name ? 'page' : null,
  }, icon(ic, { size: 18 }), h('span', null, label));
  return h('header', { class: 'site-header' },
    h('a', { class: 'brand', href: '#/', 'aria-label': `${ctx.config.siteName} — today's puzzle` },
      brandMark(30),
      h('span', { class: 'brand-text' },
        h('span', { class: 'brand-name' }, ctx.config.siteName),
        ctx.config.tagline && h('span', { class: 'brand-tagline' }, ctx.config.tagline))),
    ctx.preview && h('span', { class: 'pill pill-preview', title: "Preview mode: progress isn't saved" }, 'Preview'),
    h('nav', { class: 'site-nav', 'aria-label': 'Main' },
      link('#/', 'Today', 'today', 'grid'),
      link('#/archive', 'Archive', 'archive', 'calendar')));
}

/**
 * A centered message page.
 * @param {object} ctx
 * @param {{ icon?: string, emoji?: string, title: string, text?: string|Node[], actions?: Array<{label, href?, onClick?, primary?}>, active?: string, details?: string[] }} o
 */
export function messageScreen(ctx, { icon: ic = null, emoji = null, title, text = '', actions = [], active = null, details = [] }) {
  const actionEls = actions.map((a) => {
    const cls = ['btn', a.primary ? 'btn-primary' : 'btn-secondary'];
    if (a.href) return h('a', { class: cls, href: a.href }, a.label);
    return h('button', { type: 'button', class: cls, onclick: a.onClick }, a.icon && icon(a.icon, { size: 18 }), h('span', null, a.label));
  });
  return h('div', { class: 'screen screen-message' },
    siteHeader(ctx, active),
    h('main', { class: 'page page-center', id: 'main' },
      h('div', { class: 'message-card' },
        emoji ? h('div', { class: 'message-emoji', 'aria-hidden': 'true' }, emoji) : ic && h('div', { class: 'message-icon' }, icon(ic, { size: 30 })),
        h('h1', { class: 'message-title' }, title),
        text && h('p', { class: 'message-text' }, text),
        details.length ? h('details', { class: 'message-details' },
          h('summary', null, 'Details'),
          h('ul', null, details.slice(0, 8).map((d) => h('li', null, d)))) : null,
        actionEls.length ? h('div', { class: 'message-actions' }, actionEls) : null)));
}

/** Loading placeholder (fades in after a short delay so fast loads don't flash). */
export function loadingScreen(ctx) {
  return h('div', { class: 'screen screen-loading' },
    siteHeader(ctx, null),
    h('main', { class: 'page page-center', 'aria-busy': 'true' },
      h('div', { class: 'loading', role: 'status' },
        h('div', { class: 'loading-grid', 'aria-hidden': 'true' }, Array.from({ length: 9 }, (_, i) => h('span', { style: { '--i': i } }))),
        h('span', { class: 'visually-hidden' }, 'Loading…'))));
}
