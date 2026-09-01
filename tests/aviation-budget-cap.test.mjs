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
import {
  aviationStackBudgetCycle,
  avstackBudgetKey as serverAvstackBudgetKey,
} from '../server/worldmonitor/aviation/v1/_avstack-budget.ts';
import { avstackBudgetKey as seederAvstackBudgetKey } from '../scripts/seed-aviation.mjs';

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
    assert.match(src, /aviationStackBudgetCycle\(\)/);
    // Cache key must NOT vary by limit (was the spend-multiplying explosion).
    assert.doesNotMatch(src, /aviation:flights:\$\{airport\}:\$\{[^}]*\}:\$\{limit\}/);
    // Keyed by LEG, not by the caller's requested direction: three of the four
    // directions issue the same dep_iata query, so keying on direction stored
    // duplicate departure payloads under two extra paid keys.
    assert.match(src, /aviation:flights:\$\{airport\}:\$\{leg\}:v3:\$\{aviationStackBudgetCycle\(\)\}/);
    assert.doesNotMatch(src, /aviation:flights:\$\{airport\}:\$\{direction\}/);
    // Upstream always fetches a fixed page per leg, then slices in memory.
    assert.match(src, /limit:\s*String\(UPSTREAM_PAGE\)/);
    assert.match(src, /flights\.slice\(0, limit\)/);
  });

  it('get-flight-status reserves budget before the upstream call and negative-caches relay errors', () => {
    const src = read('server/worldmonitor/aviation/v1/get-flight-status.ts');
    assert.match(src, /reserveAviationStackCalls\(1, 'request'\)/);
    assert.match(src, /aviation:status:\$\{flightNumber\}:\$\{date\}:\$\{origin\}:v1:\$\{aviationStackBudgetCycle\(\)\}/);
    assert.match(src, /Flight status relay fetch failed/);
    assert.match(src, /unavailableSource = 'error';\n\s+return null;/);
  });

  it('seeder reserves its batch against the same shared counter + key', () => {
    const src = read('scripts/seed-aviation.mjs');
    assert.match(src, /reserveAviationStackBudget\(AVIATIONSTACK_LIST\.length\)/);
    // Same Redis key format as the server helper — they MUST share the counter.
    assert.match(src, /aviation:avstack:calls:\$\{cycle\}/);
  });

  it('server and seeder count against the identical cycle budget key', () => {
    // Drift here splits the shared ceiling into two independent counters and
    // silently doubles AviationStack spend. Run both key builders over the same
    // instants instead of grepping both files for `getUTCMonth()` — which
    // passes even if one side computes a different key from it.
    for (const iso of [
      '2026-01-01T00:00:00Z',
      '2026-08-16T12:34:56Z',
      '2026-12-31T23:59:59Z',
    ]) {
      const at = new Date(iso);
      assert.equal(serverAvstackBudgetKey(at), seederAvstackBudgetKey(at), iso);
    }
  });

  it('rolls the budget key on the billing anniversary, not the calendar month', () => {
    // The bug this replaces: the counter keyed on <YYYY-MM> while AviationStack
    // invoices the 25th → 24th. A calendar key keeps refusing calls into the
    // first days of a fresh allowance AND zeroes itself a week into a cycle
    // that is already partly spent — wrong in both directions.
    for (const key of [serverAvstackBudgetKey, seederAvstackBudgetKey]) {
      // The calendar month turns over here; the cycle must NOT.
      assert.equal(key(new Date('2026-07-31T23:59:59.999Z')), 'aviation:avstack:calls:2026-07-25');
      assert.equal(key(new Date('2026-08-01T00:00:00.000Z')), 'aviation:avstack:calls:2026-07-25');
      // The cycle turns over here; the calendar month does not.
      assert.equal(key(new Date('2026-08-24T23:59:59.999Z')), 'aviation:avstack:calls:2026-07-25');
      assert.equal(key(new Date('2026-08-25T00:00:00.000Z')), 'aviation:avstack:calls:2026-08-25');
    }
  });

  it('rolls on the UTC anniversary, not the local one', () => {
    // A local-time boundary would roll early or late for the deployment region
    // and hand a fresh cycle's quota to the tail of the previous one.
    assert.equal(serverAvstackBudgetKey(new Date('2026-08-24T23:59:59.999Z')), 'aviation:avstack:calls:2026-07-25');
    assert.equal(seederAvstackBudgetKey(new Date('2026-08-24T23:59:59.999Z')), 'aviation:avstack:calls:2026-07-25');
  });

  it('carries a cycle that opened in the previous year back across January', () => {
    // Date.UTC(y, -1, 25) must normalise to the previous December, not throw or
    // clamp — otherwise every January restarts the counter mid-cycle.
    for (const key of [serverAvstackBudgetKey, seederAvstackBudgetKey]) {
      assert.equal(key(new Date('2026-01-24T12:00:00Z')), 'aviation:avstack:calls:2025-12-25');
      assert.equal(key(new Date('2026-01-25T00:00:00Z')), 'aviation:avstack:calls:2026-01-25');
    }
  });

  it('zero-pads single-digit months and days so keys sort chronologically', () => {
    assert.equal(aviationStackBudgetCycle(new Date('2026-09-26T00:00:00Z')), '2026-09-25');
    assert.equal(aviationStackBudgetCycle(new Date('2026-10-01T00:00:00Z')), '2026-09-25');
  });

  it('opens a cycle in February, which an anniversary above 28 would skip', () => {
    // A reset day of 29-31 has no February instant to land on. Both sides clamp
    // to the 25th default rather than silently running a double-length cycle.
    const prior = process.env.AVIATIONSTACK_CYCLE_RESET_DAY;
    process.env.AVIATIONSTACK_CYCLE_RESET_DAY = '31';
    try {
      for (const key of [serverAvstackBudgetKey, seederAvstackBudgetKey]) {
        assert.equal(key(new Date('2026-02-26T00:00:00Z')), 'aviation:avstack:calls:2026-02-25');
      }
    } finally {
      if (prior === undefined) delete process.env.AVIATIONSTACK_CYCLE_RESET_DAY;
      else process.env.AVIATIONSTACK_CYCLE_RESET_DAY = prior;
    }
  });

  it('honours a configured anniversary day on both sides', () => {
    const prior = process.env.AVIATIONSTACK_CYCLE_RESET_DAY;
    process.env.AVIATIONSTACK_CYCLE_RESET_DAY = '5';
    try {
      for (const key of [serverAvstackBudgetKey, seederAvstackBudgetKey]) {
        assert.equal(key(new Date('2026-08-04T23:59:59Z')), 'aviation:avstack:calls:2026-07-05');
        assert.equal(key(new Date('2026-08-05T00:00:00Z')), 'aviation:avstack:calls:2026-08-05');
      }
    } finally {
      if (prior === undefined) delete process.env.AVIATIONSTACK_CYCLE_RESET_DAY;
      else process.env.AVIATIONSTACK_CYCLE_RESET_DAY = prior;
    }
  });

  it('sizes both default ceilings under the 50k plan, with the seeder reserved', () => {
    // The old defaults (130k hard / 85k request) were sized for a 135k plan the
    // account does not have, so the cap never fired. These must stay under the
    // real plan, and the request ceiling must stay well below the hard one or
    // panel traffic starves the curated seeder.
    const src = read('server/worldmonitor/aviation/v1/_avstack-budget.ts');
    const hardCap = Number(/AVIATIONSTACK_MONTHLY_BUDGET', ([\d_]+)\)/.exec(src)?.[1].replace(/_/g, ''));
    const requestCap = Number(/AVIATIONSTACK_REQUEST_BUDGET', ([\d_]+)\)/.exec(src)?.[1].replace(/_/g, ''));
    const seederDefault = Number(
      /AVIATIONSTACK_MONTHLY_BUDGET', ([\d_]+)\)/.exec(read('scripts/seed-aviation.mjs'))?.[1].replace(/_/g, ''),
    );

    assert.ok(hardCap > 0 && hardCap <= 50_000, `hard cap ${hardCap} must sit under the 50,000/cycle plan`);
    assert.equal(seederDefault, hardCap, 'seeder mirror must default to the same hard cap');
    assert.ok(requestCap < hardCap, `request ceiling ${requestCap} must leave the seeder headroom under ${hardCap}`);
    // 56 airports x 24 sweeps x 30d — what the seeder structurally needs.
    assert.ok(
      hardCap - requestCap >= 40_320,
      `only ${hardCap - requestCap} reserved for the seeder, which needs ~40,320/cycle`,
    );
  });

  it('request cache keys carry the budget cycle so denials expire at rollover', () => {
    assert.match(read('server/worldmonitor/aviation/v1/list-airport-flights.ts'), /aviationStackBudgetCycle\(\)/);
    assert.match(read('server/worldmonitor/aviation/v1/get-flight-status.ts'), /aviationStackBudgetCycle\(\)/);
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
