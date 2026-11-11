// #10453 — the dashboard-focus entitlement: which plans carry it, that a row
// written before the field existed reads back with it, and the one predicate
// both Convex and the browser call.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getEntitlementFeatures, PRODUCT_CATALOG } from '../convex/config/productCatalog.ts';
import { mergeEntitlementFeatures } from '../convex/lib/entitlements.ts';
import { hasTabFocus } from '../shared/tab-focus-access.ts';

const NOW = 1_800_000_000_000;
const FOCUS_PLANS = ['pro_business_monthly', 'pro_business_annual', 'api_business', 'api_business_annual', 'enterprise'];
const NO_FOCUS_PLANS = ['free', 'pro_monthly', 'pro_annual', 'api_starter', 'api_starter_annual'];

describe('tabFocus catalog', () => {
  it('every plan is classified here', () => {
    assert.deepEqual(Object.keys(PRODUCT_CATALOG).sort(), [...FOCUS_PLANS, ...NO_FOCUS_PLANS].sort());
  });

  it('Pro Business, API Business and Enterprise focus; Free, Pro and API Starter do not', () => {
    for (const planKey of FOCUS_PLANS) {
      assert.equal(hasTabFocus({ features: getEntitlementFeatures(planKey), validUntil: NOW }, NOW), true, planKey);
    }
    for (const planKey of NO_FOCUS_PLANS) {
      assert.equal(getEntitlementFeatures(planKey).tabFocus, false, planKey);
      assert.equal(hasTabFocus({ features: getEntitlementFeatures(planKey), validUntil: NOW }, NOW), false, planKey);
    }
  });
});

describe('hasTabFocus', () => {
  it('a row stored before the field existed is fail-closed raw and entitled once merged', () => {
    const { tabFocus: _omitted, ...legacy } = getEntitlementFeatures('pro_business_monthly');
    assert.equal(hasTabFocus({ features: legacy, validUntil: NOW }, NOW), false);
    const merged = mergeEntitlementFeatures('pro_business_monthly', legacy);
    assert.equal(hasTabFocus({ features: merged, validUntil: NOW }, NOW), true);
  });

  it('an expired entitlement or a free tier never focuses', () => {
    const features = getEntitlementFeatures('api_business');
    assert.equal(hasTabFocus({ features, validUntil: NOW - 1 }, NOW), false);
    assert.equal(hasTabFocus({ features: { ...features, tier: 0 }, validUntil: NOW }, NOW), false);
    assert.equal(hasTabFocus(null, NOW), false);
  });
});
