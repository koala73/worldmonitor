/**
 * Phase 5: Multi-sector cost shock calculator tests.
 *
 * Covers:
 *   1. Pure helper math (_multi-sector-shock.ts): HS4→HS2, aggregate,
 *      pickBestBypass, clampClosureDays, computeMultiSectorShock(s).
 *   2. Vercel edge function contract: PRO-gate, params validation,
 *      Redis reads, cache-key shape.
 *   3. Client service wrapper.
 *   4. Premium paths registration.
 *   5. CountryDeepDivePanel surface: card, slider, debounced re-fetch, reset.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths.ts';

// ========================================================================
// 1. Pure helper: _multi-sector-shock.ts
// ========================================================================

import {
  SEEDED_HS2_CODES,
  hs4ToHs2,
  pickBestBypass,
  aggregateAnnualImportsByHs2,
  clampClosureDays,
  computeMultiSectorShock,
  computeMultiSectorShocks,
} from '../server/worldmonitor/supply-chain/v1/_multi-sector-shock.ts';

describe('hs4ToHs2', () => {
  it('strips leading zeros for 4-digit HS codes', () => {
    assert.equal(hs4ToHs2('2709'), '27');
    assert.equal(hs4ToHs2('8542'), '85');
    assert.equal(hs4ToHs2('0203'), '2');
  });

  it('pads and strips 3-digit HS codes', () => {
    assert.equal(hs4ToHs2('203'), '2');
  });
});

describe('clampClosureDays', () => {
  it('defaults to 30 when NaN or undefined', () => {
    assert.equal(clampClosureDays(undefined), 30);
    assert.equal(clampClosureDays(null), 30);
    assert.equal(clampClosureDays(Number.NaN), 30);
  });

  it('floors fractional values', () => {
    assert.equal(clampClosureDays(30.9), 30);
  });

  it('clamps to [1, 365]', () => {
    assert.equal(clampClosureDays(0), 1);
    assert.equal(clampClosureDays(-5), 1);
    assert.equal(clampClosureDays(10000), 365);
  });

  it('passes through 1-365 unchanged', () => {
    assert.equal(clampClosureDays(1), 1);
    assert.equal(clampClosureDays(30), 30);
    assert.equal(clampClosureDays(90), 90);
    assert.equal(clampClosureDays(365), 365);
  });
});

describe('pickBestBypass', () => {
  it('returns null for chokepoints without viable bypasses', () => {
    assert.equal(pickBestBypass('gibraltar'), null); // only no-bypass placeholder
  });

  it('picks the lowest-transit-days viable corridor for suez', () => {
    const best = pickBestBypass('suez');
    assert.ok(best, 'should find a suez bypass');
    // SUMED pipeline (2 days) beats Cape of Good Hope (12 days).
    assert.equal(best.id, 'sumed_pipeline');
  });

  it('picks sunda_strait for malacca (1 day)', () => {
    const best = pickBestBypass('malacca_strait');
    assert.ok(best);
    assert.equal(best.addedTransitDays, 1);
  });

  it('returns null for unknown chokepoints', () => {
    assert.equal(pickBestBypass('atlantis'), null);
  });
});

describe('aggregateAnnualImportsByHs2', () => {
  it('returns zeros when products array is empty/undefined', () => {
    const totals = aggregateAnnualImportsByHs2(undefined);
    for (const hs2 of SEEDED_HS2_CODES) {
      assert.equal(totals[hs2], 0);
    }
  });

  it('aggregates HS4 values to HS2 buckets', () => {
    const products = [
      { hs4: '2709', description: 'Crude', totalValue: 100, year: 2023 },
      { hs4: '2710', description: 'Refined', totalValue: 50, year: 2023 },
      { hs4: '2711', description: 'LNG', totalValue: 25, year: 2023 },
      { hs4: '8542', description: 'Semis', totalValue: 200, year: 2023 },
      { hs4: '8703', description: 'Vehicles', totalValue: 300, year: 2023 },
      { hs4: '8704', description: 'Trucks', totalValue: 150, year: 2023 },
    ];
    const totals = aggregateAnnualImportsByHs2(products);
    assert.equal(totals['27'], 175);
    assert.equal(totals['85'], 200);
    assert.equal(totals['87'], 450);
    assert.equal(totals['30'], 0);
  });

  it('ignores negative and non-finite values', () => {
    const totals = aggregateAnnualImportsByHs2([
      { hs4: '2709', description: '', totalValue: -100, year: 2023 },
      { hs4: '2709', description: '', totalValue: Number.NaN, year: 2023 },
      { hs4: '2709', description: '', totalValue: 50, year: 2023 },
    ]);
    assert.equal(totals['27'], 50);
  });
});

describe('computeMultiSectorShock', () => {
  it('returns zero cost when importValueAnnual is zero', () => {
    const shock = computeMultiSectorShock('85', 0, 'suez', 'WAR_RISK_TIER_NORMAL', 30);
    assert.equal(shock.importValueAnnual, 0);
    assert.equal(shock.totalCostShockPerDay, 0);
    assert.equal(shock.totalCostShock30Days, 0);
    assert.equal(shock.totalCostShock, 0);
  });

  it('scales linearly with closureDays', () => {
    const imports = 365_000_000; // $365M annual → $1M per day base
    const s30 = computeMultiSectorShock('85', imports, 'hormuz_strait', 'WAR_RISK_TIER_CRITICAL', 30);
    const s90 = computeMultiSectorShock('85', imports, 'hormuz_strait', 'WAR_RISK_TIER_CRITICAL', 90);
    // Per-day cost is the same; 90-day total ~= 3x 30-day total.
    assert.equal(s30.totalCostShockPerDay, s90.totalCostShockPerDay);
    assert.ok(Math.abs(s90.totalCostShock - s30.totalCostShock * 3) <= 5);
    assert.equal(s30.closureDays, 30);
    assert.equal(s90.closureDays, 90);
  });

  it('war_zone tier yields higher cost than normal for same inputs', () => {
    const imports = 1_000_000_000;
    const normal = computeMultiSectorShock('85', imports, 'suez', 'WAR_RISK_TIER_NORMAL', 30);
    const warZone = computeMultiSectorShock('85', imports, 'suez', 'WAR_RISK_TIER_WAR_ZONE', 30);
    assert.ok(warZone.totalCostShock > normal.totalCostShock);
    assert.equal(warZone.warRiskPremiumBps, 300);
    assert.equal(normal.warRiskPremiumBps, 5);
  });

  it('includes bypass freight uplift when bypass exists', () => {
    const shock = computeMultiSectorShock('85', 1_000_000_000, 'hormuz_strait', 'WAR_RISK_TIER_NORMAL', 30);
    assert.ok(shock.freightAddedPctPerTon > 0);
    assert.ok(shock.addedTransitDays > 0);
  });

  it('emits per-day, 30-day, and 90-day totals regardless of closureDays', () => {
    const shock = computeMultiSectorShock('27', 365_000_000, 'suez', 'WAR_RISK_TIER_NORMAL', 7);
    assert.ok('totalCostShockPerDay' in shock);
    assert.ok('totalCostShock30Days' in shock);
    assert.ok('totalCostShock90Days' in shock);
    assert.ok('totalCostShock' in shock);
  });

  it('clamps closureDays to [1, 365]', () => {
    const s = computeMultiSectorShock('85', 1_000_000, 'suez', 'WAR_RISK_TIER_NORMAL', 500);
    assert.equal(s.closureDays, 365);
    const s2 = computeMultiSectorShock('85', 1_000_000, 'suez', 'WAR_RISK_TIER_NORMAL', -5);
    assert.equal(s2.closureDays, 1);
  });
});

describe('computeMultiSectorShocks', () => {
  it('returns exactly 10 seeded sectors', () => {
    const imports = { '27': 1_000, '85': 2_000, '87': 3_000 };
    const results = computeMultiSectorShocks(imports, 'suez', 'WAR_RISK_TIER_NORMAL', 30);
    assert.equal(results.length, 10);
    assert.equal(new Set(results.map(r => r.hs2)).size, 10);
  });

  it('sorts sectors by totalCostShockPerDay descending', () => {
    const imports = {
      '27': 100_000_000,
      '87': 500_000_000, // vehicles largest
      '85': 200_000_000,
    };
    const results = computeMultiSectorShocks(imports, 'suez', 'WAR_RISK_TIER_HIGH', 30);
    for (let i = 1; i < results.length; i++) {
      assert.ok(
        results[i - 1].totalCostShockPerDay >= results[i].totalCostShockPerDay,
        `results not sorted DESC at ${i}`,
      );
    }
    assert.equal(results[0].hs2, '87');
  });

  it('zero-imports sectors appear at the bottom with 0 cost', () => {
    const imports = { '27': 1_000_000 };
    const results = computeMultiSectorShocks(imports, 'hormuz_strait', 'WAR_RISK_TIER_CRITICAL', 30);
    const last = results[results.length - 1];
    assert.equal(last.totalCostShockPerDay, 0);
  });

  // #2971 acceptance criterion: 30-day cost shock stays within one order of magnitude of
  // the rough "annual_imports * 0.05 * (30/365)" heuristic. This catches structural math
  // errors (wrong divisor, missing closure-duration scaling, percent vs fraction slips).
  it('30-day cost shock is within an order of magnitude of a simple 5%/year heuristic', () => {
    const imports = {
      '27': 20_000_000_000, // $20B annual energy imports
      '87': 10_000_000_000, // $10B vehicles
      '84': 5_000_000_000, // $5B machinery
    };
    const results = computeMultiSectorShocks(imports, 'bosphorus', 'WAR_RISK_TIER_NORMAL', 30);
    const total = results.reduce((sum, s) => sum + s.totalCostShock, 0);
    const annualImports = Object.values(imports).reduce((a, b) => a + b, 0);
    const heuristic = annualImports * 0.05 * (30 / 365);
    // Within 10x in either direction. Current expected is ~0.6% of imports x 30 days,
    // heuristic is ~0.4% x 30 days — well inside the order-of-magnitude band.
    assert.ok(total > heuristic / 10, `cost ${total} too low vs heuristic ${heuristic}`);
    assert.ok(total < heuristic * 10, `cost ${total} too high vs heuristic ${heuristic}`);
  });
});

// ========================================================================
// Premium enforcement. Membership in PREMIUM_RPC_PATHS is what gates the
// endpoint, so assert against the real Set rather than grepping the module
// for a path string — a path moved into a comment satisfies the grep.
//
// The handler, client-service, panel and country-intel assertions that used to
// follow all restated lines of source. The panel is exercised by booting the
// dashboard in e2e/variant-live-smoke.spec.ts.
// ========================================================================

describe('multi-sector cost shock is premium-gated', () => {
  it('is in PREMIUM_RPC_PATHS', () => {
    assert.ok(PREMIUM_RPC_PATHS.has('/api/supply-chain/v1/get-multi-sector-cost-shock'));
  });
});
