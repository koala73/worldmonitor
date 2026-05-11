/**
 * Asserts the Axiom telemetry payload emitted by createDomainGateway() —
 * specifically the four fields the round-1 Codex review flagged:
 *
 *   - domain (must be 'shipping' for /api/v2/shipping/* routes, not 'v2')
 *   - customer_id (must be populated on legacy premium bearer-token success)
 *   - auth_kind (must reflect the resolved identity, not stay 'anon')
 *   - tier (recorded when entitlement-gated routes succeed; covered indirectly
 *     by the legacy bearer success case via the Dodo `tier` branch)
 *
 * Strategy: enable telemetry (USAGE_TELEMETRY=1 + AXIOM_API_TOKEN=fake), stub
 * globalThis.fetch to intercept the Axiom ingest POST, and pass a real ctx
 * whose waitUntil collects the in-flight Promises so we can await them after
 * the gateway returns.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { afterEach, before, after, describe, it } from 'node:test';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

import { createDomainGateway, type GatewayCtx } from '../server/gateway.ts';
import { issueSessionToken } from '../api/_session.js';

// Anonymous browser access requires a wms_ session token (issue #3541).
process.env.WM_SESSION_SECRET = process.env.WM_SESSION_SECRET
  ?? 'test-secret-must-be-at-least-32-chars-long-xxx';
let SESSION_TOKEN: string;
before(async () => { SESSION_TOKEN = (await issueSessionToken()).token; });

interface CapturedEvent {
  event_type: string;
  domain: string;
  route: string;
  status: number;
  customer_id: string | null;
  auth_kind: string;
  tier: number;
  reason: string;
}

function makeRecordingCtx(): { ctx: GatewayCtx; settled: Promise<void> } {
  const pending: Promise<unknown>[] = [];
  const ctx: GatewayCtx = {
    waitUntil: (p) => { pending.push(p); },
  };
  // Quiescence loop: emitUsageEvents calls ctx.waitUntil from inside an
  // already-pending waitUntil promise, so the array grows during drain.
  // Keep awaiting until no new entries appear between iterations.
  async function settled(): Promise<void> {
    let prev = -1;
    while (pending.length !== prev) {
      prev = pending.length;
      await Promise.allSettled(pending.slice(0, prev));
    }
  }
  return {
    ctx,
    get settled() { return settled(); },
  } as { ctx: GatewayCtx; settled: Promise<void> };
}

function installAxiomFetchSpy(
  originalFetch: typeof fetch,
  opts: { entitlementsResponse?: unknown } = {},
): {
  events: CapturedEvent[];
  restore: () => void;
} {
  const events: CapturedEvent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('api.axiom.co')) {
      const body = init?.body ? JSON.parse(init.body as string) as CapturedEvent[] : [];
      for (const ev of body) events.push(ev);
      return new Response('{}', { status: 200 });
    }
    if (url.includes('/api/internal-entitlements')) {
      return new Response(JSON.stringify(opts.entitlementsResponse ?? null), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return originalFetch(input as Request | string | URL, init);
  }) as typeof fetch;
  return { events, restore: () => { globalThis.fetch = originalFetch; } };
}

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_USAGE_FLAG = process.env.USAGE_TELEMETRY;
const ORIGINAL_AXIOM_TOKEN = process.env.AXIOM_API_TOKEN;
const ORIGINAL_VALID_KEYS = process.env.WORLDMONITOR_VALID_KEYS;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_USAGE_FLAG == null) delete process.env.USAGE_TELEMETRY;
  else process.env.USAGE_TELEMETRY = ORIGINAL_USAGE_FLAG;
  if (ORIGINAL_AXIOM_TOKEN == null) delete process.env.AXIOM_API_TOKEN;
  else process.env.AXIOM_API_TOKEN = ORIGINAL_AXIOM_TOKEN;
  if (ORIGINAL_VALID_KEYS == null) delete process.env.WORLDMONITOR_VALID_KEYS;
  else process.env.WORLDMONITOR_VALID_KEYS = ORIGINAL_VALID_KEYS;
});

describe('gateway telemetry payload — domain extraction', () => {
  it("emits domain='shipping' for /api/v2/shipping/* routes (not 'v2')", async () => {
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'test-token';
    const spy = installAxiomFetchSpy(ORIGINAL_FETCH);

    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/v2/shipping/route-intelligence',
        handler: async () => new Response('{"ok":true}', { status: 200 }),
      },
    ]);

    const recorder = makeRecordingCtx();
    const res = await handler(
      new Request('https://worldmonitor.app/api/v2/shipping/route-intelligence', {
        headers: { Origin: 'https://worldmonitor.app' },
      }),
      recorder.ctx,
    );
    // Anonymous → 401 (premium path, missing API key + no bearer)
    assert.equal(res.status, 401);

    await recorder.settled;
    spy.restore();

    assert.equal(spy.events.length, 1, 'expected exactly one telemetry event');
    const ev = spy.events[0]!;
    assert.equal(ev.domain, 'shipping', `domain should strip leading vN segment, got '${ev.domain}'`);
    assert.equal(ev.route, '/api/v2/shipping/route-intelligence');
    assert.equal(ev.auth_kind, 'anon');
    assert.equal(ev.customer_id, null);
    assert.equal(ev.tier, 0);
  });

  it("emits domain='market' for the standard /api/<domain>/v1/<rpc> layout", async () => {
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'test-token';
    const spy = installAxiomFetchSpy(ORIGINAL_FETCH);

    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/list-market-quotes',
        handler: async () => new Response('{"ok":true}', { status: 200 }),
      },
    ]);

    const recorder = makeRecordingCtx();
    const res = await handler(
      new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL', {
        headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN },
      }),
      recorder.ctx,
    );
    assert.equal(res.status, 200);

    await recorder.settled;
    spy.restore();

    assert.equal(spy.events.length, 1);
    assert.equal(spy.events[0]!.domain, 'market');
  });

  it("PR #3557 round-3: anonymous wms_ token telemetry is anon, NOT enterprise_api_key", async () => {
    // Regression: an earlier revision set usage.enterpriseApiKey for any valid
    // wmKey not starting with 'wm_'. Since 'wms_' doesn't startsWith 'wm_',
    // anonymous session tokens were misattributed as enterprise traffic with
    // customer_id='enterprise-unmapped'. Lock the contract: kind:'session'
    // tokens emit auth_kind:'anon'.
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'test-token';
    const spy = installAxiomFetchSpy(ORIGINAL_FETCH);

    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/list-market-quotes',
        handler: async () => new Response('{"ok":true}', { status: 200 }),
      },
    ]);

    const recorder = makeRecordingCtx();
    const res = await handler(
      new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL', {
        headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN },
      }),
      recorder.ctx,
    );
    assert.equal(res.status, 200);

    await recorder.settled;
    spy.restore();

    assert.equal(spy.events.length, 1);
    const ev = spy.events[0]!;
    assert.equal(ev.auth_kind, 'anon', `wms_ tokens must telemeter as anon, got '${ev.auth_kind}'`);
    assert.notEqual(ev.customer_id, 'enterprise-unmapped');
  });
});

describe('gateway telemetry payload — bearer identity propagation', () => {
  let privateKey: CryptoKey;
  let jwksServer: Server;
  let jwksPort: number;

  before(async () => {
    const { publicKey, privateKey: pk } = await generateKeyPair('RS256');
    privateKey = pk;

    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 'telemetry-key-1';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    const jwks = { keys: [publicJwk] };

    jwksServer = createServer((req, res) => {
      if (req.url === '/.well-known/jwks.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jwks));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = jwksServer.address();
    jwksPort = typeof addr === 'object' && addr ? addr.port : 0;
    process.env.CLERK_JWT_ISSUER_DOMAIN = `http://127.0.0.1:${jwksPort}`;
  });

  after(async () => {
    jwksServer?.close();
    delete process.env.CLERK_JWT_ISSUER_DOMAIN;
  });

  function signToken(claims: Record<string, unknown>) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'telemetry-key-1' })
      .setIssuer(`http://127.0.0.1:${jwksPort}`)
      .setAudience('convex')
      .setSubject(claims.sub as string ?? 'user_test')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  }

  it('records customer_id from a successful legacy premium bearer call', async () => {
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'test-token';
    const spy = installAxiomFetchSpy(ORIGINAL_FETCH);

    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/resilience/v1/get-resilience-score',
        handler: async () => new Response('{"ok":true}', { status: 200 }),
      },
    ]);

    const token = await signToken({ sub: 'user_pro', plan: 'pro' });
    const recorder = makeRecordingCtx();
    const res = await handler(
      new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-score?countryCode=US', {
        headers: {
          Origin: 'https://worldmonitor.app',
          Authorization: `Bearer ${token}`,
        },
      }),
      recorder.ctx,
    );
    assert.equal(res.status, 200);

    await recorder.settled;
    spy.restore();

    assert.equal(spy.events.length, 1, 'expected exactly one telemetry event');
    const ev = spy.events[0]!;
    // The whole point of fix #2: pre-fix this would have been null/anon.
    assert.equal(ev.customer_id, 'user_pro', 'customer_id should be the bearer subject');
    assert.equal(ev.auth_kind, 'clerk_jwt');
    assert.equal(ev.domain, 'resilience');
    assert.equal(ev.status, 200);
  });

  it("records tier=2 for an entitlement-gated success (the path the round-1 P2 fix targets)", async () => {
    // /api/market/v1/analyze-stock requires tier 2 in ENDPOINT_ENTITLEMENTS.
    // Pre-fix: usage.tier stayed null → emitted as 0. Post-fix: gateway re-reads
    // entitlements after checkEntitlement allows the request, so tier=2 lands on
    // the wire. We exercise this by stubbing the Convex entitlements fallback —
    // Redis returns null without UPSTASH env, then getEntitlements falls through
    // to the Convex HTTP path which we intercept via the same fetch spy.
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'test-token';
    process.env.CONVEX_SITE_URL = 'https://convex.test';
    process.env.CONVEX_SERVER_SHARED_SECRET = 'test-shared-secret';

    const fakeEntitlements = {
      planKey: 'api_starter',
      features: {
        tier: 2,
        apiAccess: true,
        apiRateLimit: 1000,
        maxDashboards: 10,
        prioritySupport: false,
        exportFormats: ['json'],
      },
      validUntil: Date.now() + 60_000,
    };
    const spy = installAxiomFetchSpy(ORIGINAL_FETCH, { entitlementsResponse: fakeEntitlements });

    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/analyze-stock',
        handler: async () => new Response('{"ok":true}', { status: 200 }),
      },
    ]);

    // plan: 'api' so the legacy bearer-role short-circuit (`session.role === 'pro'`)
    // does NOT fire — we want the entitlement-check path that populates usage.tier.
    const token = await signToken({ sub: 'user_api', plan: 'api' });
    const recorder = makeRecordingCtx();
    const res = await handler(
      new Request('https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL', {
        headers: {
          Origin: 'https://worldmonitor.app',
          Authorization: `Bearer ${token}`,
        },
      }),
      recorder.ctx,
    );
    assert.equal(res.status, 200, 'entitlement-gated request with sufficient tier should succeed');

    await recorder.settled;
    spy.restore();
    delete process.env.CONVEX_SITE_URL;
    delete process.env.CONVEX_SERVER_SHARED_SECRET;

    assert.equal(spy.events.length, 1);
    const ev = spy.events[0]!;
    assert.equal(ev.tier, 2, `tier should reflect resolved entitlement, got ${ev.tier}`);
    assert.equal(ev.customer_id, 'user_api');
    assert.equal(ev.auth_kind, 'clerk_jwt');
    assert.equal(ev.domain, 'market');
    assert.equal(ev.route, '/api/market/v1/analyze-stock');
  });

  it('still emits with auth_kind=anon when the bearer is invalid', async () => {
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'test-token';
    const spy = installAxiomFetchSpy(ORIGINAL_FETCH);

    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/resilience/v1/get-resilience-score',
        handler: async () => new Response('{"ok":true}', { status: 200 }),
      },
    ]);

    const recorder = makeRecordingCtx();
    const res = await handler(
      new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-score?countryCode=US', {
        headers: {
          Origin: 'https://worldmonitor.app',
          Authorization: 'Bearer not-a-real-token',
        },
      }),
      recorder.ctx,
    );
    assert.equal(res.status, 401);

    await recorder.settled;
    spy.restore();

    assert.equal(spy.events.length, 1);
    const ev = spy.events[0]!;
    assert.equal(ev.auth_kind, 'anon');
    assert.equal(ev.customer_id, null);
  });
});

describe('gateway telemetry payload — ctx-optional safety', () => {
  it('handler(req) without ctx still resolves cleanly even with telemetry on', async () => {
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'test-token';
    const spy = installAxiomFetchSpy(ORIGINAL_FETCH);

    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/list-market-quotes',
        handler: async () => new Response('{"ok":true}', { status: 200 }),
      },
    ]);

    const res = await handler(
      new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL', {
        headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN },
      }),
    );
    assert.equal(res.status, 200);
    spy.restore();
    // No ctx → emit short-circuits → no events delivered. The point is that
    // the handler does not throw "Cannot read properties of undefined".
    assert.equal(spy.events.length, 0);
  });
});

describe('gateway telemetry payload — unmatched route reason labels', () => {
  // Phantom-route operability: a route like /api/trade/v1/list-tariffs that
  // doesn't exist must emit reason='unknown_route' so an Axiom filter
  // (where reason == 'unknown_route') instantly separates scraper / stale-
  // client noise from real handler errors. Same idea for 405s — a known path
  // hit with the wrong method must emit reason='method_not_allowed' so it
  // doesn't get conflated with auth_401 or rate_limit_429.
  //
  // Without these assertions, regressing both back to reason='ok' is a
  // silent telemetry-only change that CI would not catch.

  it("unknown path → status=404 + reason='unknown_route'", async () => {
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'test-token';
    const spy = installAxiomFetchSpy(ORIGINAL_FETCH);

    // Domain gateway is mounted with at least one route so the router has
    // a valid table — the request below targets a path that isn't in it.
    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/trade/v1/get-tariff-trends',
        handler: async () => new Response('{"ok":true}', { status: 200 }),
      },
    ]);

    const recorder = makeRecordingCtx();
    const res = await handler(
      new Request('https://worldmonitor.app/api/trade/v1/list-tariffs', {
        headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN },
      }),
      recorder.ctx,
    );
    assert.equal(res.status, 404);

    await recorder.settled;
    spy.restore();

    assert.equal(spy.events.length, 1, 'expected exactly one telemetry event');
    const ev = spy.events[0]!;
    assert.equal(ev.status, 404);
    assert.equal(
      ev.reason,
      'unknown_route',
      `404 emit must label reason='unknown_route' (got '${ev.reason}'); regression to 'ok' would re-conflate phantom-route noise with handled traffic`,
    );
    assert.equal(ev.route, '/api/trade/v1/list-tariffs');
    assert.equal(ev.domain, 'trade');
  });

  it("known path with wrong method → status=405 + reason='method_not_allowed'", async () => {
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'test-token';
    const spy = installAxiomFetchSpy(ORIGINAL_FETCH);

    // Register a GET-only route, then DELETE it: router responds 405 with
    // Allow: GET. POST→GET fallback only kicks in for POST, so DELETE is
    // the cleanest way to force the 405 branch.
    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/list-market-quotes',
        handler: async () => new Response('{"ok":true}', { status: 200 }),
      },
    ]);

    const recorder = makeRecordingCtx();
    const res = await handler(
      new Request('https://worldmonitor.app/api/market/v1/list-market-quotes', {
        method: 'DELETE',
        headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN },
      }),
      recorder.ctx,
    );
    assert.equal(res.status, 405);
    assert.match(res.headers.get('Allow') ?? '', /GET/);

    await recorder.settled;
    spy.restore();

    assert.equal(spy.events.length, 1, 'expected exactly one telemetry event');
    const ev = spy.events[0]!;
    assert.equal(ev.status, 405);
    assert.equal(
      ev.reason,
      'method_not_allowed',
      `405 emit must label reason='method_not_allowed' (got '${ev.reason}'); regression to 'ok' would hide method-mismatch traffic in healthy-emit counts`,
    );
  });
});
