/**
 * #5622 — the analyst panel's denial copy, as an executable table.
 *
 * `src/components/ChatAnalystPanel.ts` imports DOMPurify and `marked` at module
 * scope, so `describeDenial` was unreachable from `tsx --test` and its new
 * billing-verification branch shipped with no coverage. The decision now lives
 * in a zero-runtime-import leaf; this pins it.
 *
 * The branch that matters: a retryable 503 must NOT fall through to
 * `classifyDenialResponse`, which owns only 401/403 and returns null for a 5xx —
 * that fallthrough renders `Error 503`, the least actionable string we have, for
 * the one state where the user's subscription is fine and waiting works.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  analystDenialMessage,
  isBillingVerificationDenial,
  PRO_VERIFICATION_RETRY_MESSAGE,
} from '../src/services/analyst-denial.ts';

test('a 503 carrying X-Billing-Verification is the retryable branch', () => {
  assert.equal(
    isBillingVerificationDenial(503, 'entitlement_verification_unavailable'),
    true,
  );
  assert.equal(isBillingVerificationDenial(503, 'renewal_verification_pending'), true);
  assert.equal(isBillingVerificationDenial(503, 'renewal_verification_failed'), true);
});

test('a 503 WITHOUT the header is not the billing branch', () => {
  // api/notification-channels.ts and friends answer a bare 503 for missing env
  // and for relay failures. Those are not retryable billing states and must not
  // borrow the "your subscription is fine" copy.
  assert.equal(isBillingVerificationDenial(503, null), false);
  assert.equal(isBillingVerificationDenial(503, ''), false);
});

test('the header alone does not make a non-503 retryable', () => {
  // A terminal 403 lapse also carries X-Billing-Verification (subscription_lapsed).
  // Keying on the header alone would turn a resubscribe into a retry loop.
  assert.equal(isBillingVerificationDenial(403, 'subscription_lapsed'), false);
  assert.equal(isBillingVerificationDenial(401, 'entitlement_verification_unavailable'), false);
  assert.equal(isBillingVerificationDenial(200, 'entitlement_verification_unavailable'), false);
});

test('verdict-to-copy mapping covers every PremiumDenialVerdict member', () => {
  assert.equal(analystDenialMessage(401, 'sign_in_required'), 'Sign in to use the analyst.');
  assert.equal(analystDenialMessage(403, 'upgrade_required'), 'Pro subscription required.');
  assert.equal(
    analystDenialMessage(403, 'access_denied'),
    'Analyst temporarily unavailable — try again in a moment.',
  );
});

test('entitlement_desync shares copy with the billing-verification 503', () => {
  // Same situation from the user's side: we cannot confirm your access, and
  // retrying helps. If these ever diverge it should be a deliberate edit.
  assert.equal(analystDenialMessage(403, 'entitlement_desync'), PRO_VERIFICATION_RETRY_MESSAGE);
});

test('an unclassified denial falls back to the bare status', () => {
  assert.equal(analystDenialMessage(503, null), 'Error 503');
  assert.equal(analystDenialMessage(500, null), 'Error 500');
});

test('the retryable copy never tells a paying customer to subscribe', () => {
  // The #5600 regression in one assertion: the transient state must not render
  // the upsell string.
  assert.notEqual(PRO_VERIFICATION_RETRY_MESSAGE, 'Pro subscription required.');
  assert.ok(!/subscri/i.test(PRO_VERIFICATION_RETRY_MESSAGE));
});
