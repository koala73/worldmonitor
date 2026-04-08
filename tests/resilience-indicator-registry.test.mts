import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RESILIENCE_DIMENSION_ORDER } from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import { INDICATOR_REGISTRY } from '../server/worldmonitor/resilience/v1/_indicator-registry.ts';
import type { IndicatorSpec } from '../server/worldmonitor/resilience/v1/_indicator-registry.ts';

describe('indicator registry', () => {
  it('covers all 13 dimensions', () => {
    const coveredDimensions = new Set(INDICATOR_REGISTRY.map((i) => i.dimension));
    for (const dimId of RESILIENCE_DIMENSION_ORDER) {
      assert.ok(coveredDimensions.has(dimId), `${dimId} has no indicators in registry`);
    }
    assert.equal(coveredDimensions.size, 13);
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
    const validCadences = new Set(['realtime', 'daily', 'weekly', 'monthly', 'annual']);
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

  it('every dimension has weights that sum to a consistent total', () => {
    const byDimension = new Map<string, IndicatorSpec[]>();
    for (const spec of INDICATOR_REGISTRY) {
      const list = byDimension.get(spec.dimension) ?? [];
      list.push(spec);
      byDimension.set(spec.dimension, list);
    }
    for (const [dimId, specs] of byDimension) {
      const totalWeight = specs.reduce((sum, s) => sum + s.weight, 0);
      assert.ok(
        Math.abs(totalWeight - 1) < 0.01,
        `${dimId} weights sum to ${totalWeight.toFixed(4)}, expected ~1.0`,
      );
    }
  });
});
