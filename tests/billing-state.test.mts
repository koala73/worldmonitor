/**
 * Unit tests for the pure billing UX state derivation (#4771).
 *
 * The module is a zero-import leaf so it stays importable under `tsx --test`
 * (no jsdom, no Vite globals). Covers all six states from the issue:
 * free, active, on_hold, renewal_verification_pending,
 * renewal_verification_failed, lapsed — plus the precedence boundaries
 * (entitlement-valid wins over stale-period, on_hold wins over entitled).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveBillingUxState,
  getBillingBannerVariant,
  getBillingGateOverride,
  type BillingSubscriptionSnapshot,
  type BillingEntitlementSnapshot,
} from '@/services/billing-state';

const NOW = 1_800_000_000_000; // fixed epoch ms
const DAY = 86_400_000;

function sub(overrides: Partial<BillingSubscriptionSnapshot> = {}): BillingSubscriptionSnapshot {
  return {
    status: 'active',
    currentPeriodEnd: NOW + 30 * DAY,
    renewalVerificationState: null,
    ...overrides,
  };
}

function ent(overrides: Partial<BillingEntitlementSnapshot> = {}): BillingEntitlementSnapshot {
  return {
    planKey: 'pro',
    validUntil: NOW + 30 * DAY,
    ...overrides,
  };
}

describe('deriveBillingUxState', () => {
  it('no subscription + no entitlement = free', () => {
    assert.equal(deriveBillingUxState(null, null, NOW), 'free');
  });

  it('no subscription + expired entitlement = free', () => {
    assert.equal(deriveBillingUxState(null, ent({ validUntil: NOW - 1 }), NOW), 'free');
  });

  it('no subscription + free-tier entitlement row = free', () => {
    assert.equal(
      deriveBillingUxState(null, ent({ planKey: 'free', validUntil: 0 }), NOW),
      'free',
    );
  });

  it('no subscription + valid paid entitlement (comp grant) = active', () => {
    assert.equal(deriveBillingUxState(null, ent(), NOW), 'active');
  });

  it('active subscription + valid entitlement = active', () => {
    assert.equal(deriveBillingUxState(sub(), ent(), NOW), 'active');
  });

  it('active in-period subscription with missing entitlement snapshot = active (never over-gate)', () => {
    assert.equal(deriveBillingUxState(sub(), null, NOW), 'active');
  });

  it('on_hold wins even while the retry-window entitlement is still valid', () => {
    assert.equal(deriveBillingUxState(sub({ status: 'on_hold' }), ent(), NOW), 'on_hold');
  });

  it('on_hold with expired entitlement stays on_hold (not free, not pending)', () => {
    assert.equal(
      deriveBillingUxState(sub({ status: 'on_hold' }), ent({ validUntil: NOW - 1 }), NOW),
      'on_hold',
    );
  });

  it('stale active subscription (period end passed, entitlement lapsed, no verification verdict yet) = renewal_verification_pending', () => {
    assert.equal(
      deriveBillingUxState(
        sub({ currentPeriodEnd: NOW - DAY }),
        ent({ validUntil: NOW - DAY }),
        NOW,
      ),
      'renewal_verification_pending',
    );
  });

  it('stale active subscription with explicit pending verification = renewal_verification_pending', () => {
    assert.equal(
      deriveBillingUxState(
        sub({ currentPeriodEnd: NOW - DAY, renewalVerificationState: 'pending' }),
        ent({ validUntil: NOW - DAY }),
        NOW,
      ),
      'renewal_verification_pending',
    );
  });

  it('stale active subscription + verification failed = renewal_verification_failed', () => {
    assert.equal(
      deriveBillingUxState(
        sub({ currentPeriodEnd: NOW - DAY, renewalVerificationState: 'failed' }),
        ent({ validUntil: NOW - DAY }),
        NOW,
      ),
      'renewal_verification_failed',
    );
  });

  it('stale active subscription + verification confirmed lapse = lapsed', () => {
    assert.equal(
      deriveBillingUxState(
        sub({ currentPeriodEnd: NOW - DAY, renewalVerificationState: 'lapsed' }),
        ent({ validUntil: NOW - DAY }),
        NOW,
      ),
      'lapsed',
    );
  });

  it('valid entitlement wins over a stale verification verdict (access works = active)', () => {
    assert.equal(
      deriveBillingUxState(
        sub({ currentPeriodEnd: NOW - DAY, renewalVerificationState: 'failed' }),
        ent(),
        NOW,
      ),
      'active',
    );
  });

  it('cancelled subscription still inside the paid period with valid entitlement = active', () => {
    assert.equal(deriveBillingUxState(sub({ status: 'cancelled' }), ent(), NOW), 'active');
  });

  it('cancelled in-period with a late/missing entitlement snapshot = active (cancelled-but-paid-through, never over-gate)', () => {
    assert.equal(deriveBillingUxState(sub({ status: 'cancelled' }), null, NOW), 'active');
  });

  it('cancelled in-period with an expired entitlement snapshot = active (coverage runs to period end)', () => {
    assert.equal(
      deriveBillingUxState(sub({ status: 'cancelled' }), ent({ validUntil: NOW - 1 }), NOW),
      'active',
    );
  });

  it('expired subscription never covers, even with a future period end (mirrors isCoveringAt)', () => {
    assert.equal(
      deriveBillingUxState(sub({ status: 'expired', currentPeriodEnd: NOW + DAY }), null, NOW),
      'lapsed',
    );
  });

  it('unknown runtime status strings stay locked-side (lapsed), never unlock', () => {
    const bogus = sub({ status: 'totally_unknown' as unknown as 'active' });
    assert.equal(deriveBillingUxState(bogus, null, NOW), 'lapsed');
  });

  it('cancelled subscription past the paid period = lapsed', () => {
    assert.equal(
      deriveBillingUxState(
        sub({ status: 'cancelled', currentPeriodEnd: NOW - DAY }),
        ent({ validUntil: NOW - DAY }),
        NOW,
      ),
      'lapsed',
    );
  });

  it('expired subscription = lapsed', () => {
    assert.equal(
      deriveBillingUxState(
        sub({ status: 'expired', currentPeriodEnd: NOW - 90 * DAY }),
        null,
        NOW,
      ),
      'lapsed',
    );
  });

  it('boundary: entitlement validUntil exactly now counts as entitled', () => {
    assert.equal(
      deriveBillingUxState(sub({ currentPeriodEnd: NOW - DAY }), ent({ validUntil: NOW }), NOW),
      'active',
    );
  });

  it('boundary: currentPeriodEnd exactly now counts as in-period', () => {
    assert.equal(
      deriveBillingUxState(sub({ currentPeriodEnd: NOW }), null, NOW),
      'active',
    );
  });
});

describe('getBillingBannerVariant', () => {
  it('free/active/lapsed render no banner', () => {
    assert.equal(getBillingBannerVariant('free'), null);
    assert.equal(getBillingBannerVariant('active'), null);
    assert.equal(getBillingBannerVariant('lapsed'), null);
  });

  it('on_hold keeps the existing red banner contract (copy key, action, dismiss key)', () => {
    const v = getBillingBannerVariant('on_hold');
    assert.ok(v);
    assert.equal(v.tone, 'error');
    // en.json's onHoldBannerMessage value is locked byte-identical to the
    // pre-#4771 hardcoded copy in tests/billing-state-wiring.test.mts.
    assert.equal(v.messageKey, 'components.billingState.onHoldBannerMessage');
    assert.equal(v.actionLabelKey, 'components.billingState.updatePayment');
    assert.equal(v.action, 'billing-portal');
    // Pre-#4771 sessionStorage key must survive so existing dismissals keep working.
    assert.equal(v.dismissKey, 'pf-banner-dismissed');
  });

  it('renewal_verification_pending is a warning with no billing-portal action', () => {
    const v = getBillingBannerVariant('renewal_verification_pending');
    assert.ok(v);
    assert.equal(v.tone, 'warning');
    assert.equal(v.messageKey, 'components.billingState.renewalPendingDesc');
    assert.equal(v.actionLabelKey, null);
    assert.equal(v.dismissKey, 'pf-banner-dismissed-renewal-pending');
  });

  it('renewal_verification_failed is an error with a Manage Billing action', () => {
    const v = getBillingBannerVariant('renewal_verification_failed');
    assert.ok(v);
    assert.equal(v.tone, 'error');
    assert.equal(v.messageKey, 'components.billingState.renewalFailedDesc');
    assert.equal(v.actionLabelKey, 'components.billingState.manageBilling');
    assert.equal(v.action, 'billing-portal');
    assert.equal(v.dismissKey, 'pf-banner-dismissed-renewal-failed');
  });

  it('every banner state uses a distinct dismiss key (dismissing one must not suppress another)', () => {
    const keys = (['on_hold', 'renewal_verification_pending', 'renewal_verification_failed'] as const)
      .map((s) => getBillingBannerVariant(s)?.dismissKey);
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe('getBillingGateOverride', () => {
  it('free and active produce no override (generic gating applies)', () => {
    assert.equal(getBillingGateOverride('free'), null);
    assert.equal(getBillingGateOverride('active'), null);
  });

  it('billing states map to their gate override', () => {
    assert.equal(getBillingGateOverride('on_hold'), 'payment_on_hold');
    assert.equal(getBillingGateOverride('renewal_verification_pending'), 'renewal_pending');
    assert.equal(getBillingGateOverride('renewal_verification_failed'), 'renewal_failed');
    assert.equal(getBillingGateOverride('lapsed'), 'lapsed');
  });

  it('no state maps to an unlocking override — billing refinement is copy-only', () => {
    // The override either substitutes a LOCKED billing-specific reason for
    // FREE_TIER or returns null (keep the locked generic CTA). There is no
    // value a state could map to that unlocks a panel client-side.
    const allStates = [
      'free',
      'active',
      'on_hold',
      'renewal_verification_pending',
      'renewal_verification_failed',
      'lapsed',
    ] as const;
    const lockedOverrides = new Set(['payment_on_hold', 'renewal_pending', 'renewal_failed', 'lapsed']);
    for (const state of allStates) {
      const override = getBillingGateOverride(state);
      assert.ok(
        override === null || lockedOverrides.has(override),
        `${state} produced unexpected override ${String(override)}`,
      );
    }
  });
});
