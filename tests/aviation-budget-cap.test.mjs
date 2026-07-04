/**
 * Tests for the AviationStack monthly call budget — the hard ceiling that keeps
 * total paid usage under the plan limit.
 *
 *   reserveAviationStackCalls()  server/worldmonitor/aviation/v1/_avstack-budget.ts
 *   request-time wiring          list-airport-flights.ts, get-flight-status.ts
 *   seeder backstop              scripts/seed-aviation.mjs
 *
 * Behavioural tests mock the Upstash pipeline so the shared counter is
 * exercised end-to-end without network. Static tests pin the wiring + the
 * limit cache-key quantization (a separate spend regression).
 *
 * Run with: npm run test:data -- --test-name-pattern="aviation budget"
 */

import { describe, it, before, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// ────────────────────────────────────────────────────────────────────────────
// 1. Behavioural — shared counter enforces request + hard ceilings
// ────────────────────────────────────────────────────────────────────────────

describe('aviation budget: reserveAviationStackCalls enforces ceilings', () => {
  let reserveAviationStackCalls;
  let counter; // simulated Redis INCRBY/DECRBY state

  before(async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'http://localhost:0';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    delete process.env.LOCAL_API_MODE;
    ({ reserveAviationStackCalls } = await import(
      '../server/worldmonitor/aviation/v1/_avstack-budget.ts'
    ));
  });

  beforeEach(() => {
    counter = 0;
    mock.method(globalThis, 'fetch', async (_url, opts) => {
      const cmds = JSON.parse(opts.body); // [[ 'INCRBY', key, n ], [ 'EXPIRE', ... ]]
      const results = cmds.map((cmd) => {
        const [verb, , n] = cmd;
        if (verb === 'INCRBY') { counter += Number(n); return { result: counter }; }
        if (verb === 'DECRBY') { counter -= Number(n); return { result: counter }; }
        return { result: 1 }; // EXPIRE
      });
      return { ok: true, json: async () => results };
    });
  });

  afterEach(() => {
    mock.restoreAll();
    delete process.env.AVIATIONSTACK_MONTHLY_BUDGET;
    delete process.env.AVIATIONSTACK_REQUEST_BUDGET;
  });

  it('allows request-time calls up to AVIATIONSTACK_REQUEST_BUDGET, then denies', async () => {
    process.env.AVIATIONSTACK_MONTHLY_BUDGET = '10';
    process.env.AVIATIONSTACK_REQUEST_BUDGET = '5';

    for (let i = 0; i < 5; i++) {
      assert.equal(await reserveAviationStackCalls(1, 'request'), true, `call ${i + 1} should be allowed`);
    }
    // 6th request would exceed the request ceiling.
    assert.equal(await reserveAviationStackCalls(1, 'request'), false);
    // Denied reservation is returned — counter stays at the ceiling, not above.
    assert.equal(counter, 5);
  });

  it('reserves headroom for the seeder above the request ceiling', async () => {
    process.env.AVIATIONSTACK_MONTHLY_BUDGET = '10';
    process.env.AVIATIONSTACK_REQUEST_BUDGET = '5';

    // Burn the request budget.
    for (let i = 0; i < 5; i++) await reserveAviationStackCalls(1, 'request');
    assert.equal(await reserveAviationStackCalls(1, 'request'), false);

    // Seeder can still use the reserved gap (5 → 10).
    assert.equal(await reserveAviationStackCalls(3, 'seed'), true);
    assert.equal(counter, 8);
    // ...but not past the hard cap.
    assert.equal(await reserveAviationStackCalls(3, 'seed'), false);
    assert.equal(counter, 8);
  });

  it('treats a zero MONTHLY budget as disabled (always allow, no Redis I/O)', async () => {
    process.env.AVIATIONSTACK_MONTHLY_BUDGET = '0';
    const fetchMock = globalThis.fetch;
    assert.equal(await reserveAviationStackCalls(999, 'request'), true);
    assert.equal(await reserveAviationStackCalls(999, 'seed'), true);
    assert.equal(fetchMock.mock.callCount(), 0, 'disabled cap must not touch Redis');
  });

  it('treats blank budget env vars as unset defaults, not disabled', async () => {
    process.env.AVIATIONSTACK_MONTHLY_BUDGET = ' ';
    process.env.AVIATIONSTACK_REQUEST_BUDGET = '';

    assert.equal(await reserveAviationStackCalls(1, 'request'), true);
    assert.equal(counter, 1, 'blank budget env vars should still reserve against Redis');
  });

  it('fails open when Redis is unreachable (never blanks the panel on a blip)', async () => {
    process.env.AVIATIONSTACK_MONTHLY_BUDGET = '10';
    mock.restoreAll();
    mock.method(globalThis, 'fetch', async () => { throw new Error('ECONNREFUSED'); });
    assert.equal(await reserveAviationStackCalls(1, 'request'), true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Static — wiring + limit cache-key quantization
// ────────────────────────────────────────────────────────────────────────────

describe('aviation budget: call sites are wired to the cap', () => {
  const read = (p) => readFileSync(resolve(root, p), 'utf-8');

  it('list-airport-flights reserves budget and quantizes the limit out of the cache key', () => {
    const src = read('server/worldmonitor/aviation/v1/list-airport-flights.ts');
    assert.match(src, /reserveAviationStackCalls\(1, 'request'\)/);
    assert.match(src, /aviationStackBudgetMonth\(\)/);
    // Cache key must NOT vary by limit (was the spend-multiplying explosion).
    assert.doesNotMatch(src, /aviation:flights:\$\{airport\}:\$\{direction\}:\$\{limit\}/);
    assert.match(src, /aviation:flights:\$\{airport\}:\$\{direction\}:v2:\$\{aviationStackBudgetMonth\(\)\}/);
    // Upstream always fetches a fixed page, then slices in memory.
    assert.match(src, /limit:\s*String\(UPSTREAM_PAGE\)/);
    assert.match(src, /flights\.slice\(0, limit\)/);
  });

  it('get-flight-status reserves budget before the upstream call and caches relay errors', () => {
    const src = read('server/worldmonitor/aviation/v1/get-flight-status.ts');
    assert.match(src, /reserveAviationStackCalls\(1, 'request'\)/);
    assert.match(src, /aviation:status:\$\{flightNumber\}:\$\{date\}:\$\{origin\}:v1:\$\{aviationStackBudgetMonth\(\)\}/);
    assert.match(src, /Flight status relay fetch failed/);
    assert.match(src, /return \{ flights: \[\], source: 'error' \}/);
  });

  it('seeder reserves its batch against the same shared counter + key', () => {
    const src = read('scripts/seed-aviation.mjs');
    assert.match(src, /reserveAviationStackBudget\(AVIATIONSTACK_LIST\.length\)/);
    // Same Redis key format as the server helper — they MUST share the counter.
    assert.match(src, /aviation:avstack:calls:\$\{ym\}/);
  });

  it('server budget helper uses the same key format + UTC month math as the seeder', () => {
    // Cross-file drift would split the counter and silently defeat the shared
    // ceiling — pin both halves so a future edit to either fails the test.
    const srv = read('server/worldmonitor/aviation/v1/_avstack-budget.ts');
    assert.match(srv, /aviation:avstack:calls:/);
    assert.match(srv, /getUTCFullYear\(\)/);
    assert.match(srv, /getUTCMonth\(\)/);
    const seeder = read('scripts/seed-aviation.mjs');
    assert.match(seeder, /getUTCFullYear\(\)/);
    assert.match(seeder, /getUTCMonth\(\)/);
  });

  it('request cache keys include the UTC budget month so budget denials expire across month rollover', () => {
    const srv = read('server/worldmonitor/aviation/v1/_avstack-budget.ts');
    assert.match(srv, /export function aviationStackBudgetMonth/);
    assert.match(srv, /getUTCFullYear\(\)/);
    assert.match(srv, /getUTCMonth\(\)/);
    assert.match(read('server/worldmonitor/aviation/v1/list-airport-flights.ts'), /aviationStackBudgetMonth\(\)/);
    assert.match(read('server/worldmonitor/aviation/v1/get-flight-status.ts'), /aviationStackBudgetMonth\(\)/);
  });

  it('seeder freshness gate is clamped below the health staleness window', () => {
    const src = read('scripts/seed-aviation.mjs');
    assert.match(src, /const MAX_INTL_MIN_REFRESH_MIN = 60/);
    assert.match(src, /AVIATIONSTACK_MIN_REFRESH_MIN', 55, MAX_INTL_MIN_REFRESH_MIN/);
  });

  it('seeder fetchIntl marks its throw nonRetryable so runSeed cannot 4x the paid sweep', () => {
    // Regression guard for the retry-multiplier undercount: without this tag,
    // withRetry re-runs the full airport sweep up to 4x on an unhealthy tick
    // while the budget counter only saw one reserved batch.
    const src = read('scripts/seed-aviation.mjs');
    assert.match(src, /err\.nonRetryable = true/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Behavioural — seeder helpers (scripts/seed-aviation.mjs)
// ────────────────────────────────────────────────────────────────────────────
// The seeder's freshness gate is the PRIMARY normal-spend control and its
// budget backstop is the hard ceiling on the biggest spender — both were
// previously only regex-checked. Importing is safe: seed-aviation.mjs has an
// isMain guard, so module load does not fire the seed run.

describe('aviation budget: seeder helpers behave', () => {
  let intlIsFresh, reserveAviationStackBudget;

  before(async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'http://localhost:0';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    delete process.env.LOCAL_API_MODE;
    // Leave AVIATIONSTACK_MIN_REFRESH_MIN unset so the module loads the default
    // 55-min gate (the const is captured at import time).
    delete process.env.AVIATIONSTACK_MIN_REFRESH_MIN;
    ({ intlIsFresh, reserveAviationStackBudget } = await import('../scripts/seed-aviation.mjs'));
  });

  afterEach(() => {
    mock.restoreAll();
    delete process.env.AVIATIONSTACK_MONTHLY_BUDGET;
  });

  // -- intlIsFresh: skip when last publish is younger than the gate --

  function mockSeedMeta(metaValue) {
    mock.method(globalThis, 'fetch', async (url) => {
      // readCanonicalValue → redisGet → GET /get/<key>
      if (String(url).includes('/get/')) {
        return { ok: true, json: async () => ({ result: metaValue == null ? null : JSON.stringify(metaValue) }) };
      }
      return { ok: true, json: async () => [{ result: 1 }] };
    });
  }

  it('returns true (skip the fetch) when last publish is younger than the gate', async () => {
    mockSeedMeta({ fetchedAt: Date.now() - 10 * 60_000, recordCount: 4 });
    assert.equal(await intlIsFresh(), true);
  });

  it('returns false (fetch) when last publish is older than the gate', async () => {
    mockSeedMeta({ fetchedAt: Date.now() - 90 * 60_000, recordCount: 4 });
    assert.equal(await intlIsFresh(), false);
  });

  it('returns false (fetch) when seed-meta is missing', async () => {
    mockSeedMeta(null);
    assert.equal(await intlIsFresh(), false);
  });

  it('returns false (fetch) on a non-numeric fetchedAt', async () => {
    mockSeedMeta({ fetchedAt: 'not-a-number', recordCount: 4 });
    assert.equal(await intlIsFresh(), false);
  });

  it('returns false (fetch) on a future fetchedAt (clock skew)', async () => {
    mockSeedMeta({ fetchedAt: Date.now() + 60 * 60_000, recordCount: 4 });
    assert.equal(await intlIsFresh(), false);
  });

  // -- reserveAviationStackBudget: hard ceiling, conservative counter --

  function mockBudgetCounter() {
    const state = { counter: 0 };
    mock.method(globalThis, 'fetch', async (_url, opts) => {
      const cmds = JSON.parse(opts.body);
      const results = cmds.map((cmd) => {
        const [verb, , n] = cmd;
        if (verb === 'INCRBY') { state.counter += Number(n); return { result: state.counter }; }
        if (verb === 'DECRBY') { state.counter -= Number(n); return { result: state.counter }; }
        return { result: 1 };
      });
      return { ok: true, json: async () => results };
    });
    return state;
  }

  it('allows the seed batch under the hard cap, denies once it would breach, and refunds on deny', async () => {
    process.env.AVIATIONSTACK_MONTHLY_BUDGET = '100';
    const state = mockBudgetCounter();
    // 50 + 50 = 100 (== cap, allowed since deny is total > cap).
    assert.equal(await reserveAviationStackBudget(50), true);
    assert.equal(await reserveAviationStackBudget(50), true);
    assert.equal(state.counter, 100);
    // Next batch would push to 150 > 100 → denied, and refunded back to the cap.
    assert.equal(await reserveAviationStackBudget(50), false);
    assert.equal(state.counter, 100);
  });

  it('treats a zero MONTHLY budget as disabled (always allow, no Redis I/O)', async () => {
    process.env.AVIATIONSTACK_MONTHLY_BUDGET = '0';
    const state = mockBudgetCounter();
    assert.equal(await reserveAviationStackBudget(999), true);
    assert.equal(state.counter, 0);
  });

  it('treats a blank MONTHLY budget as unset default, not disabled', async () => {
    process.env.AVIATIONSTACK_MONTHLY_BUDGET = ' ';
    const state = mockBudgetCounter();
    assert.equal(await reserveAviationStackBudget(50), true);
    assert.equal(state.counter, 50, 'blank monthly budget should still reserve against Redis');
  });

  it('fails open when the budget pipeline throws', async () => {
    process.env.AVIATIONSTACK_MONTHLY_BUDGET = '100';
    mock.method(globalThis, 'fetch', async () => { throw new Error('ECONNREFUSED'); });
    assert.equal(await reserveAviationStackBudget(50), true);
  });
});
