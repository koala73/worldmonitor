/**
 * Strix pentest 2026-10-27, "unbounded notification/alert rules": the edge
 * handler relayed any `variant` / `eventTypes` / `channels` to Convex. The
 * same bounds every Convex writer enforces (shared/alert-rule-shape.ts) are
 * answered here as a 400 with the code, before any relay round trip, and a
 * relay 400 (the per-account row cap) passes through with its body intact on
 * every alert-rule action.
 *
 * Run: node --import tsx --test tests/notification-channels-rule-shape.test.mts
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  ALERT_RULE_CHANNELS_MAX,
  ALERT_RULE_EVENT_TYPES_MAX,
  ALERT_RULE_EVENT_TYPE_MAX_LENGTH,
} from '../shared/alert-rule-shape';

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

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('https://worldmonitor.app/api/notification-channels', {
    method: 'POST',
    headers: {
      Origin: 'https://worldmonitor.app',
      Authorization: 'Bearer clerk-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function proEntitlements() {
  return {
    planKey: 'pro_monthly',
    features: { tier: 1, apiAccess: false, apiRateLimit: 0, maxDashboards: 3, prioritySupport: false, exportFormats: ['csv'], mcpAccess: false },
    validUntil: Date.now() + 86_400_000,
  };
}

async function installDeps(relay: { status: number; body: unknown } = { status: 200, body: { ok: true } }) {
  const mod = await importFreshNotificationChannels();
  const relayBodies: Array<Record<string, unknown>> = [];
  mod.__setNotificationChannelsDepsForTests({
    validateBearerToken: async () => ({ valid: true, userId: 'user_shape' }),
    getEntitlements: async () => proEntitlements(),
    checkScopedRateLimit: async () => ({ allowed: true, limit: 30, reset: 0, degraded: false }),
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      relayBodies.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(JSON.stringify(relay.body), { status: relay.status, headers: { 'Content-Type': 'application/json' } });
    },
  });
  return { mod, relayBodies };
}

const ctx = { waitUntil: (_promise: Promise<unknown>) => {} };

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  restoreEnv();
});

const tooManyEventTypes = Array.from({ length: ALERT_RULE_EVENT_TYPES_MAX + 1 }, (_, i) => `t${i}`);
const tooLongEventType = ['x'.repeat(ALERT_RULE_EVENT_TYPE_MAX_LENGTH + 1)];
const tooManyChannels = Array.from({ length: ALERT_RULE_CHANNELS_MAX + 1 }, () => 'email');
const base = { enabled: true, eventTypes: [], channels: [] };

describe('/api/notification-channels alert-rule shape bounds', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['set-alert-rules: variant outside the registry', { action: 'set-alert-rules', variant: 'v0', ...base }, 'VARIANT_INVALID'],
    ['set-alert-rules: 900 KB variant', { action: 'set-alert-rules', variant: 'x'.repeat(900_000), ...base }, 'VARIANT_INVALID'],
    [`set-alert-rules: eventTypes > ${ALERT_RULE_EVENT_TYPES_MAX}`, { action: 'set-alert-rules', variant: 'full', ...base, eventTypes: tooManyEventTypes }, 'EVENT_TYPES_INVALID'],
    [`set-alert-rules: eventType > ${ALERT_RULE_EVENT_TYPE_MAX_LENGTH} chars`, { action: 'set-alert-rules', variant: 'full', ...base, eventTypes: tooLongEventType }, 'EVENT_TYPES_INVALID'],
    ['set-alert-rules: eventType that is not a string', { action: 'set-alert-rules', variant: 'full', ...base, eventTypes: [{ huge: true }] }, 'EVENT_TYPES_INVALID'],
    [`set-alert-rules: channels > ${ALERT_RULE_CHANNELS_MAX}`, { action: 'set-alert-rules', variant: 'full', ...base, channels: tooManyChannels }, 'CHANNELS_INVALID'],
    ['set-alert-rules: unknown channel type', { action: 'set-alert-rules', variant: 'full', ...base, channels: ['carrier-pigeon'] }, 'CHANNELS_INVALID'],
    ['set-notification-config: variant outside the registry', { action: 'set-notification-config', variant: 'v0' }, 'VARIANT_INVALID'],
    [`set-notification-config: eventTypes > ${ALERT_RULE_EVENT_TYPES_MAX}`, { action: 'set-notification-config', variant: 'full', eventTypes: tooManyEventTypes }, 'EVENT_TYPES_INVALID'],
    [`set-notification-config: channels > ${ALERT_RULE_CHANNELS_MAX}`, { action: 'set-notification-config', variant: 'full', channels: tooManyChannels }, 'CHANNELS_INVALID'],
    ['set-digest-settings: variant outside the registry', { action: 'set-digest-settings', variant: 'v0', digestMode: 'daily' }, 'VARIANT_INVALID'],
    ['set-quiet-hours: variant outside the registry', { action: 'set-quiet-hours', variant: 'v0', quietHoursEnabled: false }, 'VARIANT_INVALID'],
  ];

  for (const [name, body, code] of cases) {
    it(`${name} → 400 ${code} without a relay call`, async () => {
      const { mod, relayBodies } = await installDeps();
      const res = await mod.default(makeRequest(body), ctx);
      assert.equal(res.status, 400);
      const payload = await res.json() as { error: string; message?: string };
      assert.equal(payload.error, code);
      assert.ok(payload.message, 'carries a human-readable message');
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://worldmonitor.app');
      assert.deepEqual(relayBodies, []);
    });
  }

  it('an in-shape rule for every registry variant reaches the relay unchanged', async () => {
    const { mod, relayBodies } = await installDeps();
    for (const variant of ['full', 'tech', 'finance', 'happy', 'commodity', 'energy']) {
      const res = await mod.default(makeRequest({
        action: 'set-alert-rules', variant, enabled: true, sensitivity: 'critical',
        eventTypes: ['watchlist_story_alert', 'chokepoint_disruption'], channels: ['email', 'telegram', 'web_push'],
      }), ctx);
      assert.equal(res.status, 200);
    }
    assert.equal(relayBodies.length, 6);
    assert.deepEqual(relayBodies[0]!.eventTypes, ['watchlist_story_alert', 'chokepoint_disruption']);
    assert.deepEqual(relayBodies[0]!.channels, ['email', 'telegram', 'web_push']);
  });

  for (const action of ['set-alert-rules', 'set-notification-config', 'set-digest-settings', 'set-quiet-hours']) {
    it(`${action}: the relay's per-account row cap 400 passes through with its body`, async () => {
      const { mod } = await installDeps({ status: 400, body: { error: 'RULE_LIMIT_EXCEEDED', message: 'an account holds at most 6 alert rules (one per variant)' } });
      const res = await mod.default(makeRequest({ action, variant: 'full', ...base, digestMode: 'daily', quietHoursEnabled: false }), ctx);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: 'RULE_LIMIT_EXCEEDED', message: 'an account holds at most 6 alert rules (one per variant)' });
    });
  }
});
