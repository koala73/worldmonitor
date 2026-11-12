// `travelRiskAssessment` gates the prepare_travel_risk_assessment MCP tool
// (#10451). It is a named feature, not a tier rule: Pro Business shares
// `tier: 1` with Pro and API Starter shares `tier: 2` with API Business, so
// neither `tier` nor `dataExport` can express the split.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getEntitlementFeatures, PRODUCT_CATALOG } from '../convex/config/productCatalog.ts';
import { mergeEntitlementFeatures } from '../convex/lib/entitlements.ts';

const ENTITLED = new Set([
  'pro_business_monthly',
  'pro_business_annual',
  'api_business',
  'api_business_annual',
  'enterprise',
]);

const TRAVEL_RISK_FEATURE = 'Travel risk assessment drafts over MCP';

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

  it('published feature lists name the assessment only on plans the flag includes', () => {
    for (const [planKey, entry] of Object.entries(PRODUCT_CATALOG)) {
      const listed = entry.marketingFeatures.includes(TRAVEL_RISK_FEATURE);
      if (entry.marketingFeatures.length === 0) {
        assert.equal(listed, false, `${planKey} publishes no feature list`);
        continue;
      }
      assert.equal(listed, entry.features.travelRiskAssessment === true, planKey);
    }
  });

  it('pricing prose and the machine-readable summary follow the same flag', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const phrase = /travel risk assessment drafts over MCP/i;
    const pricingMd = readFileSync(resolve(root, 'public/pricing.md'), 'utf8');
    const summary = JSON.parse(pricingMd.match(/```json\n([\s\S]*?)```/)?.[1] ?? '{}') as {
      plans: Array<{ name: string; features: string[] }>;
    };
    const byName = Object.fromEntries(summary.plans.map((plan) => [plan.name, plan.features]));
    for (const name of ['Pro Business', 'API Business', 'Enterprise']) {
      assert.equal(byName[name].includes('travel risk assessment drafts over MCP'), true, name);
    }
    for (const name of ['Free', 'Pro', 'API']) {
      assert.equal(byName[name].includes('travel risk assessment drafts over MCP'), false, name);
    }

    const section = (markdown: string, heading: string) => {
      const match = markdown.match(new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`));
      assert.ok(match, heading);
      return match[1];
    };
    assert.match(section(pricingMd, 'Pro Business'), phrase);
    assert.match(section(pricingMd, 'API Business'), phrase);
    assert.match(section(pricingMd, 'Enterprise'), phrase);
    assert.doesNotMatch(section(pricingMd, 'Pro'), phrase);
    assert.doesNotMatch(section(pricingMd, 'API Starter'), phrase);

    const docs = readFileSync(resolve(root, 'docs/pricing.mdx'), 'utf8');
    const bullet = (name: string) => {
      const line = docs.split('\n').find((entry) => entry.startsWith(`- **${name}**`));
      assert.ok(line, name);
      return line;
    };
    assert.match(bullet('Pro Business'), phrase);
    assert.match(bullet('API Business'), phrase);
    assert.match(bullet('Enterprise'), phrase);
    assert.doesNotMatch(bullet('Pro'), phrase);
    assert.doesNotMatch(bullet('API Starter'), phrase);
    assert.match(readFileSync(resolve(root, 'docs/zh/pricing.mdx'), 'utf8'), /通过 MCP 起草旅行风险评估/);
  });
});
