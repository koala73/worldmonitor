// Tests for scripts/seed-unrest-events.mjs — GDELT proxy retry + multi-theme
// fan-out aggregation.
//
// Proxy-retry contract (locked since PR #3395):
//
//   1. Single attempt success — happy path, no retries fire.
//   2. Transient proxy failure recoverable by retry — first attempt(s)
//      fail, a later attempt succeeds, returns parsed JSON.
//   3. All attempts fail — throws the LAST error so ops sees the most
//      recent failure mode (Cloudflare 522 vs ECONNRESET drift).
//   4. Malformed proxy body — JSON.parse throws SyntaxError; the helper
//      bails immediately rather than burning attempts on a deterministic
//      parse failure.
//   5. Missing CONNECT proxy creds — fetchGdeltEvents throws with a
//      clear "PROXY_URL env var is not set" pointer for ops, with NO
//      proxy fetcher invocation (no wasted network).
//
// Fan-out aggregation contract (PR #3853 — switched from a single keyword
// query to N theme-tag calls fanned out + merged):
//
//   6. End-to-end happy path with a transient flake on theme 1 — retries
//      succeed and events aggregate across all themes.
//   7. All proxy attempts fail across every theme — throws last error.
//   8. Fan-out merges counts at the same location across themes (the
//      load-bearing claim of the PR — that a hotspot mentioned under
//      multiple themes sums into one event, not duplicates).
//   9. One theme's proxy fails fatally — surviving themes still aggregate
//      (the anyThemeSucceeded partial-failure path).
//   10. Multi-location article: composite (url, lat/lon) dedup lets the
//       same URL count at TWO different locations. URL-only dedup would
//       collapse one of them.
//   11. Multi-field URL resolution: a feature exposing only source_url
//       (not url) is still deduped across themes — extractGdeltSourceUrls
//       resolves it before the dedup key is built.
//
// Pre-PR-#3395 behaviour to AVOID regressing into:
//   - Direct fetch was tried first and failed UND_ERR_CONNECT_TIMEOUT
//     on every Railway tick (0% success). Re-introducing a "soft"
//     direct fallback would just add latency and log noise.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const { fetchGdeltViaProxy, fetchGdeltEvents } = await import('../scripts/seed-unrest-events.mjs');

const URL = 'https://api.gdeltproject.org/api/v1/gkg_geojson?query=test';
const PROXY_AUTH = 'user:pass@gate.decodo.com:7000';

function jsonBuffer(obj) {
  return { buffer: Buffer.from(JSON.stringify(obj), 'utf8') };
}

const noSleep = async () => {};
const noJitter = () => 0;

// ─── 1. happy path: first attempt succeeds ─────────────────────────────

test('proxy success on first attempt → returns parsed JSON, no retries', async () => {
  let calls = 0;
  const _proxyFetcher = async () => {
    calls++;
    return jsonBuffer({ features: [{ name: 'A' }] });
  };
  const result = await fetchGdeltViaProxy(URL, PROXY_AUTH, {
    _proxyFetcher,
    _sleep: noSleep,
    _jitter: noJitter,
  });
  assert.deepEqual(result, { features: [{ name: 'A' }] });
  assert.equal(calls, 1, 'should NOT retry on success');
});

// ─── 2. transient flake: 2 failures + 1 success ────────────────────────

test('two proxy failures, third attempt succeeds → returns parsed JSON', async () => {
  let calls = 0;
  const _proxyFetcher = async () => {
    calls++;
    if (calls < 3) throw new Error(`Proxy CONNECT: HTTP/1.1 522 Server Error`);
    return jsonBuffer({ features: [{ name: 'B' }] });
  };
  let sleepCount = 0;
  const _sleep = async () => { sleepCount++; };
  const result = await fetchGdeltViaProxy(URL, PROXY_AUTH, {
    _proxyFetcher,
    _sleep,
    _jitter: noJitter,
    _maxAttempts: 3,
  });
  assert.deepEqual(result, { features: [{ name: 'B' }] });
  assert.equal(calls, 3, 'should retry until success');
  assert.equal(sleepCount, 2, 'should sleep between attempts only (not after final)');
});

// ─── 3. all attempts fail ──────────────────────────────────────────────

test('all attempts fail → throws LAST error', async () => {
  let calls = 0;
  const errors = [
    new Error('Proxy CONNECT: HTTP/1.1 522 Server Error'),
    new Error('CONNECT tunnel timeout'),
    new Error('Client network socket disconnected'),
  ];
  const _proxyFetcher = async () => {
    throw errors[calls++];
  };
  await assert.rejects(
    fetchGdeltViaProxy(URL, PROXY_AUTH, {
      _proxyFetcher,
      _sleep: noSleep,
      _jitter: noJitter,
      _maxAttempts: 3,
    }),
    /Client network socket disconnected/,
  );
  assert.equal(calls, 3);
});

// ─── 4. parse failure short-circuits retry ─────────────────────────────

test('malformed proxy body → throws SyntaxError immediately, no retry', async () => {
  let calls = 0;
  const _proxyFetcher = async () => {
    calls++;
    return { buffer: Buffer.from('<html>this is not json</html>', 'utf8') };
  };
  await assert.rejects(
    fetchGdeltViaProxy(URL, PROXY_AUTH, {
      _proxyFetcher,
      _sleep: noSleep,
      _jitter: noJitter,
      _maxAttempts: 3,
    }),
    SyntaxError,
  );
  assert.equal(calls, 1, 'parse error must not trigger retries');
});

// ─── 5. fetchGdeltEvents: missing proxy creds ──────────────────────────

test('fetchGdeltEvents with no proxy creds → throws clear ops-actionable error, no fetcher call', async () => {
  let fetcherCalled = false;
  await assert.rejects(
    fetchGdeltEvents({
      _resolveProxyForConnect: () => null,
      _proxyFetcher: async () => { fetcherCalled = true; return jsonBuffer({}); },
      _sleep: noSleep,
      _jitter: noJitter,
    }),
    /PROXY_URL env var is not set/,
  );
  assert.equal(fetcherCalled, false, 'must not attempt proxy fetch when creds missing');
});

test('fetchGdeltEvents default inter-theme delay stays above documented GDELT pacing floor', async () => {
  let calls = 0;
  const sleeps = [];
  const _proxyFetcher = async () => {
    calls++;
    return jsonBuffer({ features: [] });
  };
  const events = await fetchGdeltEvents({
    _resolveProxyForConnect: () => PROXY_AUTH,
    _proxyFetcher,
    _sleep: async (ms) => { sleeps.push(ms); },
    _maxAttempts: 1,
  });
  assert.equal(calls, 3, 'one call per UNREST_THEMES entry');
  assert.deepEqual(events, [], 'valid empty GDELT payloads should still be successful');
  assert.equal(sleeps.length, 2, 'three themes should produce two inter-theme sleeps');
  assert.ok(
    sleeps.every((ms) => ms >= 5_500),
    `default inter-theme sleeps must be >= 5500ms; got ${sleeps.join(', ')}`,
  );
});

// ─── 6. fetchGdeltEvents: end-to-end with retry path ───────────────────

test('fetchGdeltEvents with one transient proxy failure → recovers and aggregates events', async () => {
  let calls = 0;
  const _proxyFetcher = async () => {
    calls++;
    if (calls === 1) throw new Error('Proxy CONNECT: HTTP/1.1 522 Server Error');
    // Five mentions at the same lat/lon — passes the count >= 5 floor in the aggregator.
    const features = Array.from({ length: 5 }, () => ({
      properties: { name: 'Cairo, Egypt', urltone: -3 },
      geometry: { type: 'Point', coordinates: [31.2, 30.0] },
    }));
    features[0].properties.url = 'https://example.com/cairo-protest';
    features[1].properties.source_url = 'https://news.example.org/cairo-protest';
    return jsonBuffer({ features });
  };
  const events = await fetchGdeltEvents({
    _resolveProxyForConnect: () => PROXY_AUTH,
    _proxyFetcher,
    _sleep: noSleep,
    _jitter: noJitter,
    _maxAttempts: 3,
  });
  // Theme 1: 1 throw + 1 retry-success. Themes 2 & 3: 1 call each. Total = 4.
  assert.equal(calls, 4, 'theme 1: 1 throw + 1 retry; themes 2,3: 1 call each');
  // Per theme: 5 features (urls A, B, then 3 with no URL). Across the 3 themes
  // the (A|loc) and (B|loc) dedup keys block re-counting, but the 3 no-URL
  // features always count → 5 (theme 1) + 3 + 3 = 11.
  assert.equal(events.length, 1, '11 deduped mentions at one location → one aggregated event');
  assert.match(events[0].title, /11 reports/, 'composite dedup blocks A and B from inflating across themes');
  assert.equal(events[0].country, 'Egypt');
  assert.deepEqual(events[0].sourceUrls, [
    'https://example.com/cairo-protest',
    'https://news.example.org/cairo-protest',
  ]);
});

// ─── 7. fetchGdeltEvents: every proxy call fails ──────────────────────────

test('fetchGdeltEvents with all proxy attempts failing → throws last error', async () => {
  let calls = 0;
  const _proxyFetcher = async () => {
    calls++;
    throw new Error(`Proxy CONNECT: HTTP/1.1 522 Server Error`);
  };
  await assert.rejects(
    fetchGdeltEvents({
      _resolveProxyForConnect: () => PROXY_AUTH,
      _proxyFetcher,
      _sleep: noSleep,
      _jitter: noJitter,
      _maxAttempts: 3,
    }),
    /HTTP\/1\.1 522 Server Error/,
  );
  assert.equal(calls, 9, 'should retry the max number of attempts times 3 (there are 3 queries in fetchGdeltEvents)');
});

// ─── 8. fetchGdeltEvents: fan-out merges counts across themes ─────────────

test('three themes hitting same location → counts sum into one merged event', async () => {
  let calls = 0;
  const _proxyFetcher = async () => {
    calls++;
    // 2 unique-URL features at Cairo per theme. No cross-theme URL overlap,
    // so dedup is a no-op and all 6 (2 × 3 themes) must reach the location.
    const features = Array.from({ length: 2 }, (_, j) => ({
      properties: { name: 'Cairo, Egypt', urltone: -3, url: `https://ex.com/${calls}-${j}` },
      geometry: { type: 'Point', coordinates: [31.2, 30.0] },
    }));
    return jsonBuffer({ features });
  };
  const events = await fetchGdeltEvents({
    _resolveProxyForConnect: () => PROXY_AUTH,
    _proxyFetcher,
    _sleep: noSleep,
    _jitter: noJitter,
    _maxAttempts: 1,
  });
  assert.equal(calls, 3, 'one call per UNREST_THEMES entry');
  assert.equal(events.length, 1, 'three themes at one location → one merged event');
  assert.match(events[0].title, /Cairo.*6 reports/, 'counts sum across themes (2 × 3 = 6)');
});

// ─── 9. fetchGdeltEvents: partial-failure tolerance ───────────────────────

test('one theme proxy fails fatally, others succeed → still aggregates from survivors', async () => {
  let calls = 0;
  const _proxyFetcher = async () => {
    calls++;
    // Theme 1 dies for good (only 1 attempt, no retry); themes 2 and 3 succeed.
    if (calls === 1) throw new Error('Proxy CONNECT: HTTP/1.1 522 Server Error');
    const features = Array.from({ length: 5 }, (_, j) => ({
      properties: { name: 'Gaza, Palestine', urltone: -5, url: `https://ex.com/${calls}-${j}` },
      geometry: { type: 'Point', coordinates: [34.4, 31.5] },
    }));
    return jsonBuffer({ features });
  };
  const events = await fetchGdeltEvents({
    _resolveProxyForConnect: () => PROXY_AUTH,
    _proxyFetcher,
    _sleep: noSleep,
    _jitter: noJitter,
    _maxAttempts: 1,
  });
  assert.equal(calls, 3, 'theme 1 failure must NOT short-circuit themes 2 and 3');
  assert.equal(events.length, 1, 'two surviving themes × 5 features → 10 mentions → 1 event');
  assert.match(events[0].title, /Gaza.*10 reports/);
  assert.equal(events[0].country, 'Palestine');
});

// ─── 10. composite (url, lat/lon) dedup preserves multi-location articles ─

test('same article URL at two different locations → both locations counted (composite dedup)', async () => {
  // GKG v1 emits one feature per (article, location). The dedup key must be
  // composite (url|lat-lon) so an article mentioning Cairo + Alexandria still
  // contributes to BOTH location buckets. URL-only dedup would skip Alexandria
  // after Cairo claimed the URL first, leaving Alex undercounted by 1 mention
  // per theme (Cairo=13, Alex=12 instead of both=13).
  const sharedUrl = 'https://ex.com/multi-location-article';
  let calls = 0;
  const _proxyFetcher = async () => {
    calls++;
    const features = [
      // The shared article appears at BOTH locations under every theme
      { properties: { name: 'Cairo, Egypt',      urltone: -3, url: sharedUrl }, geometry: { type: 'Point', coordinates: [31.2, 30.0] } },
      { properties: { name: 'Alexandria, Egypt', urltone: -3, url: sharedUrl }, geometry: { type: 'Point', coordinates: [29.9, 31.2] } },
      // Padding with unique URLs so each location clears the count >= 5 floor
      ...Array.from({ length: 4 }, (_, j) => ({
        properties: { name: 'Cairo, Egypt', urltone: -3, url: `https://ex.com/cai-${calls}-${j}` },
        geometry: { type: 'Point', coordinates: [31.2, 30.0] },
      })),
      ...Array.from({ length: 4 }, (_, j) => ({
        properties: { name: 'Alexandria, Egypt', urltone: -3, url: `https://ex.com/alx-${calls}-${j}` },
        geometry: { type: 'Point', coordinates: [29.9, 31.2] },
      })),
    ];
    return jsonBuffer({ features });
  };
  const events = await fetchGdeltEvents({
    _resolveProxyForConnect: () => PROXY_AUTH,
    _proxyFetcher,
    _sleep: noSleep,
    _jitter: noJitter,
    _maxAttempts: 1,
  });
  assert.equal(calls, 3);
  assert.equal(events.length, 2, 'both locations survive — composite dedup did not collapse the shared URL');
  const byCity = Object.fromEntries(events.map((e) => [e.title.split(',')[0], e]));
  // Shared URL counts once at each location (theme 1 only — themes 2,3 deduped),
  // plus 4 padding mentions per theme × 3 themes = 12. Total per city: 13.
  assert.match(byCity['Cairo'].title, /13 reports/);
  assert.match(byCity['Alexandria'].title, /13 reports/, 'URL-only dedup would leave Alexandria at 12 reports');
});

// ─── 11. multi-field URL resolution for dedup ─────────────────────────────

test('feature exposing only source_url (no url field) is still deduped across themes', async () => {
  // extractGdeltSourceUrls walks 7 URL fields. If the dedup key only checked
  // properties.url, features carrying source_url/document_url/article_url
  // would bypass dedup entirely and inflate counts 3× across the fan-out.
  let calls = 0;
  const _proxyFetcher = async () => {
    calls++;
    // Same 5 articles (by source_url) repeat in every theme call.
    const features = Array.from({ length: 5 }, (_, j) => ({
      properties: { name: 'Tehran, Iran', urltone: -4, source_url: `https://ex.com/article-${j}` },
      geometry: { type: 'Point', coordinates: [51.4, 35.7] },
    }));
    return jsonBuffer({ features });
  };
  const events = await fetchGdeltEvents({
    _resolveProxyForConnect: () => PROXY_AUTH,
    _proxyFetcher,
    _sleep: noSleep,
    _jitter: noJitter,
    _maxAttempts: 1,
  });
  assert.equal(calls, 3);
  assert.equal(events.length, 1);
  assert.match(events[0].title, /5 reports/, 'source_url-only features deduped across themes (NOT 15)');
});
