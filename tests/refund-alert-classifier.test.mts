import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRefundAlert } from '../convex/payments/subscriptionHelpers.ts';

// ---------------------------------------------------------------------------
// classifyRefundAlert — pure tri-state classifier for the refund-alert branch
// in handlePaymentOrRefundEvent.
//
// Background (2026-04-29 nokzbtl@gmail.com incident): Dodo Payments treats
// refund and cancellation as separate operations. Refunding a subscription
// charge does NOT cancel the subscription — operators must do both steps.
// When they forget the cancel step, the user retains Pro access until
// manual cleanup. This classifier is the alert-only signal for that case.
//
// `recurring_pre_tax_amount` is only present in `rawPayload` (snake_case,
// the Dodo webhook payload). It is NOT a top-level column on `subscriptions`
// — verified against schema.ts:286-297. The classifier reads it defensively.
// ---------------------------------------------------------------------------

const ACTIVE_SUB = {
  subStatus: 'active' as string | undefined,
  subCancelledAt: undefined as number | undefined,
  subUserId: 'user_2x8ActiveSub' as string | undefined,
  subRawPayload: { recurring_pre_tax_amount: 3999 },
};

describe('classifyRefundAlert — alert path', () => {
  it('alerts on full-amount refund of an active uncancelled sub', () => {
    const decision = classifyRefundAlert({ ...ACTIVE_SUB, refundAmount: 3999 });
    assert.equal(decision.kind, 'alert');
    if (decision.kind === 'alert') {
      assert.equal(decision.userId, 'user_2x8ActiveSub');
      assert.equal(decision.refundAmount, 3999);
      assert.equal(decision.subAmount, 3999);
    }
  });

  it('alerts when refund is within 1% of sub amount (tax/rounding tolerance)', () => {
    // 99.7% of 3999 = 3987 (rounded). Should still trip the alert because
    // refunds in some currencies round to whole minor units.
    const decision = classifyRefundAlert({ ...ACTIVE_SUB, refundAmount: 3960 });
    assert.equal(decision.kind, 'alert', '~99% refund still classifies as full');
  });

  it('alerts when refund exceeds sub amount (operator bumped or refund-with-tip)', () => {
    const decision = classifyRefundAlert({ ...ACTIVE_SUB, refundAmount: 4500 });
    assert.equal(decision.kind, 'alert');
  });
});

describe('classifyRefundAlert — no-op paths', () => {
  it('no-ops when refund is partial (50% of sub amount)', () => {
    const decision = classifyRefundAlert({ ...ACTIVE_SUB, refundAmount: 1999 });
    assert.equal(decision.kind, 'no-op');
    if (decision.kind === 'no-op') assert.equal(decision.reason, 'partial-refund');
  });

  it('no-ops when sub is already cancelled (operator did the right thing)', () => {
    const decision = classifyRefundAlert({
      ...ACTIVE_SUB,
      subCancelledAt: Date.now(),
      refundAmount: 3999,
    });
    assert.equal(decision.kind, 'no-op');
    if (decision.kind === 'no-op') assert.equal(decision.reason, 'already-cancelled');
  });

  it('no-ops when sub status is not active (e.g. on_hold, cancelled, expired)', () => {
    for (const status of ['on_hold', 'cancelled', 'expired']) {
      const decision = classifyRefundAlert({
        ...ACTIVE_SUB,
        subStatus: status,
        refundAmount: 3999,
      });
      assert.equal(decision.kind, 'no-op', `status=${status} should be no-op`);
      if (decision.kind === 'no-op') {
        assert.equal(decision.reason, `sub-status-${status}`);
      }
    }
  });

  it('no-ops when no subscription was found (one-time payment refund)', () => {
    const decision = classifyRefundAlert({
      subStatus: undefined,
      subCancelledAt: undefined,
      subRawPayload: undefined,
      subUserId: undefined,
      refundAmount: 3999,
    });
    assert.equal(decision.kind, 'no-op');
    if (decision.kind === 'no-op') assert.equal(decision.reason, 'no-subscription');
  });
});

describe('classifyRefundAlert — defensive paths for missing rawPayload data', () => {
  it('warn-amount-unknown when rawPayload is missing entirely', () => {
    const decision = classifyRefundAlert({
      ...ACTIVE_SUB,
      subRawPayload: undefined,
      refundAmount: 3999,
    });
    assert.equal(decision.kind, 'warn-amount-unknown');
    if (decision.kind === 'warn-amount-unknown') {
      assert.equal(decision.userId, 'user_2x8ActiveSub');
      assert.equal(decision.refundAmount, 3999);
    }
  });

  it('warn-amount-unknown when rawPayload lacks recurring_pre_tax_amount', () => {
    const decision = classifyRefundAlert({
      ...ACTIVE_SUB,
      subRawPayload: { other_field: 'present' },
      refundAmount: 3999,
    });
    assert.equal(decision.kind, 'warn-amount-unknown');
  });

  it('warn-amount-unknown when recurring_pre_tax_amount is not a number (string)', () => {
    // Defensive: an upstream legacy row could have stringified the amount.
    // Treat as unclassifiable rather than coercing — coercion would risk
    // false-positive alerts.
    const decision = classifyRefundAlert({
      ...ACTIVE_SUB,
      subRawPayload: { recurring_pre_tax_amount: '3999' },
      refundAmount: 3999,
    });
    assert.equal(decision.kind, 'warn-amount-unknown');
  });

  it('warn-amount-unknown when recurring_pre_tax_amount is zero', () => {
    // A zero-priced sub is either misconfigured or a comp grant — either
    // way, the "full refund" comparison is meaningless. Don't alert; warn.
    const decision = classifyRefundAlert({
      ...ACTIVE_SUB,
      subRawPayload: { recurring_pre_tax_amount: 0 },
      refundAmount: 100,
    });
    assert.equal(decision.kind, 'warn-amount-unknown');
  });
});
