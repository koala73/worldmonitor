import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const TEST_KEY = 'rss-proxy-test-key';

process.env.WORLDMONITOR_VALID_KEYS = TEST_KEY;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { default: handler, __testing__ } = await import('./rss-proxy.js');
const { RELAY_ONLY_DOMAINS } = __testing__;
const { __resetRateLimitForTest } = await import('./_rate-limit.js');
const { default: isAllowedDomain } = await import('./_rss-allowed-domain-match.js');

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

const PROXY_ENDPOINT = 'https://api.worldmonitor.app/api/rss-proxy';

/**
 * @param {string | null} feedUrl  feed to proxy; `null` omits the `url` param
 *   entirely (the missing-parameter case). Passed through encodeURIComponent
 *   so malformed values survive the query string verbatim.
 * @param {{ method?: string, origin?: string | null, apiKey?: string | null }} [opts]
 *   `origin: null` / `apiKey: null` omit that header rather than sending it
 *   empty — the handler distinguishes absent from present-but-wrong.
 */
function makeRequest(feedUrl, opts = {}) {
  const { method = 'GET', origin = 'https://worldmonitor.app', apiKey = TEST_KEY } = opts;
  const url = feedUrl === null
    ? PROXY_ENDPOINT
    : `${PROXY_ENDPOINT}?url=${encodeURIComponent(feedUrl)}`;
  const headers = {};
  if (origin !== null) headers.Origin = origin;
  if (apiKey !== null) headers['X-WorldMonitor-Key'] = apiKey;
  return new Request(url, { method, headers });
}

/**
 * Installs a fetch spy and returns the recorded call list. Any fetch the
 * handler makes is recorded; `respond` decides the reply (default: a 200 feed).
 * Guards that reject *before* fetching assert `calls` stays empty — that is the
 * assertion with teeth, since a bypassed guard shows up as an upstream call.
 */
function spyFetch(respond = () => new Response('<rss/>', { status: 200 })) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), redirect: init.redirect, headers: init.headers });
    return respond(String(input), init, calls);
  };
  return calls;
}

/** Feed hosts these tests treat as "reachable upstream" — used to prove a
 *  guard fired before any feed fetch, while ignoring Upstash/relay traffic. */
function feedCalls(calls) {
  return calls.filter((c) => !c.url.includes('upstash') && !c.url.includes('relay.example.com'));
}

beforeEach(() => {
  process.env.WORLDMONITOR_VALID_KEYS = TEST_KEY;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.WS_RELAY_URL;
  delete process.env.RELAY_SHARED_SECRET;
  // getRatelimit() caches limiters in a module-level Map keyed by policy, so a
  // limiter built against the fake Upstash host in one test would survive into
  // the next even after the env vars are deleted. Reset the cache each time.
  __resetRateLimitForTest();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
  __resetRateLimitForTest();
});

test('rejects allowlisted redirect chains that escape the RSS domain allowlist on a later hop', async () => {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), redirect: init.redirect });
    if (calls.length === 1) {
      return new Response('', {
        status: 302,
        headers: { Location: 'https://www.techcrunch.com/feed' },
      });
    }
    if (calls.length === 2) {
      return new Response('', {
        status: 302,
        headers: { Location: 'http://169.254.169.254/latest/meta-data' },
      });
    }
    throw new Error(`unexpected fetch after disallowed redirect: ${input}`);
  };

  const res = await handler(makeRequest('https://techcrunch.com/feed'));
  const body = await res.json();

  assert.equal(res.status, 403);
  assert.equal(body.error, 'Redirect to disallowed domain');
  assert.deepEqual(calls.map((call) => call.url), [
    'https://techcrunch.com/feed',
    'https://www.techcrunch.com/feed',
  ]);
  assert.deepEqual(calls.map((call) => call.redirect), ['manual', 'manual']);
});

test('allows legitimate apex to www RSS canonical redirects', async () => {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), redirect: init.redirect });
    if (calls.length === 1) {
      return new Response('', {
        status: 301,
        headers: { Location: 'https://www.techcrunch.com/feed' },
      });
    }
    return new Response('<rss><channel><title>ok</title></channel></rss>', {
      status: 200,
      headers: { 'Content-Type': 'application/rss+xml' },
    });
  };

  const res = await handler(makeRequest('https://techcrunch.com/feed'));

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/rss+xml');
  assert.match(await res.text(), /<rss>/);
  assert.deepEqual(calls.map((call) => call.url), [
    'https://techcrunch.com/feed',
    'https://www.techcrunch.com/feed',
  ]);
  assert.deepEqual(calls.map((call) => call.redirect), ['manual', 'manual']);
});

test('rejects redirects that switch away from http or https', async () => {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), redirect: init.redirect });
    return new Response('', {
      status: 302,
      headers: { Location: 'file:///etc/passwd' },
    });
  };

  const res = await handler(makeRequest('https://techcrunch.com/feed'));
  const body = await res.json();

  assert.equal(res.status, 403);
  assert.equal(body.error, 'Redirect protocol not allowed');
  assert.deepEqual(calls, [{ url: 'https://techcrunch.com/feed', redirect: 'manual' }]);
});

test('rejects direct RSS fetches that exceed the redirect limit', async () => {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), redirect: init.redirect });
    return new Response('', {
      status: 302,
      headers: { Location: `https://www.techcrunch.com/feed-hop-${calls.length}` },
    });
  };

  const res = await handler(makeRequest('https://techcrunch.com/feed'));
  const body = await res.json();

  assert.equal(res.status, 502);
  assert.equal(body.error, 'Too many redirects');
  assert.deepEqual(calls.map((call) => call.url), [
    'https://techcrunch.com/feed',
    'https://www.techcrunch.com/feed-hop-1',
    'https://www.techcrunch.com/feed-hop-2',
    'https://www.techcrunch.com/feed-hop-3',
  ]);
  assert.deepEqual(calls.map((call) => call.redirect), ['manual', 'manual', 'manual', 'manual']);
});

test('preserves Railway relay fallback for direct-fetch transport failures', async () => {
  process.env.WS_RELAY_URL = 'wss://relay.example.com';
  process.env.RELAY_SHARED_SECRET = 'relay-secret';
  const calls = [];

  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), headers: init.headers });
    if (calls.length === 1) {
      throw new Error('direct fetch failed');
    }
    return new Response('<rss><channel><title>relay</title></channel></rss>', {
      status: 200,
      headers: { 'Content-Type': 'application/xml' },
    });
  };

  const feedUrl = 'https://techcrunch.com/feed';
  const res = await handler(makeRequest(feedUrl));

  assert.equal(res.status, 200);
  assert.match(await res.text(), /relay/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, feedUrl);
  assert.equal(calls[1].url, `https://relay.example.com/rss?url=${encodeURIComponent(feedUrl)}`);
  assert.equal(calls[1].headers['x-relay-key'], 'relay-secret');
});

// ---------------------------------------------------------------------------
// Initial-host SSRF allowlist guard (#5378)
//
// These lock `isAllowedDomain(parsedUrl.hostname)` in api/rss-proxy.js. The
// adversarial sweep flagged "hostname/userinfo confusion" as a possible
// BYPASS; probing WHATWG `new URL()` shows it is not — userinfo is stripped
// into `username`/`password` and a suffix-confusion host stays intact, so both
// resolve to a non-allowlisted `hostname` and 403. What the sweep actually
// found is that the guard had ZERO coverage: deleting it changed nothing in
// the suite while the handler happily fetched the attacker host. That is what
// these tests close. The teeth are `calls` staying empty — a 403 alone can be
// produced by an unrelated failure, but "never touched the network" cannot.
// ---------------------------------------------------------------------------

test('rejects suffix-confusion hosts that merely start with an allowlisted domain', async () => {
  const calls = spyFetch();

  const res = await handler(makeRequest('https://techcrunch.com.attacker.example/feed'));
  const body = await res.json();

  assert.equal(res.status, 403);
  assert.equal(body.error, 'Domain not allowed');
  assert.deepEqual(calls, [], 'attacker host must never be fetched');
});

test('rejects userinfo-confusion URLs whose real host is not allowlisted', async () => {
  const calls = spyFetch();

  const res = await handler(makeRequest('https://techcrunch.com@attacker.example/feed'));
  const body = await res.json();

  assert.equal(res.status, 403);
  assert.equal(body.error, 'Domain not allowed');
  assert.deepEqual(calls, [], 'attacker host must never be fetched');
});

test('rejects a trailing-dot FQDN form of an allowlisted host', async () => {
  const calls = spyFetch();

  const res = await handler(makeRequest('https://techcrunch.com./feed'));

  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'Domain not allowed');
  assert.deepEqual(calls, []);
});

test('rejects link-local metadata addresses supplied as the initial url', async () => {
  const calls = spyFetch();

  const res = await handler(makeRequest('http://169.254.169.254/latest/meta-data'));

  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'Domain not allowed');
  assert.deepEqual(calls, [], 'metadata endpoint must never be fetched');
});

test('allows an allowlisted host supplied in mixed case (URL normalizes it)', async () => {
  const calls = spyFetch(() => new Response('<rss><channel/></rss>', {
    status: 200,
    headers: { 'Content-Type': 'application/rss+xml' },
  }));

  const res = await handler(makeRequest('https://TechCrunch.COM/feed'));

  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://techcrunch.com/feed');
});

test('every relay-only domain is also in the RSS allowlist', () => {
  // Drift guard: RELAY_ONLY_DOMAINS is matched with exact `.has(hostname)`,
  // but the allowlist check runs FIRST. A relay-only host missing from the
  // allowlist would 403 before the relay routing it exists for is ever used.
  const orphans = [...RELAY_ONLY_DOMAINS].filter((host) => !isAllowedDomain(host));
  assert.deepEqual(orphans, [], `relay-only hosts missing from the RSS allowlist: ${orphans.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Pre-fetch gates: auth, rate limit, protocol (#5378)
//
// All three run BEFORE any upstream fetch. Each test asserts the status AND
// that no feed request escaped — the sweep's mutations (dropping the 401
// return, ignoring rateLimitResponse) manifested as an upstream fetch with a
// 502/200, so the "no feed call" assertion is what actually kills them.
// ---------------------------------------------------------------------------

test('rejects requests with no API key before fetching the feed', async () => {
  const calls = spyFetch();

  const res = await handler(makeRequest('https://techcrunch.com/feed', { apiKey: null }));

  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'API key required');
  assert.deepEqual(calls, [], 'unauthenticated request must not reach upstream');
});

test('rejects requests with an invalid API key before fetching the feed', async () => {
  const calls = spyFetch();

  const res = await handler(makeRequest('https://techcrunch.com/feed', { apiKey: 'wrong-key' }));

  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'Invalid API key');
  assert.deepEqual(calls, [], 'invalid-key request must not reach upstream');
});

test('returns 429 and skips the feed fetch when the rate limit is exhausted', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

  // Upstash sliding-window EVAL reply shape: [remaining, limit]. A negative
  // remaining means blocked, and the second element surfaces as `limit` on the
  // limiter verdict — hence 600, the handler's default policy (mirrors the
  // `[-1, 30]` mock for the 30/min policy in api/_rate-limit.test.mjs).
  const calls = spyFetch(() => new Response(
    JSON.stringify([{ result: [-1, 600] }]),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ));

  const res = await handler(makeRequest('https://techcrunch.com/feed'));

  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'Too many requests');
  assert.equal(res.headers.get('X-RateLimit-Limit'), '600');
  assert.equal(res.headers.get('X-RateLimit-Remaining'), '0');
  assert.match(res.headers.get('Retry-After') ?? '', /^\d+$/);
  assert.deepEqual(
    feedCalls(calls).map((c) => c.url),
    [],
    'rate-limited request must not reach the feed',
  );
});

test('allows the request through when the rate limiter reports headroom', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

  // Positive counterpart to the 429 case: proves the 429 above is produced by
  // the limiter verdict, not merely by Upstash being configured at all.
  const calls = spyFetch((url) => (
    url.includes('fake-upstash')
      ? new Response(JSON.stringify([{ result: [599, 600] }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
      : new Response('<rss><channel/></rss>', {
        status: 200,
        headers: { 'Content-Type': 'application/rss+xml' },
      })
  ));

  const res = await handler(makeRequest('https://techcrunch.com/feed'));

  assert.equal(res.status, 200);
  assert.deepEqual(feedCalls(calls).map((c) => c.url), ['https://techcrunch.com/feed']);
});

test('rejects a non-http initial url with 400, not the 403 domain verdict', async () => {
  const calls = spyFetch();

  const res = await handler(makeRequest('file:///etc/passwd'));

  // Status is the assertion with teeth: `file:` also fails the allowlist
  // (hostname is ''), so only the 400 distinguishes the protocol guard from
  // the domain guard. The sweep's mutation flipped exactly this status.
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'URL protocol not allowed');
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Request-shape handling (#5378)
// ---------------------------------------------------------------------------

test('returns 400 when the url parameter is missing entirely', async () => {
  const calls = spyFetch();

  const res = await handler(makeRequest(null));

  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Missing url parameter');
  assert.deepEqual(calls, []);
});

test('returns 400 (not 502) for a malformed url parameter', async () => {
  const calls = spyFetch();

  // Regression for WORLDMONITOR-TT: `new URL()` throwing inside the try block
  // was reported to Sentry at error level and answered 502. It is a client
  // error and must be caught by the pre-try parse.
  const res = await handler(makeRequest('not-a-url'));

  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Invalid url parameter');
  assert.deepEqual(calls, []);
});

test('answers CORS preflight with 204 and no upstream call', async () => {
  const calls = spyFetch();

  const res = await handler(makeRequest('https://techcrunch.com/feed', { method: 'OPTIONS' }));

  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://worldmonitor.app');
  assert.match(res.headers.get('Access-Control-Allow-Methods') ?? '', /GET/);
  assert.deepEqual(calls, []);
});

test('rejects non-GET methods with 405', async () => {
  const calls = spyFetch();

  const res = await handler(makeRequest('https://techcrunch.com/feed', { method: 'POST' }));

  assert.equal(res.status, 405);
  assert.equal((await res.json()).error, 'Method not allowed');
  assert.deepEqual(calls, []);
});

test('rejects a disallowed Origin before auth, method, or fetch', async () => {
  const calls = spyFetch();

  const res = await handler(makeRequest('https://techcrunch.com/feed', { origin: 'https://evil.example' }));

  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'Origin not allowed');
  // Never echo the attacker origin back.
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://worldmonitor.app');
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Routing + response policy (#5378)
// ---------------------------------------------------------------------------

test('routes relay-only domains straight to Railway with the long cache policy', async () => {
  process.env.WS_RELAY_URL = 'wss://relay.example.com';
  process.env.RELAY_SHARED_SECRET = 'relay-secret';

  const feedUrl = 'https://rss.cnn.com/rss/edition.rss';
  const calls = spyFetch(() => new Response('<rss><channel><title>cnn</title></channel></rss>', {
    status: 200,
    headers: { 'Content-Type': 'application/rss+xml' },
  }));

  const res = await handler(makeRequest(feedUrl));

  assert.equal(res.status, 200);
  // Exactly one call, to the relay — the direct fetch is skipped entirely
  // because Vercel edge IPs are blocked by these hosts.
  assert.deepEqual(calls.map((c) => c.url), [
    `https://relay.example.com/rss?url=${encodeURIComponent(feedUrl)}`,
  ]);
  assert.equal(
    res.headers.get('Cache-Control'),
    'public, max-age=600, s-maxage=3600, stale-while-revalidate=7200, stale-if-error=14400',
  );
  assert.equal(
    res.headers.get('CDN-Cache-Control'),
    'public, s-maxage=3600, stale-while-revalidate=7200, stale-if-error=14400',
  );
});

test('applies the short cache policy to a successful non-relay-only feed', async () => {
  const calls = spyFetch(() => new Response('<rss><channel/></rss>', {
    status: 200,
    headers: { 'Content-Type': 'application/rss+xml' },
  }));

  const res = await handler(makeRequest('https://techcrunch.com/feed'));

  assert.equal(res.status, 200);
  assert.deepEqual(calls.map((c) => c.url), ['https://techcrunch.com/feed']);
  assert.equal(
    res.headers.get('Cache-Control'),
    'public, max-age=180, s-maxage=900, stale-while-revalidate=1800, stale-if-error=3600',
  );
  assert.equal(
    res.headers.get('CDN-Cache-Control'),
    'public, s-maxage=900, stale-while-revalidate=1800, stale-if-error=3600',
  );
});

test('passes a non-2xx upstream status through with the short error cache and no CDN-Cache-Control', async () => {
  const calls = spyFetch(() => new Response('upstream boom', { status: 503 }));

  const res = await handler(makeRequest('https://techcrunch.com/feed'));

  assert.equal(res.status, 503);
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=15, s-maxage=60, stale-while-revalidate=120');
  assert.equal(
    res.headers.get('CDN-Cache-Control'),
    null,
    'a failed upstream must never be pinned in the CDN',
  );
  assert.deepEqual(calls.map((c) => c.url), ['https://techcrunch.com/feed']);
});

test('retries through the relay when the direct fetch returns a non-2xx status', async () => {
  process.env.WS_RELAY_URL = 'wss://relay.example.com';
  const feedUrl = 'https://techcrunch.com/feed';

  const calls = spyFetch((url) => (
    url.includes('relay.example.com')
      ? new Response('<rss><channel><title>relay</title></channel></rss>', {
        status: 200,
        headers: { 'Content-Type': 'application/rss+xml' },
      })
      : new Response('blocked', { status: 403 })
  ));

  const res = await handler(makeRequest(feedUrl));

  assert.equal(res.status, 200);
  assert.match(await res.text(), /relay/);
  assert.deepEqual(calls.map((c) => c.url), [
    feedUrl,
    `https://relay.example.com/rss?url=${encodeURIComponent(feedUrl)}`,
  ]);
});

test('falls back to application/xml when upstream sends no content-type', async () => {
  const calls = spyFetch(() => {
    const res = new Response('<rss><channel/></rss>', { status: 200 });
    res.headers.delete('content-type');
    return res;
  });

  const res = await handler(makeRequest('https://techcrunch.com/feed'));

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'application/xml');
  assert.equal(calls.length, 1);
});

test('maps a direct-fetch AbortError to 504 Feed timeout', async () => {
  // No WS_RELAY_URL, so the relay fallback returns null and the AbortError is
  // rethrown into the outer catch — which must classify it as a timeout (504)
  // and skip the Sentry capture that routine upstream timeouts would flood.
  const calls = spyFetch(() => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  });

  const res = await handler(makeRequest('https://techcrunch.com/feed'));
  const body = await res.json();

  assert.equal(res.status, 504);
  assert.equal(body.error, 'Feed timeout');
  assert.equal(body.url, 'https://techcrunch.com/feed');
  assert.equal(calls.length, 1);
});

test('gives Google News a 20s deadline and other feeds 12s', async () => {
  // The timeout is only observable through the AbortSignal that
  // fetchWithTimeout arms, and it is cleared as soon as fetch settles — so the
  // fetch is held pending while the fake clock is advanced across each
  // boundary. Fake timers keep this deterministic (no real waiting).
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    for (const { feedUrl, deadlineMs, label } of [
      { feedUrl: 'https://news.google.com/rss/search?q=test', deadlineMs: 20_000, label: 'Google News' },
      { feedUrl: 'https://techcrunch.com/feed', deadlineMs: 12_000, label: 'default' },
    ]) {
      let signal;
      let release;
      globalThis.fetch = async (_input, init = {}) => {
        signal = init.signal;
        await new Promise((resolve) => { release = resolve; });
        return new Response('<rss/>', { status: 200 });
      };

      const pending = handler(makeRequest(feedUrl));
      // Yield until the handler has entered fetch and armed the signal.
      while (!signal) await new Promise((resolve) => setImmediate(resolve));

      mock.timers.tick(deadlineMs - 1);
      assert.equal(signal.aborted, false, `${label} feed aborted before its ${deadlineMs}ms deadline`);
      mock.timers.tick(2);
      assert.equal(signal.aborted, true, `${label} feed did not abort at its ${deadlineMs}ms deadline`);

      release();
      await pending;
    }
  } finally {
    mock.timers.reset();
  }
});
