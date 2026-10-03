// Safe key/value storage on top of localStorage.
//
// Browsers can block localStorage entirely (Safari private mode in old versions, "block all cookies",
// sandboxed iframes) or throw on write (quota). Every access is wrapped in try/catch, and when the real
// storage is unusable we fall back to an in-memory Map so the app keeps working for the current visit.
//
// `persist: false` (preview mode) never writes to the real storage, but can still read from it.

/** True if `backing` behaves like a working Storage object. */
function probe(backing) {
  if (!backing) return false;
  try {
    const key = '__xw_probe__';
    backing.setItem(key, '1');
    const ok = backing.getItem(key) === '1';
    backing.removeItem(key);
    return ok;
  } catch {
    return false;
  }
}

function defaultBacking() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // accessing the property itself throws when storage is blocked
  }
}

/**
 * createStorage({ backing, persist }) -> {
 *   available   real storage works (false = memory only, data is lost on reload)
 *   persistent  writes reach the real storage (false in preview mode or when unavailable)
 *   getRaw(key) / setRaw(key, string) / getJSON(key, fallback) / setJSON(key, value) / remove(key)
 *   keys(prefix) -> string[]
 *   onWriteError(fn)  called once per failed write (e.g. quota exceeded)
 * }
 */
export function createStorage({ backing = defaultBacking(), persist = true } = {}) {
  const available = probe(backing);
  const real = available ? backing : null;
  const persistent = Boolean(real && persist);
  const memory = new Map(); // writes when not persistent; reads check memory first
  const errorListeners = new Set();

  function getRaw(key) {
    if (memory.has(key)) return memory.get(key);
    if (!real) return null;
    try {
      return real.getItem(key);
    } catch {
      return null;
    }
  }

  function setRaw(key, value) {
    const str = String(value);
    if (!persistent) {
      memory.set(key, str);
      return true;
    }
    try {
      real.setItem(key, str);
      memory.delete(key);
      return true;
    } catch (err) {
      memory.set(key, str); // keep it for this visit at least
      for (const fn of errorListeners) fn(err);
      return false;
    }
  }

  function remove(key) {
    const had = memory.delete(key);
    if (!persistent) {
      // Shadow the real value so reads return null for this visit without touching real storage.
      if (real && !had) memory.set(key, null);
      return;
    }
    try {
      real.removeItem(key);
    } catch {
      /* ignore */
    }
  }

  function getJSON(key, fallback = null) {
    const raw = getRaw(key);
    if (raw == null) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function setJSON(key, value) {
    return setRaw(key, JSON.stringify(value));
  }

  function keys(prefix = '') {
    const out = new Set();
    if (real) {
      try {
        for (let i = 0; i < real.length; i++) {
          const k = real.key(i);
          if (k != null && k.startsWith(prefix)) out.add(k);
        }
      } catch {
        /* ignore */
      }
    }
    for (const [k, v] of memory) {
      if (!k.startsWith(prefix)) continue;
      if (v == null) out.delete(k);
      else out.add(k);
    }
    return [...out];
  }

  return {
    available,
    persistent,
    getRaw,
    setRaw,
    getJSON,
    setJSON,
    remove,
    keys,
    onWriteError(fn) {
      errorListeners.add(fn);
      return () => errorListeners.delete(fn);
    },
  };
}

/** A minimal in-memory Storage implementation (for tests). */
export class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}
