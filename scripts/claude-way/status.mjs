// `status`: what Claude's way should make next — today and tomorrow in the site's time zone, which Claude puzzles
// exist for them, their difficulty, recent themes (to avoid repeats) and how many recent answers the fill avoids.

import fsp from 'node:fs/promises';

import { KINDS, addDays, isValidDateId } from '../../site/shared/puzzle.js';
import {
  CliError, LEVEL_GUIDES, RECENT_DAYS, SERIES, SIZES, THEME_HISTORY_DAYS, claudeId, difficulty, listDrafts, listPublished,
  readJson, recentAnswers, siteTimeZone, siteToday, weekdayName,
} from './common.mjs';

/** opts: { P, date?, today? } -> status report (see the CLI's printStatus for the human form). */
export async function getStatus({ P, date = null, today: todayOverride = null }) {
  if (date && !isValidDateId(date)) throw new CliError(`--date must be YYYY-MM-DD (got "${date}")`, { code: 2 });
  const timeZone = await siteTimeZone(P);
  const today = await siteToday(P, todayOverride);
  const tomorrow = addDays(today, 1);
  const dates = date ? [date] : [today, tomorrow];

  const published = await listPublished(P, SERIES);
  const drafts = await listDrafts(P);
  const info = new Map(); // id -> { title, theme }
  for (const f of published) {
    try {
      const p = JSON.parse(await fsp.readFile(f.file, 'utf8'));
      info.set(f.id, { title: p.title || '', theme: p.theme || '' });
    } catch {
      info.set(f.id, { title: '(unreadable)', theme: '' });
    }
  }
  // Themes may only be recorded in the index (older files): fill the gaps from it.
  const index = await readJson(P.claudeIndex, null).catch(() => null);
  for (const e of index?.puzzles || []) {
    if (e?.id && info.has(e.id) && !info.get(e.id).theme && e.theme) info.get(e.id).theme = e.theme;
  }
  const publishedIds = new Set(published.map((f) => f.id));
  const draftIds = new Set(drafts.map((d) => d.id));

  const days = dates.map((d) => ({
    date: d,
    label: d === today ? 'today' : d === tomorrow ? 'tomorrow' : '',
    weekday: weekdayName(d),
    kinds: Object.fromEntries(KINDS.map((kind) => {
      const id = claudeId(d, kind);
      return [kind, {
        id, size: SIZES[kind], level: difficulty(d, kind), published: publishedIds.has(id), draft: draftIds.has(id),
        ...(info.get(id) || {}),
      }];
    })),
  }));

  // To make: tomorrow's set first (the routine's main job), then anything missing today; within a date in build
  // order (Daily, Midi, Mini: later builds avoid the answers of the earlier drafts).
  const order = date ? days : [...days].sort((a, b) => (a.date === tomorrow ? -1 : b.date === tomorrow ? 1 : 0));
  const todo = [];
  for (const day of order) {
    for (const kind of [...KINDS].reverse()) {
      const k = day.kinds[kind];
      if (!k.published) todo.push({ date: day.date, kind, id: k.id, size: `${k.size}x${k.size}`, level: k.level, draft: k.draft });
    }
  }

  // Recent themes: Claude sets within the last THEME_HISTORY_DAYS (and any scheduled ahead), newest first.
  const from = addDays(today, -THEME_HISTORY_DAYS);
  const byDate = new Map();
  for (const f of published) {
    if (f.date < from) continue;
    if (!byDate.has(f.date)) byDate.set(f.date, { date: f.date, themes: [], titles: {} });
    const row = byDate.get(f.date);
    const { title = '', theme = '' } = info.get(f.id) || {};
    row.titles[f.kind] = title;
    if (theme && !row.themes.includes(theme)) row.themes.push(theme);
  }
  const history = [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : -1));

  const target = date || tomorrow;
  const recent = await recentAnswers(P, { date: target, excludeId: null });
  return {
    timeZone, today, tomorrow, dates: days, todo, levels: LEVEL_GUIDES,
    history, freshness: { date: target, days: RECENT_DAYS, answers: recent.size },
  };
}
