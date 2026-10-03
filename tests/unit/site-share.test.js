// Unit tests for the share text (site/js/share.js) — the format is fixed by SPEC §6.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildShareText, shareGridRows, hintSummary, shareDate, shareUrlFor, deliverShare, legacyCopy,
} from '../../site/js/share.js';
import { loadPuzzle } from '../../site/shared/puzzle.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/sample-puzzle.json', import.meta.url), 'utf8'));
const puzzle = loadPuzzle(fixture); // 5×5: blocks at 0 and 24

test('matches the SPEC example exactly', () => {
  const marks = new Array(25).fill('');
  marks[19] = 'revealed'; // row 4, col 5
  const text = buildShareText({
    siteName: 'Crossword Club',
    number: 12,
    date: '2026-10-03',
    elapsedMs: 272_000,
    checks: 0,
    reveals: 0,
    gridRows: shareGridRows(puzzle, marks, [12]),
    url: 'https://friends.example/crossword/',
  });
  assert.equal(text, [
    '🧩 Crossword Club #12 · Sat, Oct 3',
    '⏱️ 4:32 · ✨ no hints',
    '⬛🟩🟩🟩🟩',
    '🟩🟩🟩🟩🟩',
    '🟩🟩🟨🟩🟩',
    '🟩🟩🟩🟩🟪',
    '🟩🟩🟩🟩⬛',
    'https://friends.example/crossword/',
  ].join('\n'));
});

test('hint line variants', () => {
  assert.equal(hintSummary(0, 0), '✨ no hints');
  assert.equal(hintSummary(2, 1), '🔍 2 checked · 💡 1 revealed');
  assert.equal(hintSummary(3, 0), '🔍 3 checked');
  assert.equal(hintSummary(0, 5), '💡 5 revealed');
  const text = buildShareText({ siteName: 'XW', number: 3, date: '2026-10-02', elapsedMs: 3_725_000, checks: 2, reveals: 1, gridRows: null, url: 'u' });
  assert.equal(text, '🧩 XW #3 · Fri, Oct 2\n⏱️ 1:02:05 · 🔍 2 checked · 💡 1 revealed\nu');
});

test('grid omitted when shareGrid is false; number omitted when unknown; url optional', () => {
  const rows = shareGridRows(puzzle, new Array(25).fill(''), []);
  const text = buildShareText({ siteName: 'Crossword Club', number: null, date: '2026-10-02', elapsedMs: 59_999, gridRows: rows, shareGrid: false, url: '' });
  assert.equal(text, '🧩 Crossword Club · Fri, Oct 2\n⏱️ 0:59 · ✨ no hints');
});

test('revealed beats checked; blocks always ⬛', () => {
  const marks = new Array(25).fill('');
  marks[1] = 'revealed';
  const rows = shareGridRows(puzzle, marks, new Set([1, 2]));
  assert.equal(rows[0], '⬛🟪🟨🟩🟩');
  assert.equal(rows[4], '🟩🟩🟩🟩⬛');
});

test('shareDate is a calendar date regardless of the device zone', () => {
  assert.equal(shareDate('2026-10-03'), 'Sat, Oct 3');
  assert.equal(shareDate('2027-01-01'), 'Fri, Jan 1');
});

test('shareUrlFor prefers config.shareUrl, else the page URL without hash/query', () => {
  assert.equal(shareUrlFor('https://x.example/xw/', { origin: 'http://h', pathname: '/a/' }), 'https://x.example/xw/');
  assert.equal(shareUrlFor('', { origin: 'https://u.github.io', pathname: '/repo/' }), 'https://u.github.io/repo/');
  assert.equal(shareUrlFor(null, { origin: 'https://u.github.io', pathname: '/repo/index.html' }), 'https://u.github.io/repo/');
});

test('deliverShare: native share on touch, clipboard otherwise, then manual', async () => {
  const shared = [];
  const nav = { share: async (d) => { shared.push(d.text); }, clipboard: { writeText: async () => { throw new Error('no'); } } };
  assert.equal(await deliverShare('hi', { nav, preferNative: true, doc: null }), 'shared');
  assert.deepEqual(shared, ['hi']);

  const abort = { share: async () => { const e = new Error('x'); e.name = 'AbortError'; throw e; } };
  assert.equal(await deliverShare('hi', { nav: abort, preferNative: true, doc: null }), 'cancelled');

  const copied = [];
  const clip = { share: async () => { throw new Error('should not be used on desktop'); }, clipboard: { writeText: async (t) => { copied.push(t); } } };
  assert.equal(await deliverShare('yo', { nav: clip, preferNative: false, doc: null }), 'copied');
  assert.deepEqual(copied, ['yo']);

  // share fails with NotAllowedError -> falls back to clipboard
  const notAllowed = { share: async () => { const e = new Error('x'); e.name = 'NotAllowedError'; throw e; }, clipboard: { writeText: async () => {} } };
  assert.equal(await deliverShare('z', { nav: notAllowed, preferNative: true, doc: null }), 'copied');

  assert.equal(await deliverShare('z', { nav: {}, preferNative: false, doc: null }), 'manual');
});

test('legacyCopy uses execCommand on a temporary textarea', () => {
  const appended = [];
  const ta = { value: '', style: {}, setAttribute() {}, focus() {}, select() {}, setSelectionRange() {}, remove() { appended.pop(); } };
  const doc = {
    body: { appendChild: (el) => appended.push(el) },
    activeElement: null,
    createElement: () => ta,
    execCommand: (cmd) => cmd === 'copy' && appended.length === 1 && ta.value === 'abc',
  };
  assert.equal(legacyCopy('abc', doc), true);
  assert.equal(appended.length, 0);
  assert.equal(legacyCopy('abc', { ...doc, execCommand: () => false }), false);
});
