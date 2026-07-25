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

function makeSetWebPushRequest(): Request {
  return new Request('https://worldmonitor.app/api/notification-channels', {
    method: 'POST',
    headers: {
      Origin: 'https://worldmonitor.app',
      Authorization: 'Bearer clerk-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'notification-web-push-timeout-retry',
    },
    body: JSON.stringify({
      action: 'set-web-push',
      endpoint: 'https://fcm.googleapis.com/fcm/send/subscription-1',
      p256dh: 'p256dh-key',
      auth: 'auth-secret',
      userAgent: 'Chrome',
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
    const allRelaySignals: AbortSignal[] = [];
    const timeoutDurations = new WeakMap<AbortSignal, number>();
    const relayTimeouts: Array<number | undefined> = [];
    let mutationAttempt = 0;
    const relayFetch = mock.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        action?: string;
        scheduleWelcome?: boolean;
      };
      const relaySignal = init?.signal as AbortSignal | undefined;
      assert.ok(relaySignal);
      allRelaySignals.push(relaySignal);
      relayTimeouts.push(
        timeoutDurations.get(relaySignal),
      );
      if (body.action === 'welcome-scheduling-capability') {
        return Response.json({ durableWelcomeScheduling: true });
      }
      mutationAttempt += 1;
      const signal = init?.signal as AbortSignal;
      relaySignals.push(signal);
      assert.equal(body.scheduleWelcome, true);
      if (mutationAttempt === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          const rejectForAbort = () => reject(signal.reason ?? new DOMException('Timed out', 'TimeoutError'));
          if (signal.aborted) rejectForAbort();
          else signal.addEventListener('abort', rejectForAbort, { once: true });
        });
      }
      return Response.json({
        ok: true,
        isNew: false,
        durableWelcomeScheduling: true,
      });
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

    AbortSignal.timeout = ((delay: number) => {
      const signal = originalAbortSignalTimeout(Math.min(delay, 10));
      timeoutDurations.set(signal, delay);
      return signal;
    }) as typeof AbortSignal.timeout;

    const ctx = { waitUntil: (_promise: Promise<unknown>) => {} };
    const first = await mod.default(makeSetChannelRequest(), ctx);

    assert.equal(first.status, 500);
    assert.deepEqual(await first.json(), { error: 'Operation failed' });
    assert.equal(first.headers.get('Access-Control-Allow-Origin'), 'https://worldmonitor.app');
    assert.equal(first.headers.get('Idempotency-Key'), 'notification-channel-timeout-retry');
    assert.equal(first.headers.get('Idempotent-Replayed'), 'false');
    assert.equal(relaySignals[0]?.aborted, true);
    assert.deepEqual(
      relayTimeouts,
      [15_000, 15_000],
      'capability probe and mutation must use the bounded 15-second relay deadline',
    );
    assert.equal(
      allRelaySignals[0],
      allRelaySignals[1],
      'capability probe and mutation must share one edge deadline',
    );
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
    assert.equal(relayFetch.mock.calls.length, 4);
    const relayInit = relayFetch.mock.calls[3]!.arguments[1] as RequestInit;
    assert.equal((relayInit.headers as Record<string, string>)['User-Agent'], 'worldmonitor-edge/1.0');
    assert.ok(relayInit.signal instanceof AbortSignal);
    assert.deepEqual(relayTimeouts, [15_000, 15_000, 15_000, 15_000]);
    assert.equal(allRelaySignals[2], allRelaySignals[3]);

    const replay = await mod.default(makeSetChannelRequest(), ctx);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { ok: true });
    assert.equal(replay.headers.get('Idempotent-Replayed'), 'true');
    assert.equal(relayFetch.mock.calls.length, 4, 'completed retry should replay without another relay call');
    assert.equal(consoleError.mock.calls.length >= 1, true);
  });

  it('fails closed and releases idempotency during an old-Convex/new-edge deploy window', async () => {
    const redis = installInMemoryUpstash();
    const mod = await importFreshNotificationChannels();
    const waits: Promise<unknown>[] = [];
    let durableRelayAvailable = false;

    const relayFetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      assert.equal(url, 'https://convex.test/relay/notification-channels');
      const body = JSON.parse(String(init?.body)) as {
        action?: string;
        scheduleWelcome?: boolean;
      };
      if (body.action === 'welcome-scheduling-capability') {
        if (!durableRelayAvailable) {
          return Response.json({ error: 'Unknown action' }, { status: 400 });
        }
        return Response.json({ durableWelcomeScheduling: true });
      }
      assert.equal(body.action, 'set-channel');
      assert.equal(body.scheduleWelcome, true);
      return Response.json({
        ok: true,
        isNew: true,
        durableWelcomeScheduling: true,
      });
    });

    mod.__setNotificationChannelsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: 'user-mixed-deploy' }),
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

    const first = await mod.default(makeSetChannelRequest(), {
      waitUntil: (promise: Promise<unknown>) => {
        waits.push(promise);
      },
    });

    assert.equal(first.status, 503);
    assert.deepEqual(await first.json(), { error: 'Service unavailable' });
    assert.equal(waits.length, 0);
    assert.equal(redis.store.size, 0, 'retryable deploy-window failure must release the processing marker');
    assert.equal(relayFetch.mock.calls.length, 1, 'old Convex must not receive the mutation');

    durableRelayAvailable = true;
    const retry = await mod.default(makeSetChannelRequest(), {
      waitUntil: (promise: Promise<unknown>) => {
        waits.push(promise);
      },
    });

    assert.equal(retry.status, 200);
    assert.equal(waits.length, 0, 'Convex owns the welcome after the retry');
    assert.equal(relayFetch.mock.calls.length, 3);
  });

  it('does not duplicate the welcome after Convex accepts scheduling ownership', async () => {
    installInMemoryUpstash();
    const mod = await importFreshNotificationChannels();
    const waits: Promise<unknown>[] = [];

    const relayFetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      assert.equal(url, 'https://convex.test/relay/notification-channels');
      const body = JSON.parse(String(init?.body)) as {
        action?: string;
        scheduleWelcome?: boolean;
      };
      if (body.action === 'welcome-scheduling-capability') {
        return Response.json({ durableWelcomeScheduling: true });
      }
      assert.equal(body.action, 'set-channel');
      assert.equal(body.scheduleWelcome, true);
      return Response.json({
        ok: true,
        isNew: true,
        durableWelcomeScheduling: true,
      });
    });

    mod.__setNotificationChannelsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: 'user-durable-deploy' }),
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

    const response = await mod.default(makeSetChannelRequest(), {
      waitUntil: (promise: Promise<unknown>) => {
        waits.push(promise);
      },
    });

    assert.equal(response.status, 200);
    assert.equal(waits.length, 0, 'edge must not enqueue a second welcome');
    assert.equal(relayFetch.mock.calls.length, 2);
  });

  it('applies the same fail-closed and duplicate-guard wiring to set-web-push', async () => {
    const redis = installInMemoryUpstash();
    const mod = await importFreshNotificationChannels();
    const waits: Promise<unknown>[] = [];
    let durableRelayAvailable = false;

    const relayFetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      assert.equal(url, 'https://convex.test/relay/notification-channels');
      const body = JSON.parse(String(init?.body)) as {
        action?: string;
        scheduleWelcome?: boolean;
        endpoint?: string;
      };
      if (body.action === 'welcome-scheduling-capability') {
        if (!durableRelayAvailable) {
          return Response.json({ error: 'Unknown action' }, { status: 400 });
        }
        return Response.json({ durableWelcomeScheduling: true });
      }
      assert.equal(body.action, 'set-web-push');
      assert.equal(body.scheduleWelcome, true);
      assert.equal(body.endpoint, 'https://fcm.googleapis.com/fcm/send/subscription-1');
      return Response.json({
        ok: true,
        isNew: true,
        durableWelcomeScheduling: true,
      });
    });

    mod.__setNotificationChannelsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: 'user-web-push-deploy' }),
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

    const ctx = {
      waitUntil: (promise: Promise<unknown>) => {
        waits.push(promise);
      },
    };

    const first = await mod.default(makeSetWebPushRequest(), ctx);
    assert.equal(first.status, 503);
    assert.deepEqual(await first.json(), { error: 'Service unavailable' });
    assert.equal(waits.length, 0);
    assert.equal(redis.store.size, 0, 'deploy-window 503 must release the processing marker');
    assert.equal(relayFetch.mock.calls.length, 1, 'old Convex must not receive the set-web-push mutation');

    durableRelayAvailable = true;
    const retry = await mod.default(makeSetWebPushRequest(), ctx);
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { ok: true });
    assert.equal(waits.length, 0, 'Convex owns the welcome — edge must not enqueue a duplicate');
    assert.equal(relayFetch.mock.calls.length, 3);
  });
});
