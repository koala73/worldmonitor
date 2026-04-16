import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { getResilienceRanking } from '../server/worldmonitor/resilience/v1/get-resilience-ranking.ts';
import { buildRankingItem, sortRankingItems } from '../server/worldmonitor/resilience/v1/_shared.ts';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { RESILIENCE_FIXTURES } from './helpers/resilience-fixtures.mts';

const originalFetch = globalThis.fetch;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const originalVercelEnv = process.env.VERCEL_ENV;
const originalVercelSha = process.env.VERCEL_GIT_COMMIT_SHA;

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
  // Any test that touched VERCEL_ENV / VERCEL_GIT_COMMIT_SHA must invalidate
  // the memoized key prefix so the next test recomputes it against the
  // restored env — otherwise preview/dev tests would leak a stale prefix.
  __resetKeyPrefixCacheForTests();
});

describe('resilience ranking contracts', () => {
  it('sorts descending by overall score and keeps unscored placeholders at the end', () => {
    const sorted = sortRankingItems([
      { countryCode: 'US', overallScore: 61, level: 'medium', lowConfidence: false },
      { countryCode: 'YE', overallScore: -1, level: 'unknown', lowConfidence: true },
      { countryCode: 'NO', overallScore: 82, level: 'high', lowConfidence: false },
      { countryCode: 'DE', overallScore: -1, level: 'unknown', lowConfidence: true },
      { countryCode: 'JP', overallScore: 61, level: 'medium', lowConfidence: false },
    ]);

    assert.deepEqual(
      sorted.map((item) => [item.countryCode, item.overallScore]),
      [['NO', 82], ['JP', 61], ['US', 61], ['DE', -1], ['YE', -1]],
    );
  });

  it('returns the cached ranking payload unchanged when the ranking cache already exists', async () => {
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    const cached = {
      items: [
        { countryCode: 'NO', overallScore: 82, level: 'high', lowConfidence: false, overallCoverage: 0.95 },
        { countryCode: 'US', overallScore: 61, level: 'medium', lowConfidence: false, overallCoverage: 0.88 },
      ],
      greyedOut: [],
    };
    redis.set('resilience:ranking:v9', JSON.stringify(cached));

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    assert.deepEqual(response, cached);
    assert.equal(redis.has('resilience:score:v9:YE'), false, 'cache hit must not trigger score warmup');
  });

  it('returns all-greyed-out cached payload without rewarming (items=[], greyedOut non-empty)', async () => {
    // Regression for: `cached?.items?.length` was falsy when items=[] even though
    // greyedOut had entries, causing unnecessary rewarming on every request.
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    const cached = {
      items: [],
      greyedOut: [
        { countryCode: 'SS', overallScore: 12, level: 'critical', lowConfidence: true, overallCoverage: 0.15 },
        { countryCode: 'ER', overallScore: 10, level: 'critical', lowConfidence: true, overallCoverage: 0.12 },
      ],
    };
    redis.set('resilience:ranking:v9', JSON.stringify(cached));

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    assert.deepEqual(response, cached);
    assert.equal(redis.has('resilience:score:v9:SS'), false, 'all-greyed-out cache hit must not trigger score warmup');
  });

  it('warms missing scores synchronously and returns complete ranking on first call', async () => {
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    const domainWithCoverage = [{ name: 'political', dimensions: [{ name: 'd1', coverage: 0.9 }] }];
    redis.set('resilience:score:v9:NO', JSON.stringify({
      countryCode: 'NO',
      overallScore: 82,
      level: 'high',
      domains: domainWithCoverage,
      trend: 'stable',
      change30d: 1.2,
      lowConfidence: false,
      imputationShare: 0.05,
    }));
    redis.set('resilience:score:v9:US', JSON.stringify({
      countryCode: 'US',
      overallScore: 61,
      level: 'medium',
      domains: domainWithCoverage,
      trend: 'rising',
      change30d: 4.3,
      lowConfidence: false,
      imputationShare: 0.1,
    }));

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    const totalItems = response.items.length + (response.greyedOut?.length ?? 0);
    assert.equal(totalItems, 3, `expected 3 total items across ranked + greyedOut, got ${totalItems}`);
    assert.ok(redis.has('resilience:score:v9:YE'), 'missing country should be warmed during first call');
    assert.ok(response.items.every((item) => item.overallScore >= 0), 'ranked items should all have computed scores');
    assert.ok(redis.has('resilience:ranking:v9'), 'fully scored ranking should be cached');
  });

  it('sets rankStable=true when interval data exists and width <= 8', async () => {
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    const domainWithCoverage = [{ id: 'political', score: 80, weight: 0.2, dimensions: [{ id: 'd1', score: 80, coverage: 0.9, observedWeight: 1, imputedWeight: 0 }] }];
    redis.set('resilience:score:v9:NO', JSON.stringify({
      countryCode: 'NO', overallScore: 82, level: 'high',
      domains: domainWithCoverage, trend: 'stable', change30d: 1.2,
      lowConfidence: false, imputationShare: 0.05,
    }));
    redis.set('resilience:score:v9:US', JSON.stringify({
      countryCode: 'US', overallScore: 61, level: 'medium',
      domains: domainWithCoverage, trend: 'rising', change30d: 4.3,
      lowConfidence: false, imputationShare: 0.1,
    }));
    redis.set('resilience:intervals:v1:NO', JSON.stringify({ p05: 78, p95: 84 }));
    redis.set('resilience:intervals:v1:US', JSON.stringify({ p05: 50, p95: 72 }));

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    const no = response.items.find((item) => item.countryCode === 'NO');
    const us = response.items.find((item) => item.countryCode === 'US');
    assert.equal(no?.rankStable, true, 'NO interval width 6 should be stable');
    assert.equal(us?.rankStable, false, 'US interval width 22 should be unstable');
  });

  it('caches the ranking when partial coverage meets the 75% threshold (4 countries, 3 scored)', async () => {
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    // Override the static index so we have an un-scoreable extra country (ZZ has
    // no fixture → warm will throw and ZZ stays missing).
    redis.set('resilience:static:index:v1', JSON.stringify({
      countries: ['NO', 'US', 'YE', 'ZZ'],
      recordCount: 4,
      failedDatasets: [],
      seedYear: 2025,
    }));
    const domainWithCoverage = [{ id: 'political', score: 80, weight: 0.2, dimensions: [{ id: 'd1', score: 80, coverage: 0.9, observedWeight: 1, imputedWeight: 0 }] }];
    redis.set('resilience:score:v9:NO', JSON.stringify({
      countryCode: 'NO', overallScore: 82, level: 'high',
      domains: domainWithCoverage, trend: 'stable', change30d: 1.2,
      lowConfidence: false, imputationShare: 0.05,
    }));
    redis.set('resilience:score:v9:US', JSON.stringify({
      countryCode: 'US', overallScore: 61, level: 'medium',
      domains: domainWithCoverage, trend: 'rising', change30d: 4.3,
      lowConfidence: false, imputationShare: 0.1,
    }));

    await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    // 3 of 4 (NO + US pre-cached, YE warmed from fixtures, ZZ can't be warmed)
    // = 75% which meets the threshold — must cache.
    assert.ok(redis.has('resilience:ranking:v9'), 'ranking must be cached at exactly 75% coverage');
    assert.ok(redis.has('seed-meta:resilience:ranking'), 'seed-meta must be written alongside the ranking');
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
    // return null, coverage = 0% < 75%, handler skips the write. Post-fix,
    // the in-memory merge carries both scores, coverage = 100%, write
    // proceeds.
    redis.set('resilience:static:index:v1', JSON.stringify({
      countries: ['NO', 'US'],
      recordCount: 2,
      failedDatasets: [],
      seedYear: 2026,
    }));

    // Stale pipeline-GETs for score keys: pretend Redis hasn't caught up with
    // the /set writes yet. /set calls still mutate the underlying map so the
    // final assertion on ranking presence can verify the SET happened.
    const lagged = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/pipeline') && typeof init?.body === 'string') {
        const commands = JSON.parse(init.body) as Array<Array<string>>;
        const allScoreReads = commands.length > 0 && commands.every(
          (cmd) => cmd[0] === 'GET' && typeof cmd[1] === 'string' && cmd[1].startsWith('resilience:score:v9:'),
        );
        if (allScoreReads) {
          // Simulate visibility lag: pretend no scores are cached yet.
          return new Response(
            JSON.stringify(commands.map(() => ({ result: null }))),
            { status: 200 },
          );
        }
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    globalThis.fetch = lagged;

    await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    assert.ok(redis.has('resilience:ranking:v9'), 'ranking must be published despite pipeline-GET race');
    assert.ok(redis.has('seed-meta:resilience:ranking'), 'seed-meta must be written despite pipeline-GET race');
  });

  it('pipeline SETs apply env prefix so preview warms do not leak into production namespace', async () => {
    // Reviewer regression: passing `raw=true` to runRedisPipeline bypasses the
    // env-based key prefix (preview: / dev:) that isolates preview deploys
    // from production. The symptom is asymmetric: preview reads hit
    // `preview:<sha>:resilience:score:v9:XX` while preview writes landed at
    // raw `resilience:score:v9:XX`, simultaneously (a) missing the preview
    // cache forever and (b) poisoning production's shared cache. Simulate a
    // preview deploy and assert the pipeline SET keys carry the prefix.
    // Shared afterEach snapshots/restores VERCEL_ENV + VERCEL_GIT_COMMIT_SHA
    // and invalidates the memoized key prefix, so this test just mutates them
    // freely without a finally block.
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_GIT_COMMIT_SHA = 'abcdef12ffff';
    __resetKeyPrefixCacheForTests();

    const { redis, fetchImpl } = installRedis({ ...RESILIENCE_FIXTURES }, { keepVercelEnv: true });
    redis.set('resilience:static:index:v1', JSON.stringify({
      countries: ['NO', 'US'],
      recordCount: 2,
      failedDatasets: [],
      seedYear: 2026,
    }));

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
      .filter((cmd) => cmd[0] === 'SET' && typeof cmd[1] === 'string' && (cmd[1] as string).includes('resilience:score:v9:'))
      .map((cmd) => cmd[1] as string);
    assert.ok(scoreSetKeys.length >= 2, `expected at least 2 score SETs, got ${scoreSetKeys.length}`);
    for (const key of scoreSetKeys) {
      assert.ok(
        key.startsWith('preview:abcdef12:'),
        `score SET key must carry preview prefix; got ${key} — writes would poison the production namespace`,
      );
    }
  });

  it('does NOT publish ranking when score-key /set writes silently fail (persistence guard)', async () => {
    // Reviewer regression: trusting in-memory warm results without verifying
    // persistence turned a read-lag fix into a write-failure false positive.
    // With writes broken at the Upstash layer, coverage should NOT pass the
    // gate and neither the ranking nor its meta should be published.
    const { redis, fetchImpl } = installRedis({ ...RESILIENCE_FIXTURES });
    redis.set('resilience:static:index:v1', JSON.stringify({
      countries: ['NO', 'US'],
      recordCount: 2,
      failedDatasets: [],
      seedYear: 2026,
    }));

    // Intercept any pipeline SET to resilience:score:v9:* and reply with
    // non-OK results (persisted but authoritative signal says no). /set and
    // other paths pass through normally so history/interval writes succeed.
    const blockedScoreWrites = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/pipeline') && typeof init?.body === 'string') {
        const commands = JSON.parse(init.body) as Array<Array<string>>;
        const allScoreSets = commands.length > 0 && commands.every(
          (cmd) => cmd[0] === 'SET' && typeof cmd[1] === 'string' && cmd[1].startsWith('resilience:score:v9:'),
        );
        if (allScoreSets) {
          return new Response(
            JSON.stringify(commands.map(() => ({ error: 'simulated write failure' }))),
            { status: 200 },
          );
        }
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    globalThis.fetch = blockedScoreWrites;

    await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    assert.ok(!redis.has('resilience:ranking:v9'), 'ranking must NOT be published when score writes failed');
    assert.ok(!redis.has('seed-meta:resilience:ranking'), 'seed-meta must NOT be written when score writes failed');
  });

  it('defaults rankStable=false when no interval data exists', () => {
    const item = buildRankingItem('ZZ', {
      countryCode: 'ZZ', overallScore: 50, level: 'medium',
      domains: [], trend: 'stable', change30d: 0,
      lowConfidence: false, imputationShare: 0,
      baselineScore: 50, stressScore: 50, stressFactor: 0.5, dataVersion: '',
    });
    assert.equal(item.rankStable, false, 'missing interval should default to unstable');
  });

  it('returns rankStable=false for null response (unscored country)', () => {
    const item = buildRankingItem('XX');
    assert.equal(item.rankStable, false);
  });
});
