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

const { decideNoUserPathOutcome } = await import('../src/services/checkout-no-user-policy.ts');

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

// #5380 High-3: the policy module is pure, so a mutation wiring
// `savePendingCheckoutIntent(intent)` into checkout.ts's REDIRECT branch left
// this suite green — the leak this file documents would be back with every
// test passing. Pin the caller's wiring by source-grep (checkout.ts needs the
// full Clerk + Dodo tree and cannot load under node:test).
describe('startCheckout no-user wiring (source-grep)', () => {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(dirname, '..', 'src', 'services', 'checkout.ts'), 'utf8');

  function noUserBlock(): { redirectBranch: string; inlineBranch: string } {
    const start = src.indexOf('const outcome = decideNoUserPathOutcome');
    assert.ok(start > -1, 'expected decideNoUserPathOutcome call in checkout.ts');
    const ifIdx = src.indexOf("if (outcome.kind === 'redirect-pro')", start);
    const elseIdx = src.indexOf('} else {', ifIdx);
    const endIdx = src.indexOf('return false;', elseIdx);
    assert.ok(ifIdx > -1 && elseIdx > ifIdx && endIdx > elseIdx, 'no-user branch shape changed — update this test');
    return {
      redirectBranch: src.slice(ifIdx, elseIdx),
      inlineBranch: src.slice(elseIdx, endIdx),
    };
  }

  it('redirect-pro branch must NOT persist a pending checkout intent', () => {
    const { redirectBranch } = noUserBlock();
    assert.ok(redirectBranch.includes('window.location.assign'), 'redirect branch must navigate');
    assert.ok(
      !redirectBranch.includes('savePendingCheckoutIntent'),
      'redirect path persisting intent recreates the stale auto-resume leak this suite exists to prevent',
    );
    assert.ok(!redirectBranch.includes('saveCheckoutAttempt'), 'redirect path must not persist attempt state either');
  });

  it('inline sign-in branch MUST persist the intent before opening sign-in', () => {
    const { inlineBranch } = noUserBlock();
    const saveIdx = inlineBranch.indexOf('savePendingCheckoutIntent(intent)');
    const signInIdx = inlineBranch.indexOf('openSignIn()');
    assert.ok(saveIdx > -1, 'inline path must persist the pending intent');
    assert.ok(signInIdx > saveIdx, 'intent must be persisted BEFORE openSignIn so the post-auth listener can resume');
  });
});
