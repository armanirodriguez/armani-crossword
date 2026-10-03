// Unit tests for the player's activity-aware timer (site/js/timer.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityTimer } from '../../site/js/timer.js';

/** A controllable clock + activity source + interval scheduler. */
function harness({ active = true, reason = null } = {}) {
  let t = 1000;
  let isActive = active;
  let why = reason;
  const subs = new Set();
  const activity = {
    isActive: () => isActive,
    reason: () => why,
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
  };
  const intervals = new Map();
  let nextId = 1;
  const scheduler = {
    set: (fn, ms) => { intervals.set(nextId, { fn, ms }); return nextId++; },
    clear: (id) => intervals.delete(id),
  };
  return {
    now: () => t,
    activity,
    scheduler,
    intervals,
    advance(ms) { t += ms; },
    /** Advance in small steps, ticking like a real interval would. */
    run(timer, ms, step = 250) { for (let done = 0; done < ms; done += step) { t += step; timer.tick(); } },
    setActive(value, r = value ? null : 'hidden') { isActive = value; why = r; for (const fn of subs) fn(); },
    subscribers: () => subs.size,
  };
}

test('does not run until started, then accumulates while active', () => {
  const h = harness();
  const timer = new ActivityTimer({ now: h.now, activity: h.activity, scheduler: h.scheduler });
  h.run(timer, 2000);
  assert.equal(timer.elapsedMs, 0);
  assert.equal(timer.running, false);
  timer.setStarted(true);
  assert.equal(timer.running, true);
  h.run(timer, 3000);
  assert.equal(timer.elapsedMs, 3000);
});

test('resumes from a saved elapsed time', () => {
  const h = harness();
  const timer = new ActivityTimer({ now: h.now, activity: h.activity, elapsedMs: 133_000, started: true });
  h.run(timer, 1000);
  assert.equal(timer.elapsedMs, 134_000);
});

test('pauses while hidden or unfocused and auto-resumes', () => {
  const h = harness();
  const states = [];
  const timer = new ActivityTimer({ now: h.now, activity: h.activity, started: true, onStateChange: (s) => states.push(s) });
  h.run(timer, 1000);
  h.setActive(false, 'hidden');
  assert.equal(timer.running, false);
  assert.deepEqual([timer.state.paused, timer.state.reason], [true, 'hidden']);
  h.run(timer, 60_000); // time away never counts
  assert.equal(timer.elapsedMs, 1000);
  h.setActive(false, 'blurred');
  assert.equal(timer.state.reason, 'blurred');
  h.setActive(true);
  assert.equal(timer.running, true);
  h.run(timer, 500);
  assert.equal(timer.elapsedMs, 1500);
  assert.deepEqual(states.map((s) => `${s.running}:${s.reason}`), ['false:hidden', 'false:blurred', 'true:null']);
});

test('manual pause is not cleared by activity changes; resume() clears it', () => {
  const h = harness();
  const timer = new ActivityTimer({ now: h.now, activity: h.activity, started: true });
  h.run(timer, 1000);
  timer.pause();
  assert.equal(timer.state.reason, 'manual');
  h.setActive(false);
  h.setActive(true);
  assert.equal(timer.running, false, 'still manually paused after regaining focus');
  h.run(timer, 5000);
  assert.equal(timer.elapsedMs, 1000);
  timer.resume();
  h.run(timer, 1000);
  assert.equal(timer.elapsedMs, 2000);
});

test('stops for good when solved', () => {
  const h = harness();
  const timer = new ActivityTimer({ now: h.now, activity: h.activity, started: true });
  h.run(timer, 4000);
  timer.setSolved(true);
  h.run(timer, 4000);
  assert.equal(timer.elapsedMs, 4000);
  assert.equal(timer.state.paused, false, 'a solved puzzle is not "paused"');
});

test('discards a huge single gap (sleep / frozen tab) but keeps normal deltas', () => {
  const h = harness();
  const timer = new ActivityTimer({ now: h.now, activity: h.activity, started: true, maxGapMs: 30_000 });
  h.run(timer, 1000);
  h.advance(10 * 60_000); // laptop lid closed while "visible"
  timer.tick();
  assert.equal(timer.elapsedMs, 1000);
  h.run(timer, 1000);
  assert.equal(timer.elapsedMs, 2000);
});

test('persists every 5 s of running time and when it stops', () => {
  const h = harness();
  const saved = [];
  const timer = new ActivityTimer({ now: h.now, activity: h.activity, started: true, onPersist: (ms) => saved.push(ms) });
  h.run(timer, 12_000);
  assert.deepEqual(saved, [5000, 10_000]);
  h.advance(750);
  h.setActive(false); // blur/hide -> save immediately, including the partial segment
  assert.deepEqual(saved, [5000, 10_000, 12_750]);
});

test('onTick reports elapsed while running only', () => {
  const h = harness();
  const ticks = [];
  const timer = new ActivityTimer({ now: h.now, activity: h.activity, started: true, onTick: (ms) => ticks.push(ms) });
  h.run(timer, 1000, 500);
  h.setActive(false);
  h.run(timer, 1000, 500);
  assert.deepEqual(ticks, [500, 1000]);
});

test('startTicking/dispose manage the interval and the activity subscription', () => {
  const h = harness();
  const timer = new ActivityTimer({ now: h.now, activity: h.activity, scheduler: h.scheduler, started: true });
  timer.startTicking();
  timer.startTicking();
  assert.equal(h.intervals.size, 1);
  const [{ fn }] = h.intervals.values();
  h.advance(250);
  fn();
  assert.equal(timer.elapsedMs, 250);
  assert.equal(h.subscribers(), 1);
  timer.dispose();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.subscribers(), 0);
});

test('setStarted while inactive waits for activity', () => {
  const h = harness({ active: false, reason: 'hidden' });
  const timer = new ActivityTimer({ now: h.now, activity: h.activity });
  timer.setStarted(true);
  assert.equal(timer.running, false);
  assert.equal(timer.state.paused, true);
  h.run(timer, 2000);
  h.setActive(true);
  h.run(timer, 1000);
  assert.equal(timer.elapsedMs, 1000);
});
