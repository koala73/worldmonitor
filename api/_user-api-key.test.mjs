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

// `userKeyInFlight` is module-scope state keyed by the SHA-256 of the API key.
// Handing every coalescing/cache test its own canonical key makes cross-test
// contamination structurally impossible rather than cleanup-dependent.
let userKeySeq = 0;
function uniqueUserKey() {
  userKeySeq += 1;
  return `wm_${userKeySeq.toString(16).padStart(40, '0')}`;
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
        // Convex validateKeyByHash returns `id`, not `keyId`; bootstrap maps it.
        : { id: 'key_1', userId: 'user_api_owner', name: 'pipeline' };
      return new Response(JSON.stringify(value), {
        status: options.validateStatus ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/api/internal-entitlements')) {
      const value = Object.hasOwn(options, 'entitlementResponse')
        ? options.entitlementResponse
        : {
            planKey: 'api_starter',
            validUntil: Date.now() + 86_400_000,
            features: { apiAccess: true },
          };
      return new Response(JSON.stringify(value), {
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

// --- Cached user-key entry must be shape-checked before it authenticates ---
// The cache is shared with the gateway (server/_shared/user-api-key.ts) and is
// reachable by anything that can write `user-api-key:<hash>`. A malformed or
// truncated entry must never short-circuit into an authenticated identity; control
// has to fall through to the negative-cache / Convex path instead.
const UNTRUSTWORTHY_CACHED_USER_KEY_ENTRIES = [
  // Kills the `userId.length > 0` conjunct: an empty userId is a valid string.
  ['an empty userId', { userId: '' }],
  // Kills the `typeof userId === "string"` conjunct: an array is truthy, is an
  // object, and has a length > 0, so only the typeof check rejects it.
  ['an array userId', { userId: ['user_evil'] }],
  ['a numeric userId', { userId: 123 }],
  ['a null userId', { userId: null }],
  // Kills the `cached.value &&` conjunct: typeof null === 'object', so the
  // truthiness check is the only thing standing between us and a TypeError.
  ['a null entry', null],
  ['a bare string entry', 'user_evil'],
  ['a bare array entry', []],
  ['a bare number entry', 42],
];

for (const [label, cachedValue] of UNTRUSTWORTHY_CACHED_USER_KEY_ENTRIES) {
  test(`cached user-key entry with ${label} is not trusted and re-validates against Convex`, async () => {
    const key = uniqueUserKey();
    const keyHash = await sha256HexForTest(key);
    await withMockedConvex(async (calls) => {
      const result = await validateBootstrapUserApiKey(key);

      // "Not trusted" is not the same as 401: the entry is ignored and the
      // request proceeds, so the authoritative Convex answer is what wins.
      assert.deepEqual(result, { ok: true, userId: 'user_api_owner' });
      assert.equal(calls.some((call) => call.url.endsWith('/api/internal-validate-api-key')), true);
    }, { redisCache: { [`user-api-key:${keyHash}`]: cachedValue } });
  });
}

test('control: a well-formed cached user-key entry does authenticate without Convex', async () => {
  const key = uniqueUserKey();
  const keyHash = await sha256HexForTest(key);
  await withMockedConvex(async (calls) => {
    const result = await validateBootstrapUserApiKey(key);

    assert.deepEqual(result, { ok: true, userId: 'user_abc' });
    assert.equal(calls.some((call) => call.url.endsWith('/api/internal-validate-api-key')), false);
  }, { redisCache: { [`user-api-key:${keyHash}`]: { userId: 'user_abc' } } });
});

// --- Request coalescing collapses a burst onto one Convex round-trip ---
// Without it, N concurrent requests carrying the same key amplify 1:1 onto
// Convex, turning one leaked key into a validation-service DoS lever.
async function withSlowConvex(fn, options = {}) {
  const delayMs = options.delayMs ?? 25;
  await withMockedConvex(async (calls) => {
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === 'string' ? init.body : '';
      calls.push({ url, init, body });

      if (url.startsWith('https://upstash.test')) {
        const commands = JSON.parse(body || '[]');
        const result = commands[0]?.[0] === 'SET' ? 'OK' : null;
        return new Response(JSON.stringify([{ result }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Slow enough that every concurrent caller is still in flight when the
      // next one arrives — otherwise the test would pass even without coalescing.
      await new Promise((resolve) => { setTimeout(resolve, delayMs); });
      return new Response(JSON.stringify({ id: 'key_1', userId: 'user_api_owner', name: 'pipeline' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    return fn(calls, (c) => c.url.endsWith('/api/internal-validate-api-key'));
  });
}

test('concurrent validations of one user key coalesce into a single Convex round-trip', async () => {
  const key = uniqueUserKey();
  await withSlowConvex(async (calls, isConvexCall) => {
    const results = await Promise.all(Array.from({ length: 5 }, () => validateBootstrapUserApiKey(key)));

    for (const result of results) {
      assert.deepEqual(result, { ok: true, userId: 'user_api_owner' });
    }
    const convexCalls = calls.filter(isConvexCall);
    assert.equal(convexCalls.length, 1, `5 concurrent callers must amplify to 1 Convex call, got ${convexCalls.length}`);
  });
});

test('negative control: concurrent validations of distinct keys are not coalesced', async () => {
  const keys = Array.from({ length: 5 }, () => uniqueUserKey());
  await withSlowConvex(async (calls, isConvexCall) => {
    const results = await Promise.all(keys.map((key) => validateBootstrapUserApiKey(key)));

    for (const result of results) {
      assert.deepEqual(result, { ok: true, userId: 'user_api_owner' });
    }
    // Proves the previous test measures coalescing on the key hash rather than
    // some blanket cache or a stubbed-out backend.
    assert.equal(calls.filter(isConvexCall).length, 5);
  });
});

test('the in-flight coalescing map releases its entry once validation settles', async () => {
  const key = uniqueUserKey();
  await withSlowConvex(async (calls, isConvexCall) => {
    await validateBootstrapUserApiKey(key);
    assert.equal(calls.filter(isConvexCall).length, 1);

    // A settled promise left behind in the map would serve this second call
    // forever (a stale-auth bug and an unbounded module-scope memory leak).
    await validateBootstrapUserApiKey(key);
    assert.equal(calls.filter(isConvexCall).length, 2, 'in-flight entry was not released after the first call settled');
  });
});

// --- The Convex auth fetch must be bounded by a timeout ---
test('Convex key-validation fetch is bounded by an AbortSignal timeout', async () => {
  const key = uniqueUserKey();
  const realAbortTimeout = AbortSignal.timeout;
  const delayBySignal = new WeakMap();

  // Record the delay production asked for, but arm the real timer far shorter
  // so the bound is proven behaviourally without a multi-second wall-clock wait.
  AbortSignal.timeout = function timeout(ms) {
    const signal = realAbortTimeout.call(AbortSignal, 20);
    delayBySignal.set(signal, ms);
    return signal;
  };
  // AbortSignal.timeout unrefs its timer, so nothing here would keep the event
  // loop alive while we await a promise that only settles on abort.
  const keepAlive = setInterval(() => {}, 5);

  let convexSignal;
  let abortedWhenHandedToFetch;
  try {
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

        convexSignal = init?.signal;
        if (!(convexSignal instanceof AbortSignal)) {
          // No signal => an unbounded auth fetch. Answer immediately rather than
          // hanging the suite forever; the assertions below report the failure.
          return new Response(JSON.stringify({ id: 'key_1', userId: 'user_api_owner', name: 'pipeline' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        abortedWhenHandedToFetch = convexSignal.aborted;
        // Never settles on its own: only the timeout can end this request.
        return await new Promise((_resolve, reject) => {
          convexSignal.addEventListener('abort', () => reject(convexSignal.reason), { once: true });
        });
      };

      const result = await validateBootstrapUserApiKey(key);

      assert.ok(convexSignal instanceof AbortSignal, 'Convex validation fetch must be given an AbortSignal');
      assert.equal(delayBySignal.get(convexSignal), 3_000, 'must use VALIDATION_TIMEOUT_MS');
      assert.equal(abortedWhenHandedToFetch, false, 'signal must not arrive pre-aborted');
      assert.equal(convexSignal.aborted, true, 'signal must abort on its own timer, unprompted');
      // A hung validator is an outage, not a credential verdict.
      assert.equal(result.ok, false);
      assert.equal(result.status, 503);
      assert.equal(result.unavailable, true);
    });
  } finally {
    AbortSignal.timeout = realAbortTimeout;
    clearInterval(keepAlive);
  }
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

for (const billingStatus of [
  'subscription_lapsed',
  'renewal_verification_pending',
  'renewal_verification_failed',
]) {
  test(`current cached apiAccess remains usable with ${billingStatus}`, async () => {
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
          billingStatus,
          retryAfterSeconds: 19,
        },
      },
    });
  });
}

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

for (const billingStatus of [
  'subscription_lapsed',
  'renewal_verification_pending',
  'renewal_verification_failed',
]) {
  test(`current fresh apiAccess remains usable with ${billingStatus}`, async () => {
    await withMockedEntitlement({
      planKey: 'api_starter',
      validUntil: Date.now() + 86_400_000,
      features: { apiAccess: true },
      billingStatus,
      retryAfterSeconds: 19,
    }, async () => {
      const result = await validateBootstrapUserApiAccess('user_api_owner');

      assert.equal(result.ok, true);
    });
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

test('renewal verification pending is a distinct retryable 503', async () => {
  await withMockedEntitlement({
    planKey: 'free',
    validUntil: 0,
    features: { apiAccess: false },
    billingStatus: 'renewal_verification_pending',
    retryAfterSeconds: 19,
  }, async () => {
    const result = await validateBootstrapUserApiAccess('user_api_owner');

    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.reason, 'renewal_verification_pending');
    assert.equal(result.error, 'Renewal verification pending');
    assert.equal(result.headers['Retry-After'], '19');
    assert.equal(result.headers['X-Billing-Verification'], 'renewal_verification_pending');
  });
});

test('confirmed subscription lapse is distinct from verification failure', async () => {
  await withMockedEntitlement({
    planKey: 'free',
    validUntil: 0,
    features: { apiAccess: false },
    billingStatus: 'subscription_lapsed',
  }, async () => {
    const result = await validateBootstrapUserApiAccess('user_api_owner');

    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(result.reason, 'subscription_lapsed');
    assert.equal(result.error, 'API access subscription lapsed');
    assert.equal(result.headers['X-Billing-Verification'], 'subscription_lapsed');
  });
});

test('short-lived verification marker is served from Redis without another Convex request', async () => {
  await withMockedConvex(async (calls) => {
    const result = await validateBootstrapUserApiAccess('user_api_owner');

    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.reason, 'renewal_verification_failed');
    assert.equal(calls.some((call) => call.url.endsWith('/api/internal-entitlements')), false);
  }, {
    redisCache: {
      'entitlements:test:user_api_owner': {
        planKey: 'free',
        validUntil: 0,
        features: { apiAccess: false },
        billingStatus: 'renewal_verification_failed',
        retryAfterSeconds: 9,
      },
    },
  });
});

test('recent not-applicable freshness marker is served from Redis without another Convex request', async () => {
  await withMockedConvex(async (calls) => {
    const result = await validateBootstrapUserApiAccess('user_api_owner');

    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(result.reason, 'cached-forbidden');
    assert.equal(calls.some((call) => call.url.endsWith('/api/internal-entitlements')), false);
  }, {
    redisCache: {
      'entitlements:test:user_api_owner': {
        planKey: 'free',
        validUntil: 0,
        features: { apiAccess: false },
        renewalVerificationFreshness: {
          status: 'not_applicable',
          checkedAt: Date.now(),
        },
      },
    },
  });
});

test('expired not-applicable freshness marker falls through to Convex', async () => {
  await withMockedConvex(async (calls) => {
    const result = await validateBootstrapUserApiAccess('user_api_owner');

    assert.equal(result.ok, true);
    assert.equal(calls.some((call) => call.url.endsWith('/api/internal-entitlements')), true);
  }, {
    redisCache: {
      'entitlements:test:user_api_owner': {
        planKey: 'free',
        validUntil: 0,
        features: { apiAccess: false },
        renewalVerificationFreshness: {
          status: 'not_applicable',
          checkedAt: Date.now() - 900_001,
        },
      },
    },
  });
});

test('not-applicable freshness marker is cached for at most 900 seconds', async () => {
  await withMockedConvex(async (calls) => {
    const result = await validateBootstrapUserApiAccess('user_api_owner');

    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    const cacheWrite = calls.find((call) => {
      if (!call.url.startsWith('https://upstash.test') || !call.body.includes('"SET"')) return false;
      const command = JSON.parse(call.body).find((entry) => entry[0] === 'SET');
      return command?.[1] === 'entitlements:test:user_api_owner';
    });
    assert.ok(cacheWrite);
    const setCommand = JSON.parse(cacheWrite.body).find((entry) => entry[0] === 'SET');
    const ttl = Number(setCommand[4]);
    assert.ok(ttl > 0 && ttl <= 900, `unexpected marker TTL: ${ttl}`);
  }, {
    entitlementResponse: {
      planKey: 'free',
      validUntil: 0,
      features: { apiAccess: false },
      renewalVerificationFreshness: {
        status: 'not_applicable',
        checkedAt: Date.now(),
      },
    },
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

test('transient Convex HTTP 5xx on entitlement check emits the entitlement_verification_unavailable contract', async () => {
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
    // Matches server/gateway.ts's wm_-key branch and docs/usage-errors.mdx —
    // the bootstrap surface must speak the same billing-verification contract.
    assert.equal(result.error, 'Unable to verify API access');
    assert.equal(result.reason, 'entitlement_verification_unavailable');
    assert.equal(result.headers['X-Billing-Verification'], 'entitlement_verification_unavailable');
    assert.equal(result.headers['X-Validation-Mode'], 'degraded');
    assert.equal(result.headers['Retry-After'], '5');
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

test('user-key validation rate limit accepts exactly the configured maximum (600)', async () => {
  await withMockedConvex(async () => {
    const req = new Request('https://api.worldmonitor.app/api/bootstrap', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });
    const result = await checkBootstrapUserApiKeyRateLimit(req);

    assert.equal(result.ok, true);
  }, { redisResults: [{ result: 600 }, { result: 0 }, { result: 17 }] });
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
