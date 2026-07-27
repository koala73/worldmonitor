/**
 * #5646 — content-only JSON endpoints accept Clerk role=pro OR a resolved
 * Convex tier >= 1. Notification-backed endpoints intentionally require the
 * tier-backed signal used by their configuration and delivery paths.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkProEntitlement,
  checkTierProEntitlement,
} from '../server/_shared/pro-entitlement';

function entitlements(tier: number, extra: Record<string, unknown> = {}) {
  return {
    planKey: tier >= 1 ? 'pro_monthly' : 'free',
    features: {
      tier,
      apiAccess: false,
      apiRateLimit: 0,
      maxDashboards: 3,
      prioritySupport: false,
      exportFormats: ['csv'],
      mcpAccess: false,
    },
    validUntil: tier >= 1 ? Date.now() + 86_400_000 : 0,
    ...extra,
  };
}

describe('checkProEntitlement', () => {
  it('allows a Clerk role=pro grant without consulting Convex', async () => {
    const result = await checkProEntitlement(
      'user-clerk-pro',
      'pro',
      {},
      async () => {
        throw new Error('role-only Pro must short-circuit before lookup');
      },
    );

    assert.deepEqual(result, { allowed: true });
  });

  it('allows a tier-backed Pro caller whose Clerk role is free', async () => {
    const result = await checkProEntitlement(
      'user-dodo-pro',
      'free',
      {},
      async () => entitlements(1),
    );

    assert.deepEqual(result, { allowed: true });
  });

  it('keeps a genuine free caller on the terminal upsell path', async () => {
    const result = await checkProEntitlement(
      'user-free',
      'free',
      {},
      async () => entitlements(0),
    );

    if (result.allowed) assert.fail('free caller must be denied');
    assert.equal(result.billingDenial, null);
  });

  it('does not treat an absent or differently-cased role as Pro', async () => {
    for (const role of [undefined, null, 'PRO' as never]) {
      const result = await checkProEntitlement(
        'user-no-exact-role',
        role,
        {},
        async () => null,
      );
      assert.equal(result.allowed, false);
    }
  });

  it('preserves the retryable billing-verification contract for non-role callers', async () => {
    const result = await checkProEntitlement(
      'user-convex-blip',
      'free',
      { 'Access-Control-Allow-Origin': 'https://worldmonitor.app' },
      async () => entitlements(0, { verificationUnavailable: true }),
    );

    if (result.allowed) assert.fail('unverifiable caller must not be allowed');
    assert.equal(result.billingDenial?.status, 503);
    assert.equal(
      result.billingDenial?.headers.get('X-Billing-Verification'),
      'entitlement_verification_unavailable',
    );
    assert.equal(
      result.billingDenial?.headers.get('Access-Control-Allow-Origin'),
      'https://worldmonitor.app',
    );
    assert.deepEqual(await result.billingDenial?.json(), {
      error: 'Unable to verify API access',
      code: 'entitlement_verification_unavailable',
      requiredTier: 1,
    });
  });
});

describe('checkTierProEntitlement', () => {
  it('denies a role-only caller without a tier-backed entitlement', async () => {
    let lookups = 0;
    const result = await checkTierProEntitlement(
      'user-clerk-pro',
      {},
      async () => {
        lookups += 1;
        return entitlements(0);
      },
    );

    assert.equal(lookups, 1, 'notification policy must consult the tier source');
    if (result.allowed) assert.fail('role-only caller must be denied');
    assert.equal(result.billingDenial, null);
  });

  it('allows a tier-backed Pro caller', async () => {
    const result = await checkTierProEntitlement(
      'user-dodo-pro',
      {},
      async () => entitlements(1),
    );

    assert.deepEqual(result, { allowed: true });
  });

  it('preserves retryable billing-verification denials', async () => {
    const result = await checkTierProEntitlement(
      'user-convex-blip',
      {},
      async () => entitlements(0, { verificationUnavailable: true }),
    );

    if (result.allowed) assert.fail('unverifiable caller must not be allowed');
    assert.equal(result.billingDenial?.status, 503);
    assert.equal(
      result.billingDenial?.headers.get('X-Billing-Verification'),
      'entitlement_verification_unavailable',
    );
  });
});
