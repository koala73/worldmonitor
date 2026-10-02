// readCanonicalValue's opt-in strict mode (#7524 review).
//
// redisGet degrades HTTP failures to null after retries, which is right for a
// cache-merge reader that can proceed without the value and wrong for one whose
// next step reads "no value" as a first run. The SIPRI arms sweep is the latter:
// a degraded read made it republish one 56-importer slice over its ~200-row
// canonical key. `strict` opts that single caller out.
//
// The third case is the one that keeps strict honest: a genuinely ABSENT key is
// an HTTP 200 carrying a null result, not a failure, and must still return null
// so a real first run can bootstrap.

import { test, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const { readCanonicalValue } = await import('../scripts/_seed-utils.mjs');

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalWarn = console.warn;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  console.warn = originalWarn;
});

// Collapse the retry backoff ladder so exhausting it does not sleep for real.
function collapseBackoffs() {
  globalThis.setTimeout = (cb, ms, ...args) => originalSetTimeout(cb, ms > 0 && ms <= 8000 ? 0 : ms, ...args);
}

test('a persistent Redis HTTP failure still degrades to null by default', async () => {
  const warns = [];
  console.warn = (...args) => { warns.push(args.join(' ')); };
  collapseBackoffs();
  globalThis.fetch = async () => new Response('upstream error', { status: 503 });

  assert.equal(await readCanonicalValue('test:strict-read:v1'), null);
  assert.match(warns.join('\n'), /degraded to null/);
});

test('strict mode propagates the same failure instead of reading as a first run', async () => {
  collapseBackoffs();
  globalThis.fetch = async () => new Response('upstream error', { status: 503 });

  await assert.rejects(
    () => readCanonicalValue('test:strict-read:v1', { strict: true }),
    /HTTP 503/,
  );
});

test('strict mode still returns null for a genuinely absent key', async () => {
  // HTTP 200 + null result is "no such key", not a failure. If strict threw
  // here it would hard-fail every legitimate first run.
  globalThis.fetch = async () => new Response(JSON.stringify({ result: null }), { status: 200 });

  assert.equal(await readCanonicalValue('test:strict-read:v1', { strict: true }), null);
});
