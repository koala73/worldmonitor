import { describe, it, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

// Behavioral regression for PR #3078: strict-floor IMF seeders must not
// poison seed-meta on empty/invalid upstream responses. Without the opt-in
// flag, a single transient empty fetch refreshes fetchedAt →
// _bundle-runner skips the bundle for the full intervalMs (30 days for
// imf-external; Railway log 2026-04-13).
//
// Stubs the Upstash REST layer (all Redis calls go through globalThis.fetch)
// plus process.exit, then drives runSeed through both branches and asserts
// on the actual commands sent to Redis and the process exit code.

process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.local';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const { runSeed } = await import('../scripts/_seed-utils.mjs');

/** @type {Array<{url: string, body: any}>} */
let fetchCalls = [];
let originalFetch;
let originalExit;
let originalLog;
let originalWarn;
let originalError;

before(() => {
  originalFetch = globalThis.fetch;
  originalExit = process.exit;
  originalLog = console.log;
  originalWarn = console.warn;
  originalError = console.error;
});

after(() => {
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
});

beforeEach(() => {
  fetchCalls = [];
  // Silence seed noise during tests; uncomment for debugging.
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    fetchCalls.push({ url: String(url), body });
    // Lock acquire (SET ... NX PX) must succeed; everything else OK too.
    return {
      ok: true,
      status: 200,
      json: async () => ({ result: 'OK' }),
      text: async () => 'OK',
    };
  };
});

class ExitCalled extends Error {
  constructor(code) { super(`exit(${code})`); this.code = code; }
}

function stubExit() {
  process.exit = (code) => { throw new ExitCalled(code ?? 0); };
}

function metaWrites() {
  // writeFreshnessMetadata POSTs ['SET', 'seed-meta:<domain>:<res>', payload, 'EX', ttl]
  // to the base URL. Identifies any seed-meta write regardless of helper.
  return fetchCalls.filter(c =>
    Array.isArray(c.body) &&
    c.body[0] === 'SET' &&
    typeof c.body[1] === 'string' &&
    c.body[1].startsWith('seed-meta:')
  );
}

describe('runSeed emptyDataIsFailure branch (behavioral)', () => {
  const domain = 'test';
  const resource = 'strict-floor';
  const canonicalKey = 'test:strict-floor:v1';
  // validateFn rejects everything → forces atomicPublish's skipped branch.
  const alwaysInvalid = () => false;

  it('emptyDataIsFailure:true — does NOT write seed-meta and exits non-zero', async () => {
    stubExit();
    let exitCode = null;
    try {
      await runSeed(domain, resource, canonicalKey, async () => ({ countries: {} }), {
        validateFn: alwaysInvalid,
        ttlSeconds: 3600,
        emptyDataIsFailure: true,
      });
    } catch (err) {
      if (!(err instanceof ExitCalled)) throw err;
      exitCode = err.code;
    }

    assert.equal(exitCode, 1, 'strict-floor path must exit(1) so _bundle-runner counts failed++');
    assert.equal(metaWrites().length, 0,
      `expected zero seed-meta writes under emptyDataIsFailure:true, got: ${JSON.stringify(metaWrites())}`);
    // Must still extend TTL (pipeline EXPIRE) to preserve the existing cache.
    const pipelineCalls = fetchCalls.filter(c => c.url.endsWith('/pipeline'));
    assert.ok(pipelineCalls.length >= 1, 'extendExistingTtl pipeline call missing — cache TTL would drop');
  });

  it('emptyDataIsFailure:false (default) — DOES write seed-meta and exits zero', async () => {
    stubExit();
    let exitCode = null;
    try {
      await runSeed(domain, resource, canonicalKey, async () => ({ countries: {} }), {
        validateFn: alwaysInvalid,
        ttlSeconds: 3600,
        // emptyDataIsFailure omitted — default quiet-period behavior
      });
    } catch (err) {
      if (!(err instanceof ExitCalled)) throw err;
      exitCode = err.code;
    }

    assert.equal(exitCode, 0, 'default path exits(0) — quiet-period seeders must not spam bundle failures');
    const metas = metaWrites();
    assert.equal(metas.length, 1,
      `default path must write exactly one seed-meta (fresh fetchedAt for health check), got ${metas.length}`);
    assert.equal(metas[0].body[1], `seed-meta:${domain}:${resource}`);
  });
});
