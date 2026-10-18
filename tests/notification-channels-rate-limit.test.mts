/**
 * Every /api/notification-channels POST writes through the Convex relay and the
 * durable-welcome path can send mail, so a signed-in Pro user needs a per-user
 * write budget. The limiter runs after the Pro gate and fails closed on a
 * limiter outage (retryable 503), matching api/notify.ts.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

async function importFreshNotificationChannels() {
  process.env.CONVEX_SITE_URL = 'https://convex.test';
  process.env.CONVEX_TENANT_RELAY_SECRET = 'relay-secret';
  process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
  return import(`../api/notification-channels.ts?test=${Date.now()}-${Math.random()}`);
}

function makeRequest(method: 'GET' | 'POST', body?: Record<string, unknown>): Request {
  return new Request('https://worldmonitor.app/api/notification-channels', {
    method,
    headers: {
      Origin: 'https://worldmonitor.app',
      Authorization: 'Bearer clerk-token',
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function proEntitlements() {
  return {
    planKey: 'pro_monthly',
    features: {
      tier: 1,
      apiAccess: false,
      apiRateLimit: 0,
      maxDashboards: 3,
      prioritySupport: false,
      exportFormats: ['csv'],
      mcpAccess: false,
    },
    validUntil: Date.now() + 86_400_000,
  };
}

type ScopedResult = { allowed: boolean; limit: number; reset: number; degraded: boolean };
type Call = { scope: string; limit: number; window: string; identifier: string };

async function installDeps(result: ScopedResult, options: { freeTier?: boolean } = {}) {
  const mod = await importFreshNotificationChannels();
  const limiterCalls: Call[] = [];
  const relayCalls: string[] = [];
  mod.__setNotificationChannelsDepsForTests({
    validateBearerToken: async () => ({ valid: true, userId: 'user_rate_limit' }),
    getEntitlements: async () => (options.freeTier
      ? { ...proEntitlements(), planKey: 'free', features: { ...proEntitlements().features, tier: 0 }, validUntil: 0 }
      : proEntitlements()),
    checkScopedRateLimit: async (scope: string, limit: number, window: string, identifier: string) => {
      limiterCalls.push({ scope, limit, window, identifier });
      return result;
    },
    fetch: async (input: RequestInfo | URL) => {
      relayCalls.push(String(input));
      return new Response(JSON.stringify({ rules: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  return { mod, limiterCalls, relayCalls };
}

const ctx = { waitUntil: (_promise: Promise<unknown>) => {} };
const ALLOWED: ScopedResult = { allowed: true, limit: 30, reset: 0, degraded: false };

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  restoreEnv();
});

describe('/api/notification-channels POST write rate limit', () => {
  it('budgets POST writes per user on the exported scope, then reaches the relay', async () => {
    const { mod, limiterCalls, relayCalls } = await installDeps(ALLOWED);

    const res = await mod.default(makeRequest('POST', { action: 'set-alert-rules', rules: [] }), ctx);

    assert.notEqual(res.status, 429);
    assert.notEqual(res.status, 503);
    assert.deepEqual(limiterCalls, [{
      scope: mod.NOTIFICATION_CHANNELS_WRITE_RATE_SCOPE,
      limit: mod.NOTIFICATION_CHANNELS_WRITE_RATE_LIMIT,
      window: mod.NOTIFICATION_CHANNELS_WRITE_RATE_WINDOW,
      identifier: 'user_rate_limit',
    }]);
    assert.equal(relayCalls.length, 1);
    assert.match(relayCalls[0]!, /\/relay\/notification-channels$/);
  });

  it('returns 429 with the shared Retry-After contract and never reaches the relay', async () => {
    const reset = Date.now() + 42_000;
    const { mod, relayCalls } = await installDeps({ allowed: false, limit: 30, reset, degraded: false });

    const res = await mod.default(makeRequest('POST', { action: 'set-alert-rules', rules: [] }), ctx);

    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: 'RATE_LIMITED' });
    assert.ok(Number(res.headers.get('Retry-After')) > 0);
    assert.equal(res.headers.get('X-RateLimit-Limit'), '30');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://worldmonitor.app');
    assert.deepEqual(relayCalls, []);
  });

  it('fails closed with a retryable 503 when the limiter is degraded', async () => {
    const { mod, relayCalls } = await installDeps({ allowed: true, limit: 30, reset: 0, degraded: true });

    const res = await mod.default(makeRequest('POST', { action: 'set-alert-rules', rules: [] }), ctx);

    assert.equal(res.status, 503);
    assert.ok(res.headers.get('Retry-After'));
    assert.deepEqual(relayCalls, []);
  });

  it('does not spend the limiter on a caller the Pro gate already turns away', async () => {
    const { mod, limiterCalls } = await installDeps(ALLOWED, { freeTier: true });

    const res = await mod.default(makeRequest('POST', { action: 'set-alert-rules', rules: [] }), ctx);

    assert.equal(res.status, 403);
    assert.deepEqual(limiterCalls, []);
  });

  it('leaves GET reads unmetered', async () => {
    const { mod, limiterCalls } = await installDeps({ allowed: false, limit: 30, reset: Date.now() + 1000, degraded: false });

    const res = await mod.default(makeRequest('GET'), ctx);

    assert.equal(res.status, 200);
    assert.deepEqual(limiterCalls, []);
  });
});
