// @vitest-environment node

/**
 * Direct unit coverage for the Idempotency-Key core (server/_shared/idempotency.ts).
 * Complements the gateway integration test (gateway-idempotency.test.ts) by
 * driving beginIdempotency()/store() straight against a mocked runRedisPipeline,
 * including the branches the gateway path can't easily reach: corrupt-value and
 * per-command-error fail-open, and the store DEL guards (5xx / oversized /
 * non-text body).
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const runRedisPipeline = vi.fn();
vi.mock('../_shared/redis', async (importActual) => {
  const actual = await importActual<typeof import('../_shared/redis')>();
  return { ...actual, runRedisPipeline: (...a: unknown[]) => runRedisPipeline(...a) };
});

import { beginIdempotency, isValidIdempotencyKey, peekIdempotency } from '../_shared/idempotency';

const PATH = '/api/scenario/v1/run-scenario';
const BODY = JSON.stringify({ scenario: 'x' });

function makeRequest(body: string = BODY): Request {
  return new Request(`https://www.worldmonitor.app${PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

function begin(key: string, opts: { request?: Request; scope?: string | null } = {}) {
  return beginIdempotency({
    request: opts.request ?? makeRequest(),
    pathname: PATH,
    scope: opts.scope ?? 'user_api_key:acct_1',
    idempotencyKey: key,
    corsHeaders: {},
  });
}

function peek(key: string, opts: { request?: Request; scope?: string | null } = {}) {
  return peekIdempotency({
    request: opts.request ?? makeRequest(),
    pathname: PATH,
    scope: opts.scope ?? 'user_api_key:acct_1',
    idempotencyKey: key,
    corsHeaders: {},
  });
}

async function sha256Hex(str: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

beforeEach(() => runRedisPipeline.mockReset());

describe('isValidIdempotencyKey', () => {
  test.each([
    ['4f8b9c2e-1a3d-4b6f-8e0a-2c5d7f9b1e34', true],
    ['a'.repeat(255), true],
    ['~!@#$%^&*()_+', true],
    ['', false],
    ['a'.repeat(256), false],
    ['has space', false],
    ['tab\tchar', false],
    ['new\nline', false],
    ['unicodé', false],
  ])('%s → %s', (key, expected) => {
    expect(isValidIdempotencyKey(key)).toBe(expected);
  });
});

describe('beginIdempotency', () => {
  test('malformed key → invalid, never touches Redis', async () => {
    const out = await begin('');
    expect(out.kind).toBe('invalid');
    expect(runRedisPipeline).not.toHaveBeenCalled();
  });

  test('successful claim → proceed', async () => {
    runRedisPipeline.mockResolvedValueOnce([{ result: 'OK' }, { result: null }]);
    const out = await begin('k1');
    expect(out.kind).toBe('proceed');
  });

  test('empty pipeline (Redis down) → disabled (fail-open)', async () => {
    runRedisPipeline.mockResolvedValueOnce([]);
    expect((await begin('k1')).kind).toBe('disabled');
  });

  test('per-command error on the claim → disabled (fail-open)', async () => {
    runRedisPipeline.mockResolvedValueOnce([{ error: 'WRONGTYPE' }, { result: null }]);
    expect((await begin('k1')).kind).toBe('disabled');
  });

  test('key exists but stored value is corrupt → disabled (fail-open)', async () => {
    runRedisPipeline.mockResolvedValueOnce([{ result: null }, { result: 'not-json{' }]);
    expect((await begin('k1')).kind).toBe('disabled');
  });

  test('processing marker → conflict (409)', async () => {
    runRedisPipeline.mockResolvedValueOnce([
      { result: null },
      { result: JSON.stringify({ state: 'processing' }) },
    ]);
    const out = await begin('k1');
    expect(out.kind).toBe('conflict');
    if (out.kind === 'conflict') expect(out.response.status).toBe(409);
  });

  test('completed + matching body hash → replay', async () => {
    const reqHash = await sha256Hex(BODY);
    runRedisPipeline.mockResolvedValueOnce([
      { result: null },
      {
        result: JSON.stringify({
          state: 'completed',
          status: 201,
          contentType: 'application/json',
          reqHash,
          body: JSON.stringify({ id: 'orig' }),
        }),
      },
    ]);
    const out = await begin('k1');
    expect(out.kind).toBe('replay');
    if (out.kind === 'replay') {
      expect(out.response.status).toBe(201);
      expect(out.response.headers.get('Idempotent-Replayed')).toBe('true');
      expect(await out.response.json()).toEqual({ id: 'orig' });
    }
  });

  test('completed + different body hash → mismatch (422)', async () => {
    runRedisPipeline.mockResolvedValueOnce([
      { result: null },
      {
        result: JSON.stringify({
          state: 'completed',
          status: 200,
          contentType: 'application/json',
          reqHash: 'different',
          body: '{}',
        }),
      },
    ]);
    const out = await begin('k1');
    expect(out.kind).toBe('mismatch');
    if (out.kind === 'mismatch') expect(out.response.status).toBe(422);
  });
});

describe('peekIdempotency', () => {
  test('completed + matching body hash → replay without claiming', async () => {
    const reqHash = await sha256Hex(BODY);
    runRedisPipeline.mockResolvedValueOnce([
      {
        result: JSON.stringify({
          state: 'completed',
          status: 202,
          contentType: 'application/json',
          reqHash,
          body: JSON.stringify({ id: 'peeked' }),
        }),
      },
    ]);
    const out = await peek('k1');
    expect(out.kind).toBe('replay');
    if (out.kind === 'replay') {
      expect(out.response.status).toBe(202);
      expect(await out.response.json()).toEqual({ id: 'peeked' });
    }
    expect(runRedisPipeline.mock.calls[0][0][0][0]).toBe('GET');
  });

  test('missing record → miss without claiming', async () => {
    runRedisPipeline.mockResolvedValueOnce([{ result: null }]);
    const out = await peek('k1');
    expect(out.kind).toBe('miss');
    expect(runRedisPipeline.mock.calls[0][0][0][0]).toBe('GET');
  });
});

describe('store() (returned by a successful claim)', () => {
  async function getStore() {
    runRedisPipeline.mockResolvedValueOnce([{ result: 'OK' }, { result: null }]);
    const out = await begin('k1');
    if (out.kind !== 'proceed') throw new Error('expected proceed');
    runRedisPipeline.mockClear();
    runRedisPipeline.mockResolvedValue([{ result: 'OK' }]);
    return out.store;
  }

  function lastCmd() {
    return runRedisPipeline.mock.calls.at(-1)![0][0];
  }

  test('2xx JSON body → SET completed record', async () => {
    const store = await getStore();
    await store(200, new TextEncoder().encode('{"ok":true}').buffer, 'application/json');
    const cmd = lastCmd();
    expect(cmd[0]).toBe('SET');
    expect(JSON.parse(cmd[2]).state).toBe('completed');
  });

  test('stored record round-trips through beginIdempotency replay', async () => {
    const store = await getStore();
    await store(201, new TextEncoder().encode('{"ok":true}').buffer, 'application/json');
    const stored = runRedisPipeline.mock.calls.at(-1)![0][0][2];

    runRedisPipeline.mockReset();
    runRedisPipeline.mockResolvedValueOnce([{ result: null }, { result: stored }]);
    const out = await begin('k1');

    expect(out.kind).toBe('replay');
    if (out.kind === 'replay') {
      expect(out.response.status).toBe(201);
      expect(out.response.headers.get('content-type')).toBe('application/json');
      expect(await out.response.json()).toEqual({ ok: true });
    }
  });

  test('5xx → DEL (release lock)', async () => {
    const store = await getStore();
    await store(503, new TextEncoder().encode('{}').buffer, 'application/json');
    expect(lastCmd()[0]).toBe('DEL');
  });

  test('transient 429 → DEL (release lock)', async () => {
    const store = await getStore();
    await store(429, new TextEncoder().encode('{"retry":true}').buffer, 'application/json');
    expect(lastCmd()[0]).toBe('DEL');
  });

  test('oversized body → DEL (release lock)', async () => {
    const store = await getStore();
    const big = new ArrayBuffer(256 * 1024 + 1);
    await store(200, big, 'application/json');
    expect(lastCmd()[0]).toBe('DEL');
  });

  test('non-text content-type → DEL (release lock)', async () => {
    const store = await getStore();
    await store(200, new ArrayBuffer(8), 'application/octet-stream');
    expect(lastCmd()[0]).toBe('DEL');
  });

  test('completed SET failure releases the processing marker', async () => {
    const store = await getStore();
    runRedisPipeline.mockReset();
    runRedisPipeline
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ result: 1 }]);

    await store(200, new TextEncoder().encode('{"ok":true}').buffer, 'application/json');

    expect(runRedisPipeline.mock.calls[0][0][0][0]).toBe('SET');
    expect(runRedisPipeline.mock.calls[1][0][0][0]).toBe('DEL');
  });
});
