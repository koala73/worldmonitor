// @vitest-environment node

/**
 * #7275 — the gateway advertised HEAD on GET routes, then 405'd HEAD with
 * `Allow: GET, HEAD`. HEAD must run the matching GET handler and return the
 * same status/headers with an empty body (auth, cache, CORS, rate-limit).
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
const STATIC_PATH = '/api/natural/v1/list-natural-events';
const DYNAMIC_PATH_PATTERN = '/api/foo/v1/items/{id}';
const DYNAMIC_PATH = '/api/foo/v1/items/abc';
const POST_ONLY_PATH = '/api/leads/v1/submit-contact';
const BODY = JSON.stringify({ events: [{ id: 1 }] });
const KEY = 'test-head-key';

function getHandler() {
  return vi.fn(
    async () =>
      new Response(BODY, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

function makeRequest(path: string, method: string, extraHeaders: Record<string, string> = {}): Request {
  return new Request(`https://worldmonitor.app${path}?_debug=1`, {
    method,
    headers: {
      origin: 'https://worldmonitor.app',
      'cf-connecting-ip': '203.0.113.7',
      ...extraHeaders,
    },
  });
}

beforeEach(() => {
  runRedisPipeline.mockReset();
  checkRateLimit.mockReset().mockResolvedValue(null);
  checkEndpointRateLimit.mockReset().mockResolvedValue(null);
  process.env.WORLDMONITOR_VALID_KEYS = KEY;
});

afterEach(() => {
  delete process.env.WORLDMONITOR_VALID_KEYS;
});

describe('gateway HEAD on GET routes (#7275)', () => {
  test('HEAD on a static GET route keeps GET status and headers and suppresses the body', async () => {
    const handler = getHandler();
    const gateway = createDomainGateway([{ method: 'GET', path: STATIC_PATH, handler }]);

    const getRes = await gateway(makeRequest(STATIC_PATH, 'GET'), ctx);
    const headRes = await gateway(makeRequest(STATIC_PATH, 'HEAD'), ctx);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(headRes.status).toBe(200);
    expect(headRes.status).toBe(getRes.status);
    expect(await headRes.text()).toBe('');
    expect(await getRes.text()).toBe(BODY);

    expect(headRes.headers.get('Content-Type')).toBe(getRes.headers.get('Content-Type'));
    expect(headRes.headers.get('ETag')).toBe(getRes.headers.get('ETag'));
    expect(headRes.headers.get('ETag')).toBeTruthy();
    expect(headRes.headers.get('Cache-Control')).toBe(getRes.headers.get('Cache-Control'));
    expect(headRes.headers.get('Access-Control-Allow-Origin')).toBe('https://worldmonitor.app');
    expect(headRes.headers.get('X-Cache-Tier')).toBe(getRes.headers.get('X-Cache-Tier'));
  });

  test('HEAD on a dynamic GET route keeps GET status and headers and suppresses the body', async () => {
    const handler = getHandler();
    const gateway = createDomainGateway([{ method: 'GET', path: DYNAMIC_PATH_PATTERN, handler }]);

    const getRes = await gateway(makeRequest(DYNAMIC_PATH, 'GET', { 'X-WorldMonitor-Key': KEY }), ctx);
    const headRes = await gateway(makeRequest(DYNAMIC_PATH, 'HEAD', { 'X-WorldMonitor-Key': KEY }), ctx);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(headRes.status).toBe(getRes.status);
    expect(await headRes.text()).toBe('');
    expect(headRes.headers.get('ETag')).toBe(getRes.headers.get('ETag'));
    expect(headRes.headers.get('Cache-Control')).toBe(getRes.headers.get('Cache-Control'));
  });

  test('HEAD on a GET route is not 405 with Allow listing HEAD', async () => {
    const gateway = createDomainGateway([{ method: 'GET', path: STATIC_PATH, handler: getHandler() }]);
    const res = await gateway(makeRequest(STATIC_PATH, 'HEAD'), ctx);

    expect(res.status).not.toBe(405);
    expect(res.headers.get('Allow')).toBeNull();
    expect(await res.text()).toBe('');
  });

  test('HEAD on a POST-only route stays 405 and does not advertise HEAD', async () => {
    const gateway = createDomainGateway([
      {
        method: 'POST',
        path: POST_ONLY_PATH,
        handler: vi.fn(async () => new Response('{"ok":true}', { status: 200 })),
      },
    ]);
    const res = await gateway(makeRequest(POST_ONLY_PATH, 'HEAD'), ctx);

    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
    expect(await res.text()).toBe('');
  });

  test('HEAD shares the GET rate-limit check', async () => {
    const gateway = createDomainGateway([{ method: 'GET', path: STATIC_PATH, handler: getHandler() }]);
    await gateway(makeRequest(STATIC_PATH, 'HEAD'), ctx);

    expect(checkRateLimit).toHaveBeenCalledTimes(1);
    const rateLimitRequest = checkRateLimit.mock.calls[0]?.[0] as Request;
    expect(rateLimitRequest.method).toBe('HEAD');
  });

  test('a GET 429 is reproduced on HEAD with an empty body', async () => {
    checkRateLimit.mockResolvedValue(
      new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: { 'Retry-After': '30', 'Content-Type': 'application/json' },
      }),
    );
    const gateway = createDomainGateway([{ method: 'GET', path: STATIC_PATH, handler: getHandler() }]);
    const res = await gateway(makeRequest(STATIC_PATH, 'HEAD'), ctx);

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.text()).toBe('');
  });
});
