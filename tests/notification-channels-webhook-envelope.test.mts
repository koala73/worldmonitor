/**
 * #7207 — webhookEnvelope was validated on TRUTHINESS but persisted on
 * DEFINEDNESS. Two adjacent guards on the same variable used different
 * predicates, so `webhookEnvelope: ''` skipped
 * assertNotificationWebhookRegistrationUrlSafe entirely, was encrypted, and
 * was written to the user's channel config as a junk channel that could never
 * deliver. Both guards now share the definedness predicate and the validator
 * rejects empty/blank itself, so the guarantee lives in one place.
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

function makeSetChannelRequest(webhookEnvelope: string, channelType = 'slack'): Request {
  return new Request('https://worldmonitor.app/api/notification-channels', {
    method: 'POST',
    headers: {
      Origin: 'https://worldmonitor.app',
      Authorization: 'Bearer clerk-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: 'set-channel',
      channelType,
      webhookEnvelope,
    }),
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
    if (url.startsWith('https://upstash.test')) {
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
}): RelayCall[] {
  const relayCalls: RelayCall[] = [];
  installDnsFetch();
  mod.__setNotificationChannelsDepsForTests({
    checkScopedRateLimit: async () => ({ allowed: true, limit: 30, reset: 0, degraded: false }),
    validateBearerToken: async () => ({ valid: true, userId: 'user-webhook-envelope' }),
    getEntitlements: async () => proShapedEntitlements(),
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      relayCalls.push({
        url: String(input instanceof Request ? input.url : input),
        body: parsed,
      });
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

describe('set-channel webhookEnvelope guard symmetry (#7207)', () => {
  it('rejects an empty envelope with 400 and writes nothing', async () => {
    const mod = await importFreshNotificationChannels();
    const relayCalls = installDeps(mod);

    const res = await mod.default(makeSetChannelRequest(''), ctx);

    assert.equal(res.status, 400, 'the value validated by neither guard must now be rejected');
    assert.match(((await res.json()) as { error: string }).error, /must not be empty/);
    assert.deepEqual(relayCalls, [], 'nothing may be encrypted or persisted for a rejected envelope');
  });

  it('still rejects an envelope failing URL-safety with its existing message', async () => {
    const mod = await importFreshNotificationChannels();
    const relayCalls = installDeps(mod);

    const res = await mod.default(makeSetChannelRequest('http://hooks.example.com/x'), ctx);

    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /must use HTTPS/);
    assert.deepEqual(relayCalls, []);
  });

  it('still validates, encrypts, and persists a legitimate envelope', async () => {
    const mod = await importFreshNotificationChannels();
    const relayCalls = installDeps(mod);

    const res = await mod.default(
      makeSetChannelRequest('https://hooks.slack.com/services/T000/B000/XXXX'),
      ctx,
    );

    assert.ok(res.status < 400, `expected success, got ${res.status}`);
    const setChannel = relayCalls.find((call) => call.body.action === 'set-channel');
    assert.ok(setChannel, 'the relay must receive the set-channel write');
    assert.match(
      String(setChannel.body.webhookEnvelope),
      /^v1:/,
      'the persisted envelope is the encrypted form',
    );
  });
});

describe('set-channel webhook signing secret', () => {
  it('issues a one-time secret and persists only its encrypted form', async () => {
    const mod = await importFreshNotificationChannels();
    const relayCalls = installDeps(mod);

    const res = await mod.default(makeSetChannelRequest('https://hooks.example.com/in', 'webhook'), ctx);

    assert.equal(res.status, 200);
    const { signingSecret } = (await res.json()) as { signingSecret?: string };
    assert.match(String(signingSecret), /^whsec_[A-Za-z0-9_-]{43}$/);
    const setChannel = relayCalls.find((call) => call.body.action === 'set-channel');
    assert.ok(setChannel);
    const stored = String(setChannel.body.webhookSecret);
    assert.match(stored, /^v1:/);
    assert.ok(!stored.includes(String(signingSecret)), 'plaintext must not reach Convex');
    // The relay must be able to decrypt what the gateway stored.
    const { createRequire } = await import('node:module');
    const { decrypt } = createRequire(import.meta.url)('../scripts/lib/crypto.cjs');
    assert.equal(decrypt(stored), signingSecret);
  });

  it('a second registration issues a different secret (rotation)', async () => {
    const mod = await importFreshNotificationChannels();
    installDeps(mod);
    const first = (await (await mod.default(makeSetChannelRequest('https://hooks.example.com/in', 'webhook'), ctx)).json()) as { signingSecret: string };
    const second = (await (await mod.default(makeSetChannelRequest('https://hooks.example.com/in', 'webhook'), ctx)).json()) as { signingSecret: string };
    assert.notEqual(first.signingSecret, second.signingSecret);
  });

  it('never caches the secret-bearing response for idempotent replay', async () => {
    const mod = await importFreshNotificationChannels();
    installDeps(mod);
    // Stand in for Upstash: the idempotency claim succeeds, then record every
    // command so we can see whether the response was written back.
    const redisCommands: unknown[][] = [];
    const dnsFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === 'https://upstash.test/pipeline') {
        const commands = JSON.parse(String(init?.body)) as unknown[][];
        redisCommands.push(...commands);
        return Response.json(commands.map((cmd) => (
          cmd[0] === 'SET' && cmd.includes('NX') ? { result: 'OK' } : { result: JSON.stringify({ state: 'processing' }) }
        )));
      }
      return dnsFetch(input, init);
    }) as typeof fetch;

    const req = makeSetChannelRequest('https://hooks.example.com/in', 'webhook');
    req.headers.set('Idempotency-Key', 'webhook-save-1');
    const res = await mod.default(req, ctx);

    assert.equal(res.status, 200);
    const { signingSecret } = (await res.json()) as { signingSecret: string };
    assert.match(signingSecret, /^whsec_/);
    assert.ok(redisCommands.some((cmd) => cmd[0] === 'SET' && cmd.includes('NX')), 'the key was claimed');
    assert.ok(
      !redisCommands.some((cmd) => JSON.stringify(cmd).includes(signingSecret)),
      'the plaintext secret must not be written to Redis',
    );
    assert.ok(redisCommands.some((cmd) => cmd[0] === 'DEL'), 'the processing marker is released');
  });

  it('non-webhook channels get no secret', async () => {
    const mod = await importFreshNotificationChannels();
    const relayCalls = installDeps(mod);
    const res = await mod.default(makeSetChannelRequest('https://hooks.slack.com/services/T000/B000/XXXX'), ctx);
    assert.equal(((await res.json()) as { signingSecret?: string }).signingSecret, undefined);
    assert.equal(relayCalls.find((call) => call.body.action === 'set-channel')?.body.webhookSecret, undefined);
  });
});
