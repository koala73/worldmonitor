// Tests for the GDELT proxy retry path in scripts/seed-unrest-events.mjs.
//
// Locks the behavioural contract introduced in PR #3395:
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
    return jsonBuffer({ features });
  };
  const events = await fetchGdeltEvents({
    _resolveProxyForConnect: () => PROXY_AUTH,
    _proxyFetcher,
    _sleep: noSleep,
    _jitter: noJitter,
    _maxAttempts: 3,
  });
  assert.equal(calls, 2, 'should retry exactly once after the 522');
  assert.equal(events.length, 1, 'five mentions at one location → one aggregated event');
  assert.equal(events[0].country, 'Egypt');
});
