/**
 * Entitlement listener fan-out isolation (#5632 review follow-up).
 *
 * Subscribers to `onEntitlementChange` are independent UI surfaces — the panel
 * gate, the Pro banner, the export gate, the playback gate. They share one
 * emission loop, so an unguarded loop means the FIRST listener to throw
 * silently stops every listener registered after it from ever updating again.
 * There is no error path for that: the survivors quietly hold their last
 * verdict, which is the same "green while dead" shape the gate this landed
 * beside was fixed for.
 *
 * `resetEntitlementState()` is the one emission site reachable without a live
 * Convex client, so it is what these tests drive. The Convex watch path shares
 * the same `notifyListeners` helper by construction, which is the point of the
 * extraction — the guarantee cannot hold on one path and not the other.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { onEntitlementChange, resetEntitlementState } from '@/services/entitlements';

/** Unsubscribers for every listener a test registers. */
let cleanup: Array<() => void> = [];

function subscribe(fn: (state: unknown) => void): void {
  cleanup.push(onEntitlementChange(fn));
}

beforeEach(() => {
  cleanup = [];
});

afterEach(() => {
  for (const off of cleanup) off();
  cleanup = [];
});

describe('entitlement listener fan-out', () => {
  it('keeps notifying later listeners after an earlier one throws', () => {
    const order: string[] = [];

    subscribe(() => {
      order.push('first');
      throw new Error('listener blew up');
    });
    subscribe(() => order.push('second'));
    subscribe(() => order.push('third'));

    // Must not propagate: the emitter's caller is a Convex callback (or a
    // sign-out handler) with no meaningful way to recover from one subscriber.
    assert.doesNotThrow(() => resetEntitlementState());

    assert.deepEqual(order, ['first', 'second', 'third']);
  });

  it('survives every listener throwing', () => {
    let calls = 0;
    for (let i = 0; i < 3; i++) {
      subscribe(() => {
        calls++;
        throw new Error(`listener ${i}`);
      });
    }

    assert.doesNotThrow(() => resetEntitlementState());
    assert.equal(calls, 3);
  });

  it('still delivers on later emissions after a listener threw once', () => {
    // The isolation must not be one-shot: a listener that throws on the first
    // emission and recovers has to keep receiving, and its siblings must not
    // be dropped from the set.
    let thrown = 0;
    let healthy = 0;

    subscribe(() => {
      thrown++;
      if (thrown === 1) throw new Error('transient');
    });
    subscribe(() => healthy++);

    resetEntitlementState();
    resetEntitlementState();

    assert.equal(thrown, 2);
    assert.equal(healthy, 2);
  });

  it('unsubscribing a throwing listener removes it from the fan-out', () => {
    let healthy = 0;
    const off = onEntitlementChange(() => {
      throw new Error('bad');
    });
    subscribe(() => healthy++);

    resetEntitlementState();
    off();
    resetEntitlementState();

    assert.equal(healthy, 2);
  });
});
