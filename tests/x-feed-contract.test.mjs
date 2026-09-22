import { beforeEach, afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Ratelimit } from '@upstash/ratelimit';

import { listXFeed } from '../server/worldmonitor/intelligence/v1/list-x-feed.ts';
import { issueSessionToken } from '../api/_session.js';
import { __resetRateLimitForTest } from '../api/_rate-limit.js';
import handler from '../api/x-feed.js';

const originalFetch = globalThis.fetch;
const originalSlidingWindow = Ratelimit.slidingWindow;
const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

const SESSION_SECRET = 'x'.repeat(48);

function stubLimiter(limit) {
  mock.method(Ratelimit, 'slidingWindow', () => () => ({ limit }));
}

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  __resetRateLimitForTest();
  stubLimiter(async () => ({ success: true, pending: Promise.resolve() }));
});

afterEach(() => {
  mock.restoreAll();
  Ratelimit.slidingWindow = originalSlidingWindow;
  __resetRateLimitForTest();
  globalThis.fetch = originalFetch;
  restoreEnv();
});

/**
 * What a real first-party panel call looks like on the wire: an allowed Origin
 * PLUS the wms_ session token the browser mints at boot and the wm-session
 * interceptor attaches to every /api/ call (src/services/wm-session.ts).
 * Origin alone is no longer sufficient — see the R4 boundary suite below.
 */
async function makeRequest(path = '/api/x-feed?limit=50') {
  const { token } = await issueSessionToken();
  return new Request(`https://worldmonitor.app${path}`, {
    method: 'GET',
    headers: { origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': token },
  });
}

describe('api/x-feed contract normalization', () => {
  beforeEach(() => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
    process.env.WM_SESSION_SECRET = SESSION_SECRET;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  for (const timedOut of [false, true]) {
    it(`hides internal relay errors (timeout=${timedOut})`, async () => {
      globalThis.fetch = async () => {
        const error = new Error('https://internal.example/?key=synthetic-secret');
        if (timedOut) error.name = 'AbortError';
        throw error;
      };
      const handler = (await import(`../api/x-feed.js?error-test=${timedOut}`)).default;
      const response = await handler(await makeRequest());
      assert.equal(response.status, timedOut ? 504 : 502);
      assert.deepEqual(await response.json(), { error: timedOut ? 'Relay timeout' : 'Relay request failed' });
    });
  }

  it('normalizes items[] into the first-party panel contract and ignores a stale count field', async () => {
    globalThis.fetch = async (url, options) => {
      assert.match(String(url), /\/x\/feed\?limit=50$/);
      assert.equal(options?.headers?.Authorization, 'Bearer test-secret');
      assert.equal(options?.headers?.['User-Agent'], 'WorldMonitor-X-Feed/1.0');
      return new Response(JSON.stringify({
        enabled: true,
        source: 'relay',
        earlySignal: false,
        updatedAt: '2026-08-18T12:00:00Z',
        count: 0,
        lastHealthyAt: '2026-08-18T11:55:00Z',
        coverage: { expected: 64, polled: 61, failed: 3, attempted: 64, complete: false },
        items: [{
          id: 'Reuters:123',
          postId: '123',
          account: 'Reuters',
          accountTitle: 'Reuters',
          accountId: '1652541',
          timestampMs: 1_744_000_000_000,
          url: 'javascript:alert(1)',
          text: 'Port disruption reported',
          topic: 'breaking',
          tags: [42, 'urgent'],
          hasMedia: true,
          lang: 'en',
          contentState: 'active',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const handler = (await import(`../api/x-feed.js?t=${Date.now()}`)).default;
    const res = await handler(await makeRequest());
    assert.equal(res.status, 200);
    // The payload is credential-gated now, so it must never be stored by a
    // shared cache: a CDN hit precedes handler auth and would answer an
    // unauthenticated caller with the authorized bodies.
    const cacheControl = res.headers.get('cache-control') || '';
    assert.match(cacheControl, /private/);
    assert.doesNotMatch(cacheControl, /public|s-maxage/);
    assert.match(res.headers.get('vary') || '', /X-WorldMonitor-Key/);

    const data = await res.json();
    assert.equal(data.source, 'relay');
    assert.equal(data.count, 1);
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].source, 'x');
    assert.equal(data.items[0].account, 'Reuters');
    assert.equal(data.items[0].accountTitle, 'Reuters');
    assert.equal(data.items[0].url, '');
    assert.equal(data.items[0].text, 'Port disruption reported');
    assert.equal(data.items[0].ts, new Date(1_744_000_000_000).toISOString());
    assert.deepEqual(data.items[0].tags, ['42', 'urgent']);
    assert.equal(data.degraded, true);
    assert.deepEqual(data.coverage, { expected: 64, polled: 61, failed: 3, attempted: 64, complete: false });
    assert.equal(data.lastHealthyAt, '2026-08-18T11:55:00Z');
  });

  it('drops tombstoned posts from the first-party panel payload', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      enabled: true,
      items: [{
        id: 'Reuters:1',
        account: 'Reuters',
        url: 'https://x.com/Reuters/status/1',
        text: '',
        contentState: 'deleted',
      }, {
        id: 'Reuters:2',
        account: 'Reuters',
        url: 'https://x.com/Reuters/status/2',
        text: 'live post',
        contentState: 'active',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const handler = (await import(`../api/x-feed.js?t=${Date.now()}`)).default;
    const res = await handler(await makeRequest());
    const data = await res.json();
    assert.equal(data.count, 1);
    assert.equal(data.items[0].id, 'Reuters:2');
  });
});

describe('api/x-feed R4 first-party boundary', () => {
  // A LIVE relay stub, so every rejection below is proven against a route that
  // WOULD have served bodies. Without it a 502 would satisfy the "no text"
  // assertions for the wrong reason and the suite would be inert.
  const RELAY_BODY = JSON.stringify({
    enabled: true,
    source: 'relay',
    items: [{
      id: 'Reuters:1',
      account: 'Reuters',
      url: 'https://x.com/Reuters/status/1',
      text: 'SECRET BODY must not leave the panel route',
      contentState: 'active',
    }],
  });

  beforeEach(() => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
    process.env.WM_SESSION_SECRET = SESSION_SECRET;
    globalThis.fetch = async () => new Response(RELAY_BODY, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  async function get(headers) {
    const handler = (await import(`../api/x-feed.js?t=${Date.now()}`)).default;
    return handler(new Request('https://api.worldmonitor.app/api/x-feed?limit=200', {
      method: 'GET',
      headers,
    }));
  }

  // Positive control for every rejection below: the same stub, a real
  // credential, and the bodies DO come back. If this ever goes red the
  // rejections stop proving anything.
  it('serves post bodies to a credentialed first-party caller', async () => {
    const { token } = await issueSessionToken();
    const res = await get({ origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': token });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /SECRET BODY/);
  });

  it('rejects a credential-less request that sends no Origin at all', async () => {
    // The reported hole: isDisallowedOrigin returns false on an absent Origin,
    // so `curl https://worldmonitor.app/api/x-feed?limit=200` collected every
    // body. CORS is browser-enforced only and never gated this.
    const res = await get({});
    assert.equal(res.status, 401);
    assert.doesNotMatch(await res.text(), /SECRET BODY/);
  });

  it('rejects a credential-less request that forges an allowed Origin', async () => {
    // The reason the gate is not Origin-based: Origin is client-controlled at
    // the wire level, so an Origin-only fix costs an attacker one curl -H.
    const res = await get({ origin: 'https://worldmonitor.app' });
    assert.equal(res.status, 401);
    assert.doesNotMatch(await res.text(), /SECRET BODY/);
  });

  it('rejects a credential-less request that forges Sec-Fetch-Site: same-origin', async () => {
    // Issue #3541 / closed PR #3554: no header-only browser signal is trusted.
    // The desktop sidecar strips sec-fetch-* on the way through in any case
    // (src-tauri/sidecar/local-api-server.mjs toHeaders), so trusting it would
    // admit only forgeries.
    const res = await get({ origin: 'https://worldmonitor.app', 'sec-fetch-site': 'same-origin' });
    assert.equal(res.status, 401);
    assert.doesNotMatch(await res.text(), /SECRET BODY/);
  });

  it('rejects a tampered session token', async () => {
    const { token } = await issueSessionToken();
    const tampered = `${token.slice(0, -2)}${token.slice(-2) === 'AA' ? 'BB' : 'AA'}`;
    const res = await get({ origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': tampered });
    assert.equal(res.status, 401);
    assert.doesNotMatch(await res.text(), /SECRET BODY/);
  });

  it('still answers the CORS preflight without a credential', async () => {
    // The gate sits after the OPTIONS branch on purpose: a browser cannot
    // attach credentials to a preflight, so gating it would break the panel.
    const handler = (await import(`../api/x-feed.js?t=${Date.now()}`)).default;
    const res = await handler(new Request('https://api.worldmonitor.app/api/x-feed', {
      method: 'OPTIONS',
      headers: { origin: 'https://worldmonitor.app' },
    }));
    assert.equal(res.status, 204);
  });
});

describe('server listXFeed relay normalization', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  it('maps relay items into permalink + facts and never returns tweet bodies', async () => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
    globalThis.fetch = async (url) => {
      assert.equal(new URL(String(url)).searchParams.get('includeDeleted'), '1');
      return new Response(JSON.stringify({
      enabled: true,
      count: 0,
      items: [{
        id: 'Reuters:123',
        accountId: '1652541',
        accountTitle: 'Reuters',
        account: 'Reuters',
        ts: '2026-08-18T12:30:00Z',
        url: 'https://x.com/Reuters/status/123',
        text: 'SECRET BODY must not leave the intelligence RPC',
        topic: 'breaking',
        hasMedia: true,
        lang: 'en',
        contentState: 'active',
      }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const response = await listXFeed(/** @type {any} */ ({}), { limit: 25, topic: '', account: '' });
    assert.equal(response.enabled, true);
    assert.equal(response.count, 1);
    assert.equal(response.posts.length, 1);
    assert.equal(response.posts[0].accountName, 'Reuters');
    assert.equal(response.posts[0].permalink, 'https://x.com/Reuters/status/123');
    assert.equal(response.posts[0].timestampMs, Date.parse('2026-08-18T12:30:00Z'));
    assert.ok(response.posts[0].facts.length > 0);
    assert.equal('text' in response.posts[0], false);
    assert.doesNotMatch(JSON.stringify(response), /SECRET BODY/);
  });

  it('preserves relay tombstones for RPC consumers', async () => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
    globalThis.fetch = async () => new Response(JSON.stringify({
      enabled: true,
      items: [{
        id: 'Reuters:deleted',
        account: 'Reuters',
        topic: 'breaking',
        url: 'https://x.com/Reuters/status/deleted',
        text: '',
        contentState: 'deleted',
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    const response = await listXFeed(/** @type {any} */ ({}), { limit: 25, topic: '', account: '' });
    assert.equal(response.count, 1);
    assert.equal(response.posts[0].contentState, 'deleted');
    assert.equal('text' in response.posts[0], false);
  });

  it('derives RPC facts instead of trusting relay-provided facts', async () => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
    globalThis.fetch = async () => new Response(JSON.stringify({
      enabled: true,
      items: [{
        id: 'Reuters:124',
        account: 'Reuters',
        topic: 'breaking',
        url: 'https://x.com/Reuters/status/124',
        facts: ['SECRET BODY injected through relay facts'],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await listXFeed(/** @type {any} */ ({}), { limit: 25, topic: '', account: '' });
    assert.deepEqual(response.posts[0].facts, [
      'Reuters posted a breaking update',
      'https://x.com/Reuters/status/124',
    ]);
    assert.doesNotMatch(JSON.stringify(response), /SECRET BODY/);
  });

  it('filters unsafe permalinks in the server RPC path', async () => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
    globalThis.fetch = async () => new Response(JSON.stringify({
      enabled: true,
      items: [{
        id: 'Reuters:unsafe',
        account: 'Reuters',
        timestampMs: 1_744_000_000_000,
        url: 'javascript:alert(1)',
        text: 'should not leak',
        topic: 'breaking',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await listXFeed(/** @type {any} */ ({}), { limit: 25, topic: '', account: '' });
    assert.equal(response.count, 1);
    assert.equal(response.posts[0].permalink, '');
    assert.doesNotMatch(JSON.stringify(response), /should not leak/);
  });
});

describe('api/x-feed caller admission', () => {
  let relayCalls;
  let counters;

  beforeEach(() => {
    process.env.WM_SESSION_SECRET = SESSION_SECRET;
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
    relayCalls = 0;
    counters = new Map();
    // Exercise the shared limiter's real fixed-window fallback and route policy.
    stubLimiter(async () => {
      throw new Error('Command not allowed: EVAL');
    });
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://fake.upstash.io/')) {
        const commands = JSON.parse(init.body);
        const key = commands[0][1];
        assert.match(key, /^rl:x-feed:fw:/);
        assert.deepEqual(commands, [
          ['INCR', key], ['EXPIRE', key, '60', 'NX'], ['TTL', key],
        ]);
        const count = (counters.get(key) ?? 0) + 1;
        counters.set(key, count);
        return Response.json([{ result: count }, { result: 1 }, { result: 60 }]);
      }
      assert.match(url, /^https:\/\/relay\.example\.com\/x\/feed\?/);
      relayCalls += 1;
      return Response.json({ items: [{ id: '1', text: 'public feed post' }] });
    };
  });

  async function request(ip = '203.0.113.1', options = {}) {
    const { token } = await issueSessionToken();
    return new Request('https://worldmonitor.app/api/x-feed?limit=50', {
      method: options.method ?? 'GET',
      headers: {
        origin: 'https://worldmonitor.app',
        'X-WorldMonitor-Key': token,
        'x-real-ip': ip,
        ...options.headers,
      },
    });
  }

  it('uses the scoped 60/minute policy through the real Redis SDK', async () => {
    mock.method(Ratelimit, 'slidingWindow', originalSlidingWindow);
    const fixtureFetch = globalThis.fetch;
    const redisBodies = [];
    let remaining = 59;
    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith('https://fake.upstash.io/')) {
        redisBodies.push(String(init.body));
        return Response.json([{ result: [remaining, 60] }]);
      }
      return fixtureFetch(input, init);
    };
    assert.equal((await handler(await request())).status, 200);
    remaining = -1;
    assert.equal((await handler(await request())).status, 429);
    assert.equal(relayCalls, 1);
    assert.ok(redisBodies.some((body) => body.includes('rl:x-feed:203.0.113.1') && body.includes('60000') && body.includes('60')));
  });

  it('bounds token reuse and rotation by IP, while allowing a different caller', async () => {
    const reusedRequest = await request();
    for (let i = 0; i < 60; i += 1) {
      const response = await handler(i % 2 ? await request() : reusedRequest.clone());
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'private, max-age=30');
      assert.equal(response.headers.get('vary'), 'Origin, Cookie, X-WorldMonitor-Key, X-Api-Key, Authorization');
    }
    const denied = await handler(await request());
    assert.equal(denied.status, 429);
    assert.equal(denied.headers.get('x-ratelimit-limit'), '60');
    assert.equal(denied.headers.get('retry-after'), '60');
    assert.equal(denied.headers.get('cache-control'), 'no-store');
    assert.equal(denied.headers.get('access-control-allow-origin'), 'https://worldmonitor.app');
    assert.equal(relayCalls, 60);
    assert.equal((await handler(await request('203.0.113.2'))).status, 200);
    assert.equal(relayCalls, 61);
    assert.equal(counters.size, 2);
  });

  for (const failure of ['missing-config', 'redis-error', 'timeout']) {
    it(`fails closed without relay I/O on ${failure}`, async () => {
      if (failure === 'missing-config') delete process.env.UPSTASH_REDIS_REST_URL;
      stubLimiter(async () => {
        if (failure === 'timeout') return { success: true, reason: 'timeout', pending: Promise.resolve() };
        throw new Error('Redis unavailable');
      });
      const response = await handler(await request());
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('x-ratelimit-mode'), 'degraded');
      assert.equal(response.headers.get('retry-after'), '5');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(relayCalls, 0);
    });
  }

  it('preserves origin, preflight, method and auth precedence without limiter or relay I/O', async () => {
    const limiter = mock.fn(async () => {
      throw new Error('must not reach limiter');
    });
    stubLimiter(limiter);
    for (const [options, status] of [
      [{ method: 'OPTIONS', headers: { origin: 'https://attacker.example' } }, 403],
      [{ method: 'OPTIONS', headers: { 'X-WorldMonitor-Key': '' } }, 204],
      [{ method: 'POST', headers: { 'X-WorldMonitor-Key': '' } }, 405],
      [{ headers: { 'X-WorldMonitor-Key': 'invalid' } }, 401],
    ]) {
      assert.equal((await handler(await request('203.0.113.1', options))).status, status);
    }
    assert.equal(limiter.mock.callCount(), 0);
    assert.equal(relayCalls, 0);
  });
});
