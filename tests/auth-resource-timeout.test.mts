import assert from 'node:assert/strict';
import test from 'node:test';

const never = <T>(): Promise<T> => new Promise<T>(() => {});
const after = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms));

// Captured at module load, before any test swaps globalThis.fetch for a stub.
// The Clerk plan-lookup test needs a working fetch for its local JWKS server.
const realFetch = globalThis.fetch;

test('Clerk plan timeout env accepts only AbortSignal-safe positive integers', async () => {
  const { parsePlanLookupTimeoutMs } = await import('../server/auth-session.ts?plan-timeout-env-parse=1');

  assert.equal(parsePlanLookupTimeoutMs(undefined), 3_000);
  assert.equal(parsePlanLookupTimeoutMs('50'), 50);
  for (const value of ['0', '-1', '0.5', '1.5', 'Infinity', '4294967295', 'not-a-number']) {
    assert.equal(parsePlanLookupTimeoutMs(value), 3_000, `${value} must fall back to the safe default`);
  }
});

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.get(key) ?? null; },
    key(index) { return Array.from(values.keys())[index] ?? null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

test('frontend session mint must not block API callers forever', async () => {
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as { location: Location }).location = {
    href: 'https://worldmonitor.app/',
    origin: 'https://worldmonitor.app',
    hostname: 'worldmonitor.app',
    protocol: 'https:',
    host: 'worldmonitor.app',
  } as Location;
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = storage();
  (globalThis as unknown as { localStorage: Storage }).localStorage = storage();
  (globalThis as unknown as { document: unknown }).document = {
    visibilityState: 'visible',
    addEventListener() {},
  };
  (globalThis as unknown as { fetch: typeof fetch }).fetch = ((_input, init) => new Promise<Response>((_, reject) => {
    if (init?.signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  })) as typeof fetch;

  const mod = await import('../src/services/wm-session.ts');
  mod.__resetWmSessionForTests();
  mod.__setWmSessionFetchTimeoutForTests(50);

  const outcomes = await Promise.all(Array.from({ length: 100 }, async () => Promise.race([
    mod.ensureWmSession().then(() => 'settled'),
    after(500, 'still-pending'),
  ])));

  assert.equal(outcomes.filter((value) => value === 'still-pending').length, 0);
  mod.__resetWmSessionForTests();
});

test('wm-session request-body read must terminate for a body that never ends', async () => {
  process.env.WM_SESSION_SECRET = 'test-secret-must-be-at-least-32-chars-long-xxx';
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  process.env.WM_SESSION_BODY_TIMEOUT_MS = '50';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify([{ result: [29, 30] }]), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;

  try {
    const { default: handler } = await import('../api/wm-session.js');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"widgetKey":"'));
      },
    });
    const req = new Request('https://api.worldmonitor.app/api/wm-session', {
      method: 'POST',
      headers: {
        origin: 'https://worldmonitor.app',
        'content-type': 'application/json',
      },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const outcome = await Promise.race([
      handler(req).then(() => 'settled'),
      after(500, 'still-pending'),
    ]);
    assert.equal(outcome, 'settled');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.WM_SESSION_BODY_TIMEOUT_MS;
  }
});

test('widget-agent request-body read must terminate for a body that never ends', async () => {
  process.env.WIDGET_AGENT_KEY = 'server-widget-key';
  process.env.PRO_WIDGET_KEY = 'server-pro-key';
  process.env.WORLDMONITOR_VALID_KEYS = 'browser-test-key';
  process.env.WIDGET_AGENT_BODY_TIMEOUT_MS = '50';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => never<Response>()) as typeof fetch;
  try {
    const { default: handler } = await import('../api/widget-agent.ts?resource-repro=1');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"prompt":"'));
      },
    });
    const req = new Request('https://www.worldmonitor.app/api/widget-agent', {
      method: 'POST',
      headers: {
        Origin: 'https://www.worldmonitor.app',
        'Content-Type': 'application/json',
        'X-WorldMonitor-Key': 'browser-test-key',
      },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const outcome = await Promise.race([
      handler(req).then(() => 'settled'),
      after(500, 'still-pending'),
    ]);
    assert.equal(outcome, 'settled');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.WIDGET_AGENT_BODY_TIMEOUT_MS;
  }
});

test('__resetWmSessionForTests restores the default mint timeout', async () => {
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as { location: Location }).location = {
    href: 'https://worldmonitor.app/',
    origin: 'https://worldmonitor.app',
    hostname: 'worldmonitor.app',
    protocol: 'https:',
    host: 'worldmonitor.app',
  } as Location;
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = storage();
  (globalThis as unknown as { localStorage: Storage }).localStorage = storage();
  (globalThis as unknown as { document: unknown }).document = {
    visibilityState: 'visible',
    addEventListener() {},
  };
  (globalThis as unknown as { fetch: typeof fetch }).fetch = ((_input, init) => new Promise<Response>((resolve, reject) => {
    if (init?.signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    setTimeout(() => resolve(new Response(JSON.stringify({ exp: Date.now() + 3600000 }))), 100);
  })) as typeof fetch;

  const mod = await import('../src/services/wm-session.ts?reset-timeout-repro=1');
  mod.__setWmSessionFetchTimeoutForTests(50);
  mod.__resetWmSessionForTests();

  const outcome = await Promise.race([
    mod.ensureWmSession().then(() => 'settled'),
    after(500, 'still-pending'),
  ]);
  assert.equal(outcome, 'settled');
});

test('clerk plan lookup must not pin the gateway when Clerk never responds', async () => {
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
  const { createServer } = await import('node:http');

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'plan-timeout-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  const jwksServer = createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => { jwksServer.listen(0, '127.0.0.1', () => resolve()); });
  const addr = jwksServer.address();
  const issuer = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  // Read at module scope by server/auth-session.ts — must be set before the import below.
  process.env.CLERK_JWT_ISSUER_DOMAIN = issuer;
  process.env.CLERK_SECRET_KEY = 'sk_test_plan_timeout';
  process.env.CLERK_PLAN_LOOKUP_TIMEOUT_MS = '50';

  const originalFetch = globalThis.fetch;
  let clerkCalls = 0;
  let clerkBehaviour: 'stall' | 'pro' = 'stall';
  globalThis.fetch = ((input, init) => {
    const url = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : (input as Request).url;
    // Only the Clerk Backend API is stubbed; the local JWKS fetch must still work.
    if (!url.startsWith('https://api.clerk.com/')) return realFetch(input, init);
    clerkCalls += 1;
    if (clerkBehaviour === 'pro') {
      return Promise.resolve(new Response(JSON.stringify({ public_metadata: { plan: 'pro' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }
    return new Promise<Response>((_, reject) => {
      if (init?.signal?.aborted) {
        reject(new Error('Aborted'));
        return;
      }
      init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    });
  }) as typeof fetch;

  try {
    const mod = await import('../server/auth-session.ts?plan-timeout-repro=1');

    // A standard Clerk session token carries no `plan` claim, so validateBearerToken
    // is forced through lookupPlanFromClerk — the seam the real gateway traverses.
    const token = await new SignJWT({ sub: 'user_plan_stall' })
      .setProtectedHeader({ alg: 'RS256', kid: 'plan-timeout-key' })
      .setIssuer(issuer)
      .setAudience('convex')
      .setSubject('user_plan_stall')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const settled = await Promise.race([
      mod.validateBearerToken(token),
      after(500, 'still-pending' as const),
    ]);
    assert.notEqual(settled, 'still-pending', 'a stalled Clerk plan lookup must not keep the request pending');

    const session = settled as { valid: boolean; role?: string };
    assert.equal(session.valid, true);
    assert.equal(session.role, 'free', 'a timed-out plan lookup degrades to free, exactly like an HTTP error');
    assert.equal(clerkCalls, 1);

    // A timed-out lookup must not poison the 5-minute plan cache with a 'free' verdict.
    clerkBehaviour = 'pro';
    const retry = await mod.validateBearerToken(token);
    assert.equal(retry.role, 'pro', 'the next request must retry Clerk, not serve a cached timeout verdict');
  } finally {
    globalThis.fetch = originalFetch;
    jwksServer.close();
    delete process.env.CLERK_JWT_ISSUER_DOMAIN;
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_PLAN_LOOKUP_TIMEOUT_MS;
  }
});
