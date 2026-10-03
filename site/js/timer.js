// Activity-aware solve timer (SPEC §6 "Timer").
//
// Elapsed time accumulates ONLY while all of these hold:
//   started && !solved && !manuallyPaused && activity.isActive()
// where the browser activity source (see activity.js) reports "the page is visible AND focused".
//
// The timer is deliberately DOM-free: the clock (`now`) and the activity source are injected, and nothing
// runs on its own until `startTicking()` is called — so unit tests can drive it with a fake clock.
//
// Time is measured as deltas of a monotonic clock (performance.now()). A single delta larger than
// `maxGapMs` is discarded: while the page is visible and focused we tick several times a second, so a huge
// gap means the machine slept or the tab was frozen — that time must never count.

/** Activity source that is always active (default; handy for tests). */
export const ALWAYS_ACTIVE = Object.freeze({
  isActive: () => true,
  reason: () => null,
  subscribe: () => () => {},
});

export class ActivityTimer {
  /**
   * @param {object} opts
   * @param {number}   [opts.elapsedMs=0]        previously accumulated time (from saved progress)
   * @param {boolean}  [opts.started=false]
   * @param {boolean}  [opts.solved=false]
   * @param {() => number} [opts.now]            monotonic clock in ms (default performance.now)
   * @param {{isActive():boolean, reason?():string|null, subscribe(fn):Function}} [opts.activity]
   * @param {number}   [opts.maxGapMs=30000]     larger single deltas are discarded (sleep/freeze)
   * @param {number}   [opts.persistEveryMs=5000]
   * @param {(ms:number) => void} [opts.onTick]          called on every tick while running
   * @param {(ms:number) => void} [opts.onPersist]       called when elapsed time should be saved
   * @param {(state:object) => void} [opts.onStateChange] called when running/paused state changes
   * @param {{set:Function, clear:Function}} [opts.scheduler] interval functions (default set/clearInterval)
   * @param {number}   [opts.tickMs=250]
   */
  constructor({
    elapsedMs = 0,
    started = false,
    solved = false,
    now = () => performance.now(),
    activity = ALWAYS_ACTIVE,
    maxGapMs = 30_000,
    persistEveryMs = 5_000,
    onTick = () => {},
    onPersist = () => {},
    onStateChange = () => {},
    scheduler = { set: (fn, ms) => setInterval(fn, ms), clear: (id) => clearInterval(id) },
    tickMs = 250,
  } = {}) {
    this._elapsed = Math.max(0, Number(elapsedMs) || 0);
    this._started = Boolean(started);
    this._solved = Boolean(solved);
    this._manual = false;
    this._now = now;
    this._activity = activity;
    this._maxGap = maxGapMs;
    this._persistEvery = persistEveryMs;
    this._onTick = onTick;
    this._onPersist = onPersist;
    this._onStateChange = onStateChange;
    this._scheduler = scheduler;
    this._tickMs = tickMs;
    this._intervalId = null;
    this._running = false;
    this._last = 0; // clock value at the last settle while running
    this._sinceUnpersisted = 0; // running time accumulated since the last persist
    this._lastStateKey = '';
    this._unsubscribe = activity.subscribe(() => this.sync());
    this._evaluate(false);
  }

  /** Accumulated time in ms, including the current running segment. */
  get elapsedMs() {
    this._settle();
    return this._elapsed;
  }

  get running() { return this._running; }
  get started() { return this._started; }
  get solved() { return this._solved; }
  get manuallyPaused() { return this._manual; }

  /**
   * Snapshot of the timer state:
   *   running  time is accumulating right now
   *   paused   started, not solved, but not running (the UI covers the grid)
   *   reason   why it is paused: 'manual' | 'hidden' | 'blurred' | 'inactive' | null
   */
  get state() {
    const paused = this._started && !this._solved && !this._running;
    let reason = null;
    if (paused) reason = this._manual ? 'manual' : (this._activity.reason?.() || 'inactive');
    return { running: this._running, paused, reason, started: this._started, solved: this._solved, elapsedMs: this._elapsed };
  }

  setStarted(value = true) { this._settle(); this._started = Boolean(value); this._evaluate(); }
  setSolved(value = true) { this._settle(); this._solved = Boolean(value); this._evaluate(); }
  /** Manual pause (the Pause button). Only `resume()` clears it — activity changes never do. */
  pause() { this._settle(); this._manual = true; this._evaluate(); }
  resume() { this._settle(); this._manual = false; this._evaluate(); }
  /** Overwrite the accumulated time (e.g. when restoring). */
  setElapsed(ms) { this._settle(); this._elapsed = Math.max(0, Number(ms) || 0); this._onTick(this._elapsed); }

  /** Re-read the activity source (called automatically on its events). */
  sync() { this._settle(); this._evaluate(); }

  /** Periodic work: accumulate, notify the display, persist every `persistEveryMs` of running time. */
  tick() {
    this._settle();
    this._evaluate();
    if (this._running) {
      this._onTick(this._elapsed);
      if (this._sinceUnpersisted >= this._persistEvery) this.persist();
    }
  }

  /** Ask the owner to save the current elapsed time now. */
  persist() {
    this._settle();
    this._sinceUnpersisted = 0;
    this._onPersist(this._elapsed);
  }

  /** Start the periodic tick (idempotent). */
  startTicking() {
    if (this._intervalId == null) this._intervalId = this._scheduler.set(() => this.tick(), this._tickMs);
  }

  stopTicking() {
    if (this._intervalId != null) this._scheduler.clear(this._intervalId);
    this._intervalId = null;
  }

  dispose() {
    this._settle();
    this.stopTicking();
    this._unsubscribe?.();
    this._unsubscribe = null;
  }

  // -- internals ------------------------------------------------------------

  _shouldRun() {
    return this._started && !this._solved && !this._manual && Boolean(this._activity.isActive());
  }

  /** Add the time since the last settle to the total (only while running). */
  _settle() {
    if (!this._running) return;
    const t = this._now();
    const delta = t - this._last;
    this._last = t;
    if (delta > 0 && delta <= this._maxGap) {
      this._elapsed += delta;
      this._sinceUnpersisted += delta;
    }
  }

  /** Recompute running; on a transition notify listeners (and persist when stopping). */
  _evaluate(notify = true) {
    const shouldRun = this._shouldRun();
    if (shouldRun && !this._running) {
      this._running = true;
      this._last = this._now();
    } else if (!shouldRun && this._running) {
      this._running = false;
      this.persist(); // stopping: save what we have (covers blur / hide / manual pause)
    }
    const state = this.state;
    const key = `${state.running}|${state.paused}|${state.reason}|${state.started}|${state.solved}`;
    if (key !== this._lastStateKey) {
      this._lastStateKey = key;
      if (notify) this._onStateChange(state);
    }
  }
}
