import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

import { isAllowedRouteHost, bulkReadLearnedRoutes, bulkWriteLearnedRoutes, processItemRoute } from '../scripts/_seed-utils.mjs';

// ---------------------------------------------------------------------------
// isAllowedRouteHost
// ---------------------------------------------------------------------------

describe('isAllowedRouteHost', () => {
  it('accepts URL matching a listed site exactly', () => {
    assert.equal(isAllowedRouteHost('https://carrefouruae.com/product/sugar', ['carrefouruae.com', 'noon.com']), true);
  });

  it('accepts URL with www. prefix', () => {
    assert.equal(isAllowedRouteHost('https://www.carrefouruae.com/product/sugar', ['carrefouruae.com']), true);
  });

  it('accepts subdomain of listed site', () => {
    assert.equal(isAllowedRouteHost('https://shop.luluhypermarket.com/en/sugar', ['luluhypermarket.com']), true);
  });

  it('rejects URL from unlisted hostname', () => {
    assert.equal(isAllowedRouteHost('https://numbeo.com/cost-of-living', ['carrefouruae.com']), false);
  });

  it('rejects malformed URL without throwing', () => {
    assert.equal(isAllowedRouteHost('not-a-url', ['carrefouruae.com']), false);
  });

  it('rejects empty string without throwing', () => {
    assert.equal(isAllowedRouteHost('', ['carrefouruae.com']), false);
  });

  it('accepts noon.com URL when allowedHosts entry is path-bearing (noon.com/saudi-en stripped to noon.com)', () => {
    // grocery-basket.json SA sites contains "noon.com/saudi-en" — must be stripped to bare hostname
    // before comparison, otherwise no noon.com route ever matches and SA cache never stabilizes
    const allowedHosts = ['noon.com/saudi-en', 'carrefour.com.sa'].map(s => s.split('/')[0]);
    assert.equal(isAllowedRouteHost('https://noon.com/saudi-en/sugar', allowedHosts), true);
  });
});

// ---------------------------------------------------------------------------
// Helpers — mock fetch for Redis tests
// ---------------------------------------------------------------------------

function withEnv(vars) {
  const original = {};
  for (const [k, v] of Object.entries(vars)) {
    original[k] = process.env[k];
    process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

// ---------------------------------------------------------------------------
// bulkReadLearnedRoutes
// ---------------------------------------------------------------------------

describe('bulkReadLearnedRoutes', () => {
  let restoreEnv;

  beforeEach(() => {
    restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'tok',
    });
  });

  afterEach(() => {
    restoreEnv();
  });

  it('returns empty Map when keys array is empty (no fetch)', async () => {
    let fetchCalled = false;
    const restore = mockFetch(() => { fetchCalled = true; });
    const result = await bulkReadLearnedRoutes('grocery-basket', []);
    restore();
    assert.equal(fetchCalled, false);
    assert.equal(result.size, 0);
  });

  it('parses valid pipeline responses into Map', async () => {
    const route = { url: 'https://carrefouruae.com/sugar', lastSuccessAt: 1000, hits: 3, failsSinceSuccess: 0, currency: 'AED' };
    const restore = mockFetch(async () => ({
      ok: true,
      json: async () => [
        { result: JSON.stringify(route) },
        { result: null },
      ],
    }));
    const result = await bulkReadLearnedRoutes('grocery-basket', ['AE:sugar', 'AE:salt']);
    restore();
    assert.equal(result.size, 1);
    assert.deepEqual(result.get('AE:sugar'), route);
    assert.equal(result.has('AE:salt'), false);
  });

  it('skips malformed JSON entries without throwing', async () => {
    const restore = mockFetch(async () => ({
      ok: true,
      json: async () => [{ result: 'not-valid-json{{' }],
    }));
    const result = await bulkReadLearnedRoutes('grocery-basket', ['AE:sugar']);
    restore();
    assert.equal(result.size, 0);
  });

  it('throws on HTTP error (non-fatal: caller catches)', async () => {
    const restore = mockFetch(async () => ({ ok: false, status: 500 }));
    await assert.rejects(
      () => bulkReadLearnedRoutes('grocery-basket', ['AE:sugar']),
      /bulkReadLearnedRoutes HTTP 500/
    );
    restore();
  });
});

// ---------------------------------------------------------------------------
// bulkWriteLearnedRoutes
// ---------------------------------------------------------------------------

describe('bulkWriteLearnedRoutes', () => {
  let restoreEnv;

  beforeEach(() => {
    restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'tok',
    });
  });

  afterEach(() => {
    restoreEnv();
  });

  it('no-ops when both maps are empty (no fetch)', async () => {
    let fetchCalled = false;
    const restore = mockFetch(() => { fetchCalled = true; });
    await bulkWriteLearnedRoutes('grocery-basket', new Map(), new Set());
    restore();
    assert.equal(fetchCalled, false);
  });

  it('sends SET with 14-day TTL for updated keys', async () => {
    let capturedBody;
    const restore = mockFetch(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, json: async () => [] };
    });
    const route = { url: 'https://carrefouruae.com/sugar', lastSuccessAt: 1000, hits: 1, failsSinceSuccess: 0, currency: 'AED' };
    await bulkWriteLearnedRoutes('grocery-basket', new Map([['AE:sugar', route]]), new Set());
    restore();
    assert.equal(capturedBody.length, 1);
    const [cmd, key, val, ex, ttl] = capturedBody[0];
    assert.equal(cmd, 'SET');
    assert.equal(key, 'seed-routes:grocery-basket:AE:sugar');
    assert.deepEqual(JSON.parse(val), route);
    assert.equal(ex, 'EX');
    assert.equal(ttl, 14 * 24 * 3600);
  });

  it('sends DEL for evicted keys not in updates', async () => {
    let capturedBody;
    const restore = mockFetch(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, json: async () => [] };
    });
    await bulkWriteLearnedRoutes('grocery-basket', new Map(), new Set(['AE:sugar']));
    restore();
    assert.equal(capturedBody.length, 1);
    assert.equal(capturedBody[0][0], 'DEL');
    assert.equal(capturedBody[0][1], 'seed-routes:grocery-basket:AE:sugar');
  });

  it('SET wins when key is in both updates and deletes — DEL not sent', async () => {
    let capturedBody;
    const restore = mockFetch(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, json: async () => [] };
    });
    const route = { url: 'https://carrefouruae.com/sugar', lastSuccessAt: 1000, hits: 1, failsSinceSuccess: 0, currency: 'AED' };
    await bulkWriteLearnedRoutes(
      'grocery-basket',
      new Map([['AE:sugar', route]]),
      new Set(['AE:sugar']) // same key
    );
    restore();
    // Only SET, no DEL
    assert.equal(capturedBody.length, 1);
    assert.equal(capturedBody[0][0], 'SET');
  });

  it('sends DELs before SETs in pipeline', async () => {
    let capturedBody;
    const restore = mockFetch(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, json: async () => [] };
    });
    const route = { url: 'https://carrefouruae.com/salt', lastSuccessAt: 1000, hits: 1, failsSinceSuccess: 0, currency: 'AED' };
    await bulkWriteLearnedRoutes(
      'grocery-basket',
      new Map([['AE:salt', route]]),
      new Set(['AE:sugar']) // different key — both should appear
    );
    restore();
    assert.equal(capturedBody.length, 2);
    assert.equal(capturedBody[0][0], 'DEL');  // DEL first
    assert.equal(capturedBody[1][0], 'SET');  // SET second
  });

  it('throws on HTTP error', async () => {
    const restore = mockFetch(async () => ({ ok: false, status: 503 }));
    const route = { url: 'https://carrefouruae.com/sugar', lastSuccessAt: 1000, hits: 1, failsSinceSuccess: 0, currency: 'AED' };
    await assert.rejects(
      () => bulkWriteLearnedRoutes('grocery-basket', new Map([['AE:sugar', route]]), new Set()),
      /bulkWriteLearnedRoutes HTTP 503/
    );
    restore();
  });
});

// ---------------------------------------------------------------------------
// processItemRoute — integration-level decision tree
// ---------------------------------------------------------------------------

describe('processItemRoute', () => {
  const noop = async () => {};
  const allowedHosts = ['carrefouruae.com'];
  const baseRoute = { url: 'https://carrefouruae.com/sugar', lastSuccessAt: 1000, hits: 3, failsSinceSuccess: 0, currency: 'AED' };
  const baseOpts = {
    allowedHosts,
    currency: 'AED',
    itemId: 'sugar',
    fxRate: 0.27,
    itemUsdMax: 5,
    tryDirectFetch: async () => null,
    scrapeFirecrawl: async () => null,
    fetchViaExa: async () => null,
    sleep: noop,
    firecrawlDelayMs: 0,
  };

  it('learned-hit success: fetchViaExa not called', async () => {
    let exaCalled = false;
    const result = await processItemRoute({
      ...baseOpts,
      learned: baseRoute,
      tryDirectFetch: async () => 5.50,
      fetchViaExa: async () => { exaCalled = true; return null; },
    });
    assert.equal(exaCalled, false);
    assert.equal(result.localPrice, 5.50);
    assert.equal(result.routeUpdate?.hits, 4);
    assert.equal(result.routeUpdate?.failsSinceSuccess, 0);
    assert.equal(result.routeDelete, false);
  });

  it('learned-hit fail + EXA success: routeUpdate has new URL, hits=1', async () => {
    const result = await processItemRoute({
      ...baseOpts,
      learned: baseRoute,
      tryDirectFetch: async () => null,
      scrapeFirecrawl: async () => null,
      fetchViaExa: async () => ({ localPrice: 6.00, sourceSite: 'https://carrefouruae.com/new-sugar' }),
    });
    assert.equal(result.localPrice, 6.00);
    assert.equal(result.routeUpdate?.url, 'https://carrefouruae.com/new-sugar');
    assert.equal(result.routeUpdate?.hits, 1);
    assert.equal(result.routeDelete, false);
  });

  it('learned fail x2: routeDelete=true, routeUpdate=null, localPrice=null', async () => {
    const staleRoute = { ...baseRoute, failsSinceSuccess: 1 };
    const result = await processItemRoute({
      ...baseOpts,
      learned: staleRoute,
      tryDirectFetch: async () => null,
      scrapeFirecrawl: async () => null,
      fetchViaExa: async () => null,
    });
    assert.equal(result.routeDelete, true);
    assert.equal(result.routeUpdate, null);
    assert.equal(result.localPrice, null);
  });

  it('corrupted URL (bad host): routeDelete=true, tryDirectFetch never called (SSRF guard)', async () => {
    let directFetchCalled = false;
    const badRoute = { ...baseRoute, url: 'https://evil.com/sugar' };
    const result = await processItemRoute({
      ...baseOpts,
      learned: badRoute,
      tryDirectFetch: async () => { directFetchCalled = true; return null; },
      fetchViaExa: async () => null,  // EXA still runs to find a replacement
    });
    assert.equal(result.routeDelete, true);
    assert.equal(directFetchCalled, false);
  });

  it('EXA success but host not in allowlist: price returned, route NOT saved', async () => {
    const result = await processItemRoute({
      ...baseOpts,
      learned: undefined,
      fetchViaExa: async () => ({ localPrice: 5.50, sourceSite: 'https://evil.com/sugar' }),
    });
    assert.equal(result.localPrice, 5.50);
    assert.equal(result.routeUpdate, null);
    assert.equal(result.routeDelete, false);
  });
});
