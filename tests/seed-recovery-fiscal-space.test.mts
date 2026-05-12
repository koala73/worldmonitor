import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildFiscalSpaceCountries,
  latestCommonYear,
  validateFiscalSpace,
  FISCAL_SPACE_VALIDATION_FLOORS,
  INFLATION_GAP_CAP_PCT,
} from '../scripts/seed-recovery-fiscal-space.mjs';

// Per-year fixture helper. Mirrors the shape returned by
// imfSdmxFetchIndicator: `{ [iso3]: { [year]: number } }`.
function byYear(...entries: Array<[string, number]>): Record<string, number> {
  return Object.fromEntries(entries);
}

describe('latestCommonYear', () => {
  it('returns the most recent year present in every map', () => {
    // Derive years dynamically — weoYears() is a rolling window of
    // [current, -1, -2], so hardcoded 2024/2023 would fall out of scope
    // and break this test in 2027 (greptile P2: PR #3669).
    const currentYear = new Date().getFullYear();
    const Y  = String(currentYear);
    const Y1 = String(currentYear - 1);
    const y = latestCommonYear([
      byYear([Y, 110], [Y1, 105]),
      byYear([Y, -2.5], [Y1, -2.0]),
      byYear([Y, -4.5]),
      byYear([Y, 0.7]),
      byYear([Y, 2.1]),
    ]);
    assert.equal(y, currentYear);
  });

  it('falls back to an older year if not every map has the most recent', () => {
    const currentYear = new Date().getFullYear();
    const prior = String(currentYear - 1);
    const older = String(currentYear - 2);
    const y = latestCommonYear([
      byYear([prior, 110]),
      byYear([older, -2.5], [prior, -2.5]),
      byYear([prior, -4.5]),
      byYear([prior, 0.7]),
      byYear([prior, 2.1]),
    ]);
    assert.equal(y, Number(prior));
  });

  it('returns null when no common year exists in the scan window', () => {
    // Two maps in scope but no shared year — derive years dynamically so
    // the test exercises the "no overlap" branch in every future year.
    const currentYear = new Date().getFullYear();
    const Y  = String(currentYear);
    const Y1 = String(currentYear - 1);
    const y = latestCommonYear([
      byYear([Y, 110]),
      byYear([Y1, -2.5]),
    ]);
    // currentYear not in second map; currentYear-1 not in first; common = null
    assert.equal(y, null);
  });

  it('returns null on empty or malformed input', () => {
    const Y = String(new Date().getFullYear());
    assert.equal(latestCommonYear([]), null);
    assert.equal(latestCommonYear([byYear([Y, NaN])]), null);
  });

  it('treats non-finite values as missing (so latestCommonYear skips NaN years)', () => {
    const currentYear = String(new Date().getFullYear());
    const y = latestCommonYear([
      byYear([currentYear, 110]),
      byYear([currentYear, NaN]),  // present-as-key but non-finite value
    ]);
    assert.equal(y, null);
  });
});

describe('buildFiscalSpaceCountries (per-country payload)', () => {
  // Use the current year so weoYears() matches inside the seeder helpers.
  const Y = String(new Date().getFullYear());

  function makeInputs(overrides: Partial<Record<
    'revenue' | 'balance' | 'debt' | 'primaryBalance' | 'growth' | 'inflation',
    Record<string, Record<string, number>>
  >> = {}) {
    return {
      revenue:        overrides.revenue        ?? {},
      balance:        overrides.balance        ?? {},
      debt:           overrides.debt           ?? {},
      primaryBalance: overrides.primaryBalance ?? {},
      growth:         overrides.growth         ?? {},
      inflation:      overrides.inflation      ?? {},
    };
  }

  it('full data: all 4 score-relevant fields populated, gap matches plan example', () => {
    // France-shape inputs (110/-2.5/-4.5/0.7/2.1, expected gap ≈ -1.43).
    const result = buildFiscalSpaceCountries(makeInputs({
      revenue:        { FRA: { [Y]: 51.4 } },
      balance:        { FRA: { [Y]: -4.5 } },
      debt:           { FRA: { [Y]: 110 } },
      primaryBalance: { FRA: { [Y]: -2.5 } },
      growth:         { FRA: { [Y]: 0.7 } },
      inflation:      { FRA: { [Y]: 2.1 } },
    }));
    const fr = result.FR;
    assert.ok(fr, 'France should be emitted');
    assert.equal(fr.govRevenuePct, 51.4);
    assert.equal(fr.fiscalBalancePct, -4.5);
    assert.equal(fr.debtToGdpPct, 110);
    assert.equal(fr.primaryBalancePct, -2.5);
    assert.equal(fr.realGdpGrowthPct, 0.7);
    assert.equal(fr.inflationPct, 2.1);
    assert.equal(fr.gapYear, Number(Y));
    assert.ok(fr.debtSustainabilityGapPct !== null);
    assert.ok(Math.abs(fr.debtSustainabilityGapPct! - -1.43) < 0.01,
      `France gap expected ≈ -1.43, got ${fr.debtSustainabilityGapPct}`);
  });

  it('one fiscal-3 field missing (no revenue): country emitted with rev=null, fiscal-3 partial', () => {
    const result = buildFiscalSpaceCountries(makeInputs({
      revenue:        {},                              // no revenue for FRA
      balance:        { FRA: { [Y]: -4.5 } },
      debt:           { FRA: { [Y]: 110 } },
      primaryBalance: { FRA: { [Y]: -2.5 } },
      growth:         { FRA: { [Y]: 0.7 } },
      inflation:      { FRA: { [Y]: 2.1 } },
    }));
    const fr = result.FR;
    assert.ok(fr, 'France should still be emitted (balance ∪ debt is non-empty)');
    assert.equal(fr.govRevenuePct, null);
    assert.equal(fr.fiscalBalancePct, -4.5);
    assert.equal(fr.debtToGdpPct, 110);
    // Gap still computable because revenue is NOT in the formula:
    assert.ok(fr.debtSustainabilityGapPct !== null,
      'gap should still compute when only revenue is missing');
  });

  it('missing growth: country emitted, gap=null, fiscal-3 intact', () => {
    const result = buildFiscalSpaceCountries(makeInputs({
      revenue:        { FRA: { [Y]: 51.4 } },
      balance:        { FRA: { [Y]: -4.5 } },
      debt:           { FRA: { [Y]: 110 } },
      primaryBalance: { FRA: { [Y]: -2.5 } },
      growth:         {},                              // no growth
      inflation:      { FRA: { [Y]: 2.1 } },
    }));
    const fr = result.FR;
    assert.ok(fr);
    assert.equal(fr.govRevenuePct, 51.4);
    assert.equal(fr.fiscalBalancePct, -4.5);
    assert.equal(fr.debtToGdpPct, 110);
    assert.equal(fr.debtSustainabilityGapPct, null);
    assert.equal(fr.gapYear, null);
  });

  it('inflation > cap: country emitted, gap=null, fiscal-3 intact (Argentina case)', () => {
    const result = buildFiscalSpaceCountries(makeInputs({
      revenue:        { ARG: { [Y]: 18 } },
      balance:        { ARG: { [Y]: -5 } },
      debt:           { ARG: { [Y]: 90 } },
      primaryBalance: { ARG: { [Y]: -2 } },
      growth:         { ARG: { [Y]: -3 } },
      inflation:      { ARG: { [Y]: 200 } },             // hyperinflation
    }));
    const ar = result.AR;
    assert.ok(ar);
    assert.equal(ar.debtToGdpPct, 90);
    assert.equal(ar.fiscalBalancePct, -5);
    assert.equal(ar.debtSustainabilityGapPct, null,
      `inflation > ${INFLATION_GAP_CAP_PCT}% should drop gap to null`);
  });

  it('year mismatch across inputs: country emitted, gap=null, fiscal-3 keeps latest-per-series', () => {
    const currentYear = new Date().getFullYear();
    const Y_CUR = String(currentYear);
    const Y_PRI = String(currentYear - 1);
    const result = buildFiscalSpaceCountries(makeInputs({
      revenue:        { FRA: { [Y_CUR]: 51.4 } },
      balance:        { FRA: { [Y_CUR]: -4.5 } },
      debt:           { FRA: { [Y_CUR]: 110 } },         // 2025 forecast
      primaryBalance: { FRA: { [Y_PRI]: -2.5 } },       // 2024 actual
      growth:         { FRA: { [Y_CUR]: 0.7 } },         // 2025
      inflation:      { FRA: { [Y_CUR]: 2.1 } },         // 2025
    }));
    const fr = result.FR;
    assert.ok(fr);
    // Fiscal-3 latest values still populated (latest-per-series unchanged):
    assert.equal(fr.debtToGdpPct, 110);
    assert.equal(fr.fiscalBalancePct, -4.5);
    // Gap is null because latestCommonYear cannot align all 5 inputs:
    assert.equal(fr.debtSustainabilityGapPct, null);
    assert.equal(fr.gapYear, null);
  });

  it('all fiscal-3 missing: country SKIPPED entirely (preserves existing skip guard)', () => {
    // Country has growth + inflation + primary balance but NO revenue / balance / debt.
    // The fiscal-series outage protection requires this country to be skipped, not
    // emitted with null fiscal-3 fields (that was the R1-P0 data-quality risk).
    const result = buildFiscalSpaceCountries(makeInputs({
      revenue:        {},
      balance:        {},
      debt:           {},
      primaryBalance: { JPN: { [Y]: 0 } },
      growth:         { JPN: { [Y]: 0.5 } },
      inflation:      { JPN: { [Y]: 2.0 } },
    }));
    assert.equal(Object.keys(result).length, 0,
      'country with no fiscal-3 data must be skipped, not emitted with nulls');
  });

  it('aggregate codes are filtered out (e.g. WEOWORLD, EU)', () => {
    const result = buildFiscalSpaceCountries(makeInputs({
      revenue: { WEOWORLD: { [Y]: 40 }, EU: { [Y]: 45 }, FRA: { [Y]: 51.4 } },
      balance: { FRA: { [Y]: -4.5 } },
      debt:    { FRA: { [Y]: 110 } },
    }));
    assert.ok(result.FR, 'France should be emitted');
    assert.ok(!('XX' in result), 'no aggregate code should leak through');
    assert.equal(Object.keys(result).length, 1, 'only FR should be in the result');
  });
});

describe('validateFiscalSpace (two-floor gating)', () => {
  // Build a country payload meeting a target shape.
  function payload(opts: { withFiscal3: number; withGap: number }): { countries: Record<string, unknown> } {
    const countries: Record<string, unknown> = {};
    let i = 0;
    for (let n = 0; n < opts.withFiscal3; n++, i++) {
      countries[`F${i}`] = {
        govRevenuePct: 40, fiscalBalancePct: -2, debtToGdpPct: 60,
        debtSustainabilityGapPct: n < opts.withGap ? -1.0 : null,
      };
    }
    return { countries };
  }

  it('default floors {fiscal3: 150, gap: 100}: passes when both thresholds met', () => {
    const data = payload({ withFiscal3: 160, withGap: 110 });
    assert.equal(validateFiscalSpace(data), true);
  });

  it('default floors: fails when fiscal-3 coverage drops below 150', () => {
    const data = payload({ withFiscal3: 149, withGap: 110 });
    assert.equal(validateFiscalSpace(data), false);
  });

  it('default floors: fails when gap coverage drops below 100 (fiscal-3 alone is not enough)', () => {
    const data = payload({ withFiscal3: 160, withGap: 99 });
    assert.equal(validateFiscalSpace(data), false,
      'gap coverage < 100 must reject the whole payload — last canonical blob keeps serving');
  });

  it('two-floor independence: both must pass, not just one', () => {
    // Pass fiscal-3, fail gap → false
    assert.equal(validateFiscalSpace(payload({ withFiscal3: 200, withGap: 50 })), false);
    // Fail fiscal-3, pass gap → false (synthetic — same N for both in this fixture)
    assert.equal(validateFiscalSpace(payload({ withFiscal3: 50, withGap: 50 })), false);
  });

  it('custom floors: passes a small fixture when floors are lowered to match', () => {
    const data = payload({ withFiscal3: 5, withGap: 3 });
    assert.equal(validateFiscalSpace(data, { fiscal3: 5, gap: 3 }), true);
    assert.equal(validateFiscalSpace(data, { fiscal3: 6, gap: 3 }), false);
    assert.equal(validateFiscalSpace(data, { fiscal3: 5, gap: 4 }), false);
  });

  it('production floors are pinned at {fiscal3: 150, gap: 100}', () => {
    // Direct assertion on the named constant so future drift is caught
    // without inspecting function source via .toString().
    assert.deepEqual(FISCAL_SPACE_VALIDATION_FLOORS, { fiscal3: 150, gap: 100 });
  });

  it('inflation cap constant is pinned at 25', () => {
    assert.equal(INFLATION_GAP_CAP_PCT, 25);
  });

  it('handles empty/malformed payloads safely', () => {
    assert.equal(validateFiscalSpace(undefined), false);
    assert.equal(validateFiscalSpace({}), false);
    assert.equal(validateFiscalSpace({ countries: {} }), false);
    assert.equal(validateFiscalSpace({ countries: null }), false);
  });
});
