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
    const cachedPublic = {
      items: [
        { countryCode: 'NO', overallScore: 82, level: 'high', lowConfidence: false, overallCoverage: 0.95 },
        { countryCode: 'US', overallScore: 61, level: 'medium', lowConfidence: false, overallCoverage: 0.88 },
      ],
      greyedOut: [],
    };
    // The handler's stale-formula gate rejects untagged ranking entries,
    // so fixtures must carry the `_formula` tag matching the current env
    // (default flag-off ⇒ 'd6'). Writing the tagged shape here mirrors
    // what the handler persists via stampRankingCacheTag.
    redis.set('resilience:ranking:v14', JSON.stringify({ ...cachedPublic, _formula: 'd6' }));

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    // The handler strips `_formula` before returning, so response matches
    // the public shape rather than the on-wire cache shape.
    assert.deepEqual(response, cachedPublic);
    assert.equal(redis.has('resilience:score:v14:YE'), false, 'cache hit must not trigger score warmup');
  });

  it('returns all-greyed-out cached payload without rewarming (items=[], greyedOut non-empty)', async () => {
    // Regression for: `cached?.items?.length` was falsy when items=[] even though
    // greyedOut had entries, causing unnecessary rewarming on every request.
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    const cachedPublic = {
      items: [],
      greyedOut: [
        { countryCode: 'SS', overallScore: 12, level: 'critical', lowConfidence: true, overallCoverage: 0.15 },
        { countryCode: 'ER', overallScore: 10, level: 'critical', lowConfidence: true, overallCoverage: 0.12 },
      ],
    };
    redis.set('resilience:ranking:v14', JSON.stringify({ ...cachedPublic, _formula: 'd6' }));

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    assert.deepEqual(response, cachedPublic);
    assert.equal(redis.has('resilience:score:v14:SS'), false, 'all-greyed-out cache hit must not trigger score warmup');
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
    redis.set('resilience:static:index:v1', JSON.stringify({
      countries: ['NO', 'US'],
      recordCount: 2,
      failedDatasets: [],
      seedYear: 2026,
    }));

    const domain = [{ id: 'political', score: 80, weight: 0.2, dimensions: [{ id: 'd1', score: 80, coverage: 0.9, observedWeight: 1, imputedWeight: 0 }] }];
    // Tagged entry: served as-is.
    redis.set('resilience:score:v14:NO', JSON.stringify({
      countryCode: 'NO', overallScore: 82, level: 'high',
      domains: domain, trend: 'stable', change30d: 1.2,
      lowConfidence: false, imputationShare: 0.05, _formula: 'd6',
    }));
    // Untagged entry: must be rejected, ranking warm rebuilds US.
    redis.set('resilience:score:v14:US', JSON.stringify({
      countryCode: 'US', overallScore: 61, level: 'medium',
      domains: domain, trend: 'rising', change30d: 4.3,
      lowConfidence: false, imputationShare: 0.1,
      // NOTE: no _formula field.
    }));

    await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    // After the ranking run, the US entry in Redis must now carry
    // `_formula: 'd6'`. If the bulk read had ADMITTED the untagged
    // entry (the pre-fix bug), the warm path for US would not have
    // run, and the stored value would still be untagged.
    const rewrittenRaw = redis.get('resilience:score:v14:US');
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
        { countryCode: 'NO', overallScore: 99, level: 'high', lowConfidence: false, overallCoverage: 0.95 },
      ],
      greyedOut: [],
      _formula: 'pc', // mismatched — current env is flag-off ⇒ current='d6'
    };
    redis.set('resilience:ranking:v14', JSON.stringify(stale));

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    assert.notDeepEqual(
      response,
      { items: stale.items, greyedOut: stale.greyedOut },
      'stale-formula ranking must be rejected, not served',
    );
    // Recompute path warms missing per-country scores, so YE (in
    // RESILIENCE_FIXTURES) must get scored during this call.
    assert.ok(
      redis.has('resilience:score:v14:YE'),
      'stale-formula reject must trigger the recompute-and-warm path',
    );
  });

  it('warms missing scores synchronously and returns complete ranking on first call', async () => {
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    const domainWithCoverage = [{ name: 'political', dimensions: [{ name: 'd1', coverage: 0.9 }] }];
    redis.set('resilience:score:v14:NO', JSON.stringify({
      countryCode: 'NO',
      overallScore: 82,
      level: 'high',
      domains: domainWithCoverage,
      trend: 'stable',
      change30d: 1.2,
      lowConfidence: false,
      imputationShare: 0.05,
    }));
    redis.set('resilience:score:v14:US', JSON.stringify({
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
    assert.ok(redis.has('resilience:score:v14:YE'), 'missing country should be warmed during first call');
    assert.ok(response.items.every((item) => item.overallScore >= 0), 'ranked items should all have computed scores');
    assert.ok(redis.has('resilience:ranking:v14'), 'fully scored ranking should be cached');
  });

  it('sets rankStable=true when interval data exists and width <= 8', async () => {
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    const domainWithCoverage = [{ id: 'political', score: 80, weight: 0.2, dimensions: [{ id: 'd1', score: 80, coverage: 0.9, observedWeight: 1, imputedWeight: 0 }] }];
    redis.set('resilience:score:v14:NO', JSON.stringify({
      countryCode: 'NO', overallScore: 82, level: 'high',
      domains: domainWithCoverage, trend: 'stable', change30d: 1.2,
      lowConfidence: false, imputationShare: 0.05,
    }));
    redis.set('resilience:score:v14:US', JSON.stringify({
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
    redis.set('resilience:score:v14:NO', JSON.stringify({
      countryCode: 'NO', overallScore: 82, level: 'high',
      domains: domainWithCoverage, trend: 'stable', change30d: 1.2,
      lowConfidence: false, imputationShare: 0.05,
    }));
    redis.set('resilience:score:v14:US', JSON.stringify({
      countryCode: 'US', overallScore: 61, level: 'medium',
      domains: domainWithCoverage, trend: 'rising', change30d: 4.3,
      lowConfidence: false, imputationShare: 0.1,
    }));

    await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    // 3 of 4 (NO + US pre-cached, YE warmed from fixtures, ZZ can't be warmed)
    // = 75% which meets the threshold — must cache.
    assert.ok(redis.has('resilience:ranking:v14'), 'ranking must be cached at exactly 75% coverage');
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
          (cmd) => cmd[0] === 'GET' && typeof cmd[1] === 'string' && cmd[1].startsWith('resilience:score:v14:'),
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

    assert.ok(redis.has('resilience:ranking:v14'), 'ranking must be published despite pipeline-GET race');
    assert.ok(redis.has('seed-meta:resilience:ranking'), 'seed-meta must be written despite pipeline-GET race');
  });

  it('pipeline SETs apply env prefix so preview warms do not leak into production namespace', async () => {
    // Reviewer regression: passing `raw=true` to runRedisPipeline bypasses the
    // env-based key prefix (preview: / dev:) that isolates preview deploys
    // from production. The symptom is asymmetric: preview reads hit
    // `preview:<sha>:resilience:score:v14:XX` while preview writes landed at
    // raw `resilience:score:v14:XX`, simultaneously (a) missing the preview
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
      .filter((cmd) => cmd[0] === 'SET' && typeof cmd[1] === 'string' && (cmd[1] as string).includes('resilience:score:v14:'))
      .map((cmd) => cmd[1] as string);
    assert.ok(scoreSetKeys.length >= 2, `expected at least 2 score SETs, got ${scoreSetKeys.length}`);
    for (const key of scoreSetKeys) {
      assert.ok(
        key.startsWith('preview:abcdef12:'),
        `score SET key must carry preview prefix; got ${key} — writes would poison the production namespace`,
      );
    }
  });

  it('?refresh=1 is rejected without a valid X-WorldMonitor-Key (Pro bearer token is NOT enough)', async () => {
    // A full warm is expensive (~222 score computations + chunked pipeline
    // SETs). Allowing any Pro user to loop on ?refresh=1 would DoS Upstash
    // and Edge budget. refresh must be seed-service only — validated against
    // WORLDMONITOR_VALID_KEYS / WORLDMONITOR_API_KEY.
    const prevValidKeys = process.env.WORLDMONITOR_VALID_KEYS;
    const prevApiKey = process.env.WORLDMONITOR_API_KEY;
    process.env.WORLDMONITOR_VALID_KEYS = 'seed-secret';
    delete process.env.WORLDMONITOR_API_KEY;
    try {
      const { redis } = installRedis({ ...RESILIENCE_FIXTURES });
      redis.set('resilience:static:index:v1', JSON.stringify({
        countries: ['NO', 'US'],
        recordCount: 2,
        failedDatasets: [],
        seedYear: 2026,
      }));
      // Stale sentinel tagged with the current (flag-off default)
      // formula so the cross-formula invalidation does NOT fire here —
      // these refresh-auth tests exercise the auth gate, not the
      // formula check. An untagged sentinel would be silently
      // rejected by the formula gate and the refresh path would not
      // get tested as intended.
      const stale = { items: [{ countryCode: 'ZZ', overallScore: 1, level: 'low', lowConfidence: true, overallCoverage: 0.5 }], greyedOut: [], _formula: 'd6' };
      redis.set('resilience:ranking:v14', JSON.stringify(stale));

      // No X-WorldMonitor-Key → refresh must be ignored, stale cache returned.
      const unauth = new Request('https://example.com/api/resilience/v1/get-resilience-ranking?refresh=1');
      const unauthResp = await getResilienceRanking({ request: unauth } as never, {});
      assert.equal(unauthResp.items.length, 1);
      assert.equal(unauthResp.items[0]?.countryCode, 'ZZ', 'refresh=1 without key must fall back to cached response');

      // Wrong key → same as no key.
      const wrongKey = new Request('https://example.com/api/resilience/v1/get-resilience-ranking?refresh=1', {
        headers: { 'X-WorldMonitor-Key': 'bogus' },
      });
      const wrongResp = await getResilienceRanking({ request: wrongKey } as never, {});
      assert.equal(wrongResp.items[0]?.countryCode, 'ZZ', 'refresh=1 with wrong key must fall back to cached response');

      // Valid seed key → refresh is honored, ZZ is NOT in the recomputed response.
      const authed = new Request('https://example.com/api/resilience/v1/get-resilience-ranking?refresh=1', {
        headers: { 'X-WorldMonitor-Key': 'seed-secret' },
      });
      const authedResp = await getResilienceRanking({ request: authed } as never, {});
      const codes = (authedResp.items.concat(authedResp.greyedOut ?? [])).map((i) => i.countryCode);
      assert.ok(!codes.includes('ZZ'), 'refresh=1 with valid seed key must recompute');
    } finally {
      if (prevValidKeys == null) delete process.env.WORLDMONITOR_VALID_KEYS;
      else process.env.WORLDMONITOR_VALID_KEYS = prevValidKeys;
      if (prevApiKey == null) delete process.env.WORLDMONITOR_API_KEY;
      else process.env.WORLDMONITOR_API_KEY = prevApiKey;
    }
  });

  it('?refresh=1 bypasses the cache-hit early-return and recomputes the ranking (with valid seed key)', async () => {
    // Seeder uses ?refresh=1 on the unconditional per-cron rebuild. Without
    // this bypass, the seeder would have to DEL the ranking before rebuild
    // (the old flow) — a failed rebuild would then leave the key absent
    // instead of stale-but-present.
    const prevValidKeys = process.env.WORLDMONITOR_VALID_KEYS;
    process.env.WORLDMONITOR_VALID_KEYS = 'seed-secret';
    try {
      const { redis } = installRedis({ ...RESILIENCE_FIXTURES });
      redis.set('resilience:static:index:v1', JSON.stringify({
        countries: ['NO', 'US'],
        recordCount: 2,
        failedDatasets: [],
        seedYear: 2026,
      }));
      // Seed a pre-existing ranking so the cache-hit early-return would
      // normally fire. ?refresh=1 (with valid seed key) must ignore it.
      // Stale sentinel tagged with the current (flag-off default)
      // formula so the cross-formula invalidation does NOT fire here —
      // these refresh-auth tests exercise the auth gate, not the
      // formula check. An untagged sentinel would be silently
      // rejected by the formula gate and the refresh path would not
      // get tested as intended.
      const stale = { items: [{ countryCode: 'ZZ', overallScore: 1, level: 'low', lowConfidence: true, overallCoverage: 0.5 }], greyedOut: [], _formula: 'd6' };
      redis.set('resilience:ranking:v14', JSON.stringify(stale));

      const request = new Request('https://example.com/api/resilience/v1/get-resilience-ranking?refresh=1', {
        headers: { 'X-WorldMonitor-Key': 'seed-secret' },
      });
      const response = await getResilienceRanking({ request } as never, {});

      const returnedCountries = response.items.concat(response.greyedOut ?? []).map((i) => i.countryCode);
      assert.ok(!returnedCountries.includes('ZZ'), 'refresh=1 must recompute, not return the stale cached ZZ entry');
      assert.ok(returnedCountries.includes('NO') || returnedCountries.includes('US'), 'recomputed ranking must reflect the current static index');
    } finally {
      if (prevValidKeys == null) delete process.env.WORLDMONITOR_VALID_KEYS;
      else process.env.WORLDMONITOR_VALID_KEYS = prevValidKeys;
    }
  });

  it('warms via batched pipeline SETs (avoids 600KB single-pipeline timeout)', async () => {
    // The 5s pipeline timeout would fail on a 222-SET pipeline (~600KB body)
    // and the persistence guard would correctly return empty → no ranking.
    // Splitting into smaller batches keeps each pipeline well under timeout.
    // We assert the SET path uses MULTIPLE pipelines, not one giant one.
    const { redis, fetchImpl } = installRedis({ ...RESILIENCE_FIXTURES });
    redis.set('resilience:static:index:v1', JSON.stringify({
      countries: ['NO', 'US', 'YE'],
      recordCount: 3,
      failedDatasets: [],
      seedYear: 2026,
    }));

    const setPipelineSizes: number[] = [];
    const observing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/pipeline') && typeof init?.body === 'string') {
        const commands = JSON.parse(init.body) as Array<Array<string>>;
        const isAllScoreSets = commands.length > 0 && commands.every(
          (cmd) => cmd[0] === 'SET' && typeof cmd[1] === 'string' && (cmd[1] as string).includes('resilience:score:v14:'),
        );
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

    // Intercept any pipeline SET to resilience:score:v14:* and reply with
    // non-OK results (persisted but authoritative signal says no). /set and
    // other paths pass through normally so history/interval writes succeed.
    const blockedScoreWrites = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/pipeline') && typeof init?.body === 'string') {
        const commands = JSON.parse(init.body) as Array<Array<string>>;
        const allScoreSets = commands.length > 0 && commands.every(
          (cmd) => cmd[0] === 'SET' && typeof cmd[1] === 'string' && cmd[1].startsWith('resilience:score:v14:'),
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

    assert.ok(!redis.has('resilience:ranking:v14'), 'ranking must NOT be published when score writes failed');
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
