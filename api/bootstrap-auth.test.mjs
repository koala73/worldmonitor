import { strict as assert } from 'node:assert';
import test from 'node:test';
import handler from './bootstrap.js';

const ENTERPRISE_KEY = 'enterprise-bootstrap-test-key';
const USER_KEY = 'wm_0123456789abcdef0123456789abcdef01234567';

function snapshotEnv(names) {
  const values = new Map();
  for (const name of names) values.set(name, process.env[name]);
  return () => {
    for (const [name, value] of values) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

async function withMockedBootstrapAuth({ entitlement, userKeyResponse = 'valid', rateLimitResults, rateLimitStatus }, fn) {
  const restoreEnv = snapshotEnv([
    'CONVEX_SITE_URL',
    'CONVEX_SERVER_SHARED_SECRET',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'WORLDMONITOR_VALID_KEYS',
  ]);
  const originalFetch = globalThis.fetch;
  const calls = [];

  process.env.CONVEX_SITE_URL = 'https://convex.test';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'shared-secret';
  process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
  process.env.WORLDMONITOR_VALID_KEYS = ENTERPRISE_KEY;

  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });

    if (url.startsWith('https://upstash.test')) {
      const commands = JSON.parse(String(init?.body || '[]'));
      if (commands[0]?.[0] === 'INCR') {
        if (rateLimitStatus) {
          return new Response(JSON.stringify({ error: 'redis unavailable' }), {
            status: rateLimitStatus,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(rateLimitResults ?? [{ result: 1 }, { result: 1 }, { result: 60 }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (commands[0]?.[0] === 'GET') {
        return new Response(JSON.stringify([{ result: null }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (commands[0]?.[0] === 'SET') {
        return new Response(JSON.stringify([{ result: 'OK' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(commands.map(() => ({ result: JSON.stringify({ ok: true }) }))), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/api/internal-validate-api-key')) {
      if (userKeyResponse === 'valid') {
        return new Response(JSON.stringify({ userId: 'user_api_owner', keyId: 'key_1', name: 'pipeline' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (userKeyResponse === 'revoked') {
        return new Response(JSON.stringify(null), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'boom' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/api/internal-entitlements')) {
      return new Response(JSON.stringify(entitlement), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return originalFetch(input, init);
  };

  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
}

const activeApiEntitlement = () => ({
  planKey: 'api_starter',
  validUntil: Date.now() + 86_400_000,
  features: {
    tier: 2,
    apiAccess: true,
    apiRateLimit: 600,
    maxDashboards: 10,
    prioritySupport: false,
    exportFormats: [],
    mcpAccess: false,
  },
});

const proOnlyEntitlement = () => ({
  planKey: 'pro_monthly',
  validUntil: Date.now() + 86_400_000,
  features: {
    tier: 1,
    apiAccess: false,
    apiRateLimit: 60,
    maxDashboards: 10,
    prioritySupport: false,
    exportFormats: [],
    mcpAccess: false,
  },
});

function makeBootstrapRequest(headers = {}) {
  return new Request('https://api.worldmonitor.app/api/bootstrap?keys=marketQuotes', {
    method: 'GET',
    headers,
  });
}

function makeBootstrapRequestWithAllowedOrigin(headers = {}) {
  return makeBootstrapRequest({
    Origin: 'https://worldmonitor.app',
    ...headers,
  });
}

function makeWeatherBootstrapRequest(headers = {}) {
  return new Request('https://api.worldmonitor.app/api/bootstrap?keys=weatherAlerts', {
    method: 'GET',
    headers,
  });
}

function assertNonSharedCacheHeaders(resp) {
  assert.equal(resp.headers.get('cdn-cache-control'), null);
  assert.equal(resp.headers.get('vercel-cdn-cache-control'), null);
  assert.doesNotMatch(resp.headers.get('cache-control') || '', /\b(public|s-maxage)\b/i);
}

test('no-Origin enterprise key keeps bootstrap shape but is not shared-cacheable', async () => {
  await withMockedBootstrapAuth({ entitlement: activeApiEntitlement() }, async () => {
    const resp = await handler(makeBootstrapRequest({ 'X-WorldMonitor-Key': ENTERPRISE_KEY }));

    assert.equal(resp.status, 200);
    assert.deepEqual(Object.keys(await resp.json()).sort(), ['data', 'missing']);
    assertNonSharedCacheHeaders(resp);
  });
});

test('allowed-Origin enterprise key keeps bootstrap shape but is not shared-cacheable', async () => {
  await withMockedBootstrapAuth({ entitlement: activeApiEntitlement() }, async () => {
    const resp = await handler(makeBootstrapRequestWithAllowedOrigin({ 'X-WorldMonitor-Key': ENTERPRISE_KEY }));

    assert.equal(resp.status, 200);
    assert.deepEqual(Object.keys(await resp.json()).sort(), ['data', 'missing']);
    assertNonSharedCacheHeaders(resp);
  });
});

test('weather-only bootstrap with enterprise key uses key auth cache posture', async () => {
  await withMockedBootstrapAuth({ entitlement: activeApiEntitlement() }, async () => {
    const resp = await handler(makeWeatherBootstrapRequest({ 'X-WorldMonitor-Key': ENTERPRISE_KEY }));

    assert.equal(resp.status, 200);
    assert.deepEqual(Object.keys(await resp.json()).sort(), ['data', 'missing']);
    assertNonSharedCacheHeaders(resp);
  });
});

test('no-Origin valid wm_ user key in X-WorldMonitor-Key returns bootstrap data without shared cache headers', async () => {
  await withMockedBootstrapAuth({ entitlement: activeApiEntitlement() }, async (calls) => {
    const resp = await handler(makeBootstrapRequest({ 'X-WorldMonitor-Key': USER_KEY }));

    assert.equal(resp.status, 200);
    assert.deepEqual(Object.keys(await resp.json()).sort(), ['data', 'missing']);
    assertNonSharedCacheHeaders(resp);
    assert.ok(calls.some((call) => call.url.endsWith('/api/internal-validate-api-key')));
    assert.ok(calls.some((call) => call.url.endsWith('/api/internal-entitlements')));
  });
});

test('weather-only bootstrap with wm_ user key validates user auth before returning data', async () => {
  await withMockedBootstrapAuth({ entitlement: activeApiEntitlement() }, async (calls) => {
    const resp = await handler(makeWeatherBootstrapRequest({ 'X-WorldMonitor-Key': USER_KEY }));

    assert.equal(resp.status, 200);
    assert.deepEqual(Object.keys(await resp.json()).sort(), ['data', 'missing']);
    assertNonSharedCacheHeaders(resp);
    assert.ok(calls.some((call) => call.url.endsWith('/api/internal-validate-api-key')));
    assert.ok(calls.some((call) => call.url.endsWith('/api/internal-entitlements')));
  });
});

test('allowed-Origin valid wm_ user key returns bootstrap data without shared cache headers', async () => {
  await withMockedBootstrapAuth({ entitlement: activeApiEntitlement() }, async () => {
    const resp = await handler(makeBootstrapRequestWithAllowedOrigin({ 'X-WorldMonitor-Key': USER_KEY }));

    assert.equal(resp.status, 200);
    assert.deepEqual(Object.keys(await resp.json()).sort(), ['data', 'missing']);
    assertNonSharedCacheHeaders(resp);
  });
});

test('weather-only bootstrap with malformed wm_ header is rejected instead of anonymous bypass', async () => {
  await withMockedBootstrapAuth({ entitlement: activeApiEntitlement() }, async (calls) => {
    const resp = await handler(makeWeatherBootstrapRequest({ 'X-WorldMonitor-Key': 'wm_notcanonical' }));
    const body = await resp.json();

    assert.equal(resp.status, 401);
    assert.equal(resp.headers.get('cache-control'), 'no-store');
    assert.equal(body.error, 'Invalid API key');
    assert.equal(calls.length, 0);
  });
});

test('no-Origin valid wm_ user key in X-Api-Key alias returns bootstrap data', async () => {
  await withMockedBootstrapAuth({ entitlement: activeApiEntitlement() }, async () => {
    const resp = await handler(makeBootstrapRequest({ 'X-Api-Key': USER_KEY }));

    assert.equal(resp.status, 200);
    assert.deepEqual(Object.keys(await resp.json()).sort(), ['data', 'missing']);
    assertNonSharedCacheHeaders(resp);
  });
});

test('revoked wm_ user key returns generic non-cacheable 401 without leaking gateway sentinel', async () => {
  await withMockedBootstrapAuth({ entitlement: activeApiEntitlement(), userKeyResponse: 'revoked' }, async () => {
    const resp = await handler(makeBootstrapRequest({ 'X-WorldMonitor-Key': USER_KEY }));
    const body = await resp.json();

    assert.equal(resp.status, 401);
    assert.equal(resp.headers.get('cache-control'), 'no-store');
    assert.notEqual(body.error, 'User API key requires gateway validation');
    assert.doesNotMatch(JSON.stringify(body), /gateway validation|Convex|keyHash/i);
  });
});

test('malformed wm_ user key is rejected before Redis or Convex validation', async () => {
  await withMockedBootstrapAuth({ entitlement: activeApiEntitlement() }, async (calls) => {
    const resp = await handler(makeBootstrapRequest({ 'X-WorldMonitor-Key': 'wm_notcanonical' }));
    const body = await resp.json();

    assert.equal(resp.status, 401);
    assert.equal(resp.headers.get('cache-control'), 'no-store');
    assert.equal(body.error, 'Invalid API key');
    assert.equal(calls.length, 0);
  });
});

test('rate-limit Redis outage returns non-cacheable 503 before Convex validation', async () => {
  await withMockedBootstrapAuth({ entitlement: activeApiEntitlement(), rateLimitStatus: 500 }, async (calls) => {
    const resp = await handler(makeBootstrapRequest({ 'X-WorldMonitor-Key': USER_KEY }));
    const body = await resp.json();

    assert.equal(resp.status, 503);
    assert.equal(resp.headers.get('cache-control'), 'no-store');
    assert.equal(resp.headers.get('x-ratelimit-mode'), 'degraded');
    assert.equal(body.error, 'Rate-limit service temporarily unavailable');
    assert.equal(calls.some((call) => call.url.endsWith('/api/internal-validate-api-key')), false);
    assert.equal(calls.some((call) => call.url.endsWith('/api/internal-entitlements')), false);
  });
});

test('over-limit wm_ user key returns non-cacheable 429 before Convex validation', async () => {
  await withMockedBootstrapAuth({
    entitlement: activeApiEntitlement(),
    rateLimitResults: [{ result: 601 }, { result: 0 }, { result: 12 }],
  }, async (calls) => {
    const resp = await handler(makeBootstrapRequest({ 'X-WorldMonitor-Key': USER_KEY }));
    const body = await resp.json();

    assert.equal(resp.status, 429);
    assert.equal(resp.headers.get('cache-control'), 'no-store');
    assert.equal(resp.headers.get('retry-after'), '12');
    assert.equal(body.error, 'Too many requests');
    assert.equal(calls.some((call) => call.url.endsWith('/api/internal-validate-api-key')), false);
    assert.equal(calls.some((call) => call.url.endsWith('/api/internal-entitlements')), false);
  });
});

test('wm_ credential outside the supported header fallback never leaks the gateway sentinel', async () => {
  await withMockedBootstrapAuth({ entitlement: activeApiEntitlement() }, async () => {
    const resp = await handler(makeBootstrapRequest({ Cookie: `wm-pro-key=${USER_KEY}` }));
    const body = await resp.json();

    assert.equal(resp.status, 401);
    assert.equal(resp.headers.get('cache-control'), 'no-store');
    assert.notEqual(body.error, 'User API key requires gateway validation');
    assert.doesNotMatch(JSON.stringify(body), /gateway validation/i);
  });
});

test('valid wm_ user key without current API access returns non-cacheable 403', async () => {
  await withMockedBootstrapAuth({ entitlement: proOnlyEntitlement() }, async () => {
    const resp = await handler(makeBootstrapRequest({ 'X-WorldMonitor-Key': USER_KEY }));
    const body = await resp.json();

    assert.equal(resp.status, 403);
    assert.equal(resp.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(JSON.stringify(body), /Convex|keyHash/i);
  });
});

test('missing credentials remain a non-cacheable 401', async () => {
  await withMockedBootstrapAuth({ entitlement: activeApiEntitlement() }, async () => {
    const resp = await handler(makeBootstrapRequest());

    assert.equal(resp.status, 401);
    assert.equal(resp.headers.get('cache-control'), 'no-store');
  });
});

test('Convex validation outage returns a retryable non-cacheable 503, not a misleading 401', async () => {
  await withMockedBootstrapAuth({ entitlement: activeApiEntitlement(), userKeyResponse: 'error' }, async () => {
    const resp = await handler(makeBootstrapRequest({ 'X-WorldMonitor-Key': USER_KEY }));
    const body = await resp.json();

    assert.equal(resp.status, 503);
    assert.equal(resp.headers.get('cache-control'), 'no-store');
    assert.equal(resp.headers.get('retry-after'), '5');
    assert.equal(resp.headers.get('x-validation-mode'), 'degraded');
    assert.equal(body.error, 'Service temporarily unavailable');
    // A transient outage must not leak as "Invalid API key" or expose internals.
    assert.notEqual(body.error, 'Invalid API key');
    assert.doesNotMatch(JSON.stringify(body), /gateway validation|Convex|keyHash/i);
  });
});

test('key-auth response with an empty cache batch stays no-store (never shared-cacheable)', async () => {
  // The mocked GET pipeline returns no data, so getCachedJsonBatch yields an
  // all-missing bundle. Under key auth that empty 200 must be no-store and emit
  // no CDN cache headers, or a CDN could cache an authenticated empty response.
  await withMockedBootstrapAuth({ entitlement: activeApiEntitlement() }, async () => {
    const resp = await handler(makeBootstrapRequest({ 'X-WorldMonitor-Key': USER_KEY }));
    const body = await resp.json();

    assert.equal(resp.status, 200);
    assert.deepEqual(body, { data: {}, missing: ['marketQuotes'] });
    assert.equal(resp.headers.get('cache-control'), 'no-store');
    assert.equal(resp.headers.get('cdn-cache-control'), null);
  });
});

test('anonymous weather-only bootstrap (no key header) keeps the shared public cache posture', async () => {
  // Guards the inverse of the no-store path: a no-credential weather request
  // must stay publicly cacheable. A regression flipping the isKeyAuth predicate
  // would either break this or, worse, make a key-auth response shared-cacheable.
  await withMockedBootstrapAuth({ entitlement: activeApiEntitlement() }, async () => {
    const resp = await handler(makeWeatherBootstrapRequest());

    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('cache-control') || '', /\bpublic\b/);
    assert.match(resp.headers.get('cache-control') || '', /s-maxage/);
    assert.ok(resp.headers.get('cdn-cache-control'));
  });
});
