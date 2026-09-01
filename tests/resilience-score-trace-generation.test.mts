import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  RESILIENCE_SCORE_CACHE_PREFIX,
  ensureResilienceScoreCached,
  ensureResilienceScoreGenerationCached,
  getCachedResilienceScores,
  rankingCacheTagMatches,
  scoreTraceCacheKey,
  stampRankingCacheTag,
} from '../server/worldmonitor/resilience/v1/_shared.ts';
import { getResilienceIndicators } from '../server/worldmonitor/resilience/v1/get-resilience-indicators.ts';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';
import { fixtureReader } from './helpers/resilience-fixtures.mts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_URL = process.env.UPSTASH_REDIS_REST_URL;
const ORIGINAL_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ORIGINAL_VERCEL_ENV = process.env.VERCEL_ENV;
const ORIGINAL_FINANCIAL_SYSTEM = process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED;

interface CachedScoreFixture {
  domains: Array<{ dimensions: Array<{ id: string; score: number }> }>;
  _traceGenerationId: string;
  _traceCacheIdentity: string;
  [key: string]: unknown;
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_URL == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_URL;
  if (ORIGINAL_TOKEN == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_TOKEN;
  if (ORIGINAL_VERCEL_ENV == null) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = ORIGINAL_VERCEL_ENV;
  if (ORIGINAL_FINANCIAL_SYSTEM == null) delete process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED;
  else process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED = ORIGINAL_FINANCIAL_SYSTEM;
});

describe('resilience score trace generations', () => {
  test('the indicator endpoint explains the cached public score without rescoring newer seeds', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    process.env.VERCEL_ENV = 'production';
    const redisState = createRedisFetch({
      'seed-meta:resilience:static': { fetchedAt: Date.parse('2026-08-30T00:00:00.000Z') },
    });
    globalThis.fetch = redisState.fetchImpl;

    const score = await ensureResilienceScoreCached('NO', fixtureReader);
    const cachedRaw = redisState.redis.get(`${RESILIENCE_SCORE_CACHE_PREFIX}NO`);
    assert.ok(cachedRaw);
    const cached = JSON.parse(cachedRaw) as Record<string, unknown>;
    assert.equal(typeof cached._traceGenerationId, 'string');
    assert.equal('_traceGenerationId' in score, false, 'private generation metadata must not cross the score API');

    let newerSeedReads = 0;
    const newerReader = async () => {
      newerSeedReads += 1;
      return { changedAfterScorePublication: true };
    };
    const generation = await ensureResilienceScoreGenerationCached('NO', newerReader);
    assert.equal(newerSeedReads, 0, 'a warm linked trace must not rescore newer seeds');

    const scoreDimensions = new Map(
      generation.score.domains.flatMap((domain) => domain.dimensions).map((dimension) => [dimension.id, dimension.score]),
    );
    for (const dimension of generation.trace.snapshot.dimensions) {
      assert.equal(dimension.score, scoreDimensions.get(dimension.id), `${dimension.id} must match the public score generation`);
      const contributionTotal = Number(dimension.indicators
        .reduce((sum, indicator) => sum + indicator.effectiveContribution, 0)
        .toFixed(4));
      if (dimension.active) {
        assert.equal(contributionTotal, dimension.score, `${dimension.id} contributions must reconcile to the public score`);
      }
    }

    const response = await getResilienceIndicators(
      { request: new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-indicators?countryCode=NO') } as never,
      { countryCode: 'NO' },
    );
    for (const dimension of response.dimensions) {
      assert.equal(dimension.score, scoreDimensions.get(dimension.id));
      if (dimension.reconciliationAvailable) {
        assert.equal(dimension.effectiveContributionTotal, dimension.score);
      }
    }
  });

  test('a concurrent score-cache winner is paired with its own trace', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    process.env.VERCEL_ENV = 'production';
    const redisState = createRedisFetch({
      'seed-meta:resilience:static': { fetchedAt: Date.parse('2026-08-30T00:00:00.000Z') },
    });
    globalThis.fetch = redisState.fetchImpl;

    await ensureResilienceScoreCached('NO', fixtureReader);
    const scoreKey = `${RESILIENCE_SCORE_CACHE_PREFIX}NO`;
    const firstCached = JSON.parse(redisState.redis.get(scoreKey)!) as CachedScoreFixture;
    const secondCached = structuredClone(firstCached);
    const dimension = secondCached.domains[0].dimensions[0];
    const winningScore = dimension.score === 17 ? 18 : 17;
    dimension.score = winningScore;
    secondCached._traceGenerationId = 'concurrent-winner';

    const firstTraceKey = scoreTraceCacheKey('NO', String(firstCached._traceGenerationId));
    const secondTrace = structuredClone(JSON.parse(redisState.redis.get(firstTraceKey)!));
    secondTrace.generationId = 'concurrent-winner';
    secondTrace.snapshot.dimensions.find((item: { id: string }) => item.id === dimension.id).score = winningScore;
    redisState.redis.set(
      scoreTraceCacheKey('NO', 'concurrent-winner'),
      JSON.stringify(secondTrace),
    );

    let scoreReads = 0;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (new URL(url).pathname === `/get/${encodeURIComponent(scoreKey)}`) {
        scoreReads += 1;
        if (scoreReads === 2) redisState.redis.set(scoreKey, JSON.stringify(secondCached));
      }
      return redisState.fetchImpl(input, init);
    }) as typeof fetch;

    const generation = await ensureResilienceScoreGenerationCached('NO', fixtureReader);
    const publicDimension = generation.score.domains
      .flatMap((domain) => domain.dimensions)
      .find((item) => item.id === dimension.id);
    const traceDimension = generation.trace.snapshot.dimensions.find((item) => item.id === dimension.id);
    assert.equal(publicDimension?.score, winningScore);
    assert.equal(traceDimension?.score, winningScore);
    assert.equal(generation.trace.generationId, 'concurrent-winner');
  });

  test('finance activation invalidates score and ranking cache identities', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    process.env.VERCEL_ENV = 'production';
    process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED = 'false';
    const redisState = createRedisFetch({
      'seed-meta:resilience:static': { fetchedAt: Date.parse('2026-08-30T00:00:00.000Z') },
    });
    globalThis.fetch = redisState.fetchImpl;

    await ensureResilienceScoreCached('NO', fixtureReader);
    const ranking = stampRankingCacheTag({ items: [] });
    assert.equal((await getCachedResilienceScores(['NO'])).size, 1);
    assert.equal(rankingCacheTagMatches(ranking), true);

    process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED = 'true';
    assert.equal((await getCachedResilienceScores(['NO'])).size, 0);
    assert.equal(rankingCacheTagMatches(ranking), false);
  });
});
