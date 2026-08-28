import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_AGE_MS,
  fetchServerInsights,
  getServerInsights,
  __resetServerInsightsCacheForTests,
} from '../src/services/insights-loader';

describe('insights-loader', () => {
  describe('MAX_AGE_MS — server-cadence-aligned freshness window', () => {
    // The seeder cron interval is 30 min (scripts/seed-insights.mjs:363).
    // MAX_AGE_MS must be >= the cron interval, otherwise the panel will
    // appear UNAVAILABLE for part of every healthy cycle. 60 min gives
    // one missed-tick of headroom on top of that.
    it('is at least 30 minutes (cron interval)', () => {
      assert.ok(MAX_AGE_MS >= 30 * 60 * 1000, `expected >=30min, got ${MAX_AGE_MS / 60000}min`);
    });

    it('is at least 60 minutes (cron interval × 2 for missed-tick headroom)', () => {
      assert.ok(MAX_AGE_MS >= 60 * 60 * 1000, `expected >=60min, got ${MAX_AGE_MS / 60000}min`);
    });
  });

  describe('getServerInsights (logic validation)', () => {
    function isFresh(generatedAt) {
      const age = Date.now() - new Date(generatedAt).getTime();
      return age < MAX_AGE_MS;
    }

    it('rejects data older than the freshness window', () => {
      const old = new Date(Date.now() - MAX_AGE_MS - 60_000).toISOString();
      assert.equal(isFresh(old), false);
    });

    it('accepts data younger than the freshness window', () => {
      const fresh = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      assert.equal(isFresh(fresh), true);
    });

    it('accepts data from now', () => {
      assert.equal(isFresh(new Date().toISOString()), true);
    });

    it('rejects exactly window-aged data', () => {
      const exact = new Date(Date.now() - MAX_AGE_MS).toISOString();
      assert.equal(isFresh(exact), false);
    });
  });

  describe('ServerInsights payload shape', () => {
    it('validates required fields', () => {
      const valid = {
        worldBrief: 'Test brief',
        worldBriefSources: [{ title: 'Test', source: 's', url: 'https://example.com/test' }],
        briefProvider: 'groq',
        status: 'ok',
        topStories: [{ primaryTitle: 'Test', sourceCount: 2 }],
        generatedAt: new Date().toISOString(),
        clusterCount: 10,
        multiSourceCount: 5,
        fastMovingCount: 3,
      };
      assert.ok(valid.topStories.length >= 1);
      assert.ok(['ok', 'degraded'].includes(valid.status));
    });

    it('allows degraded status with empty brief', () => {
      const degraded = {
        worldBrief: '',
        status: 'degraded',
        topStories: [{ primaryTitle: 'Test' }],
        generatedAt: new Date().toISOString(),
      };
      assert.equal(degraded.worldBrief, '');
      assert.equal(degraded.status, 'degraded');
    });

    it('rejects empty topStories', () => {
      const empty = { topStories: [] };
      assert.equal(empty.topStories.length >= 1, false);
    });
  });

  describe('fetchServerInsights — bootstrap-key on-demand refetch', () => {
    let originalFetch;

    function makeValidInsights() {
      return {
        worldBrief: 'Test brief',
        worldBriefSources: [{ title: 'Test', source: 's', url: 'https://example.com/test' }],
        briefProvider: 'groq',
        status: 'ok',
        topStories: [{
          primaryTitle: 'Test', primarySource: 's', primaryLink: 'l', pubDate: '',
          sourceCount: 2, importanceScore: 1, velocity: { level: 'low', sourcesPerHour: 1 },
          isAlert: false, category: 'general', threatLevel: 'low', countryCode: null,
        }],
        generatedAt: new Date().toISOString(),
        clusterCount: 10,
        multiSourceCount: 5,
        fastMovingCount: 3,
      };
    }

    beforeEach(() => {
      __resetServerInsightsCacheForTests();
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('REGRESSION: recovers when getServerInsights() returns null because bootstrap hydration is missing', async () => {
      // Repros the mobile "AI INSIGHTS · UNAVAILABLE · Waiting for news data..."
      // bug: on 4G the fast-tier bootstrap aborts at 1.2 s, `insights` never
      // lands in the hydration cache, `getServerInsights()` returns null,
      // and InsightsPanel dead-ends on the mobile branch with no retry. The
      // on-demand fetcher must hit /api/bootstrap?keys=insights and return
      // validated data so the panel can recover without a page reload.
      const valid = makeValidInsights();
      let calledUrl = '';
      globalThis.fetch = async (url) => {
        calledUrl = String(url);
        return new Response(JSON.stringify({ data: { insights: valid } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      assert.equal(getServerInsights(), null, 'precondition: no hydrated data');
      const fetched = await fetchServerInsights();
      assert.ok(fetched, 'fetch fallback returned data');
      assert.equal(fetched?.worldBrief, 'Test brief');
      assert.match(calledUrl, /\/api\/bootstrap\?keys=insights\b/, 'used the bootstrap key-filter endpoint, not a separate route');
    });

    it('caches the fetched value so subsequent getServerInsights() is synchronous', async () => {
      const valid = makeValidInsights();
      let fetchCount = 0;
      globalThis.fetch = async () => {
        fetchCount++;
        return new Response(JSON.stringify({ data: { insights: valid } }), { status: 200 });
      };

      await fetchServerInsights();
      const sync = getServerInsights();
      assert.ok(sync, 'cached value visible to sync reader');
      assert.equal(sync?.worldBrief, 'Test brief');
      assert.equal(fetchCount, 1, 'no extra network round trip');
    });

    it('returns null without throwing when /api/bootstrap times out', async () => {
      globalThis.fetch = async () => {
        const err = new Error('aborted');
        err.name = 'TimeoutError';
        throw err;
      };
      const result = await fetchServerInsights(50);
      assert.equal(result, null);
    });

    it('returns null without throwing on a non-2xx response', async () => {
      globalThis.fetch = async () => new Response('upstream down', { status: 503 });
      const result = await fetchServerInsights();
      assert.equal(result, null);
    });

    it('returns null when payload validation fails (empty topStories)', async () => {
      const invalid = { ...makeValidInsights(), topStories: [] };
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ data: { insights: invalid } }), { status: 200 });
      const result = await fetchServerInsights();
      assert.equal(result, null);
    });

    it('REGRESSION: concurrent callers share one in-flight request (#7290)', async () => {
      // Three components call fetchServerInsights() independently:
      // ThreatTimelinePanel:55, InsightsPanel:278, ProActivationInterstitial:1172.
      // `cached` is only assigned after the response parses, so before #7290
      // every caller arriving inside the flight window passed the freshness
      // guard and issued its own request. DebugBear analysis 86622879 caught
      // four 200s for the same 11,382-byte body, two of them 1 ms apart.
      const valid = makeValidInsights();
      let fetchCount = 0;
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      globalThis.fetch = async () => {
        fetchCount++;
        await gate;
        return new Response(JSON.stringify({ data: { insights: valid } }), { status: 200 });
      };

      const flights = [fetchServerInsights(), fetchServerInsights(), fetchServerInsights()];
      release();
      const results = await Promise.all(flights);

      assert.equal(fetchCount, 1, 'concurrent callers must share one network request');
      for (const result of results) {
        assert.ok(result, 'every concurrent caller resolves with the payload');
        assert.equal(result?.worldBrief, 'Test brief');
      }
    });

    it('a failed flight does not latch — a later call retries (#7290)', async () => {
      // The lock must be an in-flight lock, not a negative result cache.
      // Latching here would permanently strand the panel that #4487 added the
      // on-demand path to recover.
      const valid = makeValidInsights();
      let fetchCount = 0;
      globalThis.fetch = async () => {
        fetchCount++;
        if (fetchCount === 1) return new Response('upstream down', { status: 503 });
        return new Response(JSON.stringify({ data: { insights: valid } }), { status: 200 });
      };

      assert.equal(await fetchServerInsights(), null, 'first flight fails');
      const recovered = await fetchServerInsights();
      assert.ok(recovered, 'second call retries rather than replaying the failure');
      assert.equal(fetchCount, 2);
    });

    it('a rejected payload does not latch — a later call retries (#7290)', async () => {
      // A 200 that fails validation is the drain-once hazard the loader's own
      // doc comment describes; it must not be cached as either a success or a
      // permanent failure.
      const valid = makeValidInsights();
      let fetchCount = 0;
      globalThis.fetch = async () => {
        fetchCount++;
        const body = fetchCount === 1 ? { ...valid, topStories: [] } : valid;
        return new Response(JSON.stringify({ data: { insights: body } }), { status: 200 });
      };

      assert.equal(await fetchServerInsights(), null, 'invalid payload rejected');
      const recovered = await fetchServerInsights();
      assert.ok(recovered, 'a later call refetches');
      assert.equal(fetchCount, 2);
    });

    it('returns null when payload validation fails (stale generatedAt)', async () => {
      const stale = { ...makeValidInsights(), generatedAt: new Date(Date.now() - MAX_AGE_MS - 60_000).toISOString() };
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ data: { insights: stale } }), { status: 200 });
      const result = await fetchServerInsights();
      assert.equal(result, null);
    });
  });
});
