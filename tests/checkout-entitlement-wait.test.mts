/**
 * Behavioural tests for the post-checkout entitlement wait
 * (`src/services/checkout-entitlement-wait.ts`).
 *
 * WORLDMONITOR-PZ / #6760. Production evidence: of the checkout-timeout events
 * that carried a Clerk id, three users held an ACTIVE `pro_monthly` whose
 * subscription period had already started BEFORE Sentry recorded the timeout —
 * one of them 2 m 19 s before. The payment and the entitlement were correct;
 * the banner declared an activation failure anyway.
 *
 * The three cases named `PZ:` below are that bug. They fail against the logic
 * as it shipped (subscribe-only, tear down at the deadline) and pass against
 * the fix.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  startEntitlementWait,
  type EntitlementWaitDeps,
  type EntitlementWaitState,
} from '../src/services/checkout-entitlement-wait.ts';

type Timer = { at: number; fn: () => void; every: number | null };

/** Deterministic fake clock — no real timers, so ordering cannot flake. */
function createClock() {
  let now = 0;
  let seq = 1;
  const timers = new Map<number, Timer>();
  return {
    now: () => now,
    pendingCount: () => timers.size,
    setTimeout(fn: () => void, ms: number): number {
      const id = seq++;
      timers.set(id, { at: now + ms, fn, every: null });
      return id;
    },
    clearTimeout(id: number): void {
      timers.delete(id);
    },
    setInterval(fn: () => void, ms: number): number {
      const id = seq++;
      timers.set(id, { at: now + ms, fn, every: ms });
      return id;
    },
    clearInterval(id: number): void {
      timers.delete(id);
    },
    /** Advance time, firing due timers in chronological order. */
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        let pickId: number | null = null;
        let pick: Timer | null = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (pick === null || t.at < pick.at)) {
            pickId = id;
            pick = t;
          }
        }
        if (pickId === null || pick === null) break;
        now = pick.at;
        if (pick.every === null) timers.delete(pickId);
        else pick.at = now + pick.every;
        pick.fn();
      }
      now = target;
    },
  };
}

const TIMEOUT_MS = 30_000;
const POLL_MS = 1_000;
const GRACE_MS = 300_000;

let clock: ReturnType<typeof createClock>;
let entitled: boolean;
let states: EntitlementWaitState[];
let timeoutReports: number;
let listeners: Array<() => void>;
let unsubscribeCount: number;

beforeEach(() => {
  clock = createClock();
  entitled = false;
  states = [];
  timeoutReports = 0;
  listeners = [];
  unsubscribeCount = 0;
});

function deps(): EntitlementWaitDeps {
  return {
    isEntitled: () => entitled,
    onEntitlementChange: (listener) => {
      listeners.push(listener);
      return () => {
        unsubscribeCount += 1;
        listeners = listeners.filter((l) => l !== listener);
      };
    },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    setInterval: (fn, ms) => clock.setInterval(fn, ms),
    clearInterval: (id) => clock.clearInterval(id),
    onState: (s) => states.push(s),
    onTimeoutReport: () => {
      timeoutReports += 1;
    },
  };
}

/** Entitlement flips AND the subscription notifies — the happy path. */
function grantWithEvent(): void {
  entitled = true;
  for (const l of [...listeners]) l();
}

/** Entitlement flips with NO notification — a subscription that hydrated late. */
function grantSilently(): void {
  entitled = true;
}

const start = () =>
  startEntitlementWait(
    { timeoutMs: TIMEOUT_MS, pollMs: POLL_MS, lateGraceMs: GRACE_MS },
    deps(),
  );

describe('checkout entitlement wait', () => {
  it('resolves active immediately when the user is already entitled', () => {
    entitled = true;
    start();
    assert.deepEqual(states, ['active']);
    assert.equal(timeoutReports, 0);
    assert.equal(clock.pendingCount(), 0, 'must not schedule a deadline it will never need');
  });

  it('resolves active when the entitlement arrives with a change event', () => {
    start();
    clock.advance(2_000);
    grantWithEvent();
    assert.deepEqual(states, ['active']);
    assert.equal(timeoutReports, 0);
    clock.advance(TIMEOUT_MS * 2);
    assert.deepEqual(states, ['active'], 'the deadline must not fire after resolution');
  });

  it('ignores a change event that does not carry an entitlement', () => {
    start();
    for (const l of [...listeners]) l();
    assert.deepEqual(states, [], 'a non-entitling change must leave the banner pending');
  });

  it('reports a timeout exactly once when the entitlement genuinely never arrives', () => {
    start();
    clock.advance(TIMEOUT_MS);
    assert.deepEqual(states, ['timeout']);
    assert.equal(timeoutReports, 1);
    clock.advance(TIMEOUT_MS * 3);
    assert.equal(timeoutReports, 1, 'the timeout must be reported once, not per tick');
  });

  it('cleanup stops the deadline and unsubscribes', () => {
    const cleanup = start();
    cleanup();
    assert.ok(unsubscribeCount >= 1, 'must unsubscribe from entitlement changes');
    clock.advance(TIMEOUT_MS * 2);
    assert.deepEqual(states, [], 'a cleaned-up wait must not report anything');
    assert.equal(timeoutReports, 0);
  });

  it('cleanup is safe to call twice', () => {
    const cleanup = start();
    cleanup();
    cleanup();
    clock.advance(TIMEOUT_MS * 2);
    assert.deepEqual(states, []);
  });

  // ---- WORLDMONITOR-PZ: the three cases that shipped broken ----

  it('PZ: re-checks the entitlement at the deadline before declaring a timeout', () => {
    start();
    // The entitlement lands, but the subscription never notifies this page.
    grantSilently();
    clock.advance(TIMEOUT_MS);
    assert.deepEqual(
      states,
      ['active'],
      'the entitlement was already active at the deadline — the banner must not claim a failure',
    );
    assert.equal(timeoutReports, 0, 'must not report a timeout that did not happen');
  });

  it('PZ: sees an entitlement that arrives without a change event', () => {
    start();
    clock.advance(3_000);
    grantSilently();
    // Well before the deadline: a poll must notice.
    clock.advance(5_000);
    assert.deepEqual(states, ['active']);
    assert.equal(timeoutReports, 0);
    assert.ok(clock.now() < TIMEOUT_MS, 'must resolve before the deadline, not at it');
  });

  it('PZ: a late activation after the timeout still flips the banner to active', () => {
    start();
    clock.advance(TIMEOUT_MS);
    assert.deepEqual(states, ['timeout'], 'precondition: the deadline passed with no entitlement');
    // One second later the entitlement finally lands.
    clock.advance(1_000);
    grantWithEvent();
    assert.deepEqual(
      states,
      ['timeout', 'active'],
      'a buyer whose entitlement lands late must see the banner recover',
    );
    assert.equal(timeoutReports, 1, 'the late recovery must not re-report the timeout');
  });

  it('stops watching once the late-activation grace window expires', () => {
    start();
    clock.advance(TIMEOUT_MS);
    assert.deepEqual(states, ['timeout']);
    clock.advance(GRACE_MS + POLL_MS);
    assert.equal(clock.pendingCount(), 0, 'the grace window must be bounded, not a page-lifetime leak');
    // An activation after the window closed is nobody's business any more.
    grantWithEvent();
    assert.deepEqual(states, ['timeout'], 'no state may be reported after teardown');
  });

  it('polls only until it settles — no timers survive an active resolution', () => {
    start();
    clock.advance(2_000);
    grantSilently();
    clock.advance(POLL_MS);
    assert.deepEqual(states, ['active']);
    assert.equal(clock.pendingCount(), 0, 'the deadline and the poll must both be cleared');
    assert.ok(unsubscribeCount >= 1, 'must unsubscribe once settled');
  });
});
