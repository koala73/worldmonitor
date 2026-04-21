/**
 * Exercises the save/load/clear primitives for LAST_CHECKOUT_ATTEMPT_KEY
 * and the abandonment sweep. The key invariant under test is the two-key
 * separation: Primitive A's PENDING_CHECKOUT_KEY and LAST_CHECKOUT_ATTEMPT_KEY
 * have different terminal-clear triggers (see the plan's Primitive A section).
 *
 * Only pure storage helpers are exercised here — startCheckout() and the
 * Dodo overlay event handlers require a browser/SDK environment and are
 * covered by manual + E2E paths per the PR plan.
 */

import { describe, it, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  private readonly store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

const LAST_CHECKOUT_ATTEMPT_KEY = 'wm-last-checkout-attempt';

let _sessionStorage: MemoryStorage;

before(() => {
  _sessionStorage = new MemoryStorage();
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: _sessionStorage,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { href: 'https://worldmonitor.app/', pathname: '/', search: '', hash: '' },
      history: { replaceState: () => {} },
    },
  });
});

after(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).sessionStorage;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).window;
});

beforeEach(() => {
  _sessionStorage.clear();
});

const {
  saveCheckoutAttempt,
  loadCheckoutAttempt,
  clearCheckoutAttempt,
  sweepAbandonedCheckoutAttempt,
} = await import('../src/services/checkout-attempt.ts');

describe('saveCheckoutAttempt / loadCheckoutAttempt', () => {
  it('round-trips a fresh attempt', () => {
    saveCheckoutAttempt({
      productId: 'pdt_X',
      referralCode: 'abc',
      startedAt: Date.now(),
      origin: 'dashboard',
    });
    const loaded = loadCheckoutAttempt();
    assert.equal(loaded?.productId, 'pdt_X');
    assert.equal(loaded?.referralCode, 'abc');
    assert.equal(loaded?.origin, 'dashboard');
  });

  it('returns null when nothing stored', () => {
    assert.equal(loadCheckoutAttempt(), null);
  });

  it('returns null for malformed JSON', () => {
    _sessionStorage.setItem(LAST_CHECKOUT_ATTEMPT_KEY, '{not json');
    assert.equal(loadCheckoutAttempt(), null);
  });

  it('returns null for stored records missing productId', () => {
    _sessionStorage.setItem(
      LAST_CHECKOUT_ATTEMPT_KEY,
      JSON.stringify({ startedAt: Date.now(), origin: 'dashboard' }),
    );
    assert.equal(loadCheckoutAttempt(), null);
  });

  it('returns null for records older than 24h', () => {
    const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;
    saveCheckoutAttempt({
      productId: 'pdt_X',
      startedAt: twentyFiveHoursAgo,
      origin: 'dashboard',
    });
    assert.equal(loadCheckoutAttempt(), null);
  });

  it('returns record just under 24h', () => {
    const twentyThreeHoursAgo = Date.now() - 23 * 60 * 60 * 1000;
    saveCheckoutAttempt({
      productId: 'pdt_X',
      startedAt: twentyThreeHoursAgo,
      origin: 'pro',
    });
    assert.equal(loadCheckoutAttempt()?.productId, 'pdt_X');
  });
});

describe('clearCheckoutAttempt', () => {
  it('clears the stored record regardless of reason', () => {
    const reasons: Array<'success' | 'duplicate' | 'signout' | 'dismissed' | 'abandoned'> = [
      'success',
      'duplicate',
      'signout',
      'dismissed',
      'abandoned',
    ];
    for (const reason of reasons) {
      saveCheckoutAttempt({
        productId: 'pdt_X',
        startedAt: Date.now(),
        origin: 'dashboard',
      });
      clearCheckoutAttempt(reason);
      assert.equal(loadCheckoutAttempt(), null, `reason=${reason} should clear the record`);
    }
  });

  it('is safe to call with no record present', () => {
    assert.doesNotThrow(() => clearCheckoutAttempt('success'));
  });
});

describe('sweepAbandonedCheckoutAttempt', () => {
  it('does not clear when return params are present (failed-redirect race guard)', () => {
    const oldAttempt = {
      productId: 'pdt_X',
      startedAt: Date.now() - 40 * 60 * 1000, // 40min old, past abandon cutoff
      origin: 'dashboard' as const,
    };
    saveCheckoutAttempt(oldAttempt);
    // hasReturnParams = true means the page carries ?status=failed (or
    // similar) — we must NOT clear because the failure banner is about
    // to consume the attempt record to populate retry.
    sweepAbandonedCheckoutAttempt(true);
    assert.equal(loadCheckoutAttempt()?.productId, 'pdt_X');
  });

  it('clears records older than 30min when no return params', () => {
    saveCheckoutAttempt({
      productId: 'pdt_X',
      startedAt: Date.now() - 45 * 60 * 1000,
      origin: 'dashboard',
    });
    sweepAbandonedCheckoutAttempt(false);
    assert.equal(loadCheckoutAttempt(), null);
  });

  it('preserves records younger than 30min when no return params', () => {
    saveCheckoutAttempt({
      productId: 'pdt_X',
      startedAt: Date.now() - 5 * 60 * 1000,
      origin: 'dashboard',
    });
    sweepAbandonedCheckoutAttempt(false);
    assert.equal(loadCheckoutAttempt()?.productId, 'pdt_X');
  });

  it('clears malformed records defensively', () => {
    _sessionStorage.setItem(LAST_CHECKOUT_ATTEMPT_KEY, '{not json');
    sweepAbandonedCheckoutAttempt(false);
    assert.equal(_sessionStorage.getItem(LAST_CHECKOUT_ATTEMPT_KEY), null);
  });

  it('is a no-op when nothing is stored', () => {
    sweepAbandonedCheckoutAttempt(false);
    assert.equal(loadCheckoutAttempt(), null);
  });
});
