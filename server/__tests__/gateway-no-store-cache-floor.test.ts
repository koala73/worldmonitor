// @vitest-environment node

/**
 * #6771 — the audience overwrite in server/gateway.ts must not defeat a route's
 * declared no-store tier, and a credentialed non-public response must never be
 * shared-cacheable.
 *
 * Before the fix, a GET that presented a cookie/key resolved to `slow-browser`
 * (max-age=300) via `isPremium || hasCredentialedNonPublicGet`, consulting the
 * route's declared `RPC_CACHE_TIER` only in the final `??` fallback — so a route
 * declared `no-store` (track-aircraft, company-monitoring, ...) was served
 * cacheable for 300s once credentials were present, and the slow-browser header
 * carried no `private` while Vary is Origin-only.
 *
 * Harness mirrors gateway-status-override.test.ts.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const runRedisPipeline = vi.fn();
vi.mock('../_shared/redis', async (importActual) => {
  const actual = await importActual<typeof import('../_shared/redis')>();
  return { ...actual, runRedisPipeline: (...a: unknown[]) => runRedisPipeline(...a) };
});

const checkRateLimit = vi.fn();
const checkEndpointRateLimit = vi.fn();
vi.mock('../_shared/rate-limit', async (importActual) => {
  const actual = await importActual<typeof import('../_shared/rate-limit')>();
  return {
    ...actual,
    checkRateLimit: (...a: unknown[]) => checkRateLimit(...a),
    checkEndpointRateLimit: (...a: unknown[]) => checkEndpointRateLimit(...a),
    hasEndpointRatePolicy: () => false,
  };
});

import { createDomainGateway } from '../gateway';

const ctx = { waitUntil: () => {} };
const KEY = 'test-key';

// A healthy 200 body with none of the no-store payload tripwires
// (upstreamUnavailable / unavailable / dataAvailable:false / degraded /
// available:false / error), so the tier is decided purely by route + audience.
function healthyHandler(body: Record<string, unknown>) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function gatewayFor(path: string, body: Record<string, unknown>) {
  return createDomainGateway([{ method: 'GET', path, handler: healthyHandler(body) }]);
}

function credentialedRequest(path: string): Request {
  // `_debug=1` keeps the X-Cache-Tier header for assertion; the key makes it a
  // credentialed non-public GET.
  return new Request(`https://worldmonitor.app${path}?_debug=1`, {
    headers: { 'X-WorldMonitor-Key': KEY, 'cf-connecting-ip': '203.0.113.7' },
  });
}

beforeEach(() => {
  runRedisPipeline.mockReset().mockResolvedValue([{ result: null }]);
  checkRateLimit.mockReset().mockResolvedValue(null);
  checkEndpointRateLimit.mockReset().mockResolvedValue(null);
  process.env.WORLDMONITOR_VALID_KEYS = KEY;
});

afterEach(() => {
  delete process.env.WORLDMONITOR_VALID_KEYS;
});

describe('gateway no-store floor + credentialed privacy (#6771)', () => {
  test('a route declared no-store stays no-store even with a credential and a healthy body', async () => {
    const path = '/api/aviation/v1/track-aircraft'; // RPC_CACHE_TIER: 'no-store'
    const res = await gatewayFor(path, { aircraft: [{ icao24: 'abc123', lat: 1, lon: 2 }] })(
      credentialedRequest(path),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Cache-Tier')).toBe('no-store');
    expect(res.headers.get('CDN-Cache-Control')).toBeNull();
  });

  test('a credentialed non-public GET is marked private and not shared-cacheable', async () => {
    // list-airport-flights is declared 'static', but a credentialed non-public
    // GET is forced to slow-browser by the audience overwrite regardless.
    const path = '/api/aviation/v1/list-airport-flights';
    const res = await gatewayFor(path, { flights: [{ id: 1 }], totalAvailable: 1, source: 'relay' })(
      credentialedRequest(path),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Cache-Tier')).toBe('slow-browser');
    const cacheControl = res.headers.get('Cache-Control') ?? '';
    expect(cacheControl).toContain('private');
    expect(cacheControl).toContain('max-age=300');
    // Credentialed responses are never handed to the Vercel edge cache.
    expect(res.headers.get('CDN-Cache-Control')).toBeNull();
  });

  test('an anonymous request to a public route is NOT marked private (no over-broadening)', async () => {
    // Public no-auth route, no credential -> the private gate must not fire, so
    // shared/CDN caching of public data is preserved.
    const path = '/api/natural/v1/list-natural-events';
    const res = await createDomainGateway([
      { method: 'GET', path, handler: healthyHandler({ events: [{ id: 1 }] }) },
    ])(
      new Request(`https://worldmonitor.app${path}?_debug=1`, {
        headers: { origin: 'https://worldmonitor.app', 'cf-connecting-ip': '203.0.113.7' },
      }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control') ?? '').not.toContain('private');
  });

  test('a map-declared no-store route stays no-store even under a CACHE_TIER_OVERRIDE (#6771)', async () => {
    // An operator env override must not be able to downgrade an account-private
    // no-store route to a browser-cacheable tier.
    process.env.CACHE_TIER_OVERRIDE_GET_COMPANY_COVERAGE = 'slow-browser';
    try {
      const path = '/api/company-monitoring/v1/get-company-coverage'; // RPC_CACHE_TIER: 'no-store'
      const res = await gatewayFor(path, { coverage: [{ id: 1 }] })(credentialedRequest(path), ctx);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('X-Cache-Tier')).toBe('no-store');
    } finally {
      delete process.env.CACHE_TIER_OVERRIDE_GET_COMPANY_COVERAGE;
    }
  });
});
