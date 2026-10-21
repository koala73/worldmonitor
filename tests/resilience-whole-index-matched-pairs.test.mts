import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import wholeIndexFixture from './fixtures/resilience-whole-index-pairs-2026-08-13.json' with { type: 'json' };
import {
  MATCHED_PAIRS,
  evaluateWholeIndexMatchedPairs,
} from './helpers/resilience-matched-pairs.mts';
import { scoreAllDimensions } from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import { buildDimensionList, buildDomainList, penalizedPillarScore } from '../server/worldmonitor/resilience/v1/_shared.ts';
import { buildPillarList } from '../server/worldmonitor/resilience/v1/_pillar-membership.ts';
import type { ResilienceSeedReader } from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';

const fixture = wholeIndexFixture as typeof wholeIndexFixture & {
  __fixture: {
    capturedAt: string;
    source: string;
    countries: string[];
    requiredKeys: string[];
  };
};
const fixturePayload: Record<string, unknown> = Object.fromEntries(Object.entries(fixture));
const EXPECTED_WHOLE_INDEX_PAIR_IDS = [
  'de-vs-fr',
  'no-vs-ca',
  'uae-vs-bh',
  'jp-vs-kr',
  'in-vs-za',
  'ch-vs-sg',
  'pt-vs-uz',
  'es-vs-by',
  'ch-vs-tm',
];
const originalEnvironment = {
  education: process.env.RESILIENCE_EDUCATION_ENABLED,
  financialSystemExposure: process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED,
  pillarCombine: process.env.RESILIENCE_PILLAR_COMBINE_ENABLED,
  energyV2: process.env.RESILIENCE_ENERGY_V2_ENABLED,
};

function restoreEnvironmentValue(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function createFixtureReader(): ResilienceSeedReader {
  return async (key) => {
    const value = fixturePayload[key];
    if (!key.startsWith('seed-meta:')) return value ?? null;

    // Keep the captured producer metadata, but make its health timestamp
    // current so the fixture remains valid when CI runs after the capture day.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { ...value, fetchedAt: Date.now() };
    }
    return null;
  };
}

async function scoreFixtureUniverse(): Promise<Map<string, number>> {
  const reader = createFixtureReader();
  const scores = new Map<string, number>();

  // Keep this serial. It follows the production dry-run's bounded read pattern
  // and avoids turning a fixture test into a concurrent scorer stress test.
  for (const countryCode of fixture.__fixture.countries) {
    const scoreMap = await scoreAllDimensions(countryCode, reader);
    const dimensions = buildDimensionList(scoreMap);
    const domains = buildDomainList(dimensions);
    const pillars = buildPillarList(domains, true);
    scores.set(
      countryCode,
      penalizedPillarScore(pillars.map(({ score, weight }) => ({ score, weight }))),
    );
  }
  return scores;
}

function evaluateSinglePair(
  scores: ReadonlyMap<string, number | null | undefined> | Readonly<Record<string, number | null | undefined>>,
  pairId: string,
) {
  const evaluations = evaluateWholeIndexMatchedPairs(
    scores,
    MATCHED_PAIRS.filter((pair) => pair.id === pairId),
  );
  assert.equal(evaluations.length, 1, `expected exactly one configured pair for ${pairId}`);
  const evaluation = evaluations[0];
  if (evaluation == null) throw new Error(`missing configured pair evaluation for ${pairId}`);
  return evaluation;
}

before(() => {
  assert.deepEqual(
    MATCHED_PAIRS.map((pair) => pair.id),
    EXPECTED_WHOLE_INDEX_PAIR_IDS,
    'fixture assertions must be updated when the whole-index pair contract changes',
  );
  assert.ok(fixture.__fixture.requiredKeys.length > 0, 'fixture must declare its source-key manifest');
  for (const key of fixture.__fixture.requiredKeys) {
    assert.ok(Object.prototype.hasOwnProperty.call(fixturePayload, key), `fixture source key is missing: ${key}`);
  }
  process.env.RESILIENCE_EDUCATION_ENABLED = 'true';
  process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED = 'false';
  process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'true';
  process.env.RESILIENCE_ENERGY_V2_ENABLED = 'false';
});

after(() => {
  restoreEnvironmentValue('RESILIENCE_EDUCATION_ENABLED', originalEnvironment.education);
  restoreEnvironmentValue('RESILIENCE_FIN_SYS_EXPOSURE_ENABLED', originalEnvironment.financialSystemExposure);
  restoreEnvironmentValue('RESILIENCE_PILLAR_COMBINE_ENABLED', originalEnvironment.pillarCombine);
  restoreEnvironmentValue('RESILIENCE_ENERGY_V2_ENABLED', originalEnvironment.energyV2);
});

describe('whole-index matched-pair gate', () => {
  it('scores every current pair on the captured production-shaped payload', async () => {
    const scores = await scoreFixtureUniverse();
    const evaluations = evaluateWholeIndexMatchedPairs(scores);
    const failures = evaluations.filter((evaluation) => evaluation.status !== 'pass');

    assert.deepEqual(
      failures,
      [],
      `whole-index matched pairs failed on ${fixture.__fixture.capturedAt} ${fixture.__fixture.source}: ${JSON.stringify(evaluations)}`,
    );
    assert.equal(evaluations.length, MATCHED_PAIRS.length);
    assert.ok(
      evaluations.every((evaluation) => evaluation.gap != null && evaluation.gap >= evaluation.minGap),
      'a passing pair must have a finite observed gap at or above its declared minimum',
    );
  });

  it('fails closed for missing scores and distinguishes near-flips from inversions', () => {
    const nearFlip = evaluateSinglePair({ DE: 62, FR: 61.5 }, 'de-vs-fr');
    assert.equal(nearFlip.status, 'near-flip');
    assert.equal(nearFlip.gap, 0.5);

    const inverted = evaluateSinglePair({ IN: 45, ZA: 46 }, 'in-vs-za');
    assert.equal(inverted.status, 'inverted');
    assert.equal(inverted.gap, -1);

    const nonFinite = evaluateSinglePair({ IN: Number.NaN, ZA: 45 }, 'in-vs-za');
    assert.equal(nonFinite.status, 'missing');
    assert.equal(nonFinite.gap, null);

    const infinite = evaluateSinglePair({ IN: Number.POSITIVE_INFINITY, ZA: 45 }, 'in-vs-za');
    assert.equal(infinite.status, 'missing');
    assert.equal(infinite.gap, null);

    const nonNumeric = evaluateSinglePair(
      { IN: '45', ZA: 45 } as unknown as Record<string, number>,
      'in-vs-za',
    );
    assert.equal(nonNumeric.status, 'missing');
    assert.equal(nonNumeric.gap, null);

    const defaultMinGap = evaluateWholeIndexMatchedPairs({ DE: 5, FR: 3 }, [{
      id: 'default-min-gap',
      higherExpected: 'DE',
      lowerExpected: 'FR',
      axis: 'test default',
      rationale: 'test default minimum gap',
    }])[0];
    assert.ok(defaultMinGap);
    assert.equal(defaultMinGap.minGap, 3);
    assert.equal(defaultMinGap.status, 'near-flip');

    const missing = evaluateSinglePair({ IN: 45 }, 'in-vs-za');
    assert.equal(missing.status, 'missing');
    assert.equal(missing.gap, null);
  });
});
