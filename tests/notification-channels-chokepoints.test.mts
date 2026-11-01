// #9217 item 6: the edge route forwards an alert rule's chokepoint scope to
// the Convex relay and rejects a non-array before any relay call.
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

async function importFresh() {
  process.env.CONVEX_SITE_URL = 'https://convex.test';
  process.env.CONVEX_TENANT_RELAY_SECRET = 'relay-secret';
  process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
  return import(`../api/notification-channels.ts?test=${Date.now()}-${Math.random()}`);
}

const proEntitlements = {
  planKey: 'pro_monthly',
  features: { tier: 1, apiAccess: false, apiRateLimit: 0, maxDashboards: 10, prioritySupport: false, exportFormats: ['csv'], mcpAccess: false },
  validUntil: Date.now() + 86_400_000,
};

const ctx = { waitUntil: (_promise: Promise<unknown>) => {} };

function request(body: Record<string, unknown>): Request {
  return new Request('https://worldmonitor.app/api/notification-channels', {
    method: 'POST',
    headers: {
      Origin: 'https://worldmonitor.app',
      Authorization: 'Bearer clerk-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': `chokepoints-${Math.random()}`,
    },
    body: JSON.stringify(body),
  });
}

async function harness() {
  const mod = await importFresh();
  const relayBodies: Record<string, unknown>[] = [];
  mod.__setNotificationChannelsDepsForTests({
    checkScopedRateLimit: async () => ({ allowed: true, limit: 30, reset: 0, degraded: false }),
    validateBearerToken: async () => ({ valid: true, userId: 'user-chokepoints' }),
    getEntitlements: async () => proEntitlements,
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      relayBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    captureSilentError: () => {},
  });
  mock.method(console, 'warn', () => {});
  return { mod, relayBodies };
}

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  restoreEnv();
});

const rule = { variant: 'full', enabled: true, eventTypes: ['chokepoint_disruption'], sensitivity: 'critical', channels: ['email'] };

describe('/api/notification-channels chokepoint scope', () => {
  for (const action of ['set-alert-rules', 'set-notification-config']) {
    it(`${action} forwards chokepoints to the relay`, async () => {
      const { mod, relayBodies } = await harness();
      const res = await mod.default(request({ action, ...rule, chokepoints: ['hormuz_strait', 'suez'] }), ctx);
      assert.equal(res.status, 200);
      const forwarded = relayBodies.find((body) => body.action === action);
      assert.deepEqual(forwarded?.chokepoints, ['hormuz_strait', 'suez']);
      assert.deepEqual(forwarded?.eventTypes, ['chokepoint_disruption']);
    });

    it(`${action} rejects a non-array chokepoints value before the relay`, async () => {
      const { mod, relayBodies } = await harness();
      const res = await mod.default(request({ action, ...rule, chokepoints: 'suez' }), ctx);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: 'CHOKEPOINTS_MUST_BE_ARRAY' });
      assert.equal(relayBodies.some((body) => body.action === action), false);
    });
  }
});
