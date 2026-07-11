// @vitest-environment node

/**
 * Success-status override side-channel (server/_shared/response-headers.ts →
 * server/gateway.ts). Async-enqueue handlers (run-scenario) call
 * setSuccessStatusOverride(ctx.request, 202) so a successful enqueue answers
 * 202 Accepted — the sebuf-generated servers hardcode 200 for every success.
 * The gateway applies the override only on POST-200: error statuses always
 * win and GET success flows keep 200 (their ETag/304 + CDN-cache handling
 * assumes it). Exercised over the public no-auth leads path so the auth chain
 * is out of scope, mirroring gateway-idempotency.test.ts.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

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
import { setResponseHeader, setSuccessStatusOverride } from '../_shared/response-headers';
import { IDEMPOTENCY_HEADER, IDEMPOTENT_REPLAYED_HEADER } from '../_shared/idempotency';

const PATH = '/api/leads/v1/submit-contact';
const STATUS_URL = '/api/scenario/v1/get-scenario-status?jobId=scenario%3A1717200000000%3Aabcd1234';
const ctx = { waitUntil: () => {} };

function acceptedBody() {
  return JSON.stringify({ jobId: 'scenario:1717200000000:abcd1234', status: 'pending', statusUrl: STATUS_URL });
}

// Mimics an async-enqueue handler: marks the request for a 202 upgrade and
// points Location at the poll endpoint before returning its (200) response.
const enqueueHandler = vi.fn(async (req: Request) => {
  setSuccessStatusOverride(req, 202);
  setResponseHeader(req, 'Location', STATUS_URL);
  return new Response(acceptedBody(), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});

function makeGateway(method: 'GET' | 'POST' = 'POST', handler = enqueueHandler) {
  return createDomainGateway([{ method, path: PATH, handler }]);
}

function makeRequest(method: 'GET' | 'POST' = 'POST', headers: Record<string, string> = {}): Request {
  return new Request(`https://www.worldmonitor.app${PATH}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.7', ...headers },
    body: method === 'POST' ? JSON.stringify({ email: 'agent@example.com', message: 'hi' }) : undefined,
  });
}

beforeEach(() => {
  runRedisPipeline.mockReset();
  checkRateLimit.mockReset().mockResolvedValue(null);
  checkEndpointRateLimit.mockReset().mockResolvedValue(null);
  enqueueHandler.mockClear();
});

describe('gateway success-status override', () => {
  test('POST-200 with an override returns 202 and the Location header', async () => {
    const res = await makeGateway()(makeRequest(), ctx);
    expect(enqueueHandler).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(202);
    expect(res.headers.get('Location')).toBe(STATUS_URL);
    expect(await res.json()).toMatchObject({ status: 'pending', statusUrl: STATUS_URL });
  });

  test('Location is CORS-exposed so browser agents can read the poll URL', async () => {
    const res = await makeGateway()(makeRequest(), ctx);
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('Location');
  });

  test('an error status wins over the override', async () => {
    const failingHandler = vi.fn(async (req: Request) => {
      setSuccessStatusOverride(req, 202);
      return new Response(JSON.stringify({ error: 'queue unavailable' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const res = await makeGateway('POST', failingHandler)(makeRequest(), ctx);
    expect(res.status).toBe(502);
  });

  test('a GET success keeps 200 even if an override was set', async () => {
    const res = await makeGateway('GET')(makeRequest('GET'), ctx);
    expect(res.status).toBe(200);
  });

  test('a POST without an override is untouched', async () => {
    const plainHandler = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const res = await makeGateway('POST', plainHandler)(makeRequest(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Location')).toBeNull();
  });

  test('idempotent first request stores 202 so a replay reproduces it', async () => {
    runRedisPipeline
      .mockResolvedValueOnce([{ result: null }]) // read-only peek miss
      .mockResolvedValueOnce([{ result: 'OK' }, { result: null }]) // SET NX + GET (claimed)
      .mockResolvedValueOnce([{ result: 'OK' }]); // store SET
    const res = await makeGateway()(makeRequest('POST', { [IDEMPOTENCY_HEADER]: 'key-async' }), ctx);

    expect(res.status).toBe(202);
    expect(res.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('false');

    const storeCmd = runRedisPipeline.mock.calls[2][0][0];
    expect(storeCmd[0]).toBe('SET');
    const record = JSON.parse(storeCmd[2] as string);
    expect(record.state).toBe('completed');
    expect(record.status).toBe(202);
  });
});
