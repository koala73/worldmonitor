/**
 * #9215 — Microsoft Teams channel at the gateway: the URL must be a Microsoft
 * Workflows webhook before it is encrypted and stored, and a connected Teams
 * channel can be sent a test card.
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
  // 32 zero-bytes, base64 — encryptSlackWebhook only needs a decodable key.
  process.env.NOTIFICATION_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');
  return import(`../api/notification-channels.ts?test=${Date.now()}-${Math.random()}`);
}

function proShapedEntitlements() {
  return {
    planKey: 'pro',
    features: {
      tier: 1,
      apiAccess: true,
      apiRateLimit: 100,
      maxDashboards: 10,
      prioritySupport: true,
      exportFormats: ['csv'],
      mcpAccess: true,
    },
    validUntil: Date.now() + 86_400_000,
  };
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

/** DNS-over-HTTPS answers for the validator's registration-time resolution. */
function installDnsFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
      const type = new URL(url).searchParams.get('type');
      return Response.json({
        Status: 0,
        Answer: type === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [],
      });
    }
    if (new URL(url).hostname === 'upstash.test') {
      // Idempotency marker reads/writes — irrelevant to this suite.
      return Response.json({ result: null });
    }
    throw new Error(`unexpected global fetch: ${url}`);
  }) as typeof fetch;
}

const ctx = { waitUntil: (_promise: Promise<unknown>) => {} };

type RelayCall = { url: string; body: Record<string, unknown> };

function installDeps(mod: {
  __setNotificationChannelsDepsForTests(overrides: unknown): void;
}, { queueStatus = 200, queueGate }: { queueStatus?: number; queueGate?: Promise<void> } = {}): RelayCall[] {
  const relayCalls: RelayCall[] = [];
  installDnsFetch();
  mod.__setNotificationChannelsDepsForTests({
    checkScopedRateLimit: async () => ({ allowed: true, limit: 30, reset: 0, degraded: false }),
    validateBearerToken: async () => ({ valid: true, userId: 'user-teams' }),
    getEntitlements: async () => proShapedEntitlements(),
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      relayCalls.push({
        url: String(input instanceof Request ? input.url : input),
        body: parsed,
      });
      if (new URL(String(input instanceof Request ? input.url : input)).hostname === 'upstash.test') {
        if (queueGate) await queueGate;
        return Response.json({ result: 1 }, { status: queueStatus });
      }
      // The set-channel write negotiates durable welcome scheduling first.
      if (parsed.action === 'welcome-scheduling-capability') {
        return Response.json({ durableWelcomeScheduling: true });
      }
      return Response.json({ ok: true, isNew: false, durableWelcomeScheduling: true });
    },
    captureSilentError: () => {},
  });
  return relayCalls;
}

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  restoreEnv();
});

const TEAMS_URL = 'https://abc123.12.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/0a1b2c/triggers/manual/paths/invoke?api-version=1&sig=test';

describe('set-channel teams', () => {
  for (const [label, url, pattern] of [
    ['a non-Microsoft host', 'https://hooks.example.com/powerautomate/automations/direct/workflows/x', /Workflows webhook/],
    ['a retired Office 365 connector URL', 'https://contoso.webhook.office.com/webhookb2/a/IncomingWebhook/b/c', /retired/],
    ['an IP literal', 'https://20.42.65.92/workflows/x', /Workflows webhook/],
    ['plain http', 'http://abc.environment.api.powerplatform.com/powerautomate/automations/direct/x', /HTTPS/],
  ] as const) {
    it(`rejects ${label} with 400 and writes nothing`, async () => {
      const mod = await importFreshNotificationChannels();
      const relayCalls = installDeps(mod);
      const res = await mod.default(makeRequest({ action: 'set-channel', channelType: 'teams', webhookEnvelope: url }), ctx);
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { error: string }).error, pattern);
      assert.deepEqual(relayCalls, []);
    });
  }

  it('encrypts and persists a Workflows URL without a signing secret', async () => {
    const mod = await importFreshNotificationChannels();
    const relayCalls = installDeps(mod);
    const res = await mod.default(makeRequest({ action: 'set-channel', channelType: 'teams', webhookEnvelope: TEAMS_URL }), ctx);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { signingSecret?: string }).signingSecret, undefined);
    const setChannel = relayCalls.find((call) => call.body.action === 'set-channel');
    assert.ok(setChannel);
    assert.equal(setChannel.body.channelType, 'teams');
    assert.equal(setChannel.body.webhookSecret, undefined);
    const { createRequire } = await import('node:module');
    const { decrypt } = createRequire(import.meta.url)('../scripts/lib/crypto.cjs');
    assert.equal(decrypt(String(setChannel.body.webhookEnvelope)), TEAMS_URL);
  });

  it('a generic webhook is not held to the Microsoft allowlist', async () => {
    const mod = await importFreshNotificationChannels();
    installDeps(mod);
    const res = await mod.default(makeRequest({ action: 'set-channel', channelType: 'webhook', webhookEnvelope: 'https://hooks.example.com/in' }), ctx);
    assert.equal(res.status, 200);
  });
});

describe('send-test', () => {
  it('queues a test card for the connected Teams channel', async () => {
    const mod = await importFreshNotificationChannels();
    // The queue write is held open: the handler must not answer until it
    // completes, or "Test sent" could be shown for a test that was never queued.
    let release!: () => void;
    const queueGate = new Promise<void>((resolve) => { release = resolve; });
    const relayCalls = installDeps(mod, { queueGate });
    let settled = false;
    const pendingResponse = mod.default(makeRequest({ action: 'send-test', channelType: 'teams' }), { waitUntil: () => {} })
      .then((response: Response) => { settled = true; return response; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false, 'send-test answered before the queue write completed');
    release();
    const res = await pendingResponse;
    assert.equal(res.status, 200);
    const queued = relayCalls.filter((call) => {
      const parsed = new URL(call.url);
      return parsed.hostname === 'upstash.test' && parsed.pathname.startsWith('/lpush/wm:events:queue/');
    });
    assert.equal(queued.length, 1, 'exactly one welcome event is queued');
    assert.equal(relayCalls.length, 1, 'nothing is written to Convex');
    const message = JSON.parse(decodeURIComponent(queued[0].url.split('/').pop()!));
    assert.deepEqual(message, { eventType: 'channel_welcome', userId: 'user-teams', channelType: 'teams' });
  });

  it('returns 503 when the test could not be queued', async () => {
    const mod = await importFreshNotificationChannels();
    installDeps(mod, { queueStatus: 500 });
    const res = await mod.default(makeRequest({ action: 'send-test', channelType: 'teams' }), ctx);
    assert.equal(res.status, 503);
    assert.match(((await res.json()) as { error: string }).error, /could not be queued/i);
  });

  it('rejects channel types without a test send', async () => {
    const mod = await importFreshNotificationChannels();
    const relayCalls = installDeps(mod);
    const res = await mod.default(makeRequest({ action: 'send-test', channelType: 'email' }), ctx);
    assert.equal(res.status, 400);
    assert.deepEqual(relayCalls, []);
  });
});
