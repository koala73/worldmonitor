// Regression test for issue #5478 (strand 1): runSeed's own seed-meta
// bookkeeping writes must DEGRADE, not crash, when Redis stays down past the
// retry budget.
//
// The #5438 fix wrapped writeFreshnessMetadata's SET in withRetry, but the
// helper still (correctly — external callers depend on it) throws after
// exhausting retries. On 2026-07-23 the sustained GDELT-brownout contention
// window produced three consecutive Upstash aborts in one run, the throw
// escaped runSeed's phase-2 try, and seed-gdelt-intel exited 1 with
// `FATAL: The operation was aborted due to timeout` — a red badge + alert
// over pure bookkeeping. By the time these writes run, the run's outcome is
// already decided (publish succeeded, or the skip path preserved last-good):
// the honest failure mode is a loud warning + an aging seed-meta key, which
// /api/health reports as STALE_SEED independently.

import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const { runSeed } = await import('../scripts/_seed-utils.mjs');

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalExit = process.exit;
const originalWarn = console.warn;
const ORIGINAL_SIGTERM_LISTENERS = new Set(process.rawListeners('SIGTERM'));

const CANONICAL_ENVELOPE = {
  _seed: { fetchedAt: 1784621196406, recordCount: 6, sourceVersion: 'test-v1', schemaVersion: 1, state: 'OK' },
  data: { items: ['cached'] },
};

let calls;
let warns;

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function abortError() {
  const err = new Error('The operation was aborted due to timeout');
  err.name = 'AbortError';
  return err;
}

beforeEach(() => {
  calls = [];
  warns = [];
  console.warn = (...args) => { warns.push(args.join(' ')); originalWarn(...args); };
  // Collapse retry backoffs (>=500ms) so exhaustion tests don't sleep for real.
  globalThis.setTimeout = (cb, ms, ...args) =>
    originalSetTimeout(cb, ms >= 500 ? 0 : ms, ...args);
  // Route every Redis surface runSeed touches; the seed-meta SET is the one
  // that stays down for the whole run (timeout-flavored, like the incident).
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : null;
    calls.push({ u, body });
    if (u.includes('/get/')) return jsonResponse({ result: JSON.stringify(CANONICAL_ENVELOPE) });
    if (u.endsWith('/pipeline')) return jsonResponse(body.map(() => ({ result: 1 })));
    if (Array.isArray(body) && body[0] === 'SET' && String(body[1]).startsWith('seed-meta:')) {
      throw abortError();
    }
    return jsonResponse({ result: 'OK' });
  };
  // Convert exits to throws so the test can inspect the exit code.
  process.exit = (code) => {
    const e = new Error(`__test_exit__:${code}`);
    e.exitCode = code;
    throw e;
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  process.exit = originalExit;
  console.warn = originalWarn;
  for (const listener of process.rawListeners('SIGTERM')) {
    if (!ORIGINAL_SIGTERM_LISTENERS.has(listener)) process.removeListener('SIGTERM', listener);
  }
});

async function runWithExitTrap(fn) {
  try {
    await fn();
    return { exitCode: null, threw: null };
  } catch (err) {
    if (String(err.message).startsWith('__test_exit__:')) return { exitCode: err.exitCode, threw: null };
    return { exitCode: null, threw: err };
  }
}

function metaSetAttempts(resource) {
  return calls.filter((c) =>
    Array.isArray(c.body) && c.body[0] === 'SET' && c.body[1] === `seed-meta:test:${resource}`,
  ).length;
}

test('validate-skip path: seed-meta mirror write exhausting retries degrades to exit 0, not FATAL', async () => {
  const { exitCode, threw } = await runWithExitTrap(() =>
    runSeed('test', 'meta-degrade-skip', 'test:meta-degrade-skip:v1',
      async () => ({ items: [] }),
      {
        validateFn: (d) => Array.isArray(d?.items) && d.items.length > 0, // fails → skip path
        ttlSeconds: 3600,
        declareRecords: (d) => (Array.isArray(d?.items) ? 1 : 0) || 1, // >0 → contract OK, reaches atomicPublish
        sourceVersion: 'test-v1',
        schemaVersion: 1,
        maxStaleMin: 720,
      }),
  );

  assert.equal(threw, null, `a bookkeeping SET must not escape runSeed as a crash; got: ${threw}`);
  assert.equal(exitCode, 0, 'skip path must still exit 0 when the seed-meta mirror write stays down');
  assert.ok(metaSetAttempts('meta-degrade-skip') >= 3, 'the SET must still be retried before degrading');
  assert.ok(
    warns.some((w) => w.includes('seed-meta write') && w.includes('STALE_SEED')),
    `degrade must be loud and name the surviving alarm; warns were: ${JSON.stringify(warns)}`,
  );
});

test('publish-success path: seed-meta write exhausting retries degrades to exit 0, not FATAL', async () => {
  const { exitCode, threw } = await runWithExitTrap(() =>
    runSeed('test', 'meta-degrade-pub', 'test:meta-degrade-pub:v1',
      async () => ({ items: [1, 2, 3] }),
      {
        validateFn: (d) => Array.isArray(d?.items) && d.items.length > 0, // passes → publish path
        ttlSeconds: 3600,
        declareRecords: (d) => d.items.length,
        sourceVersion: 'test-v1',
        schemaVersion: 1,
        maxStaleMin: 720,
      }),
  );

  assert.equal(threw, null, `the canonical publish already succeeded; a meta SET must not crash the run; got: ${threw}`);
  assert.equal(exitCode, 0, 'publish path must still exit 0 when the seed-meta write stays down');
  const canonicalSets = calls.filter((c) =>
    Array.isArray(c.body) && c.body[0] === 'SET' && c.body[1] === 'test:meta-degrade-pub:v1',
  );
  assert.ok(canonicalSets.length >= 1, 'canonical publish must have happened before the degraded meta write');
  assert.ok(
    warns.some((w) => w.includes('seed-meta write')),
    `degrade must be loud; warns were: ${JSON.stringify(warns)}`,
  );
});
