// U1 (plan 2026-07-25-001) — Pro Business catalog entries + the `dataExport`
// entitlement flag. `dataExport` controls the locked state and
// `exportFormats` controls the unlocked export actions. These assertions are
// the source-of-truth guard for both, mirroring the
// apiDailyAllowance guard in product-catalog-api-allowance.test.mts.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  getEntitlementFeatures,
  PLAN_PRECEDENCE,
  PRODUCT_CATALOG,
} from '../convex/config/productCatalog.ts';

const PRO_BUSINESS_KEYS = ['pro_business_monthly', 'pro_business_annual'];

describe('U1 — Pro Business catalog entries', () => {
  it('pro_business_monthly carries the agreed feature set', () => {
    const features = getEntitlementFeatures('pro_business_monthly');
    assert.equal(features.tier, 1, 'shares tier 1 with Pro so every Pro gate unlocks generically');
    assert.equal(features.apiAccess, false, 'must never leak wm_ API key issuance');
    assert.equal(features.apiRateLimit, 0);
    assert.equal(features.apiDailyAllowance, 0);
    assert.equal(features.maxDashboards, 25);
    assert.equal(features.prioritySupport, true);
    assert.equal(features.mcpAccess, true);
    assert.equal(features.dataExport, true);
    assert.deepEqual(features.planLimits, {
      apiRequestsPerDay: 0,
      apiBurstRequestsPerMinute: 0,
      mcpCallsPerDay: 250,
      mcpBurstRequestsPerMinute: 60,
    });
    assert.deepEqual(features.exportFormats, ['csv', 'json', 'pdf']);
  });

  it('pro_business_annual shares the monthly feature set', () => {
    assert.equal(
      getEntitlementFeatures('pro_business_annual'),
      getEntitlementFeatures('pro_business_monthly'),
    );
  });

  it('prices the tier at $49.99/mo and $449.99/yr', () => {
    assert.equal(PRODUCT_CATALOG.pro_business_monthly.priceCents, 4999);
    assert.equal(PRODUCT_CATALOG.pro_business_annual.priceCents, 44999);
  });

  it('is purchasable and published on /pro (U7 flipped visibility)', () => {
    for (const planKey of PRO_BUSINESS_KEYS) {
      const entry = PRODUCT_CATALOG[planKey];
      assert.ok(entry, `${planKey} must exist in the catalog`);
      assert.equal(entry.tierGroup, 'pro_business');
      assert.equal(entry.publicVisible, true, `${planKey} must stay on the public pricing surfaces`);
      assert.equal(entry.currentForCheckout, true, `${planKey} must be purchasable`);
      // Separate Dodo products, not an updatable collection — the customer
      // portal cannot perform Pro → Pro Business, so the plan-limit CTA must
      // not point at it (guided cancel-then-rebuy copy instead).
      assert.equal(entry.canChangePlanSelfServe, false, `${planKey} has no self-serve plan change`);
    }
  });

  it('still throws on an unknown planKey (the tierGroup is not one)', () => {
    assert.throws(() => getEntitlementFeatures('pro_business'), /Unknown planKey/);
  });
});

describe('U1 — dataExport is the export enforcement field', () => {
  it('every catalog entry sets dataExport explicitly (no undefined in source-of-truth rows)', () => {
    for (const [planKey, entry] of Object.entries(PRODUCT_CATALOG)) {
      assert.equal(
        typeof entry.features.dataExport,
        'boolean',
        `${planKey} must set dataExport explicitly`,
      );
    }
  });

  it('grants export to Pro Business and every API/Enterprise tier, denies Free and Pro', () => {
    assert.equal(getEntitlementFeatures('free').dataExport, false);
    assert.equal(getEntitlementFeatures('pro_monthly').dataExport, false);
    assert.equal(getEntitlementFeatures('pro_annual').dataExport, false);
    assert.equal(getEntitlementFeatures('pro_business_monthly').dataExport, true);
    assert.equal(getEntitlementFeatures('pro_business_annual').dataExport, true);
    assert.equal(getEntitlementFeatures('api_starter').dataExport, true);
    assert.equal(getEntitlementFeatures('api_starter_annual').dataExport, true);
    assert.equal(getEntitlementFeatures('api_business').dataExport, true);
    assert.equal(getEntitlementFeatures('enterprise').dataExport, true);
  });

  it('exportFormats agrees with dataExport and the menu capabilities it grants', () => {
    for (const [planKey, entry] of Object.entries(PRODUCT_CATALOG)) {
      const { dataExport, exportFormats } = entry.features;
      assert.deepEqual(
        exportFormats,
        dataExport ? ['csv', 'json', 'pdf'] : [],
        `${planKey} advertises the formats its dataExport flag actually grants`,
      );
    }
  });
});

describe('U1 — PLAN_PRECEDENCE covers the new tier', () => {
  it('ranks both Pro Business variants above both Pro variants and below API Starter', () => {
    for (const planKey of PRO_BUSINESS_KEYS) {
      const precedence = PLAN_PRECEDENCE[planKey];
      assert.equal(typeof precedence, 'number', `${planKey} needs a PLAN_PRECEDENCE entry`);
      assert.ok(
        precedence > PLAN_PRECEDENCE.pro_annual,
        `${planKey} (${precedence}) must outrank pro_annual (${PLAN_PRECEDENCE.pro_annual})`,
      );
      assert.ok(
        precedence < PLAN_PRECEDENCE.api_starter,
        `${planKey} (${precedence}) must rank below api_starter (${PLAN_PRECEDENCE.api_starter})`,
      );
    }
    assert.ok(
      PLAN_PRECEDENCE.pro_business_annual > PLAN_PRECEDENCE.pro_business_monthly,
      'the longer commitment outranks monthly at the same tier',
    );
  });

  it('covers every catalog planKey (a missing entry silently degrades to 0)', () => {
    for (const planKey of Object.keys(PRODUCT_CATALOG)) {
      assert.equal(
        typeof PLAN_PRECEDENCE[planKey],
        'number',
        `${planKey} is in PRODUCT_CATALOG but missing from PLAN_PRECEDENCE`,
      );
    }
  });
});
