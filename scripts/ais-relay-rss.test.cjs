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

  const server = http.createServer((req, res) => {
    hitCount++;
    setTimeout(() => {
      res.writeHead(responseStatus, { 'Content-Type': 'application/xml' });
      res.end(responseBody);
    }, responseDelay);
  });

  return {
    server,
    getHitCount: () => hitCount,
    resetHitCount: () => { hitCount = 0; },
    setResponse: (status, body) => { responseStatus = status; responseBody = body || responseBody; },
    setDelay: (ms) => { responseDelay = ms; },
  };
}

// ─── Create a minimal ais-relay-like RSS proxy for testing ────────────────────
// Extracts just the RSS caching logic to test in isolation.

function createTestRssProxy(upstreamPort) {
  const https = require('node:http'); // use http for testing, not https
  const zlib = require('node:zlib');

  const rssResponseCache = new Map();
  const rssInFlight = new Map();
  const RSS_CACHE_TTL_MS = 5 * 60 * 1000;
  const RSS_NEGATIVE_CACHE_TTL_MS = 60 * 1000;
  const RSS_CACHE_MAX_ENTRIES = 5; // small cap for testing

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

    // Cache check with status-aware TTL
    const rssCached = rssResponseCache.get(feedUrl);
    if (rssCached) {
      const ttl = (rssCached.statusCode >= 200 && rssCached.statusCode < 300)
        ? RSS_CACHE_TTL_MS : RSS_NEGATIVE_CACHE_TTL_MS;
      if (Date.now() - rssCached.timestamp < ttl) {
        res.writeHead(rssCached.statusCode, {
          'Content-Type': 'application/xml',
          'X-Cache': 'HIT',
        });
        return res.end(rssCached.data);
      }
    }

    // In-flight dedup — cascade-resistant
    const existing = rssInFlight.get(feedUrl);
    if (existing) {
      try {
        await existing;
        const deduped = rssResponseCache.get(feedUrl);
        if (deduped) {
          res.writeHead(deduped.statusCode, {
            'Content-Type': 'application/xml',
            'X-Cache': 'DEDUP',
          });
          return res.end(deduped.data);
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
      const request = http.get(`http://127.0.0.1:${upstreamPort}${new URL(feedUrl).pathname}`, {
        timeout: 5000,
      }, (response) => {
        const chunks = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => {
          const data = Buffer.concat(chunks);
          // FIFO eviction
          if (rssResponseCache.size >= RSS_CACHE_MAX_ENTRIES && !rssResponseCache.has(feedUrl)) {
            const oldest = rssResponseCache.keys().next().value;
            if (oldest) rssResponseCache.delete(oldest);
          }
          rssResponseCache.set(feedUrl, {
            data, contentType: 'application/xml',
            statusCode: response.statusCode, timestamp: Date.now(),
          });
          resolveInFlight();
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
          resolveInFlight();
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
          resolveInFlight();
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

  return { server, cache: rssResponseCache, inFlight: rssInFlight };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('RSS proxy: negative caching prevents thundering herd on 429', async (t) => {
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

test('RSS proxy: concurrent requests dedup on in-flight, no cascade on failure', async (t) => {
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

test('RSS proxy: successful 200 response cached with full TTL', async (t) => {
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

test('RSS proxy: FIFO eviction caps cache size', async (t) => {
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

test('RSS proxy: stale-on-error resolves in-flight (no hang)', async (t) => {
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
