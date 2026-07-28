/**
 * Regression test for the cross-page checkout intent leak that the
 * PR-3 reviewer flagged on commit b4e8fb3a1.
 *
 * Scenario covered:
 *   1. Signed-out dashboard click on a paid panel upsell (the common
 *      "click locked feature" path) → default fallbackToPricingPage=true
 *      → user is redirected to /pro.
 *   2. User does nothing on /pro (closes tab, navigates away, etc.).
 *   3. Hours/days later, the same browser tab signs in on the dashboard
 *      for an UNRELATED reason (e.g., responding to a notification).
 *   4. Without this fix, the dashboard's post-sign-in auto-resume
 *      listener reads the stale `wm-pending-checkout` key and pops a
 *      Dodo overlay for a checkout the user never asked to resume.
 *
 * The fix: the redirect-to-/pro path must NOT write
 * `wm-pending-checkout`. Only the inline-sign-in path (
 * fallbackToPricingPage=false) writes pending state, scoped to the
 * dashboard's own resume flow.
 *
 * Tested via the pure `decideNoUserPathOutcome` policy helper because
 * the surrounding `startCheckout` requires the full Clerk + Dodo SDK
 * dependency tree. The test simulates the storage state that the
 * caller would create based on the policy outcome, then exercises the
 * resume path against a sessionStorage that has NEVER been written —
 * proving auto-resume gets nothing.
 */

import { describe, it, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripJsComments } from '../scripts/lib/js-source-structure.mjs';

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

const PENDING_CHECKOUT_KEY = 'wm-pending-checkout';
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

const { decideNoUserPathOutcome, runNoUserPath } = await import(
  '../src/services/checkout-no-user-policy.ts'
);

describe('decideNoUserPathOutcome', () => {
  it('default (fallbackToPricingPage=true) returns redirect-pro with persist=false', () => {
    const outcome = decideNoUserPathOutcome(true);
    assert.equal(outcome.kind, 'redirect-pro');
    assert.equal(outcome.persist, false);
    if (outcome.kind === 'redirect-pro') {
      assert.equal(outcome.redirectUrl, 'https://worldmonitor.app/pro');
    }
  });

  it('explicit opt-out (fallbackToPricingPage=false) returns inline-signin with persist=true', () => {
    const outcome = decideNoUserPathOutcome(false);
    assert.equal(outcome.kind, 'inline-signin');
    assert.equal(outcome.persist, true);
  });
});

describe('cross-page redirect leak regression', () => {
  it('signed-out → /pro redirect → no purchase → later sign-in: no auto-resume', () => {
    // Step 1: signed-out dashboard click. The policy decides /pro
    // redirect; CALLER must respect persist=false and skip
    // savePendingCheckoutIntent.
    const outcome = decideNoUserPathOutcome(true);
    assert.equal(outcome.kind, 'redirect-pro');
    assert.equal(outcome.persist, false);
    // Simulate caller correctly skipping the persist:
    // (deliberately do NOT call sessionStorage.setItem)

    // Step 2: user does nothing on /pro. Dashboard sessionStorage is
    // untouched.

    // Step 3: later sign-in on the dashboard. Resume path checks the
    // pending key.
    const stalePending = _sessionStorage.getItem(PENDING_CHECKOUT_KEY);

    // Step 4: must be null — no auto-resume can fire.
    assert.equal(
      stalePending,
      null,
      'PENDING_CHECKOUT_KEY must not be written on the redirect-to-/pro path',
    );
  });

  it('inline sign-in path DOES persist intent (resume needs it)', () => {
    const outcome = decideNoUserPathOutcome(false);
    assert.equal(outcome.persist, true);
    // Simulate caller correctly persisting on the inline path:
    _sessionStorage.setItem(
      PENDING_CHECKOUT_KEY,
      JSON.stringify({ productId: 'pdt_X' }),
    );
    const restored = _sessionStorage.getItem(PENDING_CHECKOUT_KEY);
    assert.notEqual(restored, null);
  });

  it('redirect-pro outcome carries the canonical /pro URL (not relative)', () => {
    // Regression guard: an absolute URL is required because the
    // dashboard origin and /pro origin are the same in prod
    // (worldmonitor.app) but the helper is also used from sub-origin
    // contexts; relative would resolve unexpectedly.
    const outcome = decideNoUserPathOutcome(true);
    if (outcome.kind === 'redirect-pro') {
      assert.match(outcome.redirectUrl, /^https:\/\/worldmonitor\.app\/pro$/);
    } else {
      assert.fail('expected redirect-pro outcome');
    }
  });
});

// #5380 High-3: `decideNoUserPathOutcome` alone could not see the caller's
// wiring, so a mutation persisting inside the REDIRECT branch left this suite
// green. The first attempt at closing that used a source-grep guard over
// checkout.ts — and two mutations proved a regex cannot do this job:
//
//   a) moving `openSignIn()` ABOVE the persist calls and leaving a comment
//      naming `savePendingCheckoutIntent(intent)` above it — `indexOf` found
//      the comment, so the ordering assertion held with the bug restored;
//   b) writing `sessionStorage.setItem(...)` directly in the redirect branch —
//      the negative grep for `savePendingCheckoutIntent` never fired.
//
// Both are now executable failures: `runNoUserPath` owns the sequencing, and
// this suite runs it against a recorder.
describe('runNoUserPath effect sequencing', () => {
  function record(fallbackToPricingPage: boolean): string[] {
    const log: string[] = [];
    runNoUserPath(fallbackToPricingPage, {
      navigate: (url) => log.push(`navigate:${url}`),
      persistIntent: () => log.push('persistIntent'),
      persistAttempt: () => log.push('persistAttempt'),
      openSignIn: () => log.push('openSignIn'),
    });
    return log;
  }

  it('redirect path navigates and performs NO persistence at all', () => {
    assert.deepEqual(record(true), ['navigate:https://worldmonitor.app/pro']);
  });

  it('inline path persists intent AND attempt BEFORE opening sign-in', () => {
    // Exact sequence, not just membership: Clerk's post-auth listener fires as
    // soon as sign-in resolves, so a persist that lands after openSignIn can
    // miss the resume window.
    assert.deepEqual(record(false), ['persistIntent', 'persistAttempt', 'openSignIn']);
  });

  it('inline path never navigates away from the dashboard', () => {
    assert.ok(!record(false).some((entry) => entry.startsWith('navigate:')));
  });
});

// What regex IS reliable for: call-site COUNTS. The handler literal in
// checkout.ts is the only wiring the executable tests above cannot reach, so
// pin how many times this module writes checkout state. Any NEW write site —
// including a direct `sessionStorage.setItem` in the redirect handler (bypass
// (b) above) — moves a count and reds this test. Counts survive the comment
// and indirection tricks that defeat proximity and negative greps.
describe('checkout.ts checkout-state write sites (count pins)', () => {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const src = stripJsComments(
    readFileSync(path.join(dirname, '..', 'src', 'services', 'checkout.ts'), 'utf8'),
  );

  function countOf(token: string): number {
    return src.split(token).length - 1;
  }

  it('delegates the signed-out branch to runNoUserPath exactly once', () => {
    assert.equal(countOf('runNoUserPath('), 1);
  });

  it('pins every checkout-state write site in checkout.ts', () => {
    // savePendingCheckoutIntent: 1 declaration + 3 calls (the /pro-origin
    // capture, the signed-out handler, the mid-flight session-expired retry).
    assert.equal(
      countOf('savePendingCheckoutIntent('),
      4,
      'a new pending-intent write site appeared — confirm it cannot fire on the redirect path (#5380)',
    );
    // saveCheckoutAttempt: 3 calls (/pro-origin capture, signed-out handler,
    // pre-network attempt record); imported, not declared here.
    assert.equal(
      countOf('saveCheckoutAttempt('),
      3,
      'a new attempt write site appeared — confirm it cannot fire on the redirect path (#5380)',
    );
    // Direct sessionStorage writes: the post-checkout flag and the pending
    // intent serializer. A third means someone bypassed both helpers.
    assert.equal(
      countOf('sessionStorage.setItem('),
      2,
      'a direct sessionStorage write bypasses the persistence helpers — see #5380 bypass (b)',
    );
  });
});
