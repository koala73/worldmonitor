/**
 * Regression tests for the Sentry-emit contract in `reportCheckoutError`.
 *
 * The `no-user` checkout path is a pre-auth redirect UX (user clicks upgrade
 * before signing up), not an engineering failure. Clerk conversion analytics
 * already tracks that funnel, so `reportCheckoutError` deliberately skips
 * Sentry capture for `action: 'no-user'`. Every other action MUST still emit,
 * or mid-flight auth drops / missing tokens / server errors would be invisible
 * — exactly the class of regression a future refactor could introduce by
 * renaming or collapsing action strings.
 *
 * Tests the exported `shouldSkipSentryForAction` predicate (the pure policy)
 * and asserts the contract against every action string actually used in
 * src/services/checkout.ts so a silent drift gets caught.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldSkipSentryForAction, SENTRY_SKIP_ACTIONS } from '../src/services/checkout-sentry-policy.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('shouldSkipSentryForAction', () => {
  it('skips Sentry for the no-user pre-auth redirect', () => {
    assert.equal(shouldSkipSentryForAction('no-user'), true);
  });

  it('does NOT skip Sentry for session_expired / no-token (mid-flight auth drop)', () => {
    // no-token fires when Clerk returns null token mid-flight after a valid
    // session — a real auth-bridge regression we MUST see.
    assert.equal(shouldSkipSentryForAction('no-token'), false);
  });

  it('does NOT skip Sentry for http-error (server / network failures)', () => {
    assert.equal(shouldSkipSentryForAction('http-error'), false);
  });

  it('does NOT skip Sentry for missing-checkout-url (malformed Convex response)', () => {
    assert.equal(shouldSkipSentryForAction('missing-checkout-url'), false);
  });

  it('does NOT skip Sentry for exception (unhandled throw inside startCheckout)', () => {
    assert.equal(shouldSkipSentryForAction('exception'), false);
  });

  it('does NOT skip Sentry for entitlement-timeout (post-success activation failure)', () => {
    assert.equal(shouldSkipSentryForAction('entitlement-timeout'), false);
  });

  it('does NOT skip Sentry for an unknown / future action string', () => {
    // Fail-safe: default must be "emit to Sentry" so adding a new error site
    // never silently blinds the funnel.
    assert.equal(shouldSkipSentryForAction('something-we-havent-written-yet'), false);
  });

  it('has exactly one skip action (guards against scope drift)', () => {
    // If this grows, the PR that expands it must update this assertion AND
    // the docstring on SENTRY_SKIP_ACTIONS. Keeping the set tiny limits the
    // blast radius for future refactors that might rename `action` tags.
    assert.equal(SENTRY_SKIP_ACTIONS.size, 1);
    assert.ok(SENTRY_SKIP_ACTIONS.has('no-user'));
  });
});

describe('reportCheckoutError call sites in src/services/checkout.ts', () => {
  // Static guard: every `reportCheckoutError(... action: 'X' ...)` call site
  // in the implementation corresponds to a known skip / no-skip decision.
  // If someone adds a new action string without adding a matching assertion
  // in shouldSkipSentryForAction tests above, this test fails — forcing the
  // author to explicitly declare the Sentry-emit policy for the new action.
  const src = readFileSync(resolve(__dirname, '../src/services/checkout.ts'), 'utf-8');
  // Non-greedy multi-line match: `reportCheckoutError(` ... up to 300 chars
  // ... `action: '<tag>'`. Handles call sites where the first arg is itself
  // a function call (classifySyntheticCheckoutError('unauthorized')) so the
  // `action` tag can live on a later line.
  const actionRegex = /reportCheckoutError\([\s\S]{0,300}?action:\s*'([^']+)'/g;
  const knownActions = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = actionRegex.exec(src)) !== null) {
    knownActions.add(m[1]);
  }

  it('finds the expected reportCheckoutError call sites', () => {
    // Pins actual usage at the time of writing. If a new error site is added,
    // this assertion forces an accompanying policy decision.
    assert.deepEqual(
      [...knownActions].sort(),
      ['exception', 'http-error', 'missing-checkout-url', 'no-token', 'no-user'].sort(),
    );
  });

  it('no-user is the only call site marked for skip', () => {
    for (const action of knownActions) {
      const expected = action === 'no-user';
      assert.equal(
        shouldSkipSentryForAction(action),
        expected,
        `action='${action}' must ${expected ? 'skip' : 'emit'} Sentry`,
      );
    }
  });
});
