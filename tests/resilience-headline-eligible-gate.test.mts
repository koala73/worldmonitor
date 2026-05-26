// Plan 2026-04-26-002 §U7 (PR 6) — pinning tests for the
// headline-eligible gate logic AND the ranking-handler filter.
//
// PR 6 swaps `headlineEligible` from the PR-2 default `true` to actual
// eligibility per origin Q2 + Q5:
//   coverage >= 0.65 AND (population >= 200k OR coverage >= 0.85) AND !lowConfidence
//
// Two layers of coverage:
// 1. Truth-table tests over `computeHeadlineEligible` directly
// 2. End-to-end integration: a cached ranking payload with one
//    headlineEligible:false item must surface that item in greyedOut[],
//    NOT items[] — i.e. the handler's `passesHeadlineGate` actually fires.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getResilienceRanking } from '../server/worldmonitor/resilience/v1/get-resilience-ranking.ts';
import {
  RESILIENCE_RANKING_CACHE_KEY,
  computeHeadlineEligible,
  HEADLINE_ELIGIBLE_HIGH_COVERAGE,
  HEADLINE_ELIGIBLE_MIN_COVERAGE,
  HEADLINE_ELIGIBLE_MIN_POPULATION_MILLIONS,
} from '../server/worldmonitor/resilience/v1/_shared.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { RESILIENCE_FIXTURES } from './helpers/resilience-fixtures.mts';

describe('computeHeadlineEligible truth table (Plan 2026-04-26-002 §U7)', () => {
  it('happy path: high coverage + large population + not lowConfidence → true', () => {
    assert.equal(
      computeHeadlineEligible({ overallCoverage: 0.9, populationMillions: 100, lowConfidence: false }),
      true,
    );
  });

  it('lowConfidence short-circuits to false regardless of other signals', () => {
    assert.equal(
      computeHeadlineEligible({ overallCoverage: 0.99, populationMillions: 1000, lowConfidence: true }),
      false,
      'lowConfidence must dominate — even perfect coverage + huge population fail',
    );
  });

  it('coverage just below 0.65 floor → false even with large population', () => {
    assert.equal(
      computeHeadlineEligible({ overallCoverage: 0.64, populationMillions: 100, lowConfidence: false }),
      false,
      `${HEADLINE_ELIGIBLE_MIN_COVERAGE} is the absolute floor; below it, no compensator helps`,
    );
  });

  it('coverage at 0.65 floor + large population → true', () => {
    assert.equal(
      computeHeadlineEligible({ overallCoverage: HEADLINE_ELIGIBLE_MIN_COVERAGE, populationMillions: 50, lowConfidence: false }),
      true,
    );
  });

  it('tiny state (< 200k pop) with mid coverage 0.7 → false', () => {
    // Iceland-shape: coverage 0.7 but pop 0.4M is below 0.2M floor?
    // 0.4 > 0.2 → passes. Test with a real micro-state: pop 0.05M.
    assert.equal(
      computeHeadlineEligible({ overallCoverage: 0.7, populationMillions: 0.05, lowConfidence: false }),
      false,
      'micro-state without high-quality data fails the gate',
    );
  });

  it('tiny state (< 200k pop) with high coverage >= 0.85 → true (data-quality compensator)', () => {
    assert.equal(
      computeHeadlineEligible({ overallCoverage: HEADLINE_ELIGIBLE_HIGH_COVERAGE, populationMillions: 0.05, lowConfidence: false }),
      true,
      'high-coverage micro-state earns headline status (Iceland-class with 0.85+ coverage)',
    );
  });

  it('unknown population (null) + mid coverage → false (conservative default)', () => {
    assert.equal(
      computeHeadlineEligible({ overallCoverage: 0.75, populationMillions: null, lowConfidence: false }),
      false,
      'unknown population fails the population branch; needs coverage >= 0.85 alone to pass',
    );
  });

  it('unknown population (null) + coverage >= 0.85 → true (coverage compensator alone)', () => {
    assert.equal(
      computeHeadlineEligible({ overallCoverage: HEADLINE_ELIGIBLE_HIGH_COVERAGE, populationMillions: null, lowConfidence: false }),
      true,
      'unknown-pop country can earn headline status via the high-coverage branch',
    );
  });

  it('boundary: population at exactly 200k floor → true', () => {
    assert.equal(
      computeHeadlineEligible({ overallCoverage: 0.7, populationMillions: HEADLINE_ELIGIBLE_MIN_POPULATION_MILLIONS, lowConfidence: false }),
      true,
      '0.2M is the inclusive boundary',
    );
  });

  it('boundary: population just below 200k → false (population branch)', () => {
    assert.equal(
      computeHeadlineEligible({ overallCoverage: 0.7, populationMillions: 0.19, lowConfidence: false }),
      false,
      '0.19M < 0.2M → fails population branch; coverage 0.7 < 0.85 → fails coverage branch',
    );
  });
});

describe('ranking handler filter (Plan 2026-04-26-002 §U7)', () => {
  it('moves headlineEligible:false items to greyedOut[], NOT items[]', async () => {
    // Greptile P2 review fix: previously the only handler-level
    // coverage of the §U7 filter was indirect (via cache-hit tests
    // using post-PR-6 fixtures). This integration test seeds a cached
    // ranking with a deliberately mixed payload (one eligible + one
    // ineligible item) and asserts the handler's `passesHeadlineGate`
    // predicate actually splits them — the eligible item lands in
    // items[], the ineligible item in greyedOut[].
    //
    // Mutation-test verified: replacing the predicate body with
    // `() => true` (i.e. disabling the filter) makes this test fail.
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    const cachedPublic = {
      items: [
        // Eligible — should land in items[]
        { countryCode: 'NO', overallScore: 82, level: 'high', lowConfidence: false, overallCoverage: 0.95, headlineEligible: true },
        // Ineligible — should move to greyedOut[]
        { countryCode: 'TV', overallScore: 70, level: 'medium', lowConfidence: false, overallCoverage: 0.7, headlineEligible: false },
      ],
      greyedOut: [],
    };
    redis.set(RESILIENCE_RANKING_CACHE_KEY, JSON.stringify({ ...cachedPublic, _formula: 'd6' }));

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    const itemCodes = response.items.map((item) => item.countryCode);
    const greyedCodes = response.greyedOut.map((item) => item.countryCode);

    assert.ok(itemCodes.includes('NO'),
      `eligible item NO must remain in items[]; got items=${itemCodes.join(',')}`);
    assert.ok(!itemCodes.includes('TV'),
      `ineligible item TV must NOT appear in items[]; got items=${itemCodes.join(',')}`);
    assert.ok(greyedCodes.includes('TV'),
      `ineligible item TV must surface in greyedOut[]; got greyedOut=${greyedCodes.join(',')}`);
  });

  it('promotes greyedOut items with headlineEligible:true to items[] (symmetric gate)', async () => {
    // Plan 002 §U7 review fix (PR #3472 follow-up): the gate must
    // apply SYMMETRICALLY across both arrays. A cached greyedOut entry
    // with `headlineEligible: true` should be promoted to items[] on
    // the cache-hit read; otherwise an item that now passes the gate
    // remains demoted until a full recompute (~6h TTL).
    //
    // Mutation-verified: removing `promotedFromGreyed` from the
    // returned items[] array makes this test fail.
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    const cachedPublic = {
      items: [],
      greyedOut: [
        // Anomalous: cached in greyedOut but flagged eligible. Symmetric
        // gate should promote it.
        { countryCode: 'NO', overallScore: 82, level: 'high', lowConfidence: false, overallCoverage: 0.95, headlineEligible: true },
        // Genuinely ineligible — stays in greyedOut.
        { countryCode: 'TV', overallScore: 70, level: 'medium', lowConfidence: false, overallCoverage: 0.7, headlineEligible: false },
      ],
    };
    redis.set(RESILIENCE_RANKING_CACHE_KEY, JSON.stringify({ ...cachedPublic, _formula: 'd6' }));

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    assert.ok(response.items.some((item) => item.countryCode === 'NO'),
      'symmetric gate must promote greyedOut entries with headlineEligible:true to items[]');
    assert.ok(!response.greyedOut.some((item) => item.countryCode === 'NO'),
      'NO must NOT remain in greyedOut[] after symmetric gate promotion');
    assert.ok(response.greyedOut.some((item) => item.countryCode === 'TV'),
      'TV (genuinely ineligible) must stay in greyedOut[]');
  });

  it('re-sorts items[] after promoting from greyedOut (high-score promoted item lands at correct rank)', async () => {
    // Plan 002 §U7 review fix (PR #3477 round 2): the symmetric gate
    // appends `promotedFromGreyed` to items[] without re-sorting. A
    // higher-scoring promoted item would land at the END of items[]
    // instead of its correct rank position. Recompute path sorts
    // before publishing, so cache-hit must too — otherwise cache-hit
    // visibly differs from a fresh recompute for the same data.
    //
    // Mutation-verified: removing the sortRankingItems wrapper makes
    // this test fail.
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    const cachedPublic = {
      items: [
        // Lower-scoring eligible item — should land below the promotion.
        { countryCode: 'US', overallScore: 61, level: 'medium', lowConfidence: false, overallCoverage: 0.88, headlineEligible: true },
      ],
      greyedOut: [
        // Higher-scoring item flagged eligible — must promote to items[]
        // AND land at the top after re-sort, not appended at the end.
        { countryCode: 'NO', overallScore: 82, level: 'high', lowConfidence: false, overallCoverage: 0.95, headlineEligible: true },
      ],
    };
    redis.set(RESILIENCE_RANKING_CACHE_KEY, JSON.stringify({ ...cachedPublic, _formula: 'd6' }));

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    const itemCodes = response.items.map((item) => item.countryCode);
    assert.deepEqual(itemCodes, ['NO', 'US'],
      `expected items[] sorted descending by score: NO (82) before US (61); got ${itemCodes.join(',')}`);
  });

  it('headlineEligible:true items pass even when overallCoverage is below the legacy GREY_OUT threshold', async () => {
    // Pins the rationale for Greptile P2's "redundant coverage check"
    // simplification. After dropping the legacy
    // `overallCoverage >= GREY_OUT_COVERAGE_THRESHOLD (0.40)` conjunct
    // from `passesHeadlineGate`, the handler trusts the gate alone.
    // The §U7 contract guarantees `headlineEligible: true` already
    // implies `overallCoverage >= 0.65`, so this test really only
    // exercises a corrupted-cache safety property: even if a payload
    // somehow arrives with low coverage AND `headlineEligible: true`,
    // the handler still returns it in items[] (gate is the SoT).
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    const cachedPublic = {
      items: [
        { countryCode: 'NO', overallScore: 82, level: 'high', lowConfidence: false, overallCoverage: 0.30, headlineEligible: true },
      ],
      greyedOut: [],
    };
    redis.set(RESILIENCE_RANKING_CACHE_KEY, JSON.stringify({ ...cachedPublic, _formula: 'd6' }));

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    assert.ok(response.items.some((item) => item.countryCode === 'NO'),
      'gate is the source of truth — coverage alone does not eject an item flagged eligible');
  });
});
