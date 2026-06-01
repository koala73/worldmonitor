import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeHeadlineEligible,
  computeLowConfidence,
  computeOverallCoverage,
} from '../server/worldmonitor/resilience/v1/_shared.ts';

type TestDimension = {
  id: string;
  score: number;
  coverage: number;
  observedWeight: number;
  imputedWeight: number;
  imputationClass: string;
  freshness: { lastObservedAtMs: string; staleness: '' | 'fresh' | 'aging' | 'stale' };
};

function dimension(id: string, staleness: TestDimension['freshness']['staleness']): TestDimension {
  return {
    id,
    score: 80,
    coverage: 1,
    observedWeight: 1,
    imputedWeight: 0,
    imputationClass: '',
    freshness: {
      lastObservedAtMs: '1717200000000',
      staleness,
    },
  };
}

function response(dimensions: TestDimension[]) {
  return {
    domains: [{ id: 'test', score: 80, weight: 1, dimensions }],
  };
}

describe('resilience staleness confidence derating', () => {
  it('fresh observed dimensions preserve the existing high-confidence coverage path', () => {
    const fresh = [
      dimension('macroFiscal', 'fresh'),
      dimension('currencyExternal', 'fresh'),
      dimension('infrastructure', 'fresh'),
    ];

    assert.equal(computeLowConfidence(fresh as never, 0), false);
    assert.equal(computeOverallCoverage(response(fresh) as never), 1);
    assert.equal(computeHeadlineEligible({
      overallCoverage: computeOverallCoverage(response(fresh) as never),
      populationMillions: 100,
      lowConfidence: computeLowConfidence(fresh as never, 0),
    }), true);
  });

  it('stale observed dimensions are less confidence-worthy than fresh observed dimensions', () => {
    const stale = [
      dimension('macroFiscal', 'stale'),
      dimension('currencyExternal', 'stale'),
      dimension('infrastructure', 'stale'),
    ];

    assert.equal(computeLowConfidence(stale as never, 0), true);
    assert.ok(Math.abs(computeOverallCoverage(response(stale) as never) - 0.4) < 0.001);
    assert.equal(computeHeadlineEligible({
      overallCoverage: computeOverallCoverage(response(stale) as never),
      populationMillions: 100,
      lowConfidence: computeLowConfidence(stale as never, 0),
    }), false);
  });

  it('aging observed dimensions use the intermediate confidence coverage factor', () => {
    const aging = [
      dimension('macroFiscal', 'aging'),
      dimension('currencyExternal', 'aging'),
      dimension('infrastructure', 'aging'),
    ];

    assert.equal(computeLowConfidence(aging as never, 0), false);
    assert.ok(Math.abs(computeOverallCoverage(response(aging) as never) - 0.7) < 0.001);
  });

  it('missing freshness proof does not add a second penalty on top of existing sparsity paths', () => {
    const missingFreshness = [
      { ...dimension('macroFiscal', 'stale'), freshness: { lastObservedAtMs: '0', staleness: 'stale' as const } },
    ];

    assert.equal(computeLowConfidence(missingFreshness as never, 0), false);
    assert.equal(computeOverallCoverage(response(missingFreshness) as never), 1);
  });
});
