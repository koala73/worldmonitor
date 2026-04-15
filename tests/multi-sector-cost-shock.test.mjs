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
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const readSrc = (relPath) => readFileSync(resolve(root, relPath), 'utf-8');

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
// 2. Edge function: api/supply-chain/v1/multi-sector-cost-shock.ts
// ========================================================================

describe('multi-sector-cost-shock edge function', () => {
  const src = readSrc('api/supply-chain/v1/multi-sector-cost-shock.ts');

  it('is declared as a Vercel edge function', () => {
    assert.match(src, /export const config = \{ runtime: 'edge' \}/);
  });

  it('calls isCallerPremium for PRO-gating', () => {
    assert.match(src, /isCallerPremium/);
    assert.match(src, /PRO subscription required/);
  });

  it('validates iso2 with a 2-letter regex', () => {
    assert.match(src, /\/\^\[A-Z\]\{2\}\$\/\.test/);
  });

  it('validates chokepointId against the registry', () => {
    assert.match(src, /CHOKEPOINT_REGISTRY\.some/);
  });

  it('clamps closureDays via clampClosureDays', () => {
    assert.match(src, /clampClosureDays/);
  });

  it('reads country products from comtrade:bilateral-hs4 key', () => {
    assert.match(src, /comtrade:bilateral-hs4:\$\{iso2\}:v1/);
  });

  it('reads chokepoint status for war risk tier', () => {
    assert.match(src, /CHOKEPOINT_STATUS_KEY/);
  });

  it('returns JSON with sectors, totalAddedCost, and closureDays', () => {
    assert.match(src, /sectors/);
    assert.match(src, /totalAddedCost/);
    assert.match(src, /closureDays/);
  });

  it('uses short private Cache-Control (slider state is user-controlled)', () => {
    assert.match(src, /private, max-age=60/);
  });
});

// ========================================================================
// 3. Client service: src/services/supply-chain/index.ts
// ========================================================================

describe('supply-chain client service: fetchMultiSectorCostShock', () => {
  const src = readSrc('src/services/supply-chain/index.ts');

  it('exports fetchMultiSectorCostShock', () => {
    assert.match(src, /export async function fetchMultiSectorCostShock/);
  });

  it('exports MultiSectorShock and MultiSectorShockResponse interfaces', () => {
    assert.match(src, /export interface MultiSectorShock/);
    assert.match(src, /export interface MultiSectorShockResponse/);
  });

  it('uses premiumFetch for PRO-gated access', () => {
    assert.match(src, /fetchMultiSectorCostShock[\s\S]*?premiumFetch/);
  });

  it('passes iso2, chokepointId, and closureDays as query params', () => {
    assert.match(src, /iso2=\$\{encodeURIComponent\(iso2\)\}/);
    assert.match(src, /chokepointId=\$\{encodeURIComponent\(chokepointId\)\}/);
    assert.match(src, /closureDays=\$\{encodeURIComponent\(String\(closureDays\)\)\}/);
  });

  it('supports AbortSignal passthrough', () => {
    assert.match(src, /signal\?: AbortSignal/);
  });
});

// ========================================================================
// 4. Premium paths: multi-sector-cost-shock is PRO-gated at the gateway.
// ========================================================================

describe('premium-paths: multi-sector-cost-shock registration', () => {
  const src = readSrc('src/shared/premium-paths.ts');

  it('includes /api/supply-chain/v1/multi-sector-cost-shock', () => {
    assert.match(src, /\/api\/supply-chain\/v1\/multi-sector-cost-shock/);
  });
});

// ========================================================================
// 5. CountryDeepDivePanel: Cost Shock Calculator card + slider.
// ========================================================================

describe('CountryDeepDivePanel Cost Shock Calculator', () => {
  const src = readSrc('src/components/CountryDeepDivePanel.ts');

  it('imports fetchMultiSectorCostShock', () => {
    assert.match(src, /import[^;]*fetchMultiSectorCostShock/);
  });

  it('declares a Cost Shock Calculator section card', () => {
    assert.match(src, /Cost Shock Calculator/);
  });

  it('registers updateMultiSectorCostShock public method', () => {
    assert.match(src, /updateMultiSectorCostShock\(/);
  });

  it('builds a range input slider with min=1 and max=90', () => {
    assert.match(src, /slider\.type = 'range'/);
    assert.match(src, /slider\.min = '1'/);
    assert.match(src, /slider\.max = '90'/);
  });

  it('listens for input events on the slider', () => {
    assert.match(src, /slider\.addEventListener\('input'/);
  });

  it('debounces re-fetches by 300ms', () => {
    assert.match(src, /scheduleCostShockRefetch/);
    assert.match(src, /setTimeout\([^,]+,\s*300\)/);
  });

  it('aborts prior in-flight fetches when a new slider value arrives', () => {
    assert.match(src, /costShockCalcAbort\?\.abort\(\)/);
    assert.match(src, /new AbortController\(\)/);
  });

  it('renders a sector table with Total row', () => {
    assert.match(src, /renderMultiSectorShockRows/);
    assert.match(src, /cdp-cost-shock-calc-total-row/);
  });

  it('sorts rows by totalCostShock descending', () => {
    assert.match(src, /\.sort\(\(a, b\) => b\.totalCostShock - a\.totalCostShock\)/);
  });

  it('gates the card as PRO when the user is not premium', () => {
    assert.match(src, /makeProLocked\('Upgrade to PRO for multi-sector cost shock modelling'\)/);
  });

  it('resetPanelContent clears all cost shock calculator state', () => {
    assert.match(src, /this\.costShockCalcBody = null;/);
    assert.match(src, /this\.costShockCalcTable = null;/);
    assert.match(src, /this\.costShockCalcAbort\?\.abort\(\);/);
    assert.match(src, /this\.costShockCalcDebounceTimer[\s\S]*?clearTimeout/);
  });
});

// ========================================================================
// 6. country-intel.ts wires the initial fetch after primary chokepoint.
// ========================================================================

describe('country-intel.ts: multi-sector cost shock fetch', () => {
  const src = readSrc('src/app/country-intel.ts');

  it('imports fetchMultiSectorCostShock from services/supply-chain', () => {
    assert.match(src, /fetchMultiSectorCostShock/);
  });

  it('calls fetchMultiSectorCostShock with default 30-day window', () => {
    assert.match(src, /fetchMultiSectorCostShock\(code, top\.primaryChokepointId, 30\)/);
  });

  it('clears the card on catch paths', () => {
    assert.match(src, /updateMultiSectorCostShock\?\.\(null\)/);
  });
});
