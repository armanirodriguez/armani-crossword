#!/usr/bin/env node
// Build the deployable static site: copy site/ -> dist/ (SPEC §4).
//
//   npm run build                                  # copy everything to dist/
//   npm run build -- --released-only              # drop puzzles that are not released yet (see below)
//   npm run build -- --released-only --lead-hours 3   # ...counting puzzles that unlock within 3 hours as released
//   node scripts/build-site.mjs --out public --released-only
//   node scripts/build-site.mjs --root /tmp/repo-copy --today 2026-10-31   # (testing helpers)
//
// Released puzzles: with --released-only a puzzle is kept when its date is on or before the date in
// site/config.json's `timeZone` at (now + lead hours). The deploy workflow builds hourly with --lead-hours 3, so each
// puzzle is online a few hours before midnight in the site's zone, and the player (which compares dates in the same
// zone) unlocks it exactly at midnight. When timeZone is null (each solver uses their own local date) the date is
// taken in the EARLIEST zone on Earth (UTC+14): a puzzle is deployed as soon as it is "today" for anyone, and the
// player still hides puzzles dated after the solver's own today. `--today` sets the cutoff date directly.
//
// Output safety: every build writes a marker file (.xw-build) into its output. An existing output folder is only
// deleted when it is empty or has that marker (else pass --force). The repository itself and its own folders
// (site/, drafts/, data/, …) are always refused.
//
// Site metadata: link previews (iMessage, WhatsApp, Slack …) don't run JavaScript, so the <title>, description,
// og:* tags and the web-app manifest in the output are rewritten from config.json (siteName, tagline, shareUrl).
//
// The puzzle index is always rebuilt from the puzzle files that end up in the output, so numbering stays
// consistent (numbers are by date order, so dropping future puzzles never renumbers released ones).

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildIndex, isValidDateId, todayISO } from '../site/shared/puzzle.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The zone where the calendar date changes first (UTC+14). */
export const EARLIEST_ZONE = 'Pacific/Kiritimati';
/** Marker file written into every build output: only folders carrying it are replaced without --force. */
export const BUILD_MARKER = '.xw-build';
/** Folders of the repository a build must never be written into (or delete), even with --force. */
export const PROTECTED_DIRS = Object.freeze(['drafts', 'data', 'builder', 'engine', 'scripts', 'tests', 'site', '.git', 'node_modules', '.github']);
/** Largest accepted --lead-hours. */
const MAX_LEAD_HOURS = 48;
/** Image used for link previews (og:image) when config.shareUrl says where the site lives. */
const SHARE_IMAGE = 'icons/icon-512.png';

/**
 * The latest puzzle date that counts as released for a site config: the date in `config.timeZone` (or, when that is
 * null, in the earliest zone on Earth) at `now` + `leadHours`. Also used by the dev server (lead 0) to hold back
 * unreleased puzzles from other devices on the network.
 * @param {{ timeZone?: string|null }} [config]
 * @param {{ now?: Date|number|string, leadHours?: number }} [opts]
 */
export function releasedThrough(config = {}, { now = new Date(), leadHours = 0 } = {}) {
  const at = new Date(new Date(now).getTime() + leadHours * 3_600_000);
  if (Number.isNaN(at.getTime())) throw new Error(`Invalid time "${now}"`);
  return todayISO(config?.timeZone || EARLIEST_ZONE, at);
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** `p` with symlinks resolved as far as it exists (so a link into the repo cannot slip past the checks). */
async function realPathOf(p) {
  const rest = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(await fsp.realpath(cur), ...rest);
    } catch (err) {
      const parent = path.dirname(cur);
      if (err.code !== 'ENOENT' || parent === cur) return p;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Throw unless it is safe to (re)create `out`: never the repository (or a folder containing it), never inside one of
 * its own folders, and an existing non-empty folder only when an earlier build made it (marker file) or `force`.
 */
async function checkOutDir(out, { root, force }) {
  const outs = [...new Set([out, await realPathOf(out)])];
  const repos = [...new Set([root, REPO_ROOT, await realPathOf(root), await realPathOf(REPO_ROOT)])];
  for (const o of outs) {
    for (const repo of repos) {
      if (isInside(repo, o)) throw new Error(`Refusing to build into ${out}: it is (or contains) the repository ${repo}`);
      const dir = PROTECTED_DIRS.find((d) => isInside(o, path.join(repo, d)));
      if (dir) throw new Error(`Refusing to build into ${out}: it is inside the repository's ${dir}/ folder`);
    }
  }
  let stat;
  try {
    stat = await fsp.lstat(out);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (force) return;
  if (!stat.isDirectory()) {
    throw new Error(`Refusing to replace ${out}: it is not a folder. Pick another --out, or pass --force to replace it.`);
  }
  const names = await fsp.readdir(out);
  if (names.length && !names.includes(BUILD_MARKER)) {
    throw new Error(`Refusing to delete ${out}: it is not empty and was not made by this script (no ${BUILD_MARKER} file). `
      + 'Pick another --out, delete it yourself, or pass --force.');
  }
}

// ---------------------------------------------------------------------------
// Site metadata (index.html head + manifest)

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const nonEmpty = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Set the content of `<meta {attr}="{key}" content="…">`, inserting the tag (after `after`, else before </head>)
 * when the page does not have it.
 */
function setMeta(html, attr, key, value, { after = null } = {}) {
  const tagRe = (k) => new RegExp(`<meta\\b[^>]*\\b${attr}\\s*=\\s*["']${k.replace(/[.:]/g, '\\$&')}["'][^>]*>`, 'i');
  const content = escapeHtml(value);
  const re = tagRe(key);
  if (re.test(html)) {
    const attrRe = /\bcontent\s*=\s*("[^"]*"|'[^']*')/i;
    return html.replace(re, (tag) => (attrRe.test(tag)
      ? tag.replace(attrRe, () => `content="${content}"`)
      : tag.replace(/\s*\/?>$/, () => ` content="${content}">`)));
  }
  const tag = `<meta ${attr}="${key}" content="${content}">`;
  const anchor = after && tagRe(after).exec(html);
  if (anchor) {
    const end = anchor.index + anchor[0].length;
    const indent = /\n([ \t]*)[^\n]*$/.exec(html.slice(0, anchor.index))?.[1] ?? '';
    return `${html.slice(0, end)}\n${indent}${tag}${html.slice(end)}`;
  }
  return html.replace(/<\/head>/i, () => `  ${tag}\n</head>`);
}

/**
 * The absolute URL of a file of the site, given the address the site lives at (config.shareUrl):
 * "https://me.github.io/xw" + "icons/a.png" -> "https://me.github.io/xw/icons/a.png".
 */
export function siteFileUrl(shareUrl, file) {
  const base = new URL(shareUrl);
  base.search = '';
  base.hash = '';
  const last = base.pathname.split('/').pop();
  if (last && !last.includes('.')) base.pathname += '/'; // ".../crossword" is a folder, ".../index.html" a page
  return new URL(file, base).href;
}

/**
 * Rewrite the static metadata of index.html from the site config: <title>, description, og:title, og:description,
 * apple-mobile-web-app-title, plus og:image (absolute URL) when `imageUrl` is given. Values missing from the config
 * keep the page's own defaults. All values are HTML-escaped.
 */
export function applySiteMetadata(html, config = {}, { imageUrl = null } = {}) {
  const name = nonEmpty(config.siteName);
  const tagline = nonEmpty(config.tagline);
  let out = html;
  if (name) {
    out = out.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${escapeHtml(name)}</title>`);
    out = setMeta(out, 'property', 'og:title', name);
    out = setMeta(out, 'name', 'apple-mobile-web-app-title', name);
  }
  if (tagline) {
    out = setMeta(out, 'name', 'description', tagline);
    out = setMeta(out, 'property', 'og:description', tagline);
  }
  if (imageUrl) out = setMeta(out, 'property', 'og:image', imageUrl, { after: 'og:description' });
  return out;
}

/** A home-screen label (≤ 12 characters where possible, whole words): "Crossword Club" -> "Crossword". */
export function shortName(name) {
  const words = String(name).trim().split(/\s+/);
  const out = [words[0] || ''];
  for (const w of words.slice(1)) {
    if (`${out.join(' ')} ${w}`.length > 12) break;
    out.push(w);
  }
  // Never end on a lone "&" or "-" ("Puzzle & Pals" -> "Puzzle", not "Puzzle &").
  while (out.length > 1 && !/[\p{L}\p{N}]/u.test(out.at(-1))) out.pop();
  return out.join(' ');
}

/** The web-app manifest with name / short_name / description from the site config (others untouched). */
export function applyManifestMetadata(manifest, config = {}) {
  const name = nonEmpty(config.siteName);
  const tagline = nonEmpty(config.tagline);
  const out = { ...manifest };
  if (name) {
    out.name = name;
    out.short_name = shortName(name);
  }
  if (tagline) out.description = tagline;
  return out;
}

async function writeSiteMetadata(out, config, log) {
  let imageUrl = null;
  if (nonEmpty(config.shareUrl)) {
    try {
      await fsp.access(path.join(out, SHARE_IMAGE));
      imageUrl = siteFileUrl(config.shareUrl.trim(), SHARE_IMAGE);
    } catch (err) {
      log(`warning: no link-preview image (${err.code === 'ENOENT' ? `${SHARE_IMAGE} is missing` : err.message})`);
    }
  }
  const indexFile = path.join(out, 'index.html');
  const html = await fsp.readFile(indexFile, 'utf8');
  await fsp.writeFile(indexFile, applySiteMetadata(html, config, { imageUrl }));

  const manifestFile = path.join(out, 'manifest.webmanifest');
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log(`warning: manifest.webmanifest not updated: ${err.message}`);
    return;
  }
  await fsp.writeFile(manifestFile, `${JSON.stringify(applyManifestMetadata(manifest, config), null, 2)}\n`);
}

// ---------------------------------------------------------------------------

/**
 * Build the site.
 * @param {{ root?: string, out?: string, releasedOnly?: boolean, today?: string, leadHours?: number,
 *   now?: Date|number|string, force?: boolean, log?: (s: string) => void }} opts
 *   today:     cutoff date for releasedOnly (default: computed from config.timeZone, `now` and `leadHours`)
 *   leadHours: count puzzles that unlock within this many hours as released (default 0)
 *   now:       the current time (tests)
 *   force:     replace an existing output folder even without the build marker
 * @returns {Promise<{ out: string, today: string|null, kept: string[], dropped: string[], index: object }>}
 *   `today` is the last released date (null without releasedOnly).
 */
export async function buildSite({
  root = REPO_ROOT, out, releasedOnly = false, today, leadHours = 0, now = new Date(), force = false, log = () => {},
} = {}) {
  root = path.resolve(root);
  const siteDir = path.join(root, 'site');
  out = path.resolve(root, out || 'dist');

  // Check everything before anything is deleted.
  if (today !== undefined && today !== null && !isValidDateId(today)) throw new Error(`--today must be YYYY-MM-DD, got "${today}"`);
  if (typeof leadHours !== 'number' || !Number.isFinite(leadHours) || leadHours < 0 || leadHours > MAX_LEAD_HOURS) {
    throw new Error(`--lead-hours must be a number of hours from 0 to ${MAX_LEAD_HOURS}, got "${leadHours}"`);
  }
  if (today && leadHours) throw new Error('--today sets the cutoff date directly: use it without --lead-hours');
  await fsp.access(path.join(siteDir, 'index.html')).catch(() => {
    throw new Error(`No site found at ${siteDir} (missing index.html)`);
  });
  await checkOutDir(out, { root, force });
  if (isInside(out, siteDir) || isInside(siteDir, out)) {
    throw new Error(`Refusing to build into ${out}: it overlaps the source folder ${siteDir}`);
  }

  let config = {};
  try {
    config = JSON.parse(await fsp.readFile(path.join(siteDir, 'config.json'), 'utf8')) || {};
  } catch { /* no config: defaults */ }
  const todayId = releasedOnly ? (today || releasedThrough(config, { now, leadHours })) : null;

  await fsp.rm(out, { recursive: true, force: true });
  await fsp.cp(siteDir, out, {
    recursive: true,
    // Skip editor/OS junk and our own atomic-write temp files.
    filter: (src) => {
      const base = path.basename(src);
      return !(base === '.DS_Store' || base.endsWith('.tmp') || base === 'Thumbs.db');
    },
  });
  await fsp.writeFile(path.join(out, BUILD_MARKER),
    'Made by scripts/build-site.mjs. The next build deletes and replaces this whole folder.\n');
  // GitHub Pages: serve files as-is (no Jekyll processing).
  await fsp.writeFile(path.join(out, '.nojekyll'), '');
  await writeSiteMetadata(out, config, log);

  const puzzlesDir = path.join(out, 'puzzles');
  let names = [];
  try {
    names = (await fsp.readdir(puzzlesDir)).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    await fsp.mkdir(puzzlesDir, { recursive: true });
  }

  const kept = [];
  const dropped = [];
  const puzzles = [];
  for (const name of names.sort()) {
    const date = name.slice(0, 10);
    const file = path.join(puzzlesDir, name);
    if (todayId && date > todayId) {
      await fsp.rm(file);
      dropped.push(date);
      continue;
    }
    try {
      puzzles.push(JSON.parse(await fsp.readFile(file, 'utf8')));
      kept.push(date);
    } catch (err) {
      log(`warning: removing unreadable puzzle ${name}: ${err.message}`);
      await fsp.rm(file);
      dropped.push(date);
    }
  }
  const index = buildIndex(puzzles);
  await fsp.writeFile(path.join(puzzlesDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);

  const zone = config.timeZone || `${EARLIEST_ZONE}, the earliest zone`;
  log(`Built ${path.relative(process.cwd(), out) || out}: ${kept.length} puzzle(s)`
    + (releasedOnly
      ? `, ${dropped.length} unreleased held back (released through ${todayId}`
        + `${today ? '' : ` in ${zone}${leadHours ? `, ${leadHours} h ahead` : ''}`})`
      : ''));
  return { out, today: todayId, kept, dropped, index };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const value = () => {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === '--released-only') opts.releasedOnly = true;
    else if (flag === '--out') opts.out = value();
    else if (flag === '--root') opts.root = value();
    else if (flag === '--today') opts.today = value();
    else if (flag === '--lead-hours') {
      const v = value();
      opts.leadHours = v.trim() === '' ? NaN : Number(v);
      if (!Number.isFinite(opts.leadHours)) throw new Error(`--lead-hours must be a number, got "${v}"`);
    } else if (flag === '--force') opts.force = true;
    else if (flag === '--help' || flag === '-h') opts.help = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log('Usage: node scripts/build-site.mjs [--out dist] [--released-only [--lead-hours N | --today YYYY-MM-DD]]\n'
        + '                                    [--force] [--root <dir>]\n'
        + '  --released-only  leave out puzzles dated after today in config.timeZone (null: the earliest zone)\n'
        + '  --lead-hours N   ...counting puzzles that unlock within N hours as released (deploy workflow: 3)\n'
        + '  --force          replace --out even if it is not an earlier build (it has no .xw-build file)');
    } else {
      await buildSite({ ...opts, root: opts.root || process.env.XW_ROOT || REPO_ROOT, log: (s) => console.log(s) });
    }
  } catch (err) {
    console.error(`build-site: ${err.message}`);
    process.exit(1);
  }
}
