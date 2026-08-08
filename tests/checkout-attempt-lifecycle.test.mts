/**
 * Exercises the save/load/clear primitives for LAST_CHECKOUT_ATTEMPT_KEY.
 * The two-key separation (attempt record vs pending auto-resume intent)
 * and the 24h staleness gate are the invariants under test.
 *
 * Only pure storage helpers are exercised here — startCheckout() and the
 * Dodo overlay event handlers require a browser/SDK environment and are
 * covered by manual + E2E paths.
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

const checkout = await import('../src/services/checkout-attempt.ts');
const { saveCheckoutAttempt, loadCheckoutAttempt, clearCheckoutAttempt } = checkout;

describe('saveCheckoutAttempt / loadCheckoutAttempt', () => {
  it('round-trips a fresh attempt', () => {
    saveCheckoutAttempt({
      productId: 'pdt_X',
      referralCode: 'abc',
      startedAt: Date.now(),
    });
    const loaded = loadCheckoutAttempt();
    assert.equal(loaded?.productId, 'pdt_X');
    assert.equal(loaded?.referralCode, 'abc');
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
      JSON.stringify({ startedAt: Date.now() }),
    );
    assert.equal(loadCheckoutAttempt(), null);
  });

  it('returns null for records older than 24h', () => {
    const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;
    saveCheckoutAttempt({
      productId: 'pdt_X',
      startedAt: twentyFiveHoursAgo,
    });
    assert.equal(loadCheckoutAttempt(), null);
  });

  it('returns record just under 24h', () => {
    const twentyThreeHoursAgo = Date.now() - 23 * 60 * 60 * 1000;
    saveCheckoutAttempt({
      productId: 'pdt_X',
      startedAt: twentyThreeHoursAgo,
    });
    assert.equal(loadCheckoutAttempt()?.productId, 'pdt_X');
  });
});

describe('clearCheckoutAttempt', () => {
  it('clears the stored record regardless of reason', () => {
    const reasons: Array<'success' | 'duplicate' | 'signout' | 'dismissed'> = [
      'success',
      'duplicate',
      'signout',
      'dismissed',
    ];
    for (const reason of reasons) {
      saveCheckoutAttempt({
        productId: 'pdt_X',
        startedAt: Date.now(),
      });
      clearCheckoutAttempt(reason);
      assert.equal(loadCheckoutAttempt(), null, `reason=${reason} should clear the record`);
    }
  });

  it('is safe to call with no record present', () => {
    assert.doesNotThrow(() => clearCheckoutAttempt('success'));
  });
});
