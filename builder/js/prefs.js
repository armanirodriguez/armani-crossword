// Builder preferences in localStorage (author name, fill options, theme …). Every access is guarded:
// the builder must keep working when storage is unavailable.

const PREFIX = 'xwb:';

export function getPref(key, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function setPref(key, value) {
  try {
    if (value === undefined || value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable or full: preferences are a convenience only */
  }
}

/** Merge stored object prefs over defaults (unknown / mistyped keys fall back). */
export function getPrefObject(key, defaults) {
  const stored = getPref(key, {});
  const out = { ...defaults };
  if (stored && typeof stored === 'object') {
    for (const k of Object.keys(defaults)) {
      if (typeof stored[k] === typeof defaults[k]) out[k] = stored[k];
    }
  }
  return out;
}

/**
 * Fill options (Grid & Fill → Fill options), shared by autofill, layout generation and the answer-freshness checks.
 * avoidRecent: pass recently published answers to the engine as `penalize`; recentDays: the window (days before and
 * after the draft's date) for that and for the "used recently" tags and warnings.
 */
export const FILL_DEFAULTS = Object.freeze({ minScore: 30, randomness: 0.25, timeLimitSec: 10, avoidRecent: true, recentDays: 30 });

export function getFillOptions() {
  return getPrefObject('fillOptions', FILL_DEFAULTS);
}
