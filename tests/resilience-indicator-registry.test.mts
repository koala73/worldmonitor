import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RESILIENCE_DIMENSION_ORDER } from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import { INDICATOR_REGISTRY } from '../server/worldmonitor/resilience/v1/_indicator-registry.ts';
import type { IndicatorSpec } from '../server/worldmonitor/resilience/v1/_indicator-registry.ts';

describe('indicator registry', () => {
  it('covers all 22 dimensions (20 active + 2 retired)', () => {
    const coveredDimensions = new Set(INDICATOR_REGISTRY.map((i) => i.dimension));
    for (const dimId of RESILIENCE_DIMENSION_ORDER) {
      assert.ok(coveredDimensions.has(dimId), `${dimId} has no indicators in registry`);
    }
    // Plan 2026-04-25-004 Phase 2: 22 dims = 20 active + 2 retired
    // (19 active in Phase 1 + financialSystemExposure added in Phase 2).
    assert.equal(coveredDimensions.size, 22);
  });

  it('has no duplicate indicator ids', () => {
    const ids = INDICATOR_REGISTRY.map((i) => i.id);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size, `duplicate ids: ${ids.filter((id, idx) => ids.indexOf(id) !== idx).join(', ')}`);
  });

  it('every indicator has valid direction and positive weight', () => {
    for (const spec of INDICATOR_REGISTRY) {
      assert.ok(['higherBetter', 'lowerBetter'].includes(spec.direction), `${spec.id} has invalid direction: ${spec.direction}`);
      assert.ok(spec.weight > 0, `${spec.id} has non-positive weight: ${spec.weight}`);
    }
  });

  it('every indicator has valid cadence and scope', () => {
    const validCadences = new Set(['realtime', 'daily', 'weekly', 'monthly', 'quarterly', 'annual']);
    const validScopes = new Set(['global', 'curated']);
    for (const spec of INDICATOR_REGISTRY) {
      assert.ok(validCadences.has(spec.cadence), `${spec.id} has invalid cadence: ${spec.cadence}`);
      assert.ok(validScopes.has(spec.scope), `${spec.id} has invalid scope: ${spec.scope}`);
    }
  });

  it('goalposts worst != best for every indicator', () => {
    for (const spec of INDICATOR_REGISTRY) {
      assert.notEqual(spec.goalposts.worst, spec.goalposts.best, `${spec.id} has worst === best (${spec.goalposts.worst})`);
    }
  });

  it('imputation entries have valid type, score in [0,100], certainty in (0,1]', () => {
    const withImputation = INDICATOR_REGISTRY.filter((i): i is IndicatorSpec & { imputation: NonNullable<IndicatorSpec['imputation']> } => i.imputation != null);
    assert.ok(withImputation.length > 0, 'expected at least one indicator with imputation');
    for (const spec of withImputation) {
      assert.ok(['absenceSignal', 'conservative'].includes(spec.imputation.type), `${spec.id} has invalid imputation type`);
      assert.ok(spec.imputation.score >= 0 && spec.imputation.score <= 100, `${spec.id} imputation score out of range`);
      assert.ok(spec.imputation.certainty > 0 && spec.imputation.certainty <= 1, `${spec.id} imputation certainty out of range`);
    }
  });

  it('every dimension has non-experimental weights that sum to ~1.0', () => {
    // Weight-sum invariant applies to the CURRENTLY-ACTIVE indicator
    // set only. Indicators at tier='experimental' are flag-gated
    // / in-progress work (e.g. the PR 1 v2 energy construct lands
    // behind RESILIENCE_ENERGY_V2_ENABLED; until the flag flips,
    // these indicators are NOT part of the live score and their
    // weights must not be counted against the 1.0 invariant).
    const byDimension = new Map<string, IndicatorSpec[]>();
    for (const spec of INDICATOR_REGISTRY) {
      if (spec.tier === 'experimental') continue;
      const list = byDimension.get(spec.dimension) ?? [];
      list.push(spec);
      byDimension.set(spec.dimension, list);
    }
    for (const [dimId, specs] of byDimension) {
      const totalWeight = specs.reduce((sum, s) => sum + s.weight, 0);
      assert.ok(
        Math.abs(totalWeight - 1) < 0.01,
        `${dimId} non-experimental weights sum to ${totalWeight.toFixed(4)}, expected ~1.0`,
      );
    }
  });

  it('experimental weights are bounded at or below 1.0 per dimension', () => {
    // Loose invariant for experimental indicators. A dimension's
    // experimental set may only carry PART of the post-promotion
    // weight — if some legacy indicators are RETAINED across the
    // construct-repair (e.g. PR 1 retains energyPriceStress at a
    // different weight and renames gasStorageStress to
    // euGasStorageStress, both already in the non-experimental set),
    // the experimental-only subsum will be < 1.0.
    //
    // Post-promotion weight-sum correctness for flag-gated indicator
    // sets is the SCORER's responsibility to verify (via the flag-on
    // behavioural tests in resilience-energy-v2.test.mts), not the
    // registry's. This test enforces only the upper bound: no
    // dimension should accumulate experimental weight in excess of
    // the total it will eventually ship under the flag.
    const byDimension = new Map<string, IndicatorSpec[]>();
    for (const spec of INDICATOR_REGISTRY) {
      if (spec.tier !== 'experimental') continue;
      const list = byDimension.get(spec.dimension) ?? [];
      list.push(spec);
      byDimension.set(spec.dimension, list);
    }
    for (const [dimId, specs] of byDimension) {
      const experimentalWeight = specs.reduce((sum, s) => sum + s.weight, 0);
      assert.ok(
        experimentalWeight <= 1.0 + 0.01,
        `${dimId} experimental weights sum to ${experimentalWeight.toFixed(4)}, must not exceed 1.0`,
      );
    }
  });
});
