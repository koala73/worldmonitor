import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_AGE_MS,
  fetchServerInsights,
  getServerInsights,
  __resetServerInsightsCacheForTests,
} from '../src/services/insights-loader';
import { __testing__ as bootstrapTesting } from '../src/services/bootstrap';

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
      bootstrapTesting.resetBootstrapForTests();
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      __resetServerInsightsCacheForTests();
      bootstrapTesting.resetBootstrapForTests();
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

    it('returns null when payload validation fails (stale generatedAt)', async () => {
      const stale = { ...makeValidInsights(), generatedAt: new Date(Date.now() - MAX_AGE_MS - 60_000).toISOString() };
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ data: { insights: stale } }), { status: 200 });
      const result = await fetchServerInsights();
      assert.equal(result, null);
    });

    it('keeps the coalesced fetch alive for the longest caller budget (#7293)', async () => {
      // ProActivationInterstitial starts with 2500 ms; InsightsPanel and
      // ThreatTimelinePanel use the 5000 ms default. Sharing inFlight must
      // not pin the abort to the first (shorter) caller.
      const valid = makeValidInsights();
      let fetchCount = 0;
      let release;
      const hold = new Promise((resolve) => { release = resolve; });
      globalThis.fetch = async (_url, init) => {
        fetchCount += 1;
        const signal = init?.signal;
        await Promise.race([
          hold,
          new Promise((_, reject) => {
            const fail = () => {
              const err = new Error('aborted');
              err.name = signal?.reason?.name || 'AbortError';
              reject(err);
            };
            if (!signal) return;
            if (signal.aborted) {
              fail();
              return;
            }
            signal.addEventListener('abort', fail, { once: true });
          }),
        ]);
        return new Response(JSON.stringify({ data: { insights: valid } }), { status: 200 });
      };

      const short = fetchServerInsights(40);
      await Promise.resolve();
      const long = fetchServerInsights(200);
      await new Promise((resolve) => setTimeout(resolve, 70));
      release();
      const [shortResult, longResult] = await Promise.all([short, long]);
      assert.equal(fetchCount, 1, 'overlapping callers still share one request');
      assert.equal(longResult?.worldBrief, 'Test brief', 'the 200ms caller must survive the first caller\'s 40ms abort');
      assert.equal(shortResult, longResult);
    });

    it('does not shrink an in-flight abort when a shorter caller joins (#7293)', async () => {
      const valid = makeValidInsights();
      let fetchCount = 0;
      let release;
      const hold = new Promise((resolve) => { release = resolve; });
      globalThis.fetch = async (_url, init) => {
        fetchCount += 1;
        const signal = init?.signal;
        await Promise.race([
          hold,
          new Promise((_, reject) => {
            const fail = () => {
              const err = new Error('aborted');
              err.name = signal?.reason?.name || 'AbortError';
              reject(err);
            };
            if (!signal) return;
            if (signal.aborted) {
              fail();
              return;
            }
            signal.addEventListener('abort', fail, { once: true });
          }),
        ]);
        return new Response(JSON.stringify({ data: { insights: valid } }), { status: 200 });
      };

      const long = fetchServerInsights(200);
      await Promise.resolve();
      const short = fetchServerInsights(40);
      await new Promise((resolve) => setTimeout(resolve, 70));
      release();
      const [longResult, shortResult] = await Promise.all([long, short]);
      assert.equal(fetchCount, 1);
      assert.equal(longResult?.worldBrief, 'Test brief');
      assert.equal(shortResult, longResult);
    });

    it('still aborts a solo insights fetch at its own timeout (#7293)', async () => {
      let aborted = false;
      globalThis.fetch = async (_url, init) => {
        await new Promise((_, reject) => {
          const signal = init?.signal;
          const fail = () => {
            aborted = true;
            const err = new Error('aborted');
            err.name = signal?.reason?.name || 'AbortError';
            reject(err);
          };
          if (!signal) return;
          if (signal.aborted) {
            fail();
            return;
          }
          signal.addEventListener('abort', fail, { once: true });
        });
      };
      const result = await fetchServerInsights(30);
      assert.equal(result, null);
      assert.equal(aborted, true);
    });

    it('coalesces concurrent fetches into one network request (#7290)', async () => {
      const valid = makeValidInsights();
      let fetchCount = 0;
      let release;
      const hold = new Promise((resolve) => { release = resolve; });
      globalThis.fetch = async () => {
        fetchCount += 1;
        await hold;
        return new Response(JSON.stringify({ data: { insights: valid } }), { status: 200 });
      };

      const pending = [
        fetchServerInsights(),
        fetchServerInsights(),
        fetchServerInsights(),
      ];
      release();
      const [first, second, third] = await Promise.all(pending);
      assert.equal(fetchCount, 1, 'concurrent callers must share one in-flight request');
      assert.equal(first?.worldBrief, 'Test brief');
      assert.equal(second, first);
      assert.equal(third, first);
    });

    it('does not latch a settled network failure — a later call retries (#7290)', async () => {
      let fetchCount = 0;
      globalThis.fetch = async () => {
        fetchCount += 1;
        return new Response('upstream down', { status: 503 });
      };
      assert.equal(await fetchServerInsights(), null);
      assert.equal(await fetchServerInsights(), null);
      assert.equal(fetchCount, 2, 'in-flight lock must clear on settle so a later caller can retry');
    });

    it('does not latch a null hydration slot — a later fetch may recover (#7290)', async () => {
      // populateCache skips null, so this seeds an empty slot the same way
      // production getHydratedData returns undefined. The panel harness stub
      // that returns null is covered by tests/threat-timeline-panel.test.mts.
      bootstrapTesting.seedHydrationCacheForTests({ insights: null });
      const valid = makeValidInsights();
      let fetchCount = 0;
      globalThis.fetch = async () => {
        fetchCount += 1;
        return new Response(JSON.stringify({ data: { insights: valid } }), { status: 200 });
      };

      assert.equal(getServerInsights(), null, 'null is not a valid snapshot');
      const fetched = await fetchServerInsights();
      assert.equal(fetched?.worldBrief, 'Test brief');
      assert.equal(fetchCount, 1, 'an empty/null slot must still open ?keys=insights');
    });

    it('recovers from stale persistent hydration with one coalesced refetch (#7290)', async () => {
      // Persistent FAST-tier cache is 24h; insights freshness is 1h. A drained
      // stale snapshot must not skip the credentialed no-store ?keys=insights
      // recovery, but the three boot consumers must share that one request.
      const stale = {
        ...makeValidInsights(),
        generatedAt: new Date(Date.now() - MAX_AGE_MS - 60_000).toISOString(),
      };
      const fresh = makeValidInsights();
      bootstrapTesting.seedHydrationCacheForTests({ insights: stale });
      let fetchCount = 0;
      globalThis.fetch = async () => {
        fetchCount += 1;
        return new Response(JSON.stringify({ data: { insights: fresh } }), { status: 200 });
      };

      assert.equal(getServerInsights(), null, 'stale hydration must not be promoted');
      const [first, second, third] = await Promise.all([
        fetchServerInsights(),
        fetchServerInsights(),
        fetchServerInsights(),
      ]);
      assert.equal(first?.worldBrief, 'Test brief');
      assert.equal(second, first);
      assert.equal(third, first);
      assert.equal(fetchCount, 1, 'invalid hydration may recover via one coalesced ?keys=insights fetch');
    });

    it('does not issue one network request per consumer after invalid hydration (#7290)', async () => {
      bootstrapTesting.seedHydrationCacheForTests({
        insights: { ...makeValidInsights(), topStories: [] },
      });
      let fetchCount = 0;
      globalThis.fetch = async () => {
        fetchCount += 1;
        return new Response(JSON.stringify({ data: { insights: makeValidInsights() } }), { status: 200 });
      };

      assert.equal(getServerInsights(), null, 'invalid hydration must not be promoted');
      const [first, second, third] = await Promise.all([
        fetchServerInsights(),
        fetchServerInsights(),
        fetchServerInsights(),
      ]);
      assert.equal(first?.worldBrief, 'Test brief');
      assert.equal(second, first);
      assert.equal(third, first);
      assert.equal(fetchCount, 1, 'shape-invalid hydration still gets one coalesced recovery fetch');
    });

    it('consumes a valid FAST-tier hydration payload without a per-key fetch (#7290)', async () => {
      const valid = makeValidInsights();
      bootstrapTesting.seedHydrationCacheForTests({ insights: valid });
      let fetchCount = 0;
      globalThis.fetch = async () => {
        fetchCount += 1;
        return new Response('should not run', { status: 500 });
      };

      const first = getServerInsights();
      assert.equal(first?.worldBrief, 'Test brief');
      assert.equal(getServerInsights(), first, 'later readers must reuse the module cache, not re-drain');
      assert.equal(await fetchServerInsights(), first);
      assert.equal(fetchCount, 0, 'accepted FAST-tier hydration must not fall through to ?keys=insights');
    });

    it('fetchServerInsights consumes unused hydration before opening a network request (#7290)', async () => {
      const valid = makeValidInsights();
      bootstrapTesting.seedHydrationCacheForTests({ insights: valid });
      let fetchCount = 0;
      globalThis.fetch = async () => {
        fetchCount += 1;
        return new Response('should not run', { status: 500 });
      };

      const fetched = await fetchServerInsights();
      assert.equal(fetched?.worldBrief, 'Test brief');
      assert.equal(fetchCount, 0, 'the first fetch path is also a hydration reader');
    });
  });
});
