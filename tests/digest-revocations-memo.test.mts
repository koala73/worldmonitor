import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  REVOCATION_MEMO_TTL_MS,
  REVOKED_URLS_KEY,
  __resetRevocationMemoForTest,
  readRevokedUrlSet,
} from '../server/_shared/digest-revocations.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** Upstash pipeline stub: answers SMEMBERS with `members()`, or HTTP 500 when it returns null. */
function stubRedis(members: () => string[] | null) {
  const calls: unknown[][][] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const commands = JSON.parse(String(init?.body)) as unknown[][];
    calls.push(commands);
    assert.deepEqual(commands, [['SMEMBERS', REVOKED_URLS_KEY]]);
    const current = members();
    if (current === null) return new Response('down', { status: 500 });
    return Response.json([{ result: current }]);
  }) as typeof fetch;
  return calls;
}

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://revocation-memo.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  delete process.env.LOCAL_API_MODE;
  __resetRevocationMemoForTest();
});

afterEach(() => {
  mock.timers.reset();
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  __resetRevocationMemoForTest();
});

describe('readRevokedUrlSet per-instance memo', () => {
  it('serves repeat reads inside the window from memory', async () => {
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const calls = stubRedis(() => ['https://example.com/revoked']);
    const first = await readRevokedUrlSet();
    mock.timers.tick(REVOCATION_MEMO_TTL_MS - 1);
    const second = await readRevokedUrlSet();
    assert.equal(calls.length, 1);
    assert.deepEqual([...second.urls], ['https://example.com/revoked']);
    assert.equal(second.readable, true);
    assert.equal(second.urls, first.urls);
  });

  it('reads Redis again once the window has passed, picking up a new revocation', async () => {
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    let members = ['https://example.com/a'];
    const calls = stubRedis(() => members);
    await readRevokedUrlSet();
    members = ['https://example.com/a', 'https://example.com/b'];
    mock.timers.tick(REVOCATION_MEMO_TTL_MS);
    const refreshed = await readRevokedUrlSet();
    assert.equal(calls.length, 2);
    assert.deepEqual([...refreshed.urls].sort(), ['https://example.com/a', 'https://example.com/b']);
  });

  it('shares one Redis read between concurrent callers', async () => {
    const gate = deferred<void>();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      await gate.promise;
      return Response.json([{ result: ['https://example.com/x'] }]);
    }) as typeof fetch;
    const reads = Promise.all([readRevokedUrlSet(), readRevokedUrlSet(), readRevokedUrlSet()]);
    gate.resolve();
    const results = await reads;
    assert.equal(calls, 1);
    for (const read of results) assert.deepEqual([...read.urls], ['https://example.com/x']);
  });

  it('never keeps a failed read, so the next request retries Redis', async () => {
    let up = false;
    const calls = stubRedis(() => (up ? ['https://example.com/r'] : null));
    const failed = await readRevokedUrlSet();
    assert.equal(failed.readable, false);
    up = true;
    const recovered = await readRevokedUrlSet();
    assert.equal(calls.length, 2);
    assert.equal(recovered.readable, true);
    assert.deepEqual([...recovered.urls], ['https://example.com/r']);
  });

  it('keeps an empty set: no revocations is a readable answer', async () => {
    const calls = stubRedis(() => []);
    assert.equal((await readRevokedUrlSet()).readable, true);
    assert.equal((await readRevokedUrlSet()).urls.size, 0);
    assert.equal(calls.length, 1);
  });

  it('keeps the window at a few seconds', () => {
    assert.ok(REVOCATION_MEMO_TTL_MS > 0 && REVOCATION_MEMO_TTL_MS <= 10_000);
  });
});
