import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  runSeed,
  raceFetchDeadline,
  GRACEFUL_FETCH_FAILURE_EXIT_CODE,
} from '../scripts/_seed-utils.mjs';

const hang = () => new Promise(() => {});

// ── raceFetchDeadline helper ────────────────────────────────────────────────
describe('raceFetchDeadline', () => {
  it('resolves with the fetch value when it settles in time (transparent on success)', async () => {
    assert.deepEqual(await raceFetchDeadline(Promise.resolve({ ok: 1 }), 1000, 'd:r'), { ok: 1 });
  });

  it('rejects with the #4786 deadline error when the fetch never settles', async () => {
    await assert.rejects(() => raceFetchDeadline(hang(), 20, 'd:r'), /exceeded 20ms deadline .*#4786/);
  });

  it('passes an underlying rejection straight through', async () => {
    await assert.rejects(() => raceFetchDeadline(Promise.reject(new Error('upstream 500')), 1000, 'd:r'), /upstream 500/);
  });
});

// ── runSeed: a non-settling fetch degrades gracefully instead of exit 13 ─────
describe('runSeed fetch-phase deadline (issue #4786)', () => {
  const realExit = process.exit;
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const realErr = console.error;
  let prevUrl, prevTok;

  before(() => {
    prevUrl = process.env.UPSTASH_REDIS_REST_URL;
    prevTok = process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
  });
  after(() => {
    process.exit = realExit;
    globalThis.fetch = realFetch;
    console.log = realLog;
    console.error = realErr;
    if (prevUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = prevUrl;
    if (prevTok === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = prevTok;
  });

  // Permissive Upstash mock: lock SET-NX → OK, EXPIRE pipeline → all-extended,
  // everything else → 1. Lets runSeed acquire the lock and run its graceful
  // cleanup without touching a real Redis.
  function mockRedis() {
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      const body = init?.body ? JSON.parse(init.body) : null;
      if (u.endsWith('/pipeline') && Array.isArray(body)) {
        return { ok: true, status: 200, json: async () => body.map(() => ({ result: 1 })), text: async () => '' };
      }
      const cmd = Array.isArray(body) ? String(body[0]).toUpperCase() : '';
      return { ok: true, status: 200, json: async () => ({ result: cmd === 'SET' ? 'OK' : 1 }), text: async () => '' };
    };
  }

  // Drive runSeed with a fetchFn that never settles; capture the exit code the
  // graceful path calls process.exit() with (stubbed to throw so it unwinds).
  async function exitCodeFor(fetchFn, opts) {
    mockRedis();
    console.log = () => {};
    console.error = () => {};
    process.exit = (code) => { throw Object.assign(new Error('__EXIT__'), { __exit: true, code }); };
    try {
      await runSeed('test', 'deadline', 'test:deadline:v1', fetchFn, opts);
      return null; // returned without exiting — unexpected
    } catch (err) {
      if (err?.__exit) return err.code;
      throw err;
    } finally {
      process.exit = realExit;
      globalThis.fetch = realFetch;
      console.log = realLog;
      console.error = realErr;
    }
  }

  it('a hanging fetchFn exits 75 (graceful) rather than hanging into an exit-13 red badge', async () => {
    const code = await exitCodeFor(hang, { ttlSeconds: 600, validateFn: () => true, fetchPhaseTimeoutMs: 50 });
    assert.equal(code, GRACEFUL_FETCH_FAILURE_EXIT_CODE);
  });

  it('an ordinary fetch rejection still takes the same graceful exit-75 path (deadline is not in the way)', async () => {
    const code = await exitCodeFor(() => Promise.reject(new Error('upstream 500')), { ttlSeconds: 600, validateFn: () => true, fetchPhaseTimeoutMs: 50_000 });
    assert.equal(code, GRACEFUL_FETCH_FAILURE_EXIT_CODE);
  });
});
