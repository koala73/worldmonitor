// U1 (plan 2026-10-25-001) — the desktop-key entitlement: which plans may hold
// desktop keys, how many, the per-account limits, and the one predicate every
// caller imports.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  DESKTOP_KEY_DAILY_CEILING,
  getEntitlementFeatures,
  PRODUCT_CATALOG,
} from '../convex/config/productCatalog.ts';
import { mergeEntitlementFeatures } from '../convex/lib/entitlements.ts';
import {
  admitsDesktopKeyPrincipal,
  hasDesktopKeyAccess,
  type DesktopKeyEntitlement,
} from '../shared/desktop-key-access.js';

const NOW = 1_800_000_000_000;
const PRO_PLANS = ['pro_monthly', 'pro_annual', 'pro_business_monthly', 'pro_business_annual'];
const NON_PRO_PLANS = ['free', 'api_starter', 'api_starter_annual', 'api_business', 'api_business_annual', 'enterprise'];
const EXPECTED_MAX_KEYS: Record<string, number> = {
  pro_monthly: 2,
  pro_annual: 2,
  pro_business_monthly: 3,
  pro_business_annual: 3,
};

const covered = (planKey: string, validUntil = NOW + 1): DesktopKeyEntitlement => ({
  features: getEntitlementFeatures(planKey),
  validUntil,
});

describe('desktop-key catalog fields', () => {
  it('every catalog plan is accounted for by this test', () => {
    assert.deepEqual(
      Object.keys(PRODUCT_CATALOG).sort(),
      [...PRO_PLANS, ...NON_PRO_PLANS].sort(),
      'a new plan must be classified for desktop keys here',
    );
  });

  it('Pro and Pro Business grant desktop keys with caps 2 and 3 and the desktop limits', () => {
    for (const planKey of PRO_PLANS) {
      const f = getEntitlementFeatures(planKey);
      assert.equal(f.desktopKeyAccess, true, planKey);
      assert.equal(f.maxDesktopKeys, EXPECTED_MAX_KEYS[planKey], planKey);
      assert.equal(f.planLimits?.desktopKeyRequestsPerDay, DESKTOP_KEY_DAILY_CEILING, planKey);
      assert.equal(f.planLimits?.desktopKeyBurstPerMinute, 120, planKey);
      assert.equal(hasDesktopKeyAccess(covered(planKey), NOW), true, planKey);
    }
  });

  it('free, both API plans, and Enterprise do not grant desktop keys and carry zero limits', () => {
    for (const planKey of NON_PRO_PLANS) {
      const f = getEntitlementFeatures(planKey);
      assert.equal(f.desktopKeyAccess, false, planKey);
      assert.equal(f.maxDesktopKeys, 0, planKey);
      assert.equal(f.planLimits?.desktopKeyRequestsPerDay, 0, planKey);
      assert.equal(f.planLimits?.desktopKeyBurstPerMinute, 0, planKey);
      assert.equal(hasDesktopKeyAccess(covered(planKey), NOW), false, planKey);
    }
  });
});

describe('mergeEntitlementFeatures and desktop keys', () => {
  // A Pro row exactly as the Dodo webhook wrote it before this change: no
  // desktop fields at the top level or inside planLimits.
  const legacyProRow = () => {
    const {
      desktopKeyAccess: _a,
      maxDesktopKeys: _m,
      planLimits,
      ...rest
    } = structuredClone(getEntitlementFeatures('pro_monthly'));
    const {
      desktopKeyRequestsPerDay: _d,
      desktopKeyBurstPerMinute: _b,
      ...limits
    } = planLimits!;
    return { ...rest, planLimits: limits };
  };

  it('a Pro row stored without desktopKeyAccess passes after merge', () => {
    const row = legacyProRow();
    assert.equal('desktopKeyAccess' in row, false);
    assert.equal(
      hasDesktopKeyAccess({ features: row, validUntil: NOW + 1 }, NOW),
      false,
      'the raw legacy row fails closed — callers must merge first',
    );
    const merged = mergeEntitlementFeatures('pro_monthly', row);
    assert.equal(merged.desktopKeyAccess, true);
    assert.equal(merged.maxDesktopKeys, 2);
    assert.equal(hasDesktopKeyAccess({ features: merged, validUntil: NOW + 1 }, NOW), true);
  });

  it('a stored row with an old ceiling, burst, or key cap resolves to the current catalog values', () => {
    const base = getEntitlementFeatures('pro_business_monthly');
    const stale = {
      ...structuredClone(base),
      maxDesktopKeys: 99,
      planLimits: {
        ...structuredClone(base.planLimits!),
        desktopKeyRequestsPerDay: 1,
        desktopKeyBurstPerMinute: 9_999,
      },
    };
    const merged = mergeEntitlementFeatures('pro_business_monthly', stale);
    assert.equal(merged.maxDesktopKeys, 3);
    assert.equal(merged.planLimits?.desktopKeyRequestsPerDay, DESKTOP_KEY_DAILY_CEILING);
    assert.equal(merged.planLimits?.desktopKeyBurstPerMinute, 120);
  });

  it('a downgraded API row merged against a Pro plan key takes the Pro desktop limits', () => {
    const apiRow = structuredClone(getEntitlementFeatures('api_starter'));
    const merged = mergeEntitlementFeatures('pro_monthly', apiRow);
    assert.equal(merged.maxDesktopKeys, 2);
    assert.equal(merged.planLimits?.desktopKeyRequestsPerDay, DESKTOP_KEY_DAILY_CEILING);
  });

  it('merge still lets every other stored planLimits value through', () => {
    const row = legacyProRow();
    row.planLimits.mcpCallsPerDay = 7;
    assert.equal(mergeEntitlementFeatures('pro_monthly', row).planLimits?.mcpCallsPerDay, 7);
  });
});

describe('hasDesktopKeyAccess', () => {
  const pro: DesktopKeyEntitlement = { features: { tier: 1, desktopKeyAccess: true }, validUntil: NOW };

  it('admits coverage that ends exactly now and denies expired coverage', () => {
    assert.equal(hasDesktopKeyAccess(pro, NOW), true);
    assert.equal(hasDesktopKeyAccess({ ...pro, validUntil: NOW - 1 }, NOW), false);
    for (const planKey of PRO_PLANS) {
      assert.equal(hasDesktopKeyAccess(covered(planKey, NOW - 1), NOW), false, planKey);
    }
  });

  it('fails closed on absent rows, a missing or non-true flag, and tier 0', () => {
    const denied: unknown[] = [
      undefined,
      null,
      { features: { tier: 1 }, validUntil: NOW + 1 },
      { features: { tier: 1, desktopKeyAccess: false }, validUntil: NOW + 1 },
      { features: { tier: 1, desktopKeyAccess: 'true' }, validUntil: NOW + 1 },
      { features: { tier: 1, desktopKeyAccess: 1 }, validUntil: NOW + 1 },
      { features: { tier: 0, desktopKeyAccess: true }, validUntil: NOW + 1 },
      { features: { tier: 1, apiAccess: true }, validUntil: NOW + 1 },
    ];
    for (const e of denied) {
      assert.equal(hasDesktopKeyAccess(e as DesktopKeyEntitlement, NOW), false, JSON.stringify(e));
    }
  });
});

describe('admitsDesktopKeyPrincipal (R8: kind before plan)', () => {
  it('admits a covered Pro owner and a covered owner who upgraded to an API plan or Enterprise', () => {
    for (const planKey of [...PRO_PLANS, 'api_starter', 'api_starter_annual', 'api_business', 'api_business_annual', 'enterprise']) {
      assert.equal(admitsDesktopKeyPrincipal(covered(planKey), NOW), true, planKey);
    }
  });

  it('denies free, lapsed, absent, and unmerged owners', () => {
    assert.equal(admitsDesktopKeyPrincipal(covered('free'), NOW), false);
    assert.equal(admitsDesktopKeyPrincipal(covered('pro_monthly', NOW - 1), NOW), false);
    assert.equal(admitsDesktopKeyPrincipal(covered('api_starter', NOW - 1), NOW), false);
    assert.equal(admitsDesktopKeyPrincipal(null, NOW), false);
    assert.equal(admitsDesktopKeyPrincipal(undefined, NOW), false);
    assert.equal(admitsDesktopKeyPrincipal({ features: { tier: 1 }, validUntil: NOW + 1 }, NOW), false);
    assert.equal(
      admitsDesktopKeyPrincipal({ features: { tier: 0, apiAccess: true }, validUntil: NOW + 1 }, NOW),
      false,
      'tier 0 is never covered, whatever the flags say',
    );
  });
});

describe('entitlement crosswalk', () => {
  it('lists the desktop-key capability against both Pro plans and classifies every desktop field', () => {
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `
        const m = await import('./scripts/generate-entitlement-crosswalk.mjs');
        process.stdout.write(JSON.stringify(m.MAP.map(([re, v]) => [re.source, v])));
      `],
      { encoding: 'utf8' },
    );
    const map: Array<[string, { cap?: string; exclude?: string }]> = JSON.parse(out);
    const classify = (rule: string) => map.find(([src]) => new RegExp(src).test(rule))?.[1];
    for (const plan of ['PRO', 'PRO_BUSINESS']) {
      for (const field of ['desktopKeyAccess', 'maxDesktopKeys', 'desktopKeyRequestsPerDay', 'desktopKeyBurstPerMinute']) {
        assert.equal(classify(`catalog:${plan}.${field}`)?.cap, 'desktop.keys', `${plan}.${field}`);
      }
    }
  });

  it('the generator emits catalog rules for the desktop fields on both Pro plans', () => {
    execFileSync(process.execPath, ['scripts/generate-entitlement-crosswalk.mjs'], { encoding: 'utf8' });
    const payload = JSON.parse(readFileSync('docs/generated/entitlement-crosswalk.json', 'utf8'));
    const cap = payload.capabilities.find((c: { id: string }) => c.id === 'desktop.keys');
    assert.ok(cap, 'desktop.keys capability is present');
    const rules = new Set(cap.rules.map((r: { rule: string }) => r.rule));
    for (const plan of ['PRO', 'PRO_BUSINESS']) {
      assert.ok(rules.has(`catalog:${plan}.desktopKeyAccess`), `${plan}.desktopKeyAccess`);
      assert.ok(rules.has(`catalog:${plan}.maxDesktopKeys`), `${plan}.maxDesktopKeys`);
    }
    assert.equal(payload.totals.unmappedGates, 0);
  });
});
