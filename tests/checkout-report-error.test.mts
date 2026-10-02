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
import {
  buildCheckoutReportTags,
  CHECKOUT_REPORT_KIND,
  shouldSkipSentryForAction,
  SENTRY_SKIP_ACTIONS,
} from '../src/services/checkout-sentry-policy.ts';
import { checkoutErrorTelemetryLevel } from '../src/services/checkout.ts';

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
      [
        'exception',
        'http-error',
        'missing-checkout-url',
        // WORLDMONITOR-XV: a 200 whose body will not parse is reported
        // separately from one that parses but lacks checkout_url — the
        // two point at different layers (transport vs. relay payload).
        'unparsable-success-body',
        'no-token',
        'no-user',
        // #5911: the server produced a usable checkout URL but the desktop
        // handoff to the OS browser never opened it. Distinct from every tag
        // above because the failure is client/native-side, not a server
        // contract violation — and it is NOT skipped: a buyer who cannot
        // reach a checkout session we already created is exactly the event
        // that must reach Sentry.
        'desktop-handoff-failed',
      ].sort(),
    );
  });

  // WORLDMONITOR-Q4: the `kind` tag is the only thing keeping a checkout
  // timeout visible. The transport's 15s budget rejects with a browser-minted
  // `TimeoutError: signal timed out` DOMException whose stack is the header
  // line alone, so the zero-frame gate in src/bootstrap/sentry-init.ts drops
  // it as extension noise unless `kind` is present. Deleting the tag here
  // leaves tests/sentry-beforesend.test.mjs green — it supplies its own
  // fixture tags — while production goes silent, so the emit side needs its
  // own lock. Asserted as source text because `reportCheckoutError` is
  // module-private.
  it('puts the first-party `kind` on TAGS, where beforeSend reads it', () => {
    // Asserted on the real object, not by grepping the file. beforeSend reads
    // only `event.tags.kind`, and a source regex for the literal matches it
    // just as happily inside `extra` or a comment — so moving the key one
    // field over would leave every test green while production went dark.
    const tags = buildCheckoutReportTags({ action: 'exception', code: 'service_unavailable' });
    assert.equal(tags.kind, CHECKOUT_REPORT_KIND);
    assert.equal(tags.component, 'dodo-checkout');
    assert.equal(tags.action, 'exception');
    assert.equal(tags.code, 'service_unavailable');
    // The upstream identity tags stay optional — absent, not empty strings, so
    // the Sentry tag list does not fill with blanks (WORLDMONITOR-RN).
    assert.ok(!('cfRay' in tags));
    assert.ok(!('upstreamServer' in tags));
    const withUpstream = buildCheckoutReportTags({
      action: 'http-error',
      code: 'service_unavailable',
      cfRay: 'a1b2c3-SIN',
      upstreamServer: 'cloudflare',
    });
    assert.equal(withUpstream.cfRay, 'a1b2c3-SIN');
    assert.equal(withUpstream.upstreamServer, 'cloudflare');
    assert.equal(withUpstream.kind, CHECKOUT_REPORT_KIND);
  });

  it('builds the report tags through that helper rather than a local literal', () => {
    // The helper is only load-bearing if reportCheckoutError actually uses it.
    assert.match(
      src,
      /tags:\s*buildCheckoutReportTags\(/,
      'reportCheckoutError must build its tag block via buildCheckoutReportTags, so the assertion above tests the shipped object',
    );
  });

  it('actually hands the tagged payload to the Sentry capture calls', () => {
    // Building `payload` is not the same as delivering it. Dropping the second
    // argument — `s.captureException(caught)` — leaves the tag block above
    // untouched, so the assertion above still passes while production timeout
    // reports lose their exemption and go silent again. The gate's own suite
    // cannot catch this either: it supplies fixture tags of its own.
    assert.match(
      src,
      /captureException\(caught,\s*payload\)/,
      'the caught exception must be captured WITH the payload that carries the kind tag',
    );
    assert.match(
      src,
      /captureMessage\(`Checkout error: \$\{error\.code\}`,\s*payload\)/,
      'the message path must be captured WITH the payload that carries the kind tag',
    );
  });

  // The gate's own half of this contract is asserted behaviourally in
  // tests/sentry-beforesend.test.mjs, which compiles the real beforeSend and
  // drives a captureException through it. A source-text regex was tried here
  // and removed: six behaviour-preserving spellings of the same condition
  // (`== null`, `'kind' in ...`, an extracted helper, destructuring) all failed
  // it, and a false red on a correct refactor is what teaches the next author
  // to delete the assertion.

  it('keeps duplicate-subscription checkout attempts at info level', () => {
    assert.equal(checkoutErrorTelemetryLevel({ code: 'duplicate_subscription' }), 'info');
    assert.equal(checkoutErrorTelemetryLevel({ code: 'rate_limited' }), 'info');
    assert.equal(checkoutErrorTelemetryLevel({ code: 'payment_in_progress' }), 'error');
    assert.equal(checkoutErrorTelemetryLevel({ code: 'service_unavailable' }), 'error');
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
