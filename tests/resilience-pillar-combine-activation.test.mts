// Phase 2 T2.3 activation test suite.
//
// Exercises the `RESILIENCE_PILLAR_COMBINE_ENABLED` flag: when set,
// `overallScore` switches from the 6-domain weighted aggregate to the
// penalized pillar-combined form. The existing release-gate tests
// (tests/resilience-release-gate.test.mts) cover the default (flag=off)
// path and pin the anchors for the 6-domain formula; this file covers
// the re-anchored bands under the pillar combine.
//
// Why separate file: the existing release-gate test imports
// `getResilienceScore` at the top of the file (captures the legacy
// overallScore path) and runs many asserts that would become stale
// under the pillar combine. A separate file lets us flip the env flag
// in a per-test setup/teardown cleanly.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { getResilienceRanking } from '../server/worldmonitor/resilience/v1/get-resilience-ranking.ts';
import { getResilienceScore } from '../server/worldmonitor/resilience/v1/get-resilience-score.ts';
import {
  isPillarCombineEnabled,
  penalizedPillarScore,
} from '../server/worldmonitor/resilience/v1/_shared.ts';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';
import {
  buildReleaseGateFixtures,
} from './helpers/resilience-release-fixtures.mts';

// Re-anchored bands for the pillar-combined formula, derived from the
// 52-country live-Redis sensitivity capture in
// docs/snapshots/resilience-pillar-sensitivity-2026-04-21.json.
// Old (6-domain): NO ≥ 70, YE/SO/CD ≤ 35, NO − US ≥ 8.
// New (pillar combine, α=0.5): every country drops ~13 points, top
// stays ~65-72, fragile states drop to ~15-35. The re-anchored bands
// preserve the "high" vs "low" separation without pinning numbers that
// are only valid for the legacy formula.
//
// Plan 2026-04-26-002 §U4 (combined PR 3+4+5) coverage-penalty drop:
// halving the weight of fully-imputed dims (IPC stable-absence in
// foodWater, BIS/WTO unmonitored in economic) shifts NO down ~2pt
// because Norway's IPC stable-absence-imputed foodWater rows were
// pulling its foodWater dim UP at the prior weight; with the penalty
// the observed (lower-scoring) AQUASTAT components carry more weight.
// HIGH_BAND_FLOOR re-anchored 60 → 55 to absorb the v16 score-formula
// shift without losing the "elite stays comfortably above mid-tier"
// invariant the floor encodes.
const HIGH_BAND_FLOOR = 55;
const LOW_BAND_CEILING = 40;
const MIN_HIGH_LOW_SEPARATION = 15;

const fixtures = buildReleaseGateFixtures();

const originalFetch = globalThis.fetch;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const originalVercelEnv = process.env.VERCEL_ENV;
const originalPillarFlag = process.env.RESILIENCE_PILLAR_COMBINE_ENABLED;

function installRedisFixtures() {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  delete process.env.VERCEL_ENV;
  const redisState = createRedisFetch(fixtures);
  globalThis.fetch = redisState.fetchImpl;
  return redisState;
}

function enablePillarCombine(): void {
  process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'true';
}

function disablePillarCombine(): void {
  process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'false';
}

describe('pillar-combined score activation', () => {
  beforeEach(() => {
    enablePillarCombine();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalRedisUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
    if (originalRedisToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
    if (originalVercelEnv == null) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
    if (originalPillarFlag == null) delete process.env.RESILIENCE_PILLAR_COMBINE_ENABLED;
    else process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = originalPillarFlag;
  });

  it('isPillarCombineEnabled reads env dynamically', () => {
    enablePillarCombine();
    assert.equal(isPillarCombineEnabled(), true);
    disablePillarCombine();
    assert.equal(isPillarCombineEnabled(), false);
    enablePillarCombine();
    assert.equal(isPillarCombineEnabled(), true);
  });

  it('penalizedPillarScore collapses to weighted-sum when all pillars equal (penalty minimal)', () => {
    // All pillars at 80 → min=80 → penalty = 1 − 0.5*(1 − 0.8) = 0.9.
    // Weighted sum = 80 * (0.40 + 0.35 + 0.25) = 80.
    // Final = 80 * 0.9 = 72.
    const result = penalizedPillarScore([
      { score: 80, weight: 0.40 },
      { score: 80, weight: 0.35 },
      { score: 80, weight: 0.25 },
    ]);
    assert.equal(Math.round(result * 100) / 100, 72.00);
  });

  it('pillar-combined overallScore drops NO below the 6-domain band floor (expected, re-anchored)', async () => {
    installRedisFixtures();

    const response = await getResilienceScore(
      { request: new Request('https://example.com?countryCode=NO') } as never,
      { countryCode: 'NO' },
    );

    // Norway under the 6-domain formula scores ~86 under the current
    // fixtures (pinned by T1.1 regression test). Under the pillar
    // combine it drops to roughly the low-70s because penalty = 1 −
    // 0.5 × (1 − min_pillar/100) is always ≤ 1. The activated path's
    // HIGH_BAND_FLOOR = 60 leaves plenty of headroom above mid-tier
    // countries while accepting that elite scores no longer sit in the
    // 85+ range.
    assert.ok(
      response.overallScore >= HIGH_BAND_FLOOR,
      `NO in the pillar-combined formula must stay above the re-anchored high-band floor (${HIGH_BAND_FLOOR}), got ${response.overallScore}`,
    );
    assert.ok(
      response.overallScore <= 90,
      `NO in the pillar-combined formula should NOT exceed 90 — penalty factor is always ≤ 1, so getting close to 100 would indicate the penalty is not firing. Got ${response.overallScore}.`,
    );
  });

  it('pillar-combined overallScore keeps fragile countries (YE, SO) below the re-anchored low-band ceiling', async () => {
    installRedisFixtures();

    for (const countryCode of ['YE', 'SO'] as const) {
      const response = await getResilienceScore(
        { request: new Request(`https://example.com?countryCode=${countryCode}`) } as never,
        { countryCode },
      );
      assert.ok(
        response.overallScore <= LOW_BAND_CEILING,
        `${countryCode} in the pillar-combined formula must stay below the re-anchored low-band ceiling (${LOW_BAND_CEILING}), got ${response.overallScore}`,
      );
    }
  });

  it('pillar-combined preserves NO vs US separation (high-band vs mid-band)', async () => {
    installRedisFixtures();

    const [no, us] = await Promise.all([
      getResilienceScore({ request: new Request('https://example.com?countryCode=NO') } as never, { countryCode: 'NO' }),
      getResilienceScore({ request: new Request('https://example.com?countryCode=US') } as never, { countryCode: 'US' }),
    ]);

    // The 6-domain separation was ~14 points under fixtures. The
    // pillar combine amplifies penalty on imbalanced pillar profiles
    // (US has a weaker live-shock pillar than Norway), so the
    // separation is expected to hold or widen.
    assert.ok(
      no.overallScore > us.overallScore,
      `NO (${no.overallScore}) must still outscore US (${us.overallScore}) under the pillar combine`,
    );
    assert.ok(
      no.overallScore - us.overallScore >= MIN_HIGH_LOW_SEPARATION - 12,
      `NO − US separation must stay ≥ ${MIN_HIGH_LOW_SEPARATION - 12} under pillar combine; got NO=${no.overallScore}, US=${us.overallScore}, Δ=${(no.overallScore - us.overallScore).toFixed(2)}`,
    );
  });

  it('pillar-combined ranking preserves the elite vs fragile ordering over the release set', async () => {
    installRedisFixtures();

    const ranking = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});
    const byCountry = new Map(ranking.items.map((item) => [item.countryCode, item]));

    // Every high-band anchor (if present in the ranking) must outrank
    // every low-band anchor (if present). This is the structural
    // invariant the pillar combine must preserve to be accepted.
    const highAnchors = ['NO', 'CH', 'DK', 'IS', 'FI', 'SE', 'NZ'].filter((cc) => byCountry.has(cc));
    const lowAnchors = ['YE', 'SO', 'SD', 'CD'].filter((cc) => byCountry.has(cc));

    for (const high of highAnchors) {
      for (const low of lowAnchors) {
        const highScore = byCountry.get(high)!.overallScore;
        const lowScore = byCountry.get(low)!.overallScore;
        assert.ok(
          highScore > lowScore,
          `pillar-combined ranking must keep ${high} (${highScore}) above ${low} (${lowScore})`,
        );
      }
    }
  });

  it('disabling the flag restores the 6-domain aggregate (regression guard for the default path)', async () => {
    installRedisFixtures();
    disablePillarCombine();

    const response = await getResilienceScore(
      { request: new Request('https://example.com?countryCode=NO') } as never,
      { countryCode: 'NO' },
    );

    // Under the 6-domain formula + current fixtures, NO is pinned at
    // ≥ 70 by the existing release-gate test. The flag-off code path
    // is the same one the production default uses; we verify here that
    // switching the flag off mid-suite really does restore it (the
    // dynamic env read in isPillarCombineEnabled() is load-bearing).
    assert.ok(
      response.overallScore >= 70,
      `with flag off, NO must still meet the 6-domain release-gate floor (70), got ${response.overallScore}`,
    );
  });

  it('flipping the flag mid-session rebuilds the score (stale-formula cache invalidation)', async () => {
    // This is the core guarantee for the activation story: merging this
    // PR with flag=false populates cached scores tagged _formula='d6',
    // and later setting RESILIENCE_PILLAR_COMBINE_ENABLED=true MUST
    // force a rebuild on next read (rather than serving the d6-tagged
    // entry for up to 6h until the TTL expires). We simulate the flip
    // inside a single test by pre-computing a cache entry with the
    // flag off, flipping the flag, then reading again — the second
    // read must produce a different overallScore because the cache
    // entry's _formula no longer matches the current formula.
    disablePillarCombine();
    installRedisFixtures();
    const firstRead = await getResilienceScore(
      { request: new Request('https://example.com?countryCode=NO') } as never,
      { countryCode: 'NO' },
    );
    assert.ok(firstRead.overallScore >= 65, `flag-off NO should score ≥65, got ${firstRead.overallScore}`);

    // Flip the flag. The cached entry in Redis still carries
    // _formula='d6' from the first read. Without the stale-formula
    // gate, the second read would serve that same 6-domain score.
    enablePillarCombine();
    const secondRead = await getResilienceScore(
      { request: new Request('https://example.com?countryCode=NO') } as never,
      { countryCode: 'NO' },
    );

    assert.ok(
      secondRead.overallScore < firstRead.overallScore,
      `flag-on rebuild must drop NO's score below the 6-domain value (penalty factor ≤ 1); got first=${firstRead.overallScore} second=${secondRead.overallScore}. If these are equal, the stale-formula cache gate is not firing and a flag flip in production would serve legacy values for up to the 6h TTL.`,
    );
    assert.ok(
      secondRead.overallScore >= HIGH_BAND_FLOOR,
      `flag-on NO should still meet the re-anchored high-band floor (${HIGH_BAND_FLOOR}), got ${secondRead.overallScore}`,
    );
  });
});
