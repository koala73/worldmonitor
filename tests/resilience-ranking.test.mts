import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createDomainGateway } from '../server/gateway.ts';
import { mapErrorToResponse } from '../server/error-mapper.ts';
import { ENDPOINT_RATE_POLICIES } from '../server/_shared/rate-limit.ts';
import { getResilienceRanking } from '../server/worldmonitor/resilience/v1/get-resilience-ranking.ts';
import { ApiError } from '../src/generated/server/worldmonitor/resilience/v1/service_server.ts';
import {
  RESILIENCE_INTERVAL_METHODOLOGY,
  RESILIENCE_RANKING_CACHE_KEY,
  RESILIENCE_SCORE_CACHE_PREFIX,
  RESILIENCE_HISTORY_KEY_PREFIX,
  RESILIENCE_INTERVAL_KEY_PREFIX,
  buildRankingItem,
  ensureResilienceScoreCached,
  sortRankingItems,
  warmMissingResilienceScores,
} from '../server/worldmonitor/resilience/v1/_shared.ts';
import { __resetKeyPrefixCacheForTests, compareAndDeleteRedisKey } from '../server/_shared/redis.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { RESILIENCE_FIXTURES } from './helpers/resilience-fixtures.mts';

const originalFetch = globalThis.fetch;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const originalVercelEnv = process.env.VERCEL_ENV;
const originalVercelSha = process.env.VERCEL_GIT_COMMIT_SHA;
const originalPillarCombine = process.env.RESILIENCE_PILLAR_COMBINE_ENABLED;
const originalValidKeys = process.env.WORLDMONITOR_VALID_KEYS;
const originalApiKey = process.env.WORLDMONITOR_API_KEY;
const originalSeedRefreshKey = process.env.WORLDMONITOR_SEED_REFRESH_KEY;
const D6_RANKING_CACHE_TAG = {
  _formula: 'd6',
  _intervalMethodology: RESILIENCE_INTERVAL_METHODOLOGY,
} as const;

const RANKING_META = {
  fetchedAt: '2026-06-01T00:00:00.000Z',
  scored: 2,
  total: 2,
  coverage: 1,
  partial: false,
};

beforeEach(() => {
  // This suite exercises the legacy d6 ranking/cache contract. Production now
  // defaults to pillar-combine; rollback coverage must opt into d6 explicitly.
  process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'false';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRedisUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
  if (originalRedisToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
  if (originalVercelEnv == null) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = originalVercelEnv;
  if (originalVercelSha == null) delete process.env.VERCEL_GIT_COMMIT_SHA;
  else process.env.VERCEL_GIT_COMMIT_SHA = originalVercelSha;
  if (originalPillarCombine == null) delete process.env.RESILIENCE_PILLAR_COMBINE_ENABLED;
  else process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = originalPillarCombine;
  if (originalValidKeys == null) delete process.env.WORLDMONITOR_VALID_KEYS;
  else process.env.WORLDMONITOR_VALID_KEYS = originalValidKeys;
  if (originalApiKey == null) delete process.env.WORLDMONITOR_API_KEY;
  else process.env.WORLDMONITOR_API_KEY = originalApiKey;
  if (originalSeedRefreshKey == null) delete process.env.WORLDMONITOR_SEED_REFRESH_KEY;
  else process.env.WORLDMONITOR_SEED_REFRESH_KEY = originalSeedRefreshKey;
  // Any test that touched VERCEL_ENV / VERCEL_GIT_COMMIT_SHA must invalidate
  // the memoized key prefix so the next test recomputes it against the
  // restored env — otherwise preview/dev tests would leak a stale prefix.
  __resetKeyPrefixCacheForTests();
});

describe('resilience ranking contracts', () => {
  it('sorts descending by overall score and keeps unscored placeholders at the end', () => {
    const sorted = sortRankingItems([
      {
        countryCode: 'US',
        overallScore: 61,
        level: 'medium',
        lowConfidence: false,
      },
      {
        countryCode: 'YE',
        overallScore: -1,
        level: 'unknown',
        lowConfidence: true,
      },
      {
        countryCode: 'NO',
        overallScore: 82,
        level: 'high',
        lowConfidence: false,
      },
      {
        countryCode: 'DE',
        overallScore: -1,
        level: 'unknown',
        lowConfidence: true,
      },
      {
        countryCode: 'JP',
        overallScore: 61,
        level: 'medium',
        lowConfidence: false,
      },
    ]);

    assert.deepEqual(
      sorted.map((item) => [item.countryCode, item.overallScore]),
      [
        ['NO', 82],
        ['JP', 61],
        ['US', 61],
        ['DE', -1],
        ['YE', -1],
      ],
    );
  });

  it('returns the cached ranking payload unchanged when the ranking cache already exists', async () => {
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    // Plan 002 §U3 (PR 2): post-PR-2 cache writes carry headlineEligible.
    // Pre-PR-2 cached payloads (without the field) are exercised by the
    // dedicated backfill test in resilience-headline-eligible-field.test.mts.
    const cachedPublic = {
      items: [
        {
          countryCode: 'NO',
          overallScore: 82,
          level: 'high',
          lowConfidence: false,
          overallCoverage: 0.95,
          headlineEligible: true,
        },
        {
          countryCode: 'US',
          overallScore: 61,
          level: 'medium',
          lowConfidence: false,
          overallCoverage: 0.88,
          headlineEligible: true,
        },
      ],
      greyedOut: [],
      ...RANKING_META,
    };
    // The handler's stale-formula gate rejects untagged ranking entries,
    // so fixtures must carry the `_formula` tag matching the current env
    // (default flag-off ⇒ 'd6'). Writing the tagged shape here mirrors
    // what the handler persists via stampRankingCacheTag.
    redis.set(RESILIENCE_RANKING_CACHE_KEY, JSON.stringify({ ...cachedPublic, ...D6_RANKING_CACHE_TAG }));

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    // The handler strips `_formula` before returning, so response matches
    // the public shape rather than the on-wire cache shape.
    assert.deepEqual(response, cachedPublic);
    assert.equal(redis.has(`${RESILIENCE_SCORE_CACHE_PREFIX}YE`), false, 'cache hit must not trigger score warmup');
  });

  it('backfills headlineEligible on cached items written before PR 2 (review fix)', async () => {
    // Plan 002 §U3+§U7: at v17, missing-from-cache is anomalous (every
    // legitimate writer stamps the field), so the conservative default
    // is `false` — items lacking the field move to greyedOut[] until
    // the next recompute. Test seeds a deliberately field-omitting
    // fixture and asserts both the backfill default AND the gate
    // routing (NO without the field → greyedOut, not items).
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    const legacyCached = {
      items: [
        {
          countryCode: 'NO',
          overallScore: 82,
          level: 'high',
          lowConfidence: false,
          overallCoverage: 0.95,
        },
      ],
      greyedOut: [
        {
          countryCode: 'SS',
          overallScore: 12,
          level: 'critical',
          lowConfidence: true,
          overallCoverage: 0.15,
        },
      ],
      ...RANKING_META,
    };
    redis.set(RESILIENCE_RANKING_CACHE_KEY, JSON.stringify({ ...legacyCached, ...D6_RANKING_CACHE_TAG }));

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    // NO had headlineEligible undefined in the cache; conservative
    // backfill flips it to false, then the gate routes it to greyedOut.
    const noItem = [...response.items, ...response.greyedOut].find((item) => item.countryCode === 'NO');
    const ssItem = [...response.items, ...response.greyedOut].find((item) => item.countryCode === 'SS');
    assert.equal(noItem?.headlineEligible, false, 'v17 cache-read backfill must default missing headlineEligible to false (conservative — gate is SoT)');
    assert.equal(ssItem?.headlineEligible, false, 'v17 cache-read backfill must default missing headlineEligible to false on greyedOut[] too');
    assert.ok(
      response.greyedOut.some((item) => item.countryCode === 'NO'),
      'NO with missing headlineEligible must route to greyedOut[] (not items[]) after conservative backfill + gate filter',
    );
    assert.ok(!response.items.some((item) => item.countryCode === 'NO'), 'NO must NOT appear in items[] — conservative default sends it to greyedOut');
  });

  it('returns all-greyed-out cached payload without rewarming (items=[], greyedOut non-empty)', async () => {
    // Regression for: `cached?.items?.length` was falsy when items=[] even though
    // greyedOut had entries, causing unnecessary rewarming on every request.
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    // Plan 002 §U7 (PR 6 + #3472 follow-up): greyed-out items represent
    // low-coverage countries that wouldn't pass the gate. Post-PR-6, a
    // legitimate writer stamps `headlineEligible: false` on them. The
    // symmetric-gate handler promotes any greyedOut item flagged true
    // back to items[], so the fixture must accurately reflect the
    // post-PR-6 stamping (false for SS, ER) for the deepEqual to hold.
    const cachedPublic = {
      items: [],
      greyedOut: [
        {
          countryCode: 'SS',
          overallScore: 12,
          level: 'critical',
          lowConfidence: true,
          overallCoverage: 0.15,
          headlineEligible: false,
        },
        {
          countryCode: 'ER',
          overallScore: 10,
          level: 'critical',
          lowConfidence: true,
          overallCoverage: 0.12,
          headlineEligible: false,
        },
      ],
      ...RANKING_META,
    };
    redis.set(RESILIENCE_RANKING_CACHE_KEY, JSON.stringify({ ...cachedPublic, ...D6_RANKING_CACHE_TAG }));

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    assert.deepEqual(response, cachedPublic);
    assert.equal(redis.has(`${RESILIENCE_SCORE_CACHE_PREFIX}SS`), false, 'all-greyed-out cache hit must not trigger score warmup');
  });

  it('bulk-read path skips untagged per-country score entries (legacy writes must rebuild on flip)', async () => {
    // Pins the fix for a subtle bug: getCachedResilienceScores used
    // `parsed._formula && parsed._formula !== current` which short-
    // circuits on undefined. An untagged score entry — produced by a
    // pre-PR code path or by an external writer that has not been
    // updated — would therefore be ADMITTED into the ranking under the
    // current formula instead of being treated as stale and re-warmed.
    // On activation day that would mean a mixed-formula ranking for up
    // to the 6h score TTL even though the single-country cache-miss
    // path (ensureResilienceScoreCached) correctly invalidates the
    // same entry. This test writes two per-country score keys, one
    // tagged `_formula: 'd6'` and one untagged, and asserts the
    // ranking warm path runs for the untagged country (meaning the
    // bulk read skipped it).
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    redis.set(
      'resilience:static:index:v1',
      JSON.stringify({
        countries: ['NO', 'US'],
        recordCount: 2,
        failedDatasets: [],
        seedYear: 2026,
      }),
    );

    const domain = [
      {
        id: 'political',
        score: 80,
        weight: 0.2,
        dimensions: [
          {
            id: 'd1',
            score: 80,
            coverage: 0.9,
            observedWeight: 1,
            imputedWeight: 0,
          },
        ],
      },
    ];
    // Tagged entry: served as-is.
    redis.set(
      `${RESILIENCE_SCORE_CACHE_PREFIX}NO`,
      JSON.stringify({
        countryCode: 'NO',
        overallScore: 82,
        level: 'high',
        domains: domain,
        trend: 'stable',
        change30d: 1.2,
        lowConfidence: false,
        imputationShare: 0.05,
        _formula: 'd6',
      }),
    );
    // Untagged entry: must be rejected, ranking warm rebuilds US.
    redis.set(
      `${RESILIENCE_SCORE_CACHE_PREFIX}US`,
      JSON.stringify({
        countryCode: 'US',
        overallScore: 61,
        level: 'medium',
        domains: domain,
        trend: 'rising',
        change30d: 4.3,
        lowConfidence: false,
        imputationShare: 0.1,
        // NOTE: no _formula field.
      }),
    );

    await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    // After the ranking run, the US entry in Redis must now carry
    // `_formula: 'd6'`. If the bulk read had ADMITTED the untagged
    // entry (the pre-fix bug), the warm path for US would not have
    // run, and the stored value would still be untagged.
    const rewrittenRaw = redis.get(`${RESILIENCE_SCORE_CACHE_PREFIX}US`);
    assert.ok(rewrittenRaw, 'US entry must remain in Redis after the ranking run');
    const rewritten = JSON.parse(rewrittenRaw!);
    assert.equal(
      rewritten._formula,
      'd6',
      'untagged US entry must be rejected by the bulk read so the warm path rebuilds it with the current formula tag. If `_formula` is still undefined here, getCachedResilienceScores is admitting untagged entries.',
    );
  });

  it('rejects a stale-formula ranking cache entry and recomputes even without ?refresh=1', async () => {
    // Pins the cross-formula isolation: when the env flag is off (default)
    // and the ranking cache carries _formula='pc' (written during a prior
    // flag-on deploy that has since been rolled back), the handler must
    // NOT serve the stale-formula entry. It must recompute from the
    // per-country scores instead. Without this behavior, a flag
    // rollback would leave the old ranking in place for up to the 12h
    // ranking TTL even though scores were already back on the 6-domain
    // formula.
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    const stale = {
      items: [
        {
          countryCode: 'NO',
          overallScore: 99,
          level: 'high',
          lowConfidence: false,
          overallCoverage: 0.95,
        },
      ],
      greyedOut: [],
      ...RANKING_META,
      _formula: 'pc', // mismatched — current env is flag-off ⇒ current='d6'
      _intervalMethodology: RESILIENCE_INTERVAL_METHODOLOGY,
    };
    redis.set(RESILIENCE_RANKING_CACHE_KEY, JSON.stringify(stale));

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    assert.notDeepEqual(response, { items: stale.items, greyedOut: stale.greyedOut }, 'stale-formula ranking must be rejected, not served');
    // Recompute path warms missing per-country scores, so YE (in
    // RESILIENCE_FIXTURES) must get scored during this call.
    assert.ok(redis.has(`${RESILIENCE_SCORE_CACHE_PREFIX}YE`), 'stale-formula reject must trigger the recompute-and-warm path');
  });

  it('rejects a same-formula ranking cache entry missing interval methodology metadata', async () => {
    // Issue #3967 regression: a same-formula ranking payload can still
    // carry baked rankStable values computed from old v2 interval keys.
    // Current cache hits must therefore prove both the score formula and
    // interval methodology, not just `_formula`.
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    redis.set(
      'resilience:static:index:v1',
      JSON.stringify({
        countries: ['NO', 'US'],
        recordCount: 2,
        failedDatasets: [],
        seedYear: 2026,
      }),
    );
    const domainWithCoverage = [
      {
        id: 'political',
        score: 80,
        weight: 0.2,
        dimensions: [
          {
            id: 'd1',
            score: 80,
            coverage: 0.9,
            observedWeight: 1,
            imputedWeight: 0,
          },
        ],
      },
    ];
    redis.set(
      `${RESILIENCE_SCORE_CACHE_PREFIX}NO`,
      JSON.stringify({
        countryCode: 'NO',
        overallScore: 82,
        level: 'high',
        domains: domainWithCoverage,
        trend: 'stable',
        change30d: 1.2,
        lowConfidence: false,
        imputationShare: 0.05,
        headlineEligible: true,
        _formula: 'd6',
      }),
    );
    redis.set(
      `${RESILIENCE_SCORE_CACHE_PREFIX}US`,
      JSON.stringify({
        countryCode: 'US',
        overallScore: 61,
        level: 'medium',
        domains: domainWithCoverage,
        trend: 'rising',
        change30d: 4.3,
        lowConfidence: false,
        imputationShare: 0.1,
        headlineEligible: true,
        _formula: 'd6',
      }),
    );
    redis.set(
      RESILIENCE_RANKING_CACHE_KEY,
      JSON.stringify({
        items: [
          {
            countryCode: 'NO',
            overallScore: 99,
            level: 'high',
            lowConfidence: false,
            overallCoverage: 0.95,
            headlineEligible: true,
            rankStable: true,
          },
          {
            countryCode: 'US',
            overallScore: 98,
            level: 'high',
            lowConfidence: false,
            overallCoverage: 0.95,
            headlineEligible: true,
            rankStable: true,
          },
        ],
        greyedOut: [],
        ...RANKING_META,
        _formula: 'd6',
        // Deliberately missing _intervalMethodology: old ranking payload.
      }),
    );

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    assert.deepEqual(
      response.items.map((item) => [item.countryCode, item.overallScore, item.rankStable]),
      [
        ['NO', 82, false],
        ['US', 61, false],
      ],
      'same-formula cache without interval methodology must recompute and not preserve baked rankStable',
    );
  });

  it('rejects a same-formula ranking cache entry missing response metadata', async () => {
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    redis.set(
      'resilience:static:index:v1',
      JSON.stringify({
        countries: ['NO', 'US'],
        recordCount: 2,
        failedDatasets: [],
        seedYear: 2026,
      }),
    );
    const domainWithCoverage = [
      {
        id: 'political',
        score: 80,
        weight: 0.2,
        dimensions: [
          {
            id: 'd1',
            score: 80,
            coverage: 0.9,
            observedWeight: 1,
            imputedWeight: 0,
          },
        ],
      },
    ];
    redis.set(
      `${RESILIENCE_SCORE_CACHE_PREFIX}NO`,
      JSON.stringify({
        countryCode: 'NO',
        overallScore: 82,
        level: 'high',
        domains: domainWithCoverage,
        trend: 'stable',
        change30d: 1.2,
        lowConfidence: false,
        imputationShare: 0.05,
        headlineEligible: true,
        _formula: 'd6',
      }),
    );
    redis.set(
      `${RESILIENCE_SCORE_CACHE_PREFIX}US`,
      JSON.stringify({
        countryCode: 'US',
        overallScore: 61,
        level: 'medium',
        domains: domainWithCoverage,
        trend: 'rising',
        change30d: 4.3,
        lowConfidence: false,
        imputationShare: 0.1,
        headlineEligible: true,
        _formula: 'd6',
      }),
    );
    redis.set(
      RESILIENCE_RANKING_CACHE_KEY,
      JSON.stringify({
        items: [
          {
            countryCode: 'NO',
            overallScore: 99,
            level: 'high',
            lowConfidence: false,
            overallCoverage: 0.95,
            headlineEligible: true,
            rankStable: true,
          },
          {
            countryCode: 'US',
            overallScore: 98,
            level: 'high',
            lowConfidence: false,
            overallCoverage: 0.95,
            headlineEligible: true,
            rankStable: true,
          },
        ],
        greyedOut: [],
        ...D6_RANKING_CACHE_TAG,
        // Deliberately missing fetchedAt/scored/total/coverage/partial.
      }),
    );

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    assert.deepEqual(
      response.items.map((item) => [item.countryCode, item.overallScore]),
      [
        ['NO', 82],
        ['US', 61],
      ],
      'same-formula cache without response metadata must recompute so freshness/partial fields are real',
    );
    assert.match(response.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('warms missing scores synchronously and returns complete ranking on first call', async () => {
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    const domainWithCoverage = [{ name: 'political', dimensions: [{ name: 'd1', coverage: 0.9 }] }];
    redis.set(
      `${RESILIENCE_SCORE_CACHE_PREFIX}NO`,
      JSON.stringify({
        countryCode: 'NO',
        overallScore: 82,
        level: 'high',
        domains: domainWithCoverage,
        trend: 'stable',
        change30d: 1.2,
        lowConfidence: false,
        imputationShare: 0.05,
      }),
    );
    redis.set(
      `${RESILIENCE_SCORE_CACHE_PREFIX}US`,
      JSON.stringify({
        countryCode: 'US',
        overallScore: 61,
        level: 'medium',
        domains: domainWithCoverage,
        trend: 'rising',
        change30d: 4.3,
        lowConfidence: false,
        imputationShare: 0.1,
      }),
    );

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    const totalItems = response.items.length + (response.greyedOut?.length ?? 0);
    assert.equal(totalItems, 3, `expected 3 total items across ranked + greyedOut, got ${totalItems}`);
    assert.ok(redis.has(`${RESILIENCE_SCORE_CACHE_PREFIX}YE`), 'missing country should be warmed during first call');
    assert.ok(
      response.items.every((item) => item.overallScore >= 0),
      'ranked items should all have computed scores',
    );
    assert.ok(redis.has(RESILIENCE_RANKING_CACHE_KEY), 'fully scored ranking should be cached');
  });

  it('sets rankStable=true when interval data exists and width <= 8', async () => {
    process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'false';
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    const domainWithCoverage = [
      {
        id: 'political',
        score: 80,
        weight: 0.2,
        dimensions: [
          {
            id: 'd1',
            score: 80,
            coverage: 0.9,
            observedWeight: 1,
            imputedWeight: 0,
          },
        ],
      },
    ];
    redis.set(
      `${RESILIENCE_SCORE_CACHE_PREFIX}NO`,
      JSON.stringify({
        countryCode: 'NO',
        overallScore: 82,
        level: 'high',
        domains: domainWithCoverage,
        trend: 'stable',
        change30d: 1.2,
        lowConfidence: false,
        imputationShare: 0.05,
        headlineEligible: true,
        _formula: 'd6',
      }),
    );
    redis.set(
      `${RESILIENCE_SCORE_CACHE_PREFIX}US`,
      JSON.stringify({
        countryCode: 'US',
        overallScore: 61,
        level: 'medium',
        domains: domainWithCoverage,
        trend: 'rising',
        change30d: 4.3,
        lowConfidence: false,
        imputationShare: 0.1,
        headlineEligible: true,
        _formula: 'd6',
      }),
    );
    redis.set(`${RESILIENCE_INTERVAL_KEY_PREFIX}NO`, JSON.stringify({
      p05: 78,
      p95: 84,
      _formula: 'd6',
      methodology: RESILIENCE_INTERVAL_METHODOLOGY,
    }));
    redis.set(`${RESILIENCE_INTERVAL_KEY_PREFIX}US`, JSON.stringify({
      p05: 50,
      p95: 72,
      _formula: 'd6',
      methodology: RESILIENCE_INTERVAL_METHODOLOGY,
    }));

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    const no = response.items.find((item) => item.countryCode === 'NO');
    const us = response.items.find((item) => item.countryCode === 'US');
    assert.equal(no?.rankStable, true, 'NO interval width 6 should be stable');
    assert.equal(us?.rankStable, false, 'US interval width 22 should be unstable');
  });

  it('sets rankStable=false for stale-formula or untagged interval data', async () => {
    process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'false';
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    const domainWithCoverage = [
      {
        id: 'political',
        score: 80,
        weight: 0.2,
        dimensions: [
          {
            id: 'd1',
            score: 80,
            coverage: 0.9,
            observedWeight: 1,
            imputedWeight: 0,
          },
        ],
      },
    ];
    redis.set(
      `${RESILIENCE_SCORE_CACHE_PREFIX}NO`,
      JSON.stringify({
        countryCode: 'NO',
        overallScore: 82,
        level: 'high',
        domains: domainWithCoverage,
        trend: 'stable',
        change30d: 1.2,
        lowConfidence: false,
        imputationShare: 0.05,
        headlineEligible: true,
        _formula: 'd6',
      }),
    );
    redis.set(
      `${RESILIENCE_SCORE_CACHE_PREFIX}US`,
      JSON.stringify({
        countryCode: 'US',
        overallScore: 61,
        level: 'medium',
        domains: domainWithCoverage,
        trend: 'rising',
        change30d: 4.3,
        lowConfidence: false,
        imputationShare: 0.1,
        headlineEligible: true,
        _formula: 'd6',
      }),
    );
    redis.set(`${RESILIENCE_INTERVAL_KEY_PREFIX}NO`, JSON.stringify({
      p05: 78,
      p95: 84,
      _formula: 'pc',
      methodology: RESILIENCE_INTERVAL_METHODOLOGY,
    }));
    redis.set(`${RESILIENCE_INTERVAL_KEY_PREFIX}US`, JSON.stringify({ p05: 58, p95: 64 }));

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    const no = response.items.find((item) => item.countryCode === 'NO');
    const us = response.items.find((item) => item.countryCode === 'US');
    assert.equal(no?.rankStable, false, 'stale pc interval must be ignored under d6');
    assert.equal(us?.rankStable, false, 'untagged interval must be ignored');
  });

  it('sets rankStable=false for wrong-methodology interval data', async () => {
    process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'false';
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    redis.set(
      'resilience:static:index:v1',
      JSON.stringify({
        countries: ['NO'],
        recordCount: 1,
        failedDatasets: [],
        seedYear: 2026,
      }),
    );
    redis.set(
      `${RESILIENCE_SCORE_CACHE_PREFIX}NO`,
      JSON.stringify({
        countryCode: 'NO',
        overallScore: 82,
        level: 'high',
        domains: [
          {
            id: 'political',
            score: 80,
            weight: 0.2,
            dimensions: [
              {
                id: 'd1',
                score: 80,
                coverage: 0.9,
                observedWeight: 1,
                imputedWeight: 0,
              },
            ],
          },
        ],
        trend: 'stable',
        change30d: 1.2,
        lowConfidence: false,
        imputationShare: 0.05,
        headlineEligible: true,
        _formula: 'd6',
      }),
    );
    redis.set(`${RESILIENCE_INTERVAL_KEY_PREFIX}NO`, JSON.stringify({
      p05: 78,
      p95: 84,
      _formula: 'd6',
      methodology: 'legacy-weight-perturbation-v2',
    }));

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    const no = response.items.find((item) => item.countryCode === 'NO');
    assert.equal(no?.rankStable, false, 'wrong-methodology stable-width interval must be ignored');
  });

  it('does not cache the ranking at 80% coverage', async () => {
    const { redis, fetchImpl } = installRedis(RESILIENCE_FIXTURES);
    redis.set(
      'resilience:static:index:v1',
      JSON.stringify({
        countries: ['NO', 'US', 'YE', 'CA', 'FR', 'DE', 'JP', 'BR', 'IN', 'ZA'],
        recordCount: 10,
        failedDatasets: [],
        seedYear: 2026,
      }),
    );
    const domainWithCoverage = [
      {
        id: 'political',
        score: 80,
        weight: 0.2,
        dimensions: [
          {
            id: 'd1',
            score: 80,
            coverage: 0.9,
            observedWeight: 1,
            imputedWeight: 0,
          },
        ],
      },
    ];
    for (const [index, countryCode] of ['NO', 'US', 'YE', 'CA', 'FR', 'DE', 'JP', 'BR'].entries()) {
      redis.set(
        `${RESILIENCE_SCORE_CACHE_PREFIX}${countryCode}`,
        JSON.stringify({
          countryCode,
          overallScore: 80 - index,
          level: 'high',
          domains: domainWithCoverage,
          trend: 'stable',
          change30d: 0,
          lowConfidence: false,
          imputationShare: 0,
          headlineEligible: true,
          _formula: 'd6',
        }),
      );
    }
    const failScoreSets = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/pipeline') && typeof init?.body === 'string') {
        const commands = JSON.parse(init.body) as Array<Array<string>>;
        const allScoreSets = commands.length > 0 && commands.every((cmd) => cmd[0] === 'SET' && typeof cmd[1] === 'string' && cmd[1].startsWith(RESILIENCE_SCORE_CACHE_PREFIX));
        if (allScoreSets) {
          return new Response(JSON.stringify(commands.map(() => ({ result: null }))), { status: 200 });
        }
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    globalThis.fetch = failScoreSets;

    await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    assert.equal(redis.has(RESILIENCE_RANKING_CACHE_KEY), false, 'ranking must not be cached below 90% coverage');
    assert.equal(redis.has('seed-meta:resilience:ranking'), false, 'seed-meta must not be written below 90% coverage');
  });

  it('does not cache a 90%-94% partial ranking when the gap is a warm persistence failure', async () => {
    const { redis, fetchImpl } = installRedis(RESILIENCE_FIXTURES);
    redis.set(
      'resilience:static:index:v1',
      JSON.stringify({
        countries: ['NO', 'US', 'YE', 'CA', 'FR', 'DE', 'JP', 'BR', 'IN', 'ZA'],
        recordCount: 10,
        failedDatasets: [],
        seedYear: 2026,
      }),
    );
    const domainWithCoverage = [
      {
        id: 'political',
        score: 80,
        weight: 0.2,
        dimensions: [
          {
            id: 'd1',
            score: 80,
            coverage: 0.9,
            observedWeight: 1,
            imputedWeight: 0,
          },
        ],
      },
    ];
    for (const [index, countryCode] of ['NO', 'US', 'YE', 'CA', 'FR', 'DE', 'JP', 'BR', 'IN'].entries()) {
      redis.set(
        `${RESILIENCE_SCORE_CACHE_PREFIX}${countryCode}`,
        JSON.stringify({
          countryCode,
          overallScore: 80 - index,
          level: 'high',
          domains: domainWithCoverage,
          trend: 'stable',
          change30d: 0,
          lowConfidence: false,
          imputationShare: 0,
          headlineEligible: true,
          _formula: 'd6',
        }),
      );
    }
    const failScoreSets = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/pipeline') && typeof init?.body === 'string') {
        const commands = JSON.parse(init.body) as Array<Array<string>>;
        const allScoreSets = commands.length > 0 && commands.every((cmd) => cmd[0] === 'SET' && typeof cmd[1] === 'string' && cmd[1].startsWith(RESILIENCE_SCORE_CACHE_PREFIX));
        if (allScoreSets) {
          return new Response(JSON.stringify(commands.map(() => ({ result: null }))), { status: 200 });
        }
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    globalThis.fetch = failScoreSets;

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    assert.equal(response.scored, 9);
    assert.equal(response.total, 10);
    assert.equal(response.coverage, 0.9);
    assert.equal(response.partial, true);
    assert.match(response.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(!redis.has(RESILIENCE_RANKING_CACHE_KEY), 'warm persistence failures must not be cached as true missing coverage');
    assert.ok(!redis.has('seed-meta:resilience:ranking'), 'warm persistence failures must not write matching seed-meta');
  });

  it('retains 90%-94% partial ranking cache behavior when no warm persistence failure occurs', async () => {
    const { redis, fetchImpl } = installRedis(RESILIENCE_FIXTURES);
    // Synthetic duplicate index entry exercises the partial-cache branch without
    // invoking warmMissingResilienceScores; production seed indexes are unique.
    redis.set('resilience:static:index:v1', JSON.stringify({
      countries: ['NO', 'US', 'YE', 'CA', 'FR', 'DE', 'JP', 'BR', 'IN', 'NO'],
      recordCount: 10,
      failedDatasets: [],
      seedYear: 2026,
    }));
    const domainWithCoverage = [{ id: 'political', score: 80, weight: 0.2, dimensions: [{ id: 'd1', score: 80, coverage: 0.9, observedWeight: 1, imputedWeight: 0 }] }];
    for (const [index, countryCode] of ['NO', 'US', 'YE', 'CA', 'FR', 'DE', 'JP', 'BR', 'IN'].entries()) {
      redis.set(`${RESILIENCE_SCORE_CACHE_PREFIX}${countryCode}`, JSON.stringify({
        countryCode,
        overallScore: 80 - index,
        level: 'high',
        domains: domainWithCoverage,
        trend: 'stable',
        change30d: 0,
        lowConfidence: false,
        imputationShare: 0,
        headlineEligible: true,
        _formula: 'd6',
      }));
    }

    const rankingSetCommands: Array<Array<string>> = [];
    const captureRankingWrites = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/pipeline') && typeof init?.body === 'string') {
        const commands = JSON.parse(init.body) as Array<Array<string>>;
        for (const cmd of commands) {
          if (cmd[0] === 'SET' && cmd[1] === RESILIENCE_RANKING_CACHE_KEY) rankingSetCommands.push(cmd);
        }
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    globalThis.fetch = captureRankingWrites;

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    assert.equal(response.scored, 9);
    assert.equal(response.total, 10);
    assert.equal(response.coverage, 0.9);
    assert.equal(response.partial, true);
    assert.ok(redis.has(RESILIENCE_RANKING_CACHE_KEY), '90% coverage without warm persistence failures must still publish');
    assert.ok(redis.has('seed-meta:resilience:ranking'), '90% coverage without warm persistence failures must write matching seed-meta');
    assert.equal(Number(rankingSetCommands[0]?.[4]), 7200, 'sub-95% ranking publishes must use a 2h TTL');
    const persisted = JSON.parse(redis.get(RESILIENCE_RANKING_CACHE_KEY)!);
    assert.equal(persisted.partial, true);
    assert.equal(persisted.scored, 9);
    assert.equal(persisted.total, 10);
    assert.equal(persisted.coverage, 0.9);
  });

  it('returns explicit partial metadata for an empty scorable universe without caching', async () => {
    const { redis } = installRedis({});
    redis.set(
      'resilience:static:index:v1',
      JSON.stringify({
        countries: [],
        recordCount: 0,
        failedDatasets: [],
        seedYear: 2026,
      }),
    );

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    assert.deepEqual(response.items, []);
    assert.deepEqual(response.greyedOut, []);
    assert.equal(response.scored, 0);
    assert.equal(response.total, 0);
    assert.equal(response.coverage, 0);
    assert.equal(response.partial, true);
    assert.match(response.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(redis.has(RESILIENCE_RANKING_CACHE_KEY), false, 'empty-universe response must not be cached');
  });

  it('publishes ranking via in-memory warm results even when Upstash pipeline-GET lags after /set writes (race regression)', async () => {
    // Simulates the documented Upstash REST write→re-read lag inside a single
    // Vercel invocation: /set calls succeed, but a pipeline GET immediately
    // afterwards can return null for the same keys. Pre-fix, this collapsed
    // coverage to 0 and silently dropped the ranking publish. Post-fix, the
    // handler merges warm results from memory, so coverage reflects reality.
    const { redis, fetchImpl } = installRedis({ ...RESILIENCE_FIXTURES });
    // Override the static index: 2 countries, neither pre-cached — both must
    // be warmed by the handler. Pre-fix, both pipeline-GETs post-warm would
    // return null, coverage = 0% < 90%, handler skips the write. Post-fix,
    // the in-memory merge carries both scores, coverage = 100%, write
    // proceeds.
    redis.set(
      'resilience:static:index:v1',
      JSON.stringify({
        countries: ['NO', 'US'],
        recordCount: 2,
        failedDatasets: [],
        seedYear: 2026,
      }),
    );

    // Stale pipeline-GETs for score keys: pretend Redis hasn't caught up with
    // the /set writes yet. /set calls still mutate the underlying map so the
    // final assertion on ranking presence can verify the SET happened.
    const lagged = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/pipeline') && typeof init?.body === 'string') {
        const commands = JSON.parse(init.body) as Array<Array<string>>;
        const allScoreReads = commands.length > 0 && commands.every((cmd) => cmd[0] === 'GET' && typeof cmd[1] === 'string' && cmd[1].startsWith(RESILIENCE_SCORE_CACHE_PREFIX));
        if (allScoreReads) {
          // Simulate visibility lag: pretend no scores are cached yet.
          return new Response(JSON.stringify(commands.map(() => ({ result: null }))), { status: 200 });
        }
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    globalThis.fetch = lagged;

    await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    assert.ok(redis.has(RESILIENCE_RANKING_CACHE_KEY), 'ranking must be published despite pipeline-GET race');
    assert.ok(redis.has('seed-meta:resilience:ranking'), 'seed-meta must be written despite pipeline-GET race');
  });

  it('parity check: refuses meta write when Upstash returns SET=OK but EXISTS shows keys did not durably persist (2026-04-27 incident)', async () => {
    // Production observation 2026-04-27 (resilienceIntervals): seed-meta said
    // scored=196 while a SCAN of resilience:score:v17:* showed only 2 keys.
    // Mechanism: under saturated edge-runtime conditions, Upstash REST can
    // return result:'OK' for SETs that don't durably persist. The handler's
    // existing persistence guard (`persistResults[i]?.result === 'OK'`)
    // trusts the OK response, so cachedScores.size inflates to N while only
    // a fraction actually landed — meta lies about success.
    //
    // The parity check samples up to 20 score keys via EXISTS BEFORE writing
    // meta. If <50% of sampled keys exist, refuse the meta write so health
    // doesn't lie. Simulate this by making SETs return OK in the warm path
    // but NOT actually mutating the underlying redis map for those keys.
    const { redis, fetchImpl } = installRedis(RESILIENCE_FIXTURES);
    redis.set(
      'resilience:static:index:v1',
      JSON.stringify({
        countries: ['NO', 'US'],
        recordCount: 2,
        failedDatasets: [],
        seedYear: 2026,
      }),
    );

    // Hijack /pipeline so SETs to score:v16:* return OK but don't actually
    // persist (simulating Upstash's optimistic-OK under load). Other commands
    // (GET, EXISTS for the parity check, ranking + meta SETs) pass through.
    const optimisticOk = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/pipeline') && typeof init?.body === 'string') {
        const commands = JSON.parse(init.body) as Array<Array<string>>;
        const allScoreSets = commands.length > 0 && commands.every((cmd) => cmd[0] === 'SET' && typeof cmd[1] === 'string' && cmd[1].startsWith(RESILIENCE_SCORE_CACHE_PREFIX));
        if (allScoreSets) {
          // Return OK without mutating redis — the lying-Upstash scenario.
          return new Response(JSON.stringify(commands.map(() => ({ result: 'OK' }))), { status: 200 });
        }
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    globalThis.fetch = optimisticOk;

    await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    assert.equal(redis.has(RESILIENCE_RANKING_CACHE_KEY), false, 'ranking must NOT be published when score SETs returned OK but did not durably persist');
    assert.equal(redis.has('seed-meta:resilience:ranking'), false, 'seed-meta must NOT be written when parity check fails — that would be a lying meta');
  });

  it('parity check: catches mixed persisted-tail failure (pre-warmed keys exist; new warmed-tail SETs return OK but do not persist)', async () => {
    // Reviewer regression on PR #3458: a naïve `slice(0, 20)` over
    // cachedScores would sample the FIRST 20 entries deterministically.
    // If those first 20 are pre-warmed (already-persisted) score keys
    // and the durability failure only affects the newly warmed tail,
    // the parity check would pass and meta would still be written
    // claiming scored=N — exactly the lying-meta state we're trying to
    // prevent. The fix samples from `warmedCountryCodes` (entries SET
    // by THIS invocation) rather than all of cachedScores; pre-warmed
    // entries came from getCachedResilienceScores so they are
    // tautologically present and verifying them is uninformative.
    //
    // Setup: 4 countries in the static index. Pre-cache 2 of them
    // (NO + US) so they are tautologically present. The other 2
    // (YE + ZZ) get warmed via the SET pipeline, but our mock returns
    // OK without actually persisting them.
    const { redis, fetchImpl } = installRedis(RESILIENCE_FIXTURES);
    redis.set(
      'resilience:static:index:v1',
      JSON.stringify({
        countries: ['NO', 'US', 'YE', 'ZZ'],
        recordCount: 4,
        failedDatasets: [],
        seedYear: 2026,
      }),
    );
    const domainWithCoverage = [
      {
        id: 'political',
        score: 80,
        weight: 0.2,
        dimensions: [
          {
            id: 'd1',
            score: 80,
            coverage: 0.9,
            observedWeight: 1,
            imputedWeight: 0,
          },
        ],
      },
    ];
    // Pre-cache NO + US WITH formula tag so getCachedResilienceScores admits them.
    redis.set(
      `${RESILIENCE_SCORE_CACHE_PREFIX}NO`,
      JSON.stringify({
        countryCode: 'NO',
        overallScore: 82,
        level: 'high',
        domains: domainWithCoverage,
        trend: 'stable',
        change30d: 1.2,
        lowConfidence: false,
        imputationShare: 0.05,
        _formula: 'd6',
      }),
    );
    redis.set(
      `${RESILIENCE_SCORE_CACHE_PREFIX}US`,
      JSON.stringify({
        countryCode: 'US',
        overallScore: 61,
        level: 'medium',
        domains: domainWithCoverage,
        trend: 'rising',
        change30d: 4.3,
        lowConfidence: false,
        imputationShare: 0.1,
        _formula: 'd6',
      }),
    );

    // Hijack /pipeline so SETs to score:v16:* return OK but don't persist —
    // simulating Upstash optimistic-OK on the warmed tail. Other commands
    // (the bulk GET pre-cache check, EXISTS for parity, ranking + meta SETs)
    // pass through to the real fake redis.
    const optimisticOkOnWarmedTail = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/pipeline') && typeof init?.body === 'string') {
        const commands = JSON.parse(init.body) as Array<Array<string>>;
        const allScoreSets = commands.length > 0 && commands.every((cmd) => cmd[0] === 'SET' && typeof cmd[1] === 'string' && cmd[1].startsWith(RESILIENCE_SCORE_CACHE_PREFIX));
        if (allScoreSets) {
          // Return OK without mutating redis — the warmed-tail keys
          // (YE, ZZ) "say" they landed but actually don't.
          return new Response(JSON.stringify(commands.map(() => ({ result: 'OK' }))), { status: 200 });
        }
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    globalThis.fetch = optimisticOkOnWarmedTail;

    await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    // Pre-fix (slice(0, 20) over cachedScores): NO + US would be sampled,
    // both EXIST, parity check passes, meta gets written claiming
    // scored=4 even though YE + ZZ are missing → lying meta.
    //
    // Post-fix (sample from warmedCountryCodes only): YE + ZZ are
    // sampled, neither exists in Redis, parity check fails, meta
    // refused.
    assert.equal(redis.has(RESILIENCE_RANKING_CACHE_KEY), false, 'ranking must NOT be published when warmed-tail keys returned OK but did not persist (mixed-failure mode)');
    assert.equal(
      redis.has('seed-meta:resilience:ranking'),
      false,
      'seed-meta must NOT lie when only the warmed tail failed — sampling must focus on warmed entries, not cachedScores broadly',
    );
  });

  it('pipeline SETs apply env prefix so preview warms do not leak into production namespace', async () => {
    // Reviewer regression: passing `raw=true` to runRedisPipeline bypasses the
    // env-based key prefix (preview: / dev:) that isolates preview deploys
    // from production. The symptom is asymmetric: preview reads hit
    // `preview:<sha>:resilience:score:v17:XX` while preview writes landed at
    // raw `resilience:score:v17:XX`, simultaneously (a) missing the preview
    // cache forever and (b) poisoning production's shared cache. Simulate a
    // preview deploy and assert the pipeline SET keys carry the prefix.
    // Shared afterEach snapshots/restores VERCEL_ENV + VERCEL_GIT_COMMIT_SHA
    // and invalidates the memoized key prefix, so this test just mutates them
    // freely without a finally block.
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_GIT_COMMIT_SHA = 'abcdef12ffff';
    __resetKeyPrefixCacheForTests();

    const { redis, fetchImpl } = installRedis({ ...RESILIENCE_FIXTURES }, { keepVercelEnv: true });
    redis.set(
      'resilience:static:index:v1',
      JSON.stringify({
        countries: ['NO', 'US'],
        recordCount: 2,
        failedDatasets: [],
        seedYear: 2026,
      }),
    );

    const pipelineBodies: Array<Array<Array<unknown>>> = [];
    const capturing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/pipeline') && typeof init?.body === 'string') {
        pipelineBodies.push(JSON.parse(init.body) as Array<Array<unknown>>);
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    globalThis.fetch = capturing;

    await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    const scoreSetKeys = pipelineBodies
      .flat()
      .filter((cmd) => cmd[0] === 'SET' && typeof cmd[1] === 'string' && (cmd[1] as string).includes(RESILIENCE_SCORE_CACHE_PREFIX))
      .map((cmd) => cmd[1] as string);
    assert.ok(scoreSetKeys.length >= 2, `expected at least 2 score SETs, got ${scoreSetKeys.length}`);
    for (const key of scoreSetKeys) {
      assert.ok(key.startsWith('preview:abcdef12:'), `score SET key must carry preview prefix; got ${key} — writes would poison the production namespace`);
    }
  });

  it('?refresh=1 is rejected without the dedicated seed refresh key (Pro bearer/static read keys are NOT enough)', async () => {
    // A full warm is expensive (~222 score computations + chunked pipeline
    // SETs). Allowing any Pro user to loop on ?refresh=1 would DoS Upstash
    // and Edge budget. refresh must be seed-service only — validated against
    // WORLDMONITOR_SEED_REFRESH_KEY, not the normal premium read keys.
    process.env.WORLDMONITOR_VALID_KEYS = 'normal-read-key';
    process.env.WORLDMONITOR_API_KEY = 'legacy-read-key';
    process.env.WORLDMONITOR_SEED_REFRESH_KEY = 'seed-refresh-secret';
    const { redis } = installRedis({ ...RESILIENCE_FIXTURES });
    redis.set(
      'resilience:static:index:v1',
      JSON.stringify({
        countries: ['NO', 'US'],
        recordCount: 2,
        failedDatasets: [],
        seedYear: 2026,
      }),
    );
    // Stale sentinel tagged with the current (flag-off default) formula so
    // these refresh-auth assertions exercise the refresh gate, not formula
    // invalidation. NR is rankable but absent from the static-index fixture.
    const stale = {
      items: [
        {
          countryCode: 'NR',
          overallScore: 1,
          level: 'low',
          lowConfidence: true,
          overallCoverage: 0.5,
          headlineEligible: true,
        },
      ],
      greyedOut: [],
      ...RANKING_META,
      ...D6_RANKING_CACHE_TAG,
    };
    redis.set(RESILIENCE_RANKING_CACHE_KEY, JSON.stringify(stale));

    const assertFallsBackToCache = async (request: Request, message: string) => {
      const response = await getResilienceRanking({ request } as never, {});
      assert.equal(response.items.length, 1);
      assert.equal(response.items[0]?.countryCode, 'NR', message);
    };

    await assertFallsBackToCache(new Request('https://example.com/api/resilience/v1/get-resilience-ranking?refresh=1'), 'refresh=1 without key must fall back to cached response');
    await assertFallsBackToCache(
      new Request('https://example.com/api/resilience/v1/get-resilience-ranking?refresh=1', {
        headers: { Authorization: 'Bearer pro-session-token' },
      }),
      'refresh=1 with Pro bearer must fall back to cached response',
    );
    await assertFallsBackToCache(
      new Request('https://example.com/api/resilience/v1/get-resilience-ranking?refresh=1', {
        headers: { 'X-WorldMonitor-Key': 'normal-read-key' },
      }),
      'refresh=1 with normal static read key must fall back to cached response',
    );
    await assertFallsBackToCache(
      new Request('https://example.com/api/resilience/v1/get-resilience-ranking?refresh=1', {
        headers: { 'X-WorldMonitor-Key': 'legacy-read-key' },
      }),
      'refresh=1 with legacy read key must fall back to cached response',
    );

    // Dedicated seed refresh key → refresh is honored; NR is not in the
    // recomputed response because recompute uses static index ['NO','US'].
    const authed = new Request('https://example.com/api/resilience/v1/get-resilience-ranking?refresh=1', {
      headers: { 'X-WorldMonitor-Key': 'seed-refresh-secret' },
    });
    const authedResp = await getResilienceRanking({ request: authed } as never, {});
    const codes = authedResp.items.concat(authedResp.greyedOut ?? []).map((i) => i.countryCode);
    assert.ok(!codes.includes('NR'), 'refresh=1 with dedicated seed refresh key must recompute');
  });

  it('?refresh=1 bypasses the cache-hit early-return and recomputes the ranking (with valid seed key)', async () => {
    // Seeder uses ?refresh=1 on the unconditional per-cron rebuild. Without
    // this bypass, the seeder would have to DEL the ranking before rebuild
    // (the old flow) — a failed rebuild would then leave the key absent
    // instead of stale-but-present.
    process.env.WORLDMONITOR_SEED_REFRESH_KEY = 'seed-refresh-secret';
    const { redis } = installRedis({ ...RESILIENCE_FIXTURES });
    redis.set(
      'resilience:static:index:v1',
      JSON.stringify({
        countries: ['NO', 'US'],
        recordCount: 2,
        failedDatasets: [],
        seedYear: 2026,
      }),
    );
    // Seed a pre-existing ranking so the cache-hit early-return would
    // normally fire. ?refresh=1 (with valid seed key) must ignore it.
    const stale = {
      items: [
        {
          countryCode: 'ZZ',
          overallScore: 1,
          level: 'low',
          lowConfidence: true,
          overallCoverage: 0.5,
        },
      ],
      greyedOut: [],
      ...RANKING_META,
      ...D6_RANKING_CACHE_TAG,
    };
    redis.set(RESILIENCE_RANKING_CACHE_KEY, JSON.stringify(stale));

    const request = new Request('https://example.com/api/resilience/v1/get-resilience-ranking?refresh=1', {
      headers: { 'X-WorldMonitor-Key': 'seed-refresh-secret' },
    });
    const response = await getResilienceRanking({ request } as never, {});

    const returnedCountries = response.items.concat(response.greyedOut ?? []).map((i) => i.countryCode);
    assert.ok(!returnedCountries.includes('ZZ'), 'refresh=1 must recompute, not return the stale cached ZZ entry');
    assert.ok(returnedCountries.includes('NO') || returnedCountries.includes('US'), 'recomputed ranking must reflect the current static index');
  });

  it('?refresh=1 seed-secret recomputes release the Redis refresh slot by token', async () => {
    process.env.WORLDMONITOR_SEED_REFRESH_KEY = 'seed-refresh-secret';
    const { redis } = installRedis({ ...RESILIENCE_FIXTURES });
    redis.set(
      'resilience:static:index:v1',
      JSON.stringify({
        countries: ['NO', 'US'],
        recordCount: 2,
        failedDatasets: [],
        seedYear: 2026,
      }),
    );

    const request = () =>
      new Request('https://example.com/api/resilience/v1/get-resilience-ranking?refresh=1', {
        headers: { 'X-WorldMonitor-Key': 'seed-refresh-secret' },
      });
    const first = await getResilienceRanking({ request: request() } as never, {});
    const firstCodes = first.items.concat(first.greyedOut ?? []).map((i) => i.countryCode);
    assert.ok(firstCodes.includes('NO') || firstCodes.includes('US'), 'first seed refresh must recompute');
    assert.equal(redis.has('resilience:ranking:refresh-lock:v1'), false, 'refresh slot must be released in finally after recompute');

    const stale = {
      items: [
        {
          countryCode: 'NR',
          overallScore: 1,
          level: 'low',
          lowConfidence: true,
          overallCoverage: 0.5,
          headlineEligible: true,
        },
      ],
      greyedOut: [],
      ...RANKING_META,
      ...D6_RANKING_CACHE_TAG,
    };
    redis.set(RESILIENCE_RANKING_CACHE_KEY, JSON.stringify(stale));
    const second = await getResilienceRanking({ request: request() } as never, {});
    const secondCodes = second.items.concat(second.greyedOut ?? []).map((i) => i.countryCode);
    assert.ok(!secondCodes.includes('NR'), 'released refresh slot must allow a later authorized refresh to recompute');
    assert.equal(redis.has('resilience:ranking:refresh-lock:v1'), false, 'second refresh must also release the slot');
  });

  it('Redis lock release uses token compare-and-delete semantics', async () => {
    const { redis } = installRedis({});
    redis.set('resilience:ranking:refresh-lock:v1', 'owner-a');

    assert.equal(await compareAndDeleteRedisKey('resilience:ranking:refresh-lock:v1', 'owner-b'), false);
    assert.equal(redis.get('resilience:ranking:refresh-lock:v1'), 'owner-a', 'wrong token must not delete another owner lock');
    assert.equal(await compareAndDeleteRedisKey('resilience:ranking:refresh-lock:v1', 'owner-a'), true);
    assert.equal(redis.has('resilience:ranking:refresh-lock:v1'), false, 'matching token must delete the lock');
  });

  it('?refresh=1 seed-secret slot denial returns explicit 429 instead of empty 200 on cold cache', async () => {
    process.env.WORLDMONITOR_SEED_REFRESH_KEY = 'seed-refresh-secret';
    const { redis } = installRedis({ ...RESILIENCE_FIXTURES });
    redis.set('resilience:ranking:refresh-lock:v1', 'held');

    await assert.rejects(
      () =>
        getResilienceRanking(
          {
            request: new Request('https://example.com/api/resilience/v1/get-resilience-ranking?refresh=1', {
              headers: { 'X-WorldMonitor-Key': 'seed-refresh-secret' },
            }),
          } as never,
          {},
        ),
      (err) =>
        err instanceof ApiError && err.statusCode === 429 && (err as ApiError & { retryAfter?: number }).retryAfter === 30 && /refresh already in progress/.test(err.message),
    );
  });

  it('ApiError retryAfter maps to a Retry-After header for generated gateway responses', async () => {
    const err = new ApiError(429, 'Resilience ranking refresh already in progress', '');
    (err as ApiError & { retryAfter: number }).retryAfter = 30;
    const response = mapErrorToResponse(err, new Request('https://example.com'));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('Retry-After'), '30');
    assert.deepEqual(await response.json(), {
      message: 'Resilience ranking refresh already in progress',
      retryAfter: 30,
    });
  });

  it('normal cache-miss warm path returns explicit temporary unavailable when the warm lock is held and no cache exists', async () => {
    const { redis } = installRedis({ ...RESILIENCE_FIXTURES });
    redis.set(
      'resilience:static:index:v1',
      JSON.stringify({
        countries: ['NO', 'US'],
        recordCount: 2,
        failedDatasets: [],
        seedYear: 2026,
      }),
    );
    redis.set('resilience:ranking:warm-lock:v1', 'held');

    await assert.rejects(
      () =>
        getResilienceRanking(
          {
            request: new Request('https://example.com/api/resilience/v1/get-resilience-ranking'),
          } as never,
          {},
        ),
      (err) => err instanceof ApiError && err.statusCode === 503 && (err as ApiError & { retryAfter?: number }).retryAfter === 60 && /temporarily unavailable/.test(err.message),
    );
    assert.equal(redis.has(`${RESILIENCE_SCORE_CACHE_PREFIX}NO`), false, 'lock contention must not start a duplicate warm');
    assert.equal(redis.has(`${RESILIENCE_SCORE_CACHE_PREFIX}US`), false, 'lock contention must not start a duplicate warm');
  });

  it('normal cache-miss warm path does not serve a stale-tag cache entry during lock contention', async () => {
    const { redis } = installRedis({ ...RESILIENCE_FIXTURES });
    redis.set('resilience:ranking:warm-lock:v1', 'held');
    redis.set(
      RESILIENCE_RANKING_CACHE_KEY,
      JSON.stringify({
        items: [
          {
            countryCode: 'NO',
            overallScore: 82,
            level: 'high',
            lowConfidence: false,
            overallCoverage: 0.95,
            headlineEligible: true,
          },
        ],
        greyedOut: [],
        ...RANKING_META,
        _formula: 'stale-formula',
        _intervalMethodology: RESILIENCE_INTERVAL_METHODOLOGY,
      }),
    );

    await assert.rejects(
      () =>
        getResilienceRanking(
          {
            request: new Request('https://example.com/api/resilience/v1/get-resilience-ranking'),
          } as never,
          {},
        ),
      (err) => err instanceof ApiError && err.statusCode === 503,
    );
  });

  it('ApiError retryAfter maps temporary-unavailable warm contention to explicit 503 + Retry-After', async () => {
    const err = new ApiError(503, 'Resilience ranking temporarily unavailable while cache warm is in progress', '');
    (err as ApiError & { retryAfter: number }).retryAfter = 60;
    (err as ApiError & { exposeMessage: boolean }).exposeMessage = true;
    const response = mapErrorToResponse(err, new Request('https://example.com'));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Retry-After'), '60');
    assert.deepEqual(await response.json(), {
      message: 'Resilience ranking temporarily unavailable while cache warm is in progress',
      retryAfter: 60,
    });
  });

  it('ApiError retryAfter does not expose generic 503 messages without explicit opt-in', async () => {
    const err = new ApiError(503, 'Internal upstream URL https://secret.example failed', '');
    (err as ApiError & { retryAfter: number }).retryAfter = 60;
    const response = mapErrorToResponse(err, new Request('https://example.com'));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Retry-After'), '60');
    assert.deepEqual(await response.json(), {
      message: 'Internal server error',
      retryAfter: 60,
    });
  });

  it('gateway has a dedicated low-RPM endpoint policy for resilience ranking', () => {
    assert.deepEqual(ENDPOINT_RATE_POLICIES['/api/resilience/v1/get-resilience-ranking'], { limit: 30, window: '60 s' });
  });

  it('gateway seed-refresh bypass is scoped to ranking ?refresh=1 only', async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'normal-read-key';
    process.env.WORLDMONITOR_SEED_REFRESH_KEY = 'seed-refresh-secret';
    installRedis({});
    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/resilience/v1/get-resilience-ranking',
        handler: async (request) =>
          new Response(
            JSON.stringify({
              key: request.headers.get('X-WorldMonitor-Key'),
              refresh: new URL(request.url).searchParams.get('refresh'),
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      },
      {
        method: 'GET',
        path: '/api/resilience/v1/get-resilience-score',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
    ]);

    const seedRefresh = await handler(
      new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-ranking?refresh=1', {
        headers: { 'X-WorldMonitor-Key': 'seed-refresh-secret' },
      }),
    );
    assert.equal(seedRefresh.status, 200);
    assert.deepEqual(await seedRefresh.json(), {
      key: 'seed-refresh-secret',
      refresh: '1',
    });

    const seedWithoutRefresh = await handler(
      new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-ranking', {
        headers: { 'X-WorldMonitor-Key': 'seed-refresh-secret' },
      }),
    );
    assert.equal(seedWithoutRefresh.status, 401, 'seed secret must not bypass normal ranking-read auth');

    const seedWrongPath = await handler(
      new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-score?countryCode=US&refresh=1', {
        headers: { 'X-WorldMonitor-Key': 'seed-refresh-secret' },
      }),
    );
    assert.equal(seedWrongPath.status, 401, 'seed secret must not bypass auth on other resilience paths');

    const normalReadRefresh = await handler(
      new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-ranking?refresh=1', {
        headers: { 'X-WorldMonitor-Key': 'normal-read-key' },
      }),
    );
    assert.equal(normalReadRefresh.status, 200, 'normal read keys must keep existing ranking-read access');
    assert.deepEqual(await normalReadRefresh.json(), {
      key: 'normal-read-key',
      refresh: '1',
    });
  });

  it('warms via batched pipeline SETs (avoids 600KB single-pipeline timeout)', async () => {
    // The 5s pipeline timeout would fail on a 222-SET pipeline (~600KB body)
    // and the persistence guard would correctly return empty → no ranking.
    // Splitting into smaller batches keeps each pipeline well under timeout.
    // We assert the SET path uses MULTIPLE pipelines, not one giant one.
    const { redis, fetchImpl } = installRedis({ ...RESILIENCE_FIXTURES });
    redis.set(
      'resilience:static:index:v1',
      JSON.stringify({
        countries: ['NO', 'US', 'YE'],
        recordCount: 3,
        failedDatasets: [],
        seedYear: 2026,
      }),
    );

    const setPipelineSizes: number[] = [];
    const observing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/pipeline') && typeof init?.body === 'string') {
        const commands = JSON.parse(init.body) as Array<Array<string>>;
        const isAllScoreSets =
          commands.length > 0 && commands.every((cmd) => cmd[0] === 'SET' && typeof cmd[1] === 'string' && (cmd[1] as string).includes(RESILIENCE_SCORE_CACHE_PREFIX));
        if (isAllScoreSets) setPipelineSizes.push(commands.length);
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    globalThis.fetch = observing;

    await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    // For 3 countries the batch fits in one pipeline. The contract under test
    // is that no single pipeline exceeds the SET_BATCH bound (30) — would-be
    // 222-element pipelines must be split into multiple smaller ones.
    assert.ok(setPipelineSizes.length > 0, 'warm must issue at least one score-SET pipeline');
    for (const size of setPipelineSizes) {
      assert.ok(size <= 30, `each score-SET pipeline must be ≤30 commands; saw ${size}`);
    }
  });

  it('ensureResilienceScoreCached returns the missing-cache fallback for cachedFetchJson null sentinel hits', async () => {
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    redis.set(`${RESILIENCE_SCORE_CACHE_PREFIX}NO`, JSON.stringify('__WM_NEG__'));

    const response = await ensureResilienceScoreCached('NO');

    assert.equal(response.countryCode, 'NO');
    assert.equal(response.overallScore, 0);
    assert.equal(response.level, 'unknown');
    assert.equal(response.lowConfidence, true);
    assert.equal(response.schemaVersion, '1.0');
    assert.equal(response.headlineEligible, false);
  });

  it('warmMissingResilienceScores logs and isolates compute failures', async () => {
    installRedis({});
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const domainWithCoverage = [
        {
          id: 'political',
          score: 80,
          weight: 0.2,
          dimensions: [
            {
              id: 'd1',
              score: 80,
              coverage: 0.9,
              observedWeight: 1,
              imputedWeight: 0,
            },
          ],
        },
      ];
      const warmed = await warmMissingResilienceScores(['NO', 'US'], async (countryCode) => {
        if (countryCode === 'US') throw new Error('synthetic compute failure');
        return {
          countryCode,
          overallScore: 80,
          baselineScore: 80,
          stressScore: 80,
          stressFactor: 0.2,
          level: 'high',
          domains: domainWithCoverage,
          trend: 'stable',
          change30d: 0,
          lowConfidence: false,
          imputationShare: 0,
          dataVersion: '2026-06-01',
          pillars: [],
          schemaVersion: '1.0',
          headlineEligible: true,
        };
      });

      assert.equal(warmed.has('NO'), true, 'successful country must still warm');
      assert.equal(warmed.has('US'), false, 'failed country must be isolated');
      assert.ok(
        warnings.some((line) => line.includes('warm compute failed for 1/2 countries: US(synthetic compute failure)')),
        `expected compute-failure warning, got ${warnings.join('\n')}`,
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  it('warmMissingResilienceScores retries one failed score SET batch before marking persistence failed', async () => {
    const { redis, fetchImpl } = installRedis({});
    let scoreSetPipelineCalls = 0;
    const interceptFirstScoreSetBatchFailure = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/pipeline') && typeof init?.body === 'string') {
        const commands = JSON.parse(init.body) as Array<Array<string>>;
        const allScoreSets = commands.length > 0 && commands.every(
          (cmd) => cmd[0] === 'SET' && typeof cmd[1] === 'string' && cmd[1].startsWith(RESILIENCE_SCORE_CACHE_PREFIX),
        );
        if (allScoreSets) {
          scoreSetPipelineCalls++;
          if (scoreSetPipelineCalls === 1) {
            return new Response(JSON.stringify([]), { status: 200 });
          }
        }
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    globalThis.fetch = interceptFirstScoreSetBatchFailure;

    const domainWithCoverage = [{ id: 'political', score: 80, weight: 0.2, dimensions: [{ id: 'd1', score: 80, coverage: 0.9, observedWeight: 1, imputedWeight: 0 }] }];
    const warmed = await warmMissingResilienceScores(['NO'], async (countryCode) => ({
      countryCode,
      overallScore: 80,
      baselineScore: 80,
      stressScore: 80,
      stressFactor: 0.2,
      level: 'high',
      domains: domainWithCoverage,
      trend: 'stable',
      change30d: 0,
      lowConfidence: false,
      imputationShare: 0,
      dataVersion: '2026-06-01',
      pillars: [],
      schemaVersion: '1.0',
      headlineEligible: true,
    }));

    assert.equal(scoreSetPipelineCalls, 2, 'failed SET batch must be retried once');
    assert.equal(warmed.has('NO'), true, 'retry success must still return the warmed score');
    assert.deepEqual(warmed.failures, [], 'successful retry must not be reported as a warm failure');
    assert.ok(redis.has(`${RESILIENCE_SCORE_CACHE_PREFIX}NO`), 'retry success must persist the score cache key');
  });

  it('warmMissingResilienceScores preserves initial per-command SET successes when retry transport fails', async () => {
    const { redis, fetchImpl } = installRedis({});
    let scoreSetPipelineCalls = 0;
    const interceptPartialThenTransportFailure = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/pipeline') && typeof init?.body === 'string') {
        const commands = JSON.parse(init.body) as Array<Array<string>>;
        const allScoreSets = commands.length > 0 && commands.every(
          (cmd) => cmd[0] === 'SET' && typeof cmd[1] === 'string' && cmd[1].startsWith(RESILIENCE_SCORE_CACHE_PREFIX),
        );
        if (allScoreSets) {
          scoreSetPipelineCalls++;
          if (scoreSetPipelineCalls === 1) {
            redis.set(String(commands[0]?.[1] ?? ''), String(commands[0]?.[2] ?? ''));
            return new Response(JSON.stringify([{ result: 'OK' }, { result: null }]), { status: 200 });
          }
          return new Response(JSON.stringify([]), { status: 200 });
        }
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    globalThis.fetch = interceptPartialThenTransportFailure;

    const domainWithCoverage = [{ id: 'political', score: 80, weight: 0.2, dimensions: [{ id: 'd1', score: 80, coverage: 0.9, observedWeight: 1, imputedWeight: 0 }] }];
    const warmed = await warmMissingResilienceScores(['NO', 'US'], async (countryCode) => ({
      countryCode,
      overallScore: countryCode === 'NO' ? 80 : 79,
      baselineScore: 80,
      stressScore: 80,
      stressFactor: 0.2,
      level: 'high',
      domains: domainWithCoverage,
      trend: 'stable',
      change30d: 0,
      lowConfidence: false,
      imputationShare: 0,
      dataVersion: '2026-06-01',
      pillars: [],
      schemaVersion: '1.0',
      headlineEligible: true,
    }));

    assert.equal(scoreSetPipelineCalls, 2, 'partial batch failure must still trigger one retry');
    assert.equal(warmed.has('NO'), true, 'initial per-command OK must survive retry transport failure');
    assert.equal(warmed.has('US'), false, 'command without OK proof must remain failed');
    assert.equal(warmed.failedCountryCodes.has('US'), true);
    assert.deepEqual(warmed.failures, [{
      countryCode: 'US',
      stage: 'persist',
      reason: 'SET returned null',
      retried: true,
    }]);
  });

  it('warmMissingResilienceScores reports transport persistence failures separately from true missing scores', async () => {
    const { fetchImpl } = installRedis({});
    let scoreSetPipelineCalls = 0;
    const failScoreSetBatches = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/pipeline') && typeof init?.body === 'string') {
        const commands = JSON.parse(init.body) as Array<Array<string>>;
        const allScoreSets = commands.length > 0 && commands.every(
          (cmd) => cmd[0] === 'SET' && typeof cmd[1] === 'string' && cmd[1].startsWith(RESILIENCE_SCORE_CACHE_PREFIX),
        );
        if (allScoreSets) {
          scoreSetPipelineCalls++;
          return new Response(JSON.stringify([]), { status: 200 });
        }
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    globalThis.fetch = failScoreSetBatches;

    const domainWithCoverage = [{ id: 'political', score: 80, weight: 0.2, dimensions: [{ id: 'd1', score: 80, coverage: 0.9, observedWeight: 1, imputedWeight: 0 }] }];
    const warmed = await warmMissingResilienceScores(['NO'], async (countryCode) => ({
      countryCode,
      overallScore: 80,
      baselineScore: 80,
      stressScore: 80,
      stressFactor: 0.2,
      level: 'high',
      domains: domainWithCoverage,
      trend: 'stable',
      change30d: 0,
      lowConfidence: false,
      imputationShare: 0,
      dataVersion: '2026-06-01',
      pillars: [],
      schemaVersion: '1.0',
      headlineEligible: true,
    }));

    assert.equal(scoreSetPipelineCalls, 2, 'permanent transport failure should still retry only once');
    assert.equal(warmed.has('NO'), false, 'no persistence proof means no warmed score claim');
    assert.equal(warmed.failedCountryCodes.has('NO'), true);
    assert.deepEqual(warmed.failures, [{
      countryCode: 'NO',
      stage: 'persist',
      reason: 'pipeline transport failure',
      retried: true,
    }]);
  });

  it('does NOT publish ranking when score-key /set writes silently fail (persistence guard)', async () => {
    // Reviewer regression: trusting in-memory warm results without verifying
    // persistence turned a read-lag fix into a write-failure false positive.
    // With writes broken at the Upstash layer, coverage should NOT pass the
    // gate and neither the ranking nor its meta should be published.
    const { redis, fetchImpl } = installRedis({ ...RESILIENCE_FIXTURES });
    redis.set(
      'resilience:static:index:v1',
      JSON.stringify({
        countries: ['NO', 'US'],
        recordCount: 2,
        failedDatasets: [],
        seedYear: 2026,
      }),
    );

    // Intercept any pipeline SET to resilience:score:v17:* and reply with
    // non-OK results (persisted but authoritative signal says no). /set and
    // other paths pass through normally so history/interval writes succeed.
    const blockedScoreWrites = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/pipeline') && typeof init?.body === 'string') {
        const commands = JSON.parse(init.body) as Array<Array<string>>;
        const allScoreSets = commands.length > 0 && commands.every((cmd) => cmd[0] === 'SET' && typeof cmd[1] === 'string' && cmd[1].startsWith(RESILIENCE_SCORE_CACHE_PREFIX));
        if (allScoreSets) {
          return new Response(JSON.stringify(commands.map(() => ({ error: 'simulated write failure' }))), { status: 200 });
        }
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    globalThis.fetch = blockedScoreWrites;

    await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    assert.ok(!redis.has(RESILIENCE_RANKING_CACHE_KEY), 'ranking must NOT be published when score writes failed');
    assert.ok(!redis.has('seed-meta:resilience:ranking'), 'seed-meta must NOT be written when score writes failed');
  });

  it('defaults rankStable=false when no interval data exists', () => {
    const item = buildRankingItem('ZZ', {
      countryCode: 'ZZ',
      overallScore: 50,
      level: 'medium',
      domains: [],
      trend: 'stable',
      change30d: 0,
      lowConfidence: false,
      imputationShare: 0,
      baselineScore: 50,
      stressScore: 50,
      stressFactor: 0.5,
      dataVersion: '',
    });
    assert.equal(item.rankStable, false, 'missing interval should default to unstable');
  });

  it('returns rankStable=false for null response (unscored country)', () => {
    const item = buildRankingItem('XX');
    assert.equal(item.rankStable, false);
  });
});
