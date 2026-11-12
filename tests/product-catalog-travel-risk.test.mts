// `travelRiskAssessment` gates the prepare_travel_risk_assessment MCP tool
// (#10451). It is a named feature, not a tier rule: Pro Business shares
// `tier: 1` with Pro and API Starter shares `tier: 2` with API Business, so
// neither `tier` nor `dataExport` can express the split.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getEntitlementFeatures, PRODUCT_CATALOG } from '../convex/config/productCatalog.ts';
import { mergeEntitlementFeatures } from '../convex/lib/entitlements.ts';

const ENTITLED = new Set([
  'pro_business_monthly',
  'pro_business_annual',
  'api_business',
  'api_business_annual',
  'enterprise',
]);

describe('travelRiskAssessment catalog flag', () => {
  it('every catalog entry sets travelRiskAssessment explicitly', () => {
    for (const [planKey, entry] of Object.entries(PRODUCT_CATALOG)) {
      assert.equal(
        typeof entry.features.travelRiskAssessment,
        'boolean',
        `${planKey} must set travelRiskAssessment explicitly`,
      );
    }
  });

  it('grants the assessment to Pro Business, API Business and Enterprise only', () => {
    for (const planKey of Object.keys(PRODUCT_CATALOG)) {
      assert.equal(
        getEntitlementFeatures(planKey).travelRiskAssessment,
        ENTITLED.has(planKey),
        `${planKey} travelRiskAssessment`,
      );
    }
  });

  it('denies Free, Pro and API Starter by name', () => {
    for (const planKey of ['free', 'pro_monthly', 'pro_annual', 'api_starter', 'api_starter_annual']) {
      assert.equal(getEntitlementFeatures(planKey).travelRiskAssessment, false, planKey);
    }
  });

  it('is not derived from tier or dataExport', () => {
    // Same tier, different answer, in both directions.
    assert.equal(getEntitlementFeatures('pro_monthly').tier, getEntitlementFeatures('pro_business_monthly').tier);
    assert.equal(getEntitlementFeatures('api_starter').tier, getEntitlementFeatures('api_business').tier);
    // API Starter exports but is not entitled.
    assert.equal(getEntitlementFeatures('api_starter').dataExport, true);
    assert.equal(getEntitlementFeatures('api_starter').travelRiskAssessment, false);
  });

  it('a stored row written before the field existed reads back with the catalog value', () => {
    for (const planKey of ['pro_business_monthly', 'api_business', 'enterprise', 'pro_monthly', 'api_starter']) {
      const { travelRiskAssessment: _omitted, ...legacy } = getEntitlementFeatures(planKey);
      assert.equal('travelRiskAssessment' in legacy, false);
      assert.equal(
        mergeEntitlementFeatures(planKey, legacy).travelRiskAssessment,
        ENTITLED.has(planKey),
        `${planKey} legacy row inherits the catalog default without a migration`,
      );
    }
  });
});
