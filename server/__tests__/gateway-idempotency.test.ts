// @vitest-environment node

/**
 * Idempotency-Key support wired into the gateway (server/gateway.ts →
 * server/_shared/idempotency.ts). A POST carrying the header is claimed in
 * Redis; a retry replays the cached response instead of re-executing the
 * handler. Exercised over the public no-auth POST `submit-contact` so the auth
 * chain is out of scope; Redis is mocked to drive each idempotency state.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Drive the atomic claim / read-back / store through a controllable stub while
// keeping every other redis export real.
const runRedisPipeline = vi.fn();
vi.mock('../_shared/redis', async (importActual) => {
  const actual = await importActual<typeof import('../_shared/redis')>();
  return { ...actual, runRedisPipeline: (...a: unknown[]) => runRedisPipeline(...a) };
});

// Per-IP / per-endpoint rate limits are irrelevant here — pass them through.
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
import { IDEMPOTENCY_HEADER, IDEMPOTENT_REPLAYED_HEADER } from '../_shared/idempotency';

const PATH = '/api/leads/v1/submit-contact';
const ctx = { waitUntil: () => {} };

const handler = vi.fn(
  async () =>
    new Response(JSON.stringify({ ok: true, id: 'lead_1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
);

function makeGateway() {
  return createDomainGateway([{ method: 'POST', path: PATH, handler }]);
}

const DEFAULT_BODY = JSON.stringify({ email: 'agent@example.com', message: 'hi' });

function post(key: string | undefined, body: string = DEFAULT_BODY): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'cf-connecting-ip': '203.0.113.7',
  };
  if (key !== undefined) headers[IDEMPOTENCY_HEADER] = key;
  return new Request(`https://www.worldmonitor.app${PATH}`, { method: 'POST', headers, body });
}

async function sha256Hex(str: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

beforeEach(() => {
  runRedisPipeline.mockReset();
  checkRateLimit.mockReset().mockResolvedValue(null);
  checkEndpointRateLimit.mockReset().mockResolvedValue(null);
  handler.mockClear();
});

describe('gateway Idempotency-Key', () => {
  test('POST without the header is untouched (no Redis, no echo header)', async () => {
    const res = await makeGateway()(post(undefined), ctx);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
    expect(runRedisPipeline).not.toHaveBeenCalled();
  });

  test('first request: claims, executes, stores the completed response, echoes headers', async () => {
    runRedisPipeline
      .mockResolvedValueOnce([{ result: null }]) // read-only peek miss
      .mockResolvedValueOnce([{ result: 'OK' }, { result: null }]) // SET NX + GET (claimed)
      .mockResolvedValueOnce([{ result: 'OK' }]); // store SET
    const res = await makeGateway()(post('key-first'), ctx);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.headers.get(IDEMPOTENCY_HEADER)).toBe('key-first');
    expect(res.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('false');

    const storeCmd = runRedisPipeline.mock.calls[2][0][0];
    expect(storeCmd[0]).toBe('SET');
    const record = JSON.parse(storeCmd[2] as string);
    expect(record.state).toBe('completed');
    expect(record.status).toBe(200);
    expect(JSON.parse(record.body)).toEqual({ ok: true, id: 'lead_1' });
  });

  test('retry of a completed request replays the stored response without re-executing', async () => {
    const reqHash = await sha256Hex(DEFAULT_BODY);
    const stored = JSON.stringify({
      state: 'completed',
      status: 201,
      contentType: 'application/json',
      reqHash,
      body: JSON.stringify({ ok: true, id: 'original' }),
    });
    runRedisPipeline.mockResolvedValueOnce([{ result: stored }]);

    const res = await makeGateway()(post('key-replay'), ctx);
    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toBe(201);
    expect(res.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
    expect(await res.json()).toEqual({ ok: true, id: 'original' });
  });

  test('completed replay bypasses endpoint rate-limit charging', async () => {
    const reqHash = await sha256Hex(DEFAULT_BODY);
    const stored = JSON.stringify({
      state: 'completed',
      status: 200,
      contentType: 'application/json',
      reqHash,
      body: JSON.stringify({ ok: true, id: 'original' }),
    });
    runRedisPipeline.mockResolvedValueOnce([{ result: stored }]);
    checkEndpointRateLimit.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 }),
    );

    const res = await makeGateway()(post('key-replay'), ctx);

    expect(res.status).toBe(200);
    expect(handler).not.toHaveBeenCalled();
    expect(checkEndpointRateLimit).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ ok: true, id: 'original' });
  });

  test('a concurrent in-flight duplicate returns 409', async () => {
    runRedisPipeline.mockResolvedValueOnce([
      { result: JSON.stringify({ state: 'processing' }) },
    ]);
    const res = await makeGateway()(post('key-inflight'), ctx);
    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('idempotency_conflict');
  });

  test('same key with a different body returns 422', async () => {
    runRedisPipeline.mockResolvedValueOnce([
      {
        result: JSON.stringify({
          state: 'completed',
          status: 200,
          contentType: 'application/json',
          reqHash: 'a-different-body-hash',
          body: '{}',
        }),
      },
    ]);
    const res = await makeGateway()(post('key-reused'), ctx);
    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('idempotency_key_reused');
  });

  test('a malformed key is rejected 400 before touching Redis', async () => {
    const res = await makeGateway()(post('bad key with spaces'), ctx);
    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_idempotency_key');
    expect(runRedisPipeline).not.toHaveBeenCalled();
  });

  test('Redis unavailable fails open — request executes without idempotency', async () => {
    runRedisPipeline
      .mockResolvedValueOnce([]) // read-only peek fails open
      .mockResolvedValueOnce([]); // claim also fails open
    const res = await makeGateway()(post('key-failopen'), ctx);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBeNull();
  });

  test('a 5xx response is not cached — the lock is released for a retry', async () => {
    handler.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'upstream' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    runRedisPipeline
      .mockResolvedValueOnce([{ result: null }]) // read-only peek miss
      .mockResolvedValueOnce([{ result: 'OK' }, { result: null }]) // claim
      .mockResolvedValueOnce([{ result: 1 }]); // DEL
    const res = await makeGateway()(post('key-5xx'), ctx);
    expect(res.status).toBe(503);
    const releaseCmd = runRedisPipeline.mock.calls[2][0][0];
    expect(releaseCmd[0]).toBe('DEL');
  });

  test('a transient 429 response is not cached — the lock is released for a retry', async () => {
    handler.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'busy' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    runRedisPipeline
      .mockResolvedValueOnce([{ result: null }]) // read-only peek miss
      .mockResolvedValueOnce([{ result: 'OK' }, { result: null }]) // claim
      .mockResolvedValueOnce([{ result: 1 }]); // DEL
    const res = await makeGateway()(post('key-429'), ctx);
    expect(res.status).toBe(429);
    const releaseCmd = runRedisPipeline.mock.calls[2][0][0];
    expect(releaseCmd[0]).toBe('DEL');
  });
});
