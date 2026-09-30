/**
 * Sign-up funnel events for the resume feature (#8577): started, resumed,
 * resume-dismissed, and `resumed` on the completion `sign-up` event, read
 * once from a marker the resume surface sets before the completion reload.
 */

import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

const store = new Map<string, string>();
const calls: Array<{ event: string; data?: Record<string, unknown> }> = [];

before(() => {
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage,
      umami: {
        track: (event: string, data?: Record<string, unknown>) => calls.push({ event, data }),
        identify: () => {},
      },
    },
  });
});

const analytics = await import('../src/services/analytics.ts');

beforeEach(() => {
  store.clear();
  calls.length = 0;
  analytics.resetAnalyticsForTesting();
});

describe('sign-up resume funnel events', () => {
  it('emits the three resume events with closed payloads', () => {
    analytics.trackSignUpStarted();
    analytics.trackSignUpResumed({ trigger: 'hydration', code: 'live', sinceBootMs: 4200 });
    analytics.trackSignUpResumeDismissed();
    assert.deepEqual(calls, [
      { event: 'sign-up-started', data: undefined },
      { event: 'sign-up-resumed', data: { trigger: 'hydration', code: 'live', since_boot_ms: 4200 } },
      { event: 'sign-up-resume-dismissed', data: undefined },
    ]);
  });

  it('sign-up carries resumed, and the marker is consumed once', () => {
    assert.equal(analytics.consumeSignUpResumed(), false);
    analytics.markSignUpResumed();
    assert.equal(analytics.consumeSignUpResumed(), true);
    assert.equal(analytics.consumeSignUpResumed(), false, 'a second completion must not read the same marker');

    analytics.trackSignUp('clerk', { resumed: true });
    analytics.trackSignUp('clerk');
    assert.deepEqual(calls, [
      { event: 'sign-up', data: { method: 'clerk', resumed: true } },
      { event: 'sign-up', data: { method: 'clerk', resumed: false } },
    ]);
  });
});
