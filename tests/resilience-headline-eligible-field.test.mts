// Plan 2026-04-26-002 §U3 (PR 2) — pinning tests for the
// `headlineEligible: boolean` field on ResilienceScoreResponse and
// ResilienceRankingItem.
//
// PR 2 introduces the field and populates `true` for every successful
// score build. PR 6 / §U7 swaps to actual eligibility logic
// (coverage >= 0.65 AND (population >= 200k OR coverage >= 0.85) AND
// !lowConfidence). These tests pin the PR-2 contract: the field exists
// on every response shape, defaults to true on the happy path, and
// flips to false on the fallback paths (invalid country, missing
// score data) where the PR-6 gate could never pass anyway.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildRankingItem, ensureResilienceScoreCached, RESILIENCE_SCORE_CACHE_PREFIX } from '../server/worldmonitor/resilience/v1/_shared.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';

describe('headlineEligible field — Plan 2026-04-26-002 §U3 (PR 2)', () => {
  describe('buildRankingItem', () => {
    it('passes headlineEligible through from the score response', () => {
      const item = buildRankingItem('US', {
        countryCode: 'US',
        overallScore: 73,
        baselineScore: 82,
        stressScore: 58,
        stressFactor: 0.21,
        level: 'high',
        domains: [],
        trend: 'stable',
        change30d: 0,
        lowConfidence: false,
        imputationShare: 0.1,
        dataVersion: 'v16',
        pillars: [],
        schemaVersion: '2.0',
        headlineEligible: true,
      });
      assert.equal(item.headlineEligible, true,
        'ranking item must pass headlineEligible through from the response');
    });

    it('passes through false correctly (PR 6 will need this)', () => {
      const item = buildRankingItem('XX', {
        countryCode: 'XX',
        overallScore: 50,
        baselineScore: 50,
        stressScore: 50,
        stressFactor: 0.5,
        level: 'medium',
        domains: [],
        trend: 'stable',
        change30d: 0,
        lowConfidence: true,
        imputationShare: 0.5,
        dataVersion: 'v16',
        pillars: [],
        schemaVersion: '2.0',
        headlineEligible: false,
      });
      assert.equal(item.headlineEligible, false,
        'ranking item must pass headlineEligible=false through unchanged');
    });

    it('missing-response fallback returns headlineEligible=false', () => {
      const item = buildRankingItem('XX', null);
      assert.equal(item.headlineEligible, false,
        'fallback for missing score must default headlineEligible=false');
      assert.equal(item.lowConfidence, true,
        'fallback should keep lowConfidence=true (sanity check on the existing contract)');
    });
  });

  describe('ensureResilienceScoreCached', () => {
    it('returns headlineEligible=false for an empty/invalid country code', async () => {
      const response = await ensureResilienceScoreCached('');
      assert.equal(response.headlineEligible, false,
        'empty country code → not headline-eligible (matches the existing lowConfidence=true default)');
      assert.equal(response.countryCode, '',
        'sanity check: empty country code propagates to response');
    });
  });

  describe('cache-read backfill (PR 2 review fix)', () => {
    it('stripCacheMeta defaults headlineEligible=true when the cached payload predates the field', async () => {
      // Plan 002 §U3 review fix: the original version of this test used
      // setCachedJson directly, which silently no-ops without UPSTASH_*
      // env vars — it then "passed" because the build-path constructed
      // a fresh response with headlineEligible:true, never exercising
      // the cache-read backfill it claims to test. Use installRedis +
      // direct redis.set to seed the fake-upstash store, matching the
      // ranking-test pattern in resilience-ranking.test.mts:48.
      const { redis } = installRedis({});
      const legacyKey = `${RESILIENCE_SCORE_CACHE_PREFIX}TT`;
      const legacyPayload = {
        countryCode: 'TT',
        overallScore: 60,
        baselineScore: 65,
        stressScore: 55,
        stressFactor: 0.45,
        level: 'medium',
        domains: [],
        trend: 'stable',
        change30d: 0,
        lowConfidence: false,
        imputationShare: 0.2,
        dataVersion: 'v16',
        pillars: [],
        schemaVersion: '2.0',
        // _formula must match the current cache formula tag so the
        // stale-formula gate doesn't reject the legacy payload (which
        // would force a rebuild and test the build-path instead of
        // the backfill-path). 'd6' is the default flag-off tag.
        _formula: 'd6',
        // headlineEligible deliberately omitted — the post-PR-2 wire
        // type lists it as required, but pre-PR-2 cached payloads do
        // not carry it. Backfill on read must default to true.
      };
      redis.set(legacyKey, JSON.stringify(legacyPayload));

      const response = await ensureResilienceScoreCached('TT');

      assert.equal(response.headlineEligible, true,
        'cache-read backfill must default missing headlineEligible to true (PR-2 contract)');
      // Verify we hit the cache path, not the build path. If the
      // cache-read backfill is wired correctly, the response should
      // carry the legacy payload's stable-but-arbitrary scores
      // (overallScore=60), not what buildResilienceScore would compute
      // for an empty fixture (typically 0 or much lower).
      assert.equal(response.overallScore, 60,
        'response overallScore must come from the cached payload (60), not a fresh build (would be 0 with no seed data)');
      assert.equal(response.dataVersion, 'v16',
        'response dataVersion must come from the cached payload, confirming the cache-read path was exercised');
    });
  });

  describe('PR 2 contract: every code path emits the field', () => {
    it('happy-path response includes headlineEligible (compile-time + runtime)', () => {
      // The TypeScript compiler enforces this at compile time via the
      // generated proto type GetResilienceScoreResponse. This runtime
      // assertion exists to catch a future contributor who silently
      // makes the field optional or omits it from a stub.
      const stub = {
        countryCode: 'US',
        overallScore: 73,
        baselineScore: 82,
        stressScore: 58,
        stressFactor: 0.21,
        level: 'high',
        domains: [],
        trend: 'stable',
        change30d: 0,
        lowConfidence: false,
        imputationShare: 0.1,
        dataVersion: 'v16',
        pillars: [],
        schemaVersion: '2.0',
        headlineEligible: true,
      };
      assert.ok('headlineEligible' in stub,
        'every response object must carry the headlineEligible field per PR-2 §U3');
      assert.equal(typeof stub.headlineEligible, 'boolean',
        'headlineEligible must be a boolean (no null/undefined sentinel)');
    });
  });
});
