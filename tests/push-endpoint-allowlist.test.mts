import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { parse as legacyParse } from 'node:url';

// Sentry WORLDMONITOR-1B0 / WORLDMONITOR-XR: Chrome-labelled browsers on macOS
// got "endpoint host is not a recognised push service" during Pro activation.
// Chromium hands out https://jmt17.google.com/fcm/send/ endpoints on every
// non-STABLE channel (components/push_messaging/push_messaging_utils.cc), and
// the allow-list only knew fcm.googleapis.com. Host list cross-checked against
// pushpad/known-push-services.

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

async function loadHandler() {
  process.env.CONVEX_SITE_URL = 'https://convex.test';
  process.env.CONVEX_TENANT_RELAY_SECRET = 'relay-secret';
  process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
  const store = new Map<string, string>();
  globalThis.fetch = mock.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const commands = JSON.parse(String(init?.body)) as string[][];
    return Response.json(commands.map(([op, key, value, ...opts]) => {
      const operation = op!.toUpperCase();
      if (operation === 'GET') return { result: store.get(key!) ?? null };
      if (operation === 'DEL') return { result: store.delete(key!) ? 1 : 0 };
      if (opts.some((o) => o.toUpperCase() === 'NX') && store.has(key!)) return { result: null };
      store.set(key!, value!);
      return { result: 'OK' };
    }));
  }) as typeof fetch;

  const mod = await import(`../api/notification-channels.ts?test=${Date.now()}-${Math.random()}`);
  const relayedEndpoints: string[] = [];
  mod.__setNotificationChannelsDepsForTests({
    checkScopedRateLimit: async () => ({ allowed: true, limit: 30, reset: 0, degraded: false }),
    validateBearerToken: async () => ({ valid: true, userId: 'user-push-hosts' }),
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
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { action?: string; endpoint?: string };
      if (body.action === 'welcome-scheduling-capability') {
        return Response.json({ durableWelcomeScheduling: true });
      }
      relayedEndpoints.push(body.endpoint!);
      return Response.json({ ok: true, isNew: true, durableWelcomeScheduling: true });
    },
  });

  let request = 0;
  async function register(endpoint: string): Promise<{ status: number; body: unknown }> {
    request += 1;
    const res: Response = await mod.default(
      new Request('https://worldmonitor.app/api/notification-channels', {
        method: 'POST',
        headers: {
          Origin: 'https://worldmonitor.app',
          Authorization: 'Bearer clerk-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': `push-hosts-${request}`,
        },
        body: JSON.stringify({ action: 'set-web-push', endpoint, p256dh: 'p256dh-key', auth: 'auth-secret', userAgent: 'Chrome' }),
      }),
      { waitUntil: () => {} },
    );
    return { status: res.status, body: await res.json() };
  }
  return { register, relayedEndpoints };
}

describe('set-web-push endpoint allow-list', () => {
  const accepted = [
    'https://fcm.googleapis.com/fcm/send/token-a',
    'https://fcm.googleapis.com/wp/token-b',
    'https://fcm.googleapis.com/preprod/wp/token-b2',
    'https://jmt17.google.com/fcm/send/token-c',
    'https://android.googleapis.com/gcm/send/token-d',
    'https://updates.push.services.mozilla.com/wpush/v2/token-e',
    'https://web.push.apple.com/token-f',
    'https://api.push.apple.com/token-g',
    'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA%2bX%3d',
  ];

  for (const endpoint of accepted) {
    it(`relays ${endpoint}`, async () => {
      const { register, relayedEndpoints } = await loadHandler();
      const res = await register(endpoint);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(relayedEndpoints, [endpoint]);
    });
  }

  const rejected = [
    'https://jmt17.google.com.attacker.example/fcm/send/x',
    'https://evil-jmt17.google.com/fcm/send/x',
    'https://fcm.googleapis.com.attacker.example/fcm/send/x',
    'https://notpush.apple.com/x',
    'https://push.apple.com/x',
    'https://attackernotify.windows.com/x',
    'https://fcm.googleapis.com:8443/fcm/send/x',
    'https://internal.example.com/admin',
    'https://permanently-removed.invalid/fcm/send/x',
    // The relay's web-push sends with legacy url.parse(), which keeps `%2e`
    // out of the hostname: these would connect to `localhost` and `redis`.
    'https://localhost%2epush.apple.com/x',
    'https://redis%2enotify.windows.com/x',
    'https://fcm.googleapis.com:0443/fcm/send/x',
    'https://fcm.googleapis.com:443/fcm/send/x',
    // WHATWG keeps these inside the hostname; url.parse() ends the host there.
    'https://internal.example.com{.push.apple.com/fcm/send/x',
    "https://internal'x.notify.windows.com/x",
    'https://internal;x.push.apple.com/x',
    'https://user:pass@fcm.googleapis.com/fcm/send/x',
  ];

  for (const endpoint of rejected) {
    it(`rejects ${endpoint} before it reaches the relay`, async () => {
      const { register, relayedEndpoints } = await loadHandler();
      const res = await register(endpoint);
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { error: 'endpoint host is not a recognised push service' });
      assert.deepEqual(relayedEndpoints, []);
    });
  }

  it('relays only endpoints the relay\'s legacy url.parse() reads to the same host', async () => {
    const pieces: string[] = [];
    for (let code = 0x20; code < 0x7f; code++) pieces.push(String.fromCharCode(code));
    for (let code = 0; code < 256; code++) pieces.push(`%${code.toString(16).padStart(2, '0')}`);
    const candidates = pieces.flatMap((p) => [
      `https://internal${p}.push.apple.com/x`,
      `https://internal${p}x.notify.windows.com/x`,
      `https://fcm.googleapis.com${p}/fcm/send/x`,
      `https://a${p}@web.push.apple.com/x`,
    ]);
    const { register, relayedEndpoints } = await loadHandler();
    for (const endpoint of candidates) await register(endpoint);
    assert.ok(relayedEndpoints.length > 0, 'the sweep must reach the relay at least once');
    for (const endpoint of relayedEndpoints) {
      const whatwg = new URL(endpoint);
      const legacy = legacyParse(endpoint);
      assert.equal(legacy.hostname, whatwg.hostname, endpoint);
      assert.equal(legacy.port ?? '', whatwg.port, endpoint);
    }
  });
});
