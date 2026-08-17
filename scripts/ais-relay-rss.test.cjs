/**
 * Regression tests for the RSS proxy cache in ais-relay.cjs.
 *
 * Tests negative caching, in-flight dedup failure behavior, and no-cascade guarantees.
 * Run: node --test scripts/ais-relay-rss.test.cjs
 */
'use strict';

const { strict: assert } = require('node:assert');
const http = require('node:http');
const test = require('node:test');
const { nextBackoffMs } = require('./_ingestion-coverage.cjs');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('listening', () => resolve(server.address().port));
    server.once('error', reject);
    server.listen(port, '127.0.0.1');
  });
}

function fetch(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        });
      });
    }).on('error', reject);
  });
}

// ─── Mock upstream RSS server ─────────────────────────────────────────────────

function createMockUpstream() {
  let hitCount = 0;
  let responseStatus = 200;
  let responseBody = '<rss><channel><title>Test</title></channel></rss>';
  let responseDelay = 0;
  let etag = null;
  let lastModified = null;
  let lastRequestHeaders = {};

  const server = http.createServer((req, res) => {
    hitCount++;
    lastRequestHeaders = req.headers;
    setTimeout(() => {
      if (etag && req.headers['if-none-match'] === etag) {
        res.writeHead(304);
        return res.end();
      }
      if (lastModified && req.headers['if-modified-since'] === lastModified) {
        res.writeHead(304);
        return res.end();
      }
      const headers = { 'Content-Type': 'application/xml' };
      if (etag) headers.ETag = etag;
      if (lastModified) headers['Last-Modified'] = lastModified;
      res.writeHead(responseStatus, headers);
      res.end(responseBody);
    }, responseDelay);
  });

  return {
    server,
    getHitCount: () => hitCount,
    resetHitCount: () => { hitCount = 0; },
    setResponse: (status, body) => { responseStatus = status; responseBody = body || responseBody; },
    setDelay: (ms) => { responseDelay = ms; },
    setETag: (v) => { etag = v; },
    setLastModified: (v) => { lastModified = v; },
    getLastRequestHeaders: () => lastRequestHeaders,
  };
}

// ─── Create a minimal ais-relay-like RSS proxy for testing ────────────────────
// Extracts just the RSS caching logic to test in isolation.

function createTestRssProxy(upstreamPort) {
  const https = require('node:http'); // use http for testing, not https

  const rssResponseCache = new Map();
  const rssNegativeCache = new Map();
  const rssInFlight = new Map();
  const RSS_CACHE_TTL_MS = 5 * 60 * 1000;
  const RSS_NEGATIVE_CACHE_TTL_MS = 60 * 1000;
  const RSS_CACHE_MAX_ENTRIES = 5; // small cap for testing
  const RSS_NEGATIVE_CACHE_MAX_ENTRIES = 3; // failures need less headroom than feed bodies

  function setBoundedCacheEntry(cache, key, value, maxEntries) {
    if (!cache.has(key) && cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, value);
  }

  function safeEnd(res, statusCode, headers, body) {
    if (res.headersSent || res.writableEnded) return false;
    try {
      res.writeHead(statusCode, headers);
      res.end(body);
      return true;
    } catch { return false; }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1`);
    const feedUrl = url.searchParams.get('url');

    if (!feedUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing url' }));
    }

    // Successful and negative responses have separate lifetimes and stores.
    const rssCached = rssResponseCache.get(feedUrl);
    const rssNegativeCached = rssNegativeCache.get(feedUrl);
    if (rssCached && Date.now() - rssCached.timestamp < RSS_CACHE_TTL_MS) {
      res.writeHead(200, { 'Content-Type': 'application/xml', 'X-Cache': 'HIT' });
      return res.end(rssCached.data);
    }
    if (rssNegativeCached) {
      if (Date.now() - rssNegativeCached.timestamp < RSS_NEGATIVE_CACHE_TTL_MS) {
        if (rssCached) {
          res.writeHead(200, { 'Content-Type': 'application/xml', 'X-Cache': 'NEGATIVE-STALE' });
          return res.end(rssCached.data);
        }
        res.writeHead(rssNegativeCached.statusCode, {
          'Content-Type': 'application/xml',
          'X-Cache': 'HIT',
        });
        return res.end(rssNegativeCached.data);
      }
      rssNegativeCache.delete(feedUrl);
    }

    // In-flight dedup — cascade-resistant
    const existing = rssInFlight.get(feedUrl);
    if (existing) {
      try {
        const fetchResult = await existing;
        const deduped = rssResponseCache.get(feedUrl);
        if (deduped) {
          const dedupedNegative = rssNegativeCache.get(feedUrl);
          res.writeHead(200, {
            'Content-Type': 'application/xml',
            'X-Cache': dedupedNegative || fetchResult?.stale ? 'DEDUP-STALE' : 'DEDUP',
          });
          return res.end(deduped.data);
        }
        const dedupedNegative = rssNegativeCache.get(feedUrl);
        if (dedupedNegative) {
          res.writeHead(dedupedNegative.statusCode, {
            'Content-Type': 'application/xml',
            'X-Cache': 'DEDUP',
          });
          return res.end(dedupedNegative.data);
        }
        return safeEnd(res, 502, { 'Content-Type': 'application/json' },
          JSON.stringify({ error: 'Upstream fetch completed but not cached' }));
      } catch {
        return safeEnd(res, 502, { 'Content-Type': 'application/json' },
          JSON.stringify({ error: 'Upstream fetch failed' }));
      }
    }

    // MISS — fetch upstream
    const fetchPromise = new Promise((resolveInFlight, rejectInFlight) => {
      const conditionalHeaders = {};
      if (rssCached?.etag) conditionalHeaders['If-None-Match'] = rssCached.etag;
      if (rssCached?.lastModified) conditionalHeaders['If-Modified-Since'] = rssCached.lastModified;

      const request = http.get(`http://127.0.0.1:${upstreamPort}${new URL(feedUrl).pathname}`, {
        headers: { ...conditionalHeaders },
        timeout: 5000,
      }, (response) => {
        if (response.statusCode === 304 && rssCached) {
          rssCached.timestamp = Date.now();
          resolveInFlight({ stale: false });
          res.writeHead(200, {
            'Content-Type': rssCached.contentType || 'application/xml',
            'X-Cache': 'REVALIDATED',
          });
          res.end(rssCached.data);
          return;
        }

        const chunks = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => {
          const data = Buffer.concat(chunks);
          const isSuccess = response.statusCode >= 200 && response.statusCode < 300;
          const cacheEntry = {
            data, contentType: 'application/xml',
            statusCode: response.statusCode, timestamp: Date.now(),
          };
          if (isSuccess) {
            cacheEntry.etag = response.headers.etag || null;
            cacheEntry.lastModified = response.headers['last-modified'] || null;
            setBoundedCacheEntry(rssResponseCache, feedUrl, cacheEntry, RSS_CACHE_MAX_ENTRIES);
            rssNegativeCache.delete(feedUrl);
          } else {
            setBoundedCacheEntry(rssNegativeCache, feedUrl, cacheEntry, RSS_NEGATIVE_CACHE_MAX_ENTRIES);
          }
          if (!isSuccess && rssCached) {
            res.writeHead(200, { 'Content-Type': 'application/xml', 'X-Cache': 'STALE' });
            res.end(rssCached.data);
            resolveInFlight({ stale: true });
            return;
          }
          resolveInFlight({ stale: false });
          res.writeHead(response.statusCode, {
            'Content-Type': 'application/xml',
            'X-Cache': 'MISS',
          });
          res.end(data);
        });
      });

      request.on('error', (err) => {
        if (rssCached) {
          res.writeHead(200, { 'Content-Type': 'application/xml', 'X-Cache': 'STALE' });
          res.end(rssCached.data);
          resolveInFlight({ stale: true });
          return;
        }
        rejectInFlight(err);
        safeEnd(res, 502, { 'Content-Type': 'application/json' },
          JSON.stringify({ error: err.message }));
      });

      request.on('timeout', () => {
        request.destroy();
        if (rssCached) {
          res.writeHead(200, { 'Content-Type': 'application/xml', 'X-Cache': 'STALE' });
          res.end(rssCached.data);
          resolveInFlight({ stale: true });
          return;
        }
        rejectInFlight(new Error('timeout'));
        safeEnd(res, 504, { 'Content-Type': 'application/json' },
          JSON.stringify({ error: 'timeout' }));
      });
    });

    rssInFlight.set(feedUrl, fetchPromise);
    fetchPromise.catch(() => {}).finally(() => rssInFlight.delete(feedUrl));
  });

  return { server, cache: rssResponseCache, negativeCache: rssNegativeCache, inFlight: rssInFlight };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('RSS proxy: negative caching prevents thundering herd on 429', async (_t) => {
  const upstream = createMockUpstream();
  upstream.setResponse(429, 'Rate limited');
  const upstreamPort = await listen(upstream.server);

  const proxy = createTestRssProxy(upstreamPort);
  const proxyPort = await listen(proxy.server);

  const feedUrl = `http://example.com/nhk/news/en`;

  // First request — MISS, upstream returns 429
  const r1 = await fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(feedUrl)}`);
  assert.equal(r1.status, 429);
  assert.equal(r1.headers['x-cache'], 'MISS');
  assert.equal(upstream.getHitCount(), 1);

  // Second request — should HIT negative cache, NOT hit upstream again
  const r2 = await fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(feedUrl)}`);
  assert.equal(r2.status, 429);
  assert.equal(r2.headers['x-cache'], 'HIT');
  assert.equal(upstream.getHitCount(), 1, 'Should not hit upstream again — negative cache should serve');

  // Third request — still cached
  const r3 = await fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(feedUrl)}`);
  assert.equal(r3.headers['x-cache'], 'HIT');
  assert.equal(upstream.getHitCount(), 1);

  upstream.server.close();
  proxy.server.close();
});

test('RSS proxy: upstream rejection preserves the last successful body', async (_t) => {
  const upstream = createMockUpstream();
  upstream.setResponse(200, '<rss><channel><title>Fresh</title></channel></rss>');
  const upstreamPort = await listen(upstream.server);

  const proxy = createTestRssProxy(upstreamPort);
  const proxyPort = await listen(proxy.server);
  const feedUrl = 'http://example.com/stale-403';

  const fresh = await fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(feedUrl)}`);
  assert.equal(fresh.status, 200);
  const cached = proxy.cache.get(feedUrl);
  cached.timestamp = Date.now() - 10 * 60 * 1000;

  upstream.setResponse(403, 'Forbidden');
  const stale = await fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(feedUrl)}`);
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['x-cache'], 'STALE');
  assert.match(stale.body, /Fresh/);
  assert.equal(proxy.negativeCache.get(feedUrl).statusCode, 403);

  // A second request is served by the short-lived negative cache while the
  // positive body remains available, exercising the NEGATIVE-STALE branch.
  const negativeStale = await fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(feedUrl)}`);
  assert.equal(negativeStale.status, 200);
  assert.equal(negativeStale.headers['x-cache'], 'NEGATIVE-STALE');
  assert.match(negativeStale.body, /Fresh/);

  upstream.server.close();
  proxy.server.close();
});

test('RSS proxy: concurrent stale followers are deduplicated and served', async (_t) => {
  const upstream = createMockUpstream();
  upstream.setResponse(200, '<rss><channel><title>Fresh</title></channel></rss>');
  const upstreamPort = await listen(upstream.server);

  const proxy = createTestRssProxy(upstreamPort);
  const proxyPort = await listen(proxy.server);
  const feedUrl = 'http://example.com/stale-dedup';

  await fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(feedUrl)}`);
  proxy.cache.get(feedUrl).timestamp = Date.now() - 10 * 60 * 1000;
  upstream.setResponse(503, 'Unavailable');
  upstream.setDelay(100);

  const responses = await Promise.all([
    fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(feedUrl)}`),
    fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(feedUrl)}`),
  ]);
  assert.ok(responses.every((response) => response.status === 200));
  assert.deepEqual(new Set(responses.map((response) => response.headers['x-cache'])), new Set(['STALE', 'DEDUP-STALE']));
  assert.equal(upstream.getHitCount(), 2, 'only the leader should hit upstream after the initial prime');

  upstream.server.close();
  proxy.server.close();
});

test('RSS proxy: successful recovery clears the negative cache', async (_t) => {
  const upstream = createMockUpstream();
  upstream.setResponse(503, 'Unavailable');
  const upstreamPort = await listen(upstream.server);

  const proxy = createTestRssProxy(upstreamPort);
  const proxyPort = await listen(proxy.server);
  const feedUrl = 'http://example.com/recovery';

  const failed = await fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(feedUrl)}`);
  assert.equal(failed.status, 503);
  proxy.negativeCache.get(feedUrl).timestamp = Date.now() - 2 * 60 * 1000;

  upstream.setResponse(200, '<rss><channel><title>Recovered</title></channel></rss>');
  const recovered = await fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(feedUrl)}`);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.headers['x-cache'], 'MISS');
  assert.equal(proxy.negativeCache.has(feedUrl), false);

  const hit = await fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(feedUrl)}`);
  assert.equal(hit.headers['x-cache'], 'HIT');
  assert.equal(upstream.getHitCount(), 2);

  upstream.server.close();
  proxy.server.close();
});

test('RSS proxy: negative cache has its own bounded entry cap', async (_t) => {
  const upstream = createMockUpstream();
  upstream.setResponse(429, 'Rate limited');
  const upstreamPort = await listen(upstream.server);

  const proxy = createTestRssProxy(upstreamPort);
  const proxyPort = await listen(proxy.server);

  for (let i = 0; i < 4; i++) {
    const feedUrl = `http://example.com/negative-${i}`;
    await fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(feedUrl)}`);
  }

  assert.equal(proxy.negativeCache.size, 3);
  assert.equal(proxy.negativeCache.has('http://example.com/negative-0'), false);

  upstream.server.close();
  proxy.server.close();
});

test('RSS proxy: concurrent requests dedup on in-flight, no cascade on failure', async (_t) => {
  const upstream = createMockUpstream();
  upstream.setResponse(503, 'Service Unavailable');
  upstream.setDelay(100); // slow enough for concurrent requests to queue up
  const upstreamPort = await listen(upstream.server);

  const proxy = createTestRssProxy(upstreamPort);
  const proxyPort = await listen(proxy.server);

  const feedUrl = `http://example.com/slow-feed`;

  // Fire 5 concurrent requests
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(feedUrl)}`)
    )
  );

  // Only 1 should be MISS, the rest should be DEDUP (served from negative cache after in-flight resolves)
  const misses = results.filter((r) => r.headers['x-cache'] === 'MISS');
  const deduped = results.filter((r) => r.headers['x-cache'] === 'DEDUP');

  assert.equal(misses.length, 1, 'Exactly 1 MISS (the leader)');
  assert.equal(deduped.length, 4, 'Remaining 4 should be DEDUP');
  assert.equal(upstream.getHitCount(), 1, 'Upstream hit exactly once despite 5 concurrent requests');

  upstream.server.close();
  proxy.server.close();
});

test('RSS proxy: successful 200 response cached with full TTL', async (_t) => {
  const upstream = createMockUpstream();
  upstream.setResponse(200, '<rss><channel><title>OK</title></channel></rss>');
  const upstreamPort = await listen(upstream.server);

  const proxy = createTestRssProxy(upstreamPort);
  const proxyPort = await listen(proxy.server);

  const feedUrl = `http://example.com/good-feed`;

  const r1 = await fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(feedUrl)}`);
  assert.equal(r1.status, 200);
  assert.equal(r1.headers['x-cache'], 'MISS');

  const r2 = await fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(feedUrl)}`);
  assert.equal(r2.status, 200);
  assert.equal(r2.headers['x-cache'], 'HIT');
  assert.equal(upstream.getHitCount(), 1);

  upstream.server.close();
  proxy.server.close();
});

test('RSS proxy: FIFO eviction caps cache size', async (_t) => {
  const upstream = createMockUpstream();
  upstream.setResponse(200, '<rss>OK</rss>');
  const upstreamPort = await listen(upstream.server);

  const proxy = createTestRssProxy(upstreamPort); // max 5 entries
  const proxyPort = await listen(proxy.server);

  // Fill cache with 5 unique URLs
  for (let i = 0; i < 5; i++) {
    await fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(`http://example.com/feed-${i}`)}`);
  }
  assert.equal(proxy.cache.size, 5);

  // 6th URL should evict oldest
  await fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(`http://example.com/feed-new`)}`);
  assert.equal(proxy.cache.size, 5, 'Cache should not exceed max entries');
  assert.ok(!proxy.cache.has('http://example.com/feed-0'), 'Oldest entry should be evicted');
  assert.ok(proxy.cache.has('http://example.com/feed-new'), 'New entry should be present');

  upstream.server.close();
  proxy.server.close();
});

test('RSS proxy: conditional GET returns REVALIDATED on 304', async (_t) => {
  const upstream = createMockUpstream();
  upstream.setResponse(200, '<rss><channel><title>Conditional</title></channel></rss>');
  upstream.setETag('"abc123"');
  const upstreamPort = await listen(upstream.server);

  const proxy = createTestRssProxy(upstreamPort);
  const proxyPort = await listen(proxy.server);

  const feedUrl = `http://example.com/conditional-feed`;

  // First request — MISS, upstream returns 200 with ETag
  const r1 = await fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(feedUrl)}`);
  assert.equal(r1.status, 200);
  assert.equal(r1.headers['x-cache'], 'MISS');
  assert.equal(upstream.getHitCount(), 1);

  // Verify cache entry has etag stored
  const cached = proxy.cache.get(feedUrl);
  assert.equal(cached.etag, '"abc123"');

  // Backdate cache to make it stale
  cached.timestamp = Date.now() - 10 * 60 * 1000;

  // Second request — stale cache, upstream returns 304
  const r2 = await fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(feedUrl)}`);
  assert.equal(r2.status, 200);
  assert.equal(r2.headers['x-cache'], 'REVALIDATED');
  assert.equal(upstream.getHitCount(), 2);
  assert.ok(r2.body.includes('Conditional'), 'Should serve cached body');

  // Verify upstream received If-None-Match header
  assert.equal(upstream.getLastRequestHeaders()['if-none-match'], '"abc123"');

  // Third request — cache refreshed, should be HIT
  const r3 = await fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(feedUrl)}`);
  assert.equal(r3.headers['x-cache'], 'HIT');
  assert.equal(upstream.getHitCount(), 2, 'Should not hit upstream — cache refreshed by 304');

  upstream.server.close();
  proxy.server.close();
});

test('RSS proxy: conditional GET with If-Modified-Since', async (_t) => {
  const upstream = createMockUpstream();
  upstream.setResponse(200, '<rss><channel><title>LM Test</title></channel></rss>');
  upstream.setLastModified('Wed, 01 Jan 2025 00:00:00 GMT');
  const upstreamPort = await listen(upstream.server);

  const proxy = createTestRssProxy(upstreamPort);
  const proxyPort = await listen(proxy.server);

  const feedUrl = `http://example.com/lastmod-feed`;

  // First request — MISS
  const r1 = await fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(feedUrl)}`);
  assert.equal(r1.headers['x-cache'], 'MISS');

  const cached = proxy.cache.get(feedUrl);
  assert.equal(cached.lastModified, 'Wed, 01 Jan 2025 00:00:00 GMT');

  // Backdate cache
  cached.timestamp = Date.now() - 10 * 60 * 1000;

  // Second request — 304 revalidation
  const r2 = await fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(feedUrl)}`);
  assert.equal(r2.headers['x-cache'], 'REVALIDATED');
  assert.equal(upstream.getLastRequestHeaders()['if-modified-since'], 'Wed, 01 Jan 2025 00:00:00 GMT');

  upstream.server.close();
  proxy.server.close();
});

test('RSS proxy: stale-on-error resolves in-flight (no hang)', async (_t) => {
  const upstream = createMockUpstream();
  upstream.setResponse(200, '<rss>Fresh</rss>');
  const upstreamPort = await listen(upstream.server);

  const proxy = createTestRssProxy(upstreamPort);
  const proxyPort = await listen(proxy.server);

  const feedUrl = `http://example.com/stale-test`;

  // Prime the cache
  const r1 = await fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(feedUrl)}`);
  assert.equal(r1.status, 200);
  assert.equal(r1.headers['x-cache'], 'MISS');

  // Now make the cache entry "stale" by backdating its timestamp
  const entry = proxy.cache.get(feedUrl);
  entry.timestamp = Date.now() - 10 * 60 * 1000; // 10 min ago

  // Kill upstream so the fetch will fail
  upstream.server.close();
  await new Promise((r) => setTimeout(r, 50));

  // Request should get stale data (not hang forever)
  const r2Promise = fetch(`http://127.0.0.1:${proxyPort}/?url=${encodeURIComponent(feedUrl)}`);
  const r2 = await Promise.race([
    r2Promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Request hung — in-flight not settled')), 3000)),
  ]);

  // Should get stale or error, but NOT hang
  assert.ok(r2.status === 200 || r2.status === 502, `Expected stale/error, got ${r2.status}`);

  // Verify in-flight map is clean
  assert.equal(proxy.inFlight.size, 0, 'In-flight map should be empty after settlement');

  proxy.server.close();
});

test('RSS fallback exhaustion: repeated failures stop at the bounded cooldown cap', () => {
  const delays = [0, 1, 2, 3, 4, 5].map((failures) => nextBackoffMs(failures, 60_000, 900_000));
  // Each delay is deterministic-base ±25% jitter, capped at maxMs.
  assert.ok(delays[0] >= 45_000 && delays[0] <= 75_000, `delay[0]=${delays[0]} out of range`);
  assert.ok(delays[1] >= 90_000 && delays[1] <= 150_000, `delay[1]=${delays[1]} out of range`);
  assert.ok(delays[2] >= 180_000 && delays[2] <= 300_000, `delay[2]=${delays[2]} out of range`);
  assert.ok(delays[3] >= 360_000 && delays[3] <= 600_000, `delay[3]=${delays[3]} out of range`);
  assert.ok(delays[4] >= 675_000 && delays[4] <= 900_000, `delay[4]=${delays[4]} out of range (capped)`);
  assert.ok(delays[5] >= 675_000 && delays[5] <= 900_000, `delay[5]=${delays[5]} out of range (capped)`);
});
