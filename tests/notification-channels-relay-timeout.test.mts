import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const originalAbortSignalTimeout = AbortSignal.timeout;

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

async function importFreshNotificationChannels() {
  process.env.CONVEX_SITE_URL = 'https://convex.test';
  process.env.RELAY_SHARED_SECRET = 'relay-secret';
  process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
  return import(`../api/notification-channels.ts?test=${Date.now()}-${Math.random()}`);
}

function makeSetChannelRequest(): Request {
  return new Request('https://worldmonitor.app/api/notification-channels', {
    method: 'POST',
    headers: {
      Origin: 'https://worldmonitor.app',
      Authorization: 'Bearer clerk-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'notification-channel-timeout-retry',
    },
    body: JSON.stringify({
      action: 'set-channel',
      channelType: 'email',
      email: 'retry@example.com',
    }),
  });
}

type RedisCommand = string[];

function installInMemoryUpstash() {
  const store = new Map<string, string>();
  const batches: RedisCommand[][] = [];

  globalThis.fetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), 'https://upstash.test/pipeline');
    const commands = JSON.parse(String(init?.body)) as RedisCommand[];
    batches.push(commands);
    const results = commands.map((command) => {
      const [rawOperation, key, value, ...options] = command;
      const operation = rawOperation?.toUpperCase();
      if (operation === 'GET') return { result: store.get(key!) ?? null };
      if (operation === 'DEL') return { result: store.delete(key!) ? 1 : 0 };
      if (operation === 'SET') {
        const hasNx = options.some((option) => option.toUpperCase() === 'NX');
        if (hasNx && store.has(key!)) return { result: null };
        store.set(key!, value!);
        return { result: 'OK' };
      }
      throw new Error(`Unexpected Redis command: ${command.join(' ')}`);
    });
    return Response.json(results);
  }) as typeof fetch;

  return { store, batches };
}

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalAbortSignalTimeout;
  restoreEnv();
});

describe('/api/notification-channels relay timeout recovery', () => {
  it('returns CORS-safe 500, releases idempotency, and processes the same-key retry', async () => {
    const redis = installInMemoryUpstash();
    const mod = await importFreshNotificationChannels();
    const consoleError = mock.method(console, 'error', () => {});
    const relaySignals: AbortSignal[] = [];
    let relayAttempt = 0;
    const relayFetch = mock.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      relayAttempt += 1;
      const signal = init?.signal as AbortSignal;
      relaySignals.push(signal);
      if (relayAttempt === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          const rejectForAbort = () => reject(signal.reason ?? new DOMException('Timed out', 'TimeoutError'));
          if (signal.aborted) rejectForAbort();
          else signal.addEventListener('abort', rejectForAbort, { once: true });
        });
      }
      return Response.json({ ok: true, isNew: false });
    });

    mod.__setNotificationChannelsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: 'user-timeout-retry' }),
      getEntitlements: async () => ({
        planKey: 'pro_monthly',
        features: {
          tier: 1,
          apiAccess: true,
          apiRateLimit: 1_000,
          maxDashboards: 10,
          prioritySupport: true,
          exportFormats: ['json'],
          mcpAccess: true,
        },
        validUntil: Date.now() + 60_000,
      }),
      fetch: relayFetch,
    });

    AbortSignal.timeout = ((delay: number) =>
      originalAbortSignalTimeout(Math.min(delay, 10))) as typeof AbortSignal.timeout;

    const ctx = { waitUntil: (_promise: Promise<unknown>) => {} };
    const first = await mod.default(makeSetChannelRequest(), ctx);

    assert.equal(first.status, 500);
    assert.deepEqual(await first.json(), { error: 'Operation failed' });
    assert.equal(first.headers.get('Access-Control-Allow-Origin'), 'https://worldmonitor.app');
    assert.equal(first.headers.get('Idempotency-Key'), 'notification-channel-timeout-retry');
    assert.equal(first.headers.get('Idempotent-Replayed'), 'false');
    assert.equal(relaySignals[0]?.aborted, true);
    assert.equal(redis.store.size, 0, 'retryable 500 must release the processing marker');
    assert.equal(
      redis.batches.some((batch) => batch.some(([operation]) => operation === 'DEL')),
      true,
      'timeout path must issue the idempotency DEL cleanup',
    );

    const second = await mod.default(makeSetChannelRequest(), ctx);

    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { ok: true });
    assert.equal(second.headers.get('Idempotency-Key'), 'notification-channel-timeout-retry');
    assert.equal(second.headers.get('Idempotent-Replayed'), 'false');
    assert.equal(relayFetch.mock.calls.length, 2);
    const relayInit = relayFetch.mock.calls[1]!.arguments[1] as RequestInit;
    assert.equal((relayInit.headers as Record<string, string>)['User-Agent'], 'worldmonitor-edge/1.0');
    assert.ok(relayInit.signal instanceof AbortSignal);

    const replay = await mod.default(makeSetChannelRequest(), ctx);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { ok: true });
    assert.equal(replay.headers.get('Idempotent-Replayed'), 'true');
    assert.equal(relayFetch.mock.calls.length, 2, 'completed retry should replay without another relay call');
    assert.equal(consoleError.mock.calls.length >= 1, true);
  });
});
