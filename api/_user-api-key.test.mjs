import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  checkBootstrapUserApiKeyRateLimit,
  isCanonicalUserApiKey,
  validateBootstrapUserApiAccess,
  validateBootstrapUserApiKey,
} from './_user-api-key.js';

const USER_KEY = 'wm_0123456789abcdef0123456789abcdef01234567';

async function sha256HexForTest(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

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

async function withMockedConvex(fn, options = {}) {
  const restoreEnv = snapshotEnv([
    'CONVEX_SITE_URL',
    'CONVEX_SERVER_SHARED_SECRET',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'VERCEL_ENV',
    'VERCEL_GIT_COMMIT_SHA',
    'CF_EDGE_PROOF_SECRET',
  ]);
  const originalFetch = globalThis.fetch;
  const calls = [];

  process.env.CONVEX_SITE_URL = 'https://convex.test';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'shared-secret';
  process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
  if (options.vercelEnv) process.env.VERCEL_ENV = options.vercelEnv;
  else delete process.env.VERCEL_ENV;
  if (options.vercelGitCommitSha) process.env.VERCEL_GIT_COMMIT_SHA = options.vercelGitCommitSha;
  else delete process.env.VERCEL_GIT_COMMIT_SHA;

  const redisResults = options.redisResults ?? [{ result: 1 }, { result: 1 }, { result: 60 }];

  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, init, body });

    if (url.startsWith('https://upstash.test')) {
      const commands = JSON.parse(body || '[]');
      if (options.redisStatus) {
        return new Response(JSON.stringify({ error: 'redis unavailable' }), {
          status: options.redisStatus,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (commands[0]?.[0] === 'GET') {
        const key = commands[0][1];
        const cachedValue = options.redisCache?.[key];
        return new Response(JSON.stringify([{ result: cachedValue === undefined ? null : JSON.stringify(cachedValue) }]), {
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
      return new Response(JSON.stringify(redisResults), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/api/internal-validate-api-key')) {
      const value = Object.hasOwn(options, 'validateResponse')
        ? options.validateResponse
        : { keyId: 'key_1', userId: 'user_api_owner', name: 'pipeline' };
      return new Response(JSON.stringify(value), {
        status: options.validateStatus ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/api/internal-entitlements')) {
      return new Response(JSON.stringify({
        planKey: 'api_starter',
        validUntil: Date.now() + 86_400_000,
        features: { apiAccess: true },
      }), {
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

test('canonical wm_ user API key shape matches generated 43-char keys', () => {
  assert.equal(isCanonicalUserApiKey(USER_KEY), true);
  assert.equal(isCanonicalUserApiKey('wm_abcdef'), false);
  assert.equal(isCanonicalUserApiKey('wm_0123456789abcdef0123456789abcdef0123456Z'), false);
  assert.equal(isCanonicalUserApiKey('not-wm_0123456789abcdef0123456789abcdef01234567'), false);
});

test('malformed wm_ keys fail before hashing or Convex validation', async () => {
  await withMockedConvex(async (calls) => {
    const result = await validateBootstrapUserApiKey('wm_notcanonical');

    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(calls.length, 0);
  });
});

test('valid user key validation posts only a SHA-256 hash to Convex', async () => {
  await withMockedConvex(async (calls) => {
    const result = await validateBootstrapUserApiKey(USER_KEY);

    assert.equal(result.ok, true);
    assert.deepEqual(result, { ok: true, userId: 'user_api_owner' });
    const validateCall = calls.find((call) => call.url.endsWith('/api/internal-validate-api-key'));
    assert.ok(validateCall);
    assert.doesNotMatch(validateCall.body, new RegExp(USER_KEY));
    assert.match(JSON.parse(validateCall.body).keyHash, /^[a-f0-9]{64}$/);
    assert.equal(validateCall.init.headers['x-convex-shared-secret'], 'shared-secret');
    const cacheWrite = calls.find((call) => call.url.startsWith('https://upstash.test') && call.body.includes('"SET"'));
    assert.ok(cacheWrite);
    assert.match(cacheWrite.body, /user-api-key:[a-f0-9]{64}/);
    assert.doesNotMatch(cacheWrite.body, new RegExp(USER_KEY));
    // Caches the full gateway-shared shape so the gateway never reads back
    // keyId/name as undefined when bootstrap won the cache race.
    const setCommand = JSON.parse(cacheWrite.body).find((cmd) => cmd[0] === 'SET');
    assert.deepEqual(JSON.parse(setCommand[2]), { userId: 'user_api_owner', keyId: 'key_1', name: 'pipeline' });
  });
});

test('valid user key validation uses cached hash result without Convex', async () => {
  const keyHash = await sha256HexForTest(USER_KEY);
  await withMockedConvex(async (calls) => {
    const result = await validateBootstrapUserApiKey(USER_KEY);

    assert.equal(result.ok, true);
    assert.deepEqual(result, { ok: true, userId: 'cached_owner' });
    assert.equal(calls.some((call) => call.url.endsWith('/api/internal-validate-api-key')), false);
  }, { redisCache: { [`user-api-key:${keyHash}`]: { userId: 'cached_owner' } } });
});

test('preview deploy user-key cache matches server Redis prefix for invalidation parity', async () => {
  const keyHash = await sha256HexForTest(USER_KEY);
  const expectedCacheKey = `preview:abcdef12:user-api-key:${keyHash}`;

  await withMockedConvex(async (calls) => {
    const result = await validateBootstrapUserApiKey(USER_KEY);

    assert.equal(result.ok, true);
    const cacheRead = calls.find((call) => call.url.startsWith('https://upstash.test') && call.body.includes('"GET"'));
    const cacheWrite = calls.find((call) => call.url.startsWith('https://upstash.test') && call.body.includes('"SET"'));
    assert.ok(cacheRead);
    assert.ok(cacheWrite);
    assert.ok(cacheRead.body.includes(expectedCacheKey), cacheRead.body);
    assert.ok(cacheWrite.body.includes(expectedCacheKey), cacheWrite.body);
  }, {
    vercelEnv: 'preview',
    vercelGitCommitSha: 'abcdef1234567890',
  });
});

test('null Convex validation response fails closed as invalid', async () => {
  await withMockedConvex(async (calls) => {
    const result = await validateBootstrapUserApiKey(USER_KEY);

    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(Object.hasOwn(result, 'keyHash'), false);
    const cacheWrite = calls.find((call) => call.url.startsWith('https://upstash.test') && call.body.includes('"SET"'));
    assert.ok(cacheWrite);
    const setCommand = JSON.parse(cacheWrite.body).find((cmd) => cmd[0] === 'SET');
    assert.match(setCommand[1], /^bootstrap-user-api-key-invalid:[a-f0-9]{64}$/);
    assert.doesNotMatch(setCommand[1], /^user-api-key:/);
  }, { validateResponse: null });
});

test('missing Convex config fails closed as retryable 503 without leaking secrets', async () => {
  const restoreEnv = snapshotEnv(['CONVEX_SITE_URL', 'CONVEX_SERVER_SHARED_SECRET']);
  delete process.env.CONVEX_SITE_URL;
  delete process.env.CONVEX_SERVER_SHARED_SECRET;
  try {
    const result = await validateBootstrapUserApiKey(USER_KEY);

    // Validation could not be performed -> retryable 503, not a misleading 401.
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.error, 'Service temporarily unavailable');
    assert.equal(result.headers['Retry-After'], '5');
    assert.equal(result.headers['X-Validation-Mode'], 'degraded');
    assert.doesNotMatch(JSON.stringify(result), /shared-secret|CONVEX|keyHash/i);
  } finally {
    restoreEnv();
  }
});

test('transient Convex HTTP 5xx on key validation is a retryable 503, not 401, and writes no negative cache', async () => {
  await withMockedConvex(async (calls) => {
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === 'string' ? init.body : '';
      calls.push({ url, init, body });
      if (url.startsWith('https://upstash.test')) {
        // cache GET miss; SET would only happen on a negative-cache write
        return new Response(JSON.stringify([{ result: null }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'boom' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const result = await validateBootstrapUserApiKey(USER_KEY);

    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.unavailable, true);
    assert.equal(result.error, 'Service temporarily unavailable');
    assert.equal(result.headers['X-Validation-Mode'], 'degraded');
    // A transient outage must NOT poison the shared negative cache.
    assert.equal(calls.some((call) => call.url.startsWith('https://upstash.test') && call.body.includes('"SET"')), false);
  });
});

test('shared gateway negative sentinel is revalidated instead of hard-failing bootstrap', async () => {
  const keyHash = await sha256HexForTest(USER_KEY);
  await withMockedConvex(async (calls) => {
    const result = await validateBootstrapUserApiKey(USER_KEY);

    assert.equal(result.ok, true);
    assert.deepEqual(result, { ok: true, userId: 'user_api_owner' });
    assert.equal(calls.some((call) => call.url.endsWith('/api/internal-validate-api-key')), true);
  }, { redisCache: { [`user-api-key:${keyHash}`]: '__WM_NEG__' } });
});

test('revoked key served from bootstrap negative sentinel cache returns 401 without contacting Convex', async () => {
  const keyHash = await sha256HexForTest(USER_KEY);
  await withMockedConvex(async (calls) => {
    const result = await validateBootstrapUserApiKey(USER_KEY);

    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(calls.some((call) => call.url.endsWith('/api/internal-validate-api-key')), false);
  }, { redisCache: { [`bootstrap-user-api-key-invalid:${keyHash}`]: '__WM_NEG__' } });
});

test('current apiAccess entitlement is required', async () => {
  await withMockedConvex(async (calls) => {
    const result = await validateBootstrapUserApiAccess('user_api_owner');

    assert.equal(result.ok, true);
    const cacheWrite = calls.find((call) => call.url.startsWith('https://upstash.test') && call.body.includes('"SET"'));
    assert.ok(cacheWrite);
    assert.match(cacheWrite.body, /entitlements:test:user_api_owner/);
  });
});

test('current apiAccess entitlement can be served from Redis cache without Convex', async () => {
  await withMockedConvex(async (calls) => {
    const result = await validateBootstrapUserApiAccess('user_api_owner');

    assert.equal(result.ok, true);
    assert.equal(calls.some((call) => call.url.endsWith('/api/internal-entitlements')), false);
  }, {
    redisCache: {
      'entitlements:test:user_api_owner': {
        planKey: 'api_starter',
        validUntil: Date.now() + 86_400_000,
        features: { apiAccess: true },
      },
    },
  });
});

async function withMockedEntitlement(entitlement, fn) {
  await withMockedConvex(async (calls) => {
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === 'string' ? init.body : '';
      calls.push({ url, init, body });
      return new Response(JSON.stringify(entitlement), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    return fn(calls);
  });
}

test('future entitlement without apiAccess fails closed with 403 posture', async () => {
  await withMockedEntitlement({
    planKey: 'pro_monthly',
    validUntil: Date.now() + 86_400_000,
    features: { apiAccess: false },
  }, async () => {
    const result = await validateBootstrapUserApiAccess('user_api_owner');

    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  });
});

test('apiAccess entitlement past validUntil fails closed with 403 posture', async () => {
  await withMockedEntitlement({
    planKey: 'api_starter',
    validUntil: Date.now() - 1,
    features: { apiAccess: true },
  }, async () => {
    const result = await validateBootstrapUserApiAccess('user_api_owner');

    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  });
});

test('malformed entitlement response fails closed with 403 posture', async () => {
  await withMockedEntitlement({ ok: true }, async () => {
    const result = await validateBootstrapUserApiAccess('user_api_owner');

    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  });
});

test('stale cached entitlement (past validUntil) re-validates against Convex', async () => {
  await withMockedConvex(async (calls) => {
    const result = await validateBootstrapUserApiAccess('user_api_owner');

    // Cache holds an expired entry -> the validUntil>=now guard fails, code
    // falls through to Convex (which returns an active entitlement) -> ok.
    assert.equal(result.ok, true);
    assert.equal(calls.some((call) => call.url.endsWith('/api/internal-entitlements')), true);
  }, {
    redisCache: {
      'entitlements:test:user_api_owner': {
        planKey: 'api_starter',
        validUntil: Date.now() - 1,
        features: { apiAccess: true },
      },
    },
  });
});

test('transient Convex HTTP 5xx on entitlement check is a retryable 503, not 403', async () => {
  await withMockedConvex(async (calls) => {
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === 'string' ? init.body : '';
      calls.push({ url, init, body });
      if (url.startsWith('https://upstash.test')) {
        return new Response(JSON.stringify([{ result: null }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'boom' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const result = await validateBootstrapUserApiAccess('user_api_owner');

    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.unavailable, true);
    assert.equal(result.error, 'Service temporarily unavailable');
  });
});

test('rate limit accepts a request landing in the final sub-second of the window (ttl=0)', async () => {
  await withMockedConvex(async () => {
    const req = new Request('https://api.worldmonitor.app/api/bootstrap', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });
    const result = await checkBootstrapUserApiKeyRateLimit(req);

    // count under limit, TTL=0 (window expiring this second) must NOT 503.
    assert.equal(result.ok, true);
  }, { redisResults: [{ result: 42 }, { result: 0 }, { result: 0 }] });
});

test('user-key validation rate limit uses IP-scoped keys and never raw API key material', async () => {
  await withMockedConvex(async (calls) => {
    // getClientIp only trusts cf-connecting-ip when the request proves it
    // transited Cloudflare (GHSA-c267): x-wm-edge-proof must match
    // CF_EDGE_PROOF_SECRET. Simulate a genuine CF-proxied request so the bucket
    // is IP-scoped rather than the shared `unknown` fallback.
    process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';
    const req = new Request('https://api.worldmonitor.app/api/bootstrap', {
      headers: {
        'cf-connecting-ip': '203.0.113.7',
        'x-wm-edge-proof': 'edge-secret-xyz',
        'X-WorldMonitor-Key': USER_KEY,
      },
    });
    const result = await checkBootstrapUserApiKeyRateLimit(req);

    assert.equal(result.ok, true);
    const redisCall = calls.find((call) => call.url.startsWith('https://upstash.test'));
    assert.ok(redisCall);
    assert.doesNotMatch(redisCall.body, new RegExp(USER_KEY));
    assert.match(redisCall.body, /rl:bootstrap-user-api-key:203\.0\.113\.7/);
    const commands = JSON.parse(redisCall.body);
    assert.deepEqual(commands[1], ['EXPIRE', 'rl:bootstrap-user-api-key:203.0.113.7', '60', 'NX']);
    assert.deepEqual(commands[2], ['TTL', 'rl:bootstrap-user-api-key:203.0.113.7']);
  });
});

test('user-key validation rate limit accepts an existing fixed window without refreshing TTL', async () => {
  await withMockedConvex(async () => {
    const req = new Request('https://api.worldmonitor.app/api/bootstrap', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });
    const result = await checkBootstrapUserApiKeyRateLimit(req);

    assert.equal(result.ok, true);
  }, { redisResults: [{ result: 42 }, { result: 0 }, { result: 30 }] });
});

test('user-key validation rate limit fails closed when Redis is unavailable', async () => {
  await withMockedConvex(async () => {
    const req = new Request('https://api.worldmonitor.app/api/bootstrap', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });
    const result = await checkBootstrapUserApiKeyRateLimit(req);

    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.headers['X-RateLimit-Mode'], 'degraded');
    assert.equal(result.headers['Cache-Control'], 'no-store');
  }, { redisStatus: 500 });
});

test('user-key validation rate limit fails closed when Redis count is invalid', async () => {
  await withMockedConvex(async () => {
    const req = new Request('https://api.worldmonitor.app/api/bootstrap', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });
    const result = await checkBootstrapUserApiKeyRateLimit(req);

    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.headers['X-RateLimit-Mode'], 'degraded');
    assert.equal(result.headers['Cache-Control'], 'no-store');
  }, { redisResults: [{ result: 0 }, { result: 1 }, { result: 60 }] });
});

test('user-key validation rate limit fails closed when Redis counter has no expiry', async () => {
  await withMockedConvex(async () => {
    const req = new Request('https://api.worldmonitor.app/api/bootstrap', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });
    const result = await checkBootstrapUserApiKeyRateLimit(req);

    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.headers['X-RateLimit-Mode'], 'degraded');
    assert.equal(result.headers['Cache-Control'], 'no-store');
  }, { redisResults: [{ result: 2 }, { result: 0 }, { result: -1 }] });
});

test('user-key validation rate limit uses current TTL for Retry-After when over limit', async () => {
  await withMockedConvex(async () => {
    const req = new Request('https://api.worldmonitor.app/api/bootstrap', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });
    const result = await checkBootstrapUserApiKeyRateLimit(req);

    assert.equal(result.ok, false);
    assert.equal(result.status, 429);
    assert.equal(result.headers['Retry-After'], '17');
    assert.equal(result.headers['Cache-Control'], 'no-store');
  }, { redisResults: [{ result: 601 }, { result: 0 }, { result: 17 }] });
});
