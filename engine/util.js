// Small shared helpers for the engine: bit tricks, a seeded RNG, timing and cooperative yielding.
// Pure ES module (no DOM, no Node built-ins) so it runs unchanged in a module Worker and in Node.

/** Number of set bits in a 32-bit integer. */
export function popcount32(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

/** Index (0..31) of the lowest set bit of a non-zero 32-bit integer. */
export function lowBit(x) {
  return 31 - Math.clz32(x & -x);
}

/** Deterministic PRNG (mulberry32). Returns a function producing floats in [0, 1). */
export function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Turn any seed value (number, string, undefined) into a 32-bit integer. Undefined/null → random. */
export function normalizeSeed(seed) {
  if (seed === undefined || seed === null || seed === '') return (Math.random() * 0x100000000) >>> 0;
  if (typeof seed === 'number' && Number.isFinite(seed)) return (Math.floor(seed) >>> 0) ^ Math.floor(seed / 0x100000000);
  const s = String(seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const now = typeof performance !== 'undefined' && performance.now
  ? () => performance.now()
  : () => Date.now();

/**
 * Yield to the event loop with a macrotask so that pending messages (e.g. a worker's 'cancel') get processed.
 * A microtask (await Promise.resolve()) would NOT let other events run.
 */
export function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Uppercase A–Z only ("Trick or treat!" → "TRICKORTREAT"). Mirrors normalizeAnswer in site/shared/puzzle.js. */
export function normalizeWord(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
}
