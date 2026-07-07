import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  globalThis.fetch = originalFetch;
}

function makeRequest(body = JSON.stringify({ action: 'write' })) {
  return new Request('https://worldmonitor.app/api/test-write', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://worldmonitor.app',
    },
    body,
  });
}

async function importFreshIdempotencyModule() {
  return import(`../api/_idempotency.js?test=${Date.now()}-${Math.random()}`);
}

async function sha256Hex(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function redisKeyFor({ scope = 'user:user_1', path = '/api/test-write', key = 'k1' } = {}) {
  return `idem:v1:${await sha256Hex(`${scope}\n${path}\n${key}`)}`;
}

function installRedisPipelineMock(handler) {
  process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
  const calls = [];

  globalThis.fetch = mock.fn(async (url, init) => {
    assert.match(String(url), /\/pipeline$/);
    const commands = JSON.parse(String(init?.body ?? '[]'));
    calls.push(commands);
    return Response.json(handler(commands));
  });

  return calls;
}

afterEach(() => {
  mock.restoreAll();
  restoreEnv();
});

describe('api standalone Idempotency-Key helper', () => {
  it('rejects malformed keys without touching Redis', async () => {
    const { beginStandaloneIdempotency, IDEMPOTENCY_HEADER } = await importFreshIdempotencyModule();
    const fetchMock = mock.method(globalThis, 'fetch', async () => {
      throw new Error('Redis should not be called');
    });

    const out = await beginStandaloneIdempotency({
      request: makeRequest(),
      pathname: '/api/test-write',
      scope: 'user:user_1',
      idempotencyKey: '',
      corsHeaders: {},
    });

    assert.equal(out.kind, 'invalid');
    assert.equal(out.response.status, 400);
    assert.equal((await out.response.json()).error, 'invalid_idempotency_key');
    assert.equal(out.response.headers.has(IDEMPOTENCY_HEADER), false);
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  it('fails open when Redis credentials are absent', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const { beginStandaloneIdempotency } = await importFreshIdempotencyModule();

    const out = await beginStandaloneIdempotency({
      request: makeRequest(),
      pathname: '/api/test-write',
      scope: 'user:user_1',
      idempotencyKey: 'k1',
      corsHeaders: {},
    });

    assert.equal(out.kind, 'disabled');
  });

  it('claims a new key with SET NX EX and returns a store function', async () => {
    const calls = installRedisPipelineMock((commands) => {
      assert.deepEqual(commands[0].slice(0, 2), ['SET', commands[0][1]]);
      assert.equal(commands[0][3], 'NX');
      assert.equal(commands[0][4], 'EX');
      assert.equal(commands[1][0], 'GET');
      return [{ result: 'OK' }, { result: null }];
    });
    const { beginStandaloneIdempotency } = await importFreshIdempotencyModule();

    const out = await beginStandaloneIdempotency({
      request: makeRequest(),
      pathname: '/api/test-write',
      scope: 'user:user_1',
      idempotencyKey: 'k1',
      corsHeaders: {},
    });

    assert.equal(out.kind, 'proceed');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0][5], '180');
  });

  it('returns 409 while an identical keyed request is still processing', async () => {
    installRedisPipelineMock(() => [
      { result: null },
      { result: JSON.stringify({ state: 'processing' }) },
    ]);
    const { beginStandaloneIdempotency, IDEMPOTENCY_HEADER } = await importFreshIdempotencyModule();

    const out = await beginStandaloneIdempotency({
      request: makeRequest(),
      pathname: '/api/test-write',
      scope: 'user:user_1',
      idempotencyKey: 'k1',
      corsHeaders: {},
    });

    assert.equal(out.kind, 'conflict');
    assert.equal(out.response.status, 409);
    assert.equal(out.response.headers.get('Retry-After'), '2');
    assert.equal(out.response.headers.get(IDEMPOTENCY_HEADER), 'k1');
  });

  it('replays a completed same-body response without claiming', async () => {
    const reqBody = JSON.stringify({ action: 'write' });
    const reqHash = await sha256Hex(reqBody);
    installRedisPipelineMock(() => [
      { result: null },
      {
        result: JSON.stringify({
          state: 'completed',
          status: 201,
          contentType: 'application/json',
          reqHash,
          body: JSON.stringify({ id: 'original' }),
        }),
      },
    ]);
    const { beginStandaloneIdempotency, IDEMPOTENT_REPLAYED_HEADER } = await importFreshIdempotencyModule();

    const out = await beginStandaloneIdempotency({
      request: makeRequest(reqBody),
      pathname: '/api/test-write',
      scope: 'user:user_1',
      idempotencyKey: 'k1',
      corsHeaders: {},
    });

    assert.equal(out.kind, 'replay');
    assert.equal(out.response.status, 201);
    assert.equal(out.response.headers.get(IDEMPOTENT_REPLAYED_HEADER), 'true');
    assert.deepEqual(await out.response.json(), { id: 'original' });
  });

  it('returns 422 when the same key is reused with a different body', async () => {
    installRedisPipelineMock(() => [
      { result: null },
      {
        result: JSON.stringify({
          state: 'completed',
          status: 200,
          contentType: 'application/json',
          reqHash: 'different-hash',
          body: '{}',
        }),
      },
    ]);
    const { beginStandaloneIdempotency } = await importFreshIdempotencyModule();

    const out = await beginStandaloneIdempotency({
      request: makeRequest(JSON.stringify({ action: 'changed' })),
      pathname: '/api/test-write',
      scope: 'user:user_1',
      idempotencyKey: 'k1',
      corsHeaders: {},
    });

    assert.equal(out.kind, 'mismatch');
    assert.equal(out.response.status, 422);
    assert.equal((await out.response.json()).error, 'idempotency_key_reused');
  });

  it('stores a completed JSON response with the supplied TTL', async () => {
    const storedCommands = [];
    installRedisPipelineMock((commands) => {
      storedCommands.push(commands);
      if (commands[0][0] === 'SET' && commands[0].includes('NX')) {
        return [{ result: 'OK' }, { result: null }];
      }
      return [{ result: 'OK' }];
    });
    const { beginStandaloneIdempotency } = await importFreshIdempotencyModule();

    const out = await beginStandaloneIdempotency({
      request: makeRequest(),
      pathname: '/api/test-write',
      scope: 'user:user_1',
      idempotencyKey: 'k1',
      corsHeaders: {},
      completedTtlSeconds: 600,
    });
    assert.equal(out.kind, 'proceed');

    await out.store(200, new TextEncoder().encode('{"ok":true}').buffer, 'application/json');

    assert.equal(storedCommands[1][0][0], 'SET');
    assert.equal(storedCommands[1][0][3], 'EX');
    assert.equal(storedCommands[1][0][4], '600');
    assert.equal(JSON.parse(storedCommands[1][0][2]).state, 'completed');
  });

  it('releases the processing marker instead of caching retryable failures', async () => {
    const redisKey = await redisKeyFor();
    const commandsSeen = [];
    installRedisPipelineMock((commands) => {
      commandsSeen.push(commands);
      if (commands[0][0] === 'SET' && commands[0].includes('NX')) {
        return [{ result: 'OK' }, { result: null }];
      }
      return [{ result: 1 }];
    });
    const { beginStandaloneIdempotency } = await importFreshIdempotencyModule();

    const out = await beginStandaloneIdempotency({
      request: makeRequest(),
      pathname: '/api/test-write',
      scope: 'user:user_1',
      idempotencyKey: 'k1',
      corsHeaders: {},
    });
    assert.equal(out.kind, 'proceed');

    await out.store(503, new TextEncoder().encode('{"error":"down"}').buffer, 'application/json');

    assert.deepEqual(commandsSeen[1][0], ['DEL', redisKey]);
  });

  it('releases the processing marker when completed SET returns a command error', async () => {
    const redisKey = await redisKeyFor();
    const commandsSeen = [];
    installRedisPipelineMock((commands) => {
      commandsSeen.push(commands);
      if (commands[0][0] === 'SET' && commands[0].includes('NX')) {
        return [{ result: 'OK' }, { result: null }];
      }
      if (commands[0][0] === 'SET') return [{ error: 'WRONGTYPE' }];
      return [{ result: 1 }];
    });
    const { beginStandaloneIdempotency } = await importFreshIdempotencyModule();

    const out = await beginStandaloneIdempotency({
      request: makeRequest(),
      pathname: '/api/test-write',
      scope: 'user:user_1',
      idempotencyKey: 'k1',
      corsHeaders: {},
    });
    assert.equal(out.kind, 'proceed');

    await out.store(200, new TextEncoder().encode('{"ok":true}').buffer, 'application/json');

    assert.deepEqual(commandsSeen[2][0], ['DEL', redisKey]);
  });
});
