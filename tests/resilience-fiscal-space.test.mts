import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { scoreFiscalSpace } from '../server/worldmonitor/resilience/v1/_dimension-scorers';

const FISCAL_KEY = 'resilience:recovery:fiscal-space:v1';

interface CountryEntry {
  govRevenuePct?: number | null;
  fiscalBalancePct?: number | null;
  debtToGdpPct?: number | null;
  primaryBalancePct?: number | null;
  realGdpGrowthPct?: number | null;
  inflationPct?: number | null;
  debtSustainabilityGapPct?: number | null;
}

function makeReader(countries: Record<string, CountryEntry>) {
  return async (key: string): Promise<unknown | null> => {
    if (key === FISCAL_KEY) return { countries };
    return null;
  };
}

describe('scoreFiscalSpace — 4-indicator blend with debtSustainabilityGap', () => {
  it('Norway-shape: low debt + large positive gap → score saturates near 100', async () => {
    const reader = makeReader({
      NO: {
        govRevenuePct: 42, fiscalBalancePct: 10, debtToGdpPct: 40,
        primaryBalancePct: 11, realGdpGrowthPct: 1, inflationPct: 2.5,
        debtSustainabilityGapPct: 11.4,
      },
    });
    const result = await scoreFiscalSpace('NO', reader);
    assert.ok(result.score > 85, `Norway should score >85 with full gap + healthy fiscal, got ${result.score}`);
    assert.equal(result.imputationClass, null, 'real data must not carry imputation class');
    assert.ok(result.coverage > 0.85, `coverage should be high when all 4 indicators populated, got ${result.coverage}`);
  });

  it('Italy-shape: high debt + mild surplus + gap near zero → score near the stabilizing midpoint', async () => {
    const reader = makeReader({
      IT: {
        govRevenuePct: 47, fiscalBalancePct: -3.5, debtToGdpPct: 137,
        primaryBalancePct: 1.0, realGdpGrowthPct: 0.5, inflationPct: 2.0,
        debtSustainabilityGapPct: -0.04,
      },
    });
    const result = await scoreFiscalSpace('IT', reader);
    // Italy's debt-level penalty drags the score down, but the near-zero
    // gap (debt-stabilizing) provides offsetting credit. Result should be
    // mid-range, not at either extreme.
    assert.ok(result.score > 30 && result.score < 70,
      `Italy should land mid-range with offsetting signals, got ${result.score}`);
  });

  it('Greece-shape: high debt + negative gap → score drops significantly', async () => {
    // Hypothetical Greece-like distress profile to verify the gap signal
    // genuinely penalizes unsustainable trajectories.
    const reader = makeReader({
      GR: {
        govRevenuePct: 48, fiscalBalancePct: -4.0, debtToGdpPct: 160,
        primaryBalancePct: 0, realGdpGrowthPct: 1.0, inflationPct: 2.0,
        debtSustainabilityGapPct: -4.5,  // near worst goalpost
      },
    });
    const result = await scoreFiscalSpace('GR', reader);
    // With a -4.5 gap (normalized ~6/100) carrying weight 0.35, plus the
    // 0.20 weight on debt=160 (normalized ~0/100), the composite drops
    // well below 50.
    assert.ok(result.score < 50, `high-debt + negative-gap should score < 50, got ${result.score}`);
  });

  it('YE-shape: fiscal-3 only, gap=null → weight redistributes; observedWeight = 0.65', async () => {
    const reader = makeReader({
      YE: { govRevenuePct: 8, fiscalBalancePct: -10, debtToGdpPct: 80 },
    });
    const result = await scoreFiscalSpace('YE', reader);
    // With gap=null, only the 3 fiscal-3 indicators score (sum of weights = 0.65).
    // weightedBlend renormalizes so the score is a valid 0..100 value — but the
    // coverage field reflects that only 65% of the weight is observed.
    assert.ok(result.coverage >= 0.6 && result.coverage <= 0.7,
      `coverage should reflect 0.65 observed weight when gap missing, got ${result.coverage}`);
    assert.equal(result.imputationClass, null, 'partial data should not carry imputation class');
  });

  it('country missing entirely → unmonitored imputation', async () => {
    const emptyReader = async (_key: string): Promise<unknown | null> => null;
    const result = await scoreFiscalSpace('XX', emptyReader);
    assert.equal(result.imputationClass, 'unmonitored');
    assert.equal(result.observedWeight, 0);
    assert.equal(result.imputedWeight, 1);
  });

  it('ordering invariant: low-debt+positive-gap > high-debt+negative-gap', async () => {
    const reader = makeReader({
      GOOD: {
        govRevenuePct: 42, fiscalBalancePct: 5, debtToGdpPct: 50,
        primaryBalancePct: 5, realGdpGrowthPct: 2, inflationPct: 2,
        debtSustainabilityGapPct: 3,
      },
      BAD: {
        govRevenuePct: 30, fiscalBalancePct: -8, debtToGdpPct: 150,
        primaryBalancePct: -4, realGdpGrowthPct: 0.5, inflationPct: 2,
        debtSustainabilityGapPct: -5,
      },
    });
    const good = await scoreFiscalSpace('GOOD', reader);
    const bad = await scoreFiscalSpace('BAD', reader);
    assert.ok(good.score > bad.score,
      `low-debt + positive gap (${good.score}) must beat high-debt + negative gap (${bad.score})`);
    // Spread should be very wide for these extremes:
    assert.ok(good.score - bad.score > 50,
      `expected spread > 50 between extreme cases, got ${good.score - bad.score}`);
  });

  it('weight invariant: gap=null in fixture matches scorer output for fixture lacking gap field', async () => {
    // Same country payload, two readers:
    //   A. With debtSustainabilityGapPct explicitly null
    //   B. Without the field at all
    // Both should produce identical scores — the scorer's null-check
    // treats missing and null equivalently.
    const a = makeReader({ XX: { govRevenuePct: 35, fiscalBalancePct: -2, debtToGdpPct: 70, debtSustainabilityGapPct: null } });
    const b = makeReader({ XX: { govRevenuePct: 35, fiscalBalancePct: -2, debtToGdpPct: 70 } });
    const ra = await scoreFiscalSpace('XX', a);
    const rb = await scoreFiscalSpace('XX', b);
    assert.equal(ra.score, rb.score, 'explicit null and missing field must produce identical scores');
    assert.equal(ra.coverage, rb.coverage, 'coverage must also match');
  });
});
