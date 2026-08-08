// market_implications producer-failure health contract.
//
// The tail LLM stage is allowed to miss. Observed production window: five
// hourly attempts produced three five-card publications and two provider
// timeouts — a ~60% hit rate against a panel whose cards stay useful for
// hours. The original failure writer treated EVERY miss as a producer outage:
// it wrote `{recordCount: 0, status: 'error', fetchedAt: now}`, which
// api/health.js promotes straight to SEED_ERROR. So a single transient
// timeout turned health red while the canonical key still served five valid
// cards, and — because the error write also RESET the freshness clock — a
// chronic outage could never age past that same warn into STALE_SEED.
//
// The contract asserted here: a miss with usable last-good is a BOUNDED
// degraded state (streak recorded, content clock held at the served vintage),
// and it escalates on the second consecutive miss or once the served cards
// age past the staleness budget. A miss with nothing to serve is still an
// immediate error.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAndSeedMarketImplications,
  buildMarketImplicationsFailureMeta,
  buildMarketImplicationsFingerprint,
  MARKET_IMPLICATIONS_FAILURE_CODES,
  MARKET_IMPLICATIONS_UNKNOWN_FAILURE_CODE,
  __setRedisStoreForTests,
  __setForecastLlmTransportForTests,
  __setForecastLlmRunDeadlineForTests,
  __setForecastLlmCallOverrideForTests,
} from '../scripts/seed-forecasts.mjs';
import { __testing__ as healthTesting } from '../api/health.js';

const here = dirname(fileURLToPath(import.meta.url));
const seederSource = readFileSync(resolve(here, '../scripts/seed-forecasts.mjs'), 'utf8');

const META_KEY = 'seed-meta:intelligence:market-implications';
const CARDS_KEY = 'intelligence:market-implications:v1';

const ENV_KEYS = [
  'OPENROUTER_API_KEY', 'GROQ_API_KEY',
  'FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER', 'FORECAST_LLM_PROVIDER_ORDER',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  __setRedisStoreForTests(null);
  __setForecastLlmTransportForTests(null);
  __setForecastLlmRunDeadlineForTests(null);
  __setForecastLlmCallOverrideForTests(null);
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

// The production shape at the time of the report: five cards published 94
// minutes ago (inside the 120-minute staleness budget), then a timeout.
const SERVED_GENERATED_AT = '2026-08-05T17:02:30.133Z';
const SERVED_MS = Date.parse(SERVED_GENERATED_AT);
const SERVED_CARDS = ['LMT', 'RTX', 'XLE', 'GLD', 'USO'].map((ticker) => ({
  ticker, name: ticker, direction: 'LONG', timeframe: '3M', confidence: 'MEDIUM',
  title: `${ticker} thesis`, narrative: 'Sustained procurement lifts the backlog across primes.',
  risk_caveat: '', driver: '', transmission_chain: [],
}));

function seedLastGood(store, metaOver = {}) {
  store[CARDS_KEY] = { cards: SERVED_CARDS, generatedAt: SERVED_GENERATED_AT, model: 'deepseek/deepseek-v4-flash' };
  store[META_KEY] = {
    fetchedAt: SERVED_MS,
    recordCount: SERVED_CARDS.length,
    status: 'ok',
    lastAttemptAt: SERVED_MS,
    lastSuccessAt: SERVED_MS,
    servedGeneratedAt: SERVED_GENERATED_AT,
    consecutiveFailures: 0,
    ...metaOver,
  };
}

// Captures the EXPIRE/SET traffic redisCommand sends over real fetch.
function captureRedisCommands() {
  const commands = [];
  global.fetch = async (_url, init = {}) => {
    commands.push(JSON.parse(String(init.body || '[]')));
    return { ok: true, status: 200, json: async () => ({ result: 1 }), text: async () => '' };
  };
  return commands;
}

// A real provider timeout — the exact production failure mode behind
// errorReason 'llm_no_response'. Pinned to a single provider with a run
// deadline that admits the resolved chain, so the call is genuinely attempted.
function armTimingOutProvider() {
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER = 'openrouter';
  __setForecastLlmRunDeadlineForTests(Date.now() + 60_000);
  const calls = { count: 0 };
  __setForecastLlmTransportForTests({
    fetch: async () => {
      calls.count += 1;
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    },
  });
  return calls;
}

test('a single provider timeout over fresh last-good stays green and records the streak', async () => {
  const store = {};
  __setRedisStoreForTests(store);
  seedLastGood(store);
  const providerCalls = armTimingOutProvider();
  const commands = captureRedisCommands();

  const before = Date.now();
  await buildAndSeedMarketImplications({});
  const after = Date.now();

  assert.equal(providerCalls.count, 1, 'the timeout must come from a real attempted provider call');
  const meta = store[META_KEY];
  assert.equal(meta.status, 'ok', 'one transient miss over five served cards is not a producer outage');
  assert.equal(meta.recordCount, SERVED_CARDS.length, 'recordCount must describe what is SERVED, not the failed attempt');
  assert.equal(meta.fetchedAt, SERVED_MS, 'the content clock must hold at the served vintage — advancing it on a failure makes STALE_SEED unreachable');
  assert.equal(meta.consecutiveFailures, 1, 'the miss is recorded, not swallowed');
  assert.equal(meta.lastSuccessAt, SERVED_MS);
  assert.equal(meta.servedGeneratedAt, SERVED_GENERATED_AT);
  assert.equal(meta.lastSynthesisFailureCode, 'MARKET_IMPLICATIONS_LLM_NO_RESPONSE');
  assert.ok(meta.lastAttemptAt >= before && meta.lastAttemptAt <= after, 'lastAttemptAt marks THIS attempt');
  assert.deepEqual(store[CARDS_KEY].cards, SERVED_CARDS, 'last-good cards are untouched');
  assert.ok(
    commands.some((c) => c[0] === 'EXPIRE' && c[1] === CARDS_KEY),
    'the canonical key TTL is still refreshed so the served cards survive the outage',
  );
  assert.ok(
    !Object.keys(store).some((k) => k.startsWith('forecast:llm-market-implications:')),
    'a failed attempt must never pin a stage-cache entry',
  );
});

test('a second consecutive timeout increments the streak past the warn threshold', async () => {
  const store = {};
  __setRedisStoreForTests(store);
  seedLastGood(store, { consecutiveFailures: 1, lastSynthesisFailureCode: 'MARKET_IMPLICATIONS_LLM_NO_RESPONSE' });
  armTimingOutProvider();
  captureRedisCommands();

  await buildAndSeedMarketImplications({});

  const meta = store[META_KEY];
  assert.equal(meta.consecutiveFailures, 2, 'consecutive misses accumulate — this is what escalates health to SEED_ERROR');
  assert.equal(meta.fetchedAt, SERVED_MS, 'the content clock still holds at the served vintage');
  assert.equal(meta.lastSuccessAt, SERVED_MS, 'the last real publish is preserved across the streak');
});

test('the streak is capped so a long outage cannot grow the field unbounded', async () => {
  const store = {};
  __setRedisStoreForTests(store);
  seedLastGood(store, { consecutiveFailures: 100 });
  armTimingOutProvider();
  captureRedisCommands();

  await buildAndSeedMarketImplications({});

  assert.equal(store[META_KEY].consecutiveFailures, 100, 'the counter saturates rather than growing forever');
});

test('a live publish after a streak clears it', async () => {
  const store = {};
  __setRedisStoreForTests(store);
  seedLastGood(store, { consecutiveFailures: 3, lastSynthesisFailureCode: 'MARKET_IMPLICATIONS_LLM_NO_RESPONSE' });
  captureRedisCommands();
  __setForecastLlmRunDeadlineForTests(Date.now() + 60_000);
  __setForecastLlmCallOverrideForTests(() => ({
    text: JSON.stringify([{
      ticker: 'LMT', name: 'Lockheed Martin', direction: 'long', timeframe: '3M', confidence: 'high',
      title: 'Defense demand', narrative: 'Sustained procurement lifts the backlog across primes.',
    }]),
    model: 'recovered-model',
  }));

  const before = Date.now();
  await buildAndSeedMarketImplications({});

  const meta = store[META_KEY];
  assert.equal(meta.status, 'ok');
  assert.equal(meta.recordCount, 1);
  assert.equal(meta.consecutiveFailures, 0, 'a success MUST zero the streak, else health warns forever after recovery');
  assert.equal(meta.lastSynthesisFailureCode, null, 'the stale failure code must not outlive the failure');
  assert.ok(meta.lastSuccessAt >= before, 'lastSuccessAt advances on a real publish');
  assert.ok(meta.fetchedAt >= before, 'a real publish DOES advance the content clock');
  assert.equal(meta.servedGeneratedAt, store[CARDS_KEY].generatedAt);
});

test('a cache-hit republish after a streak clears it too', async () => {
  const store = {};
  __setRedisStoreForTests(store);
  seedLastGood(store, { consecutiveFailures: 2, lastSynthesisFailureCode: 'MARKET_IMPLICATIONS_LLM_NO_RESPONSE' });
  // Empty inputs make buildMarketImplicationsContext return this literal.
  const fingerprint = buildMarketImplicationsFingerprint('No live world state available.');
  store[`forecast:llm-market-implications:v2:${fingerprint}`] = { cards: SERVED_CARDS, model: 'cached-model' };
  global.fetch = async (url) => { throw new Error(`unexpected fetch on cache hit: ${url}`); };

  await buildAndSeedMarketImplications({});

  const meta = store[META_KEY];
  assert.equal(meta.status, 'ok');
  assert.equal(meta.consecutiveFailures, 0, 'the republish path writes meta too — it must reset the streak as well');
  assert.equal(meta.lastSynthesisFailureCode, null);
  assert.equal(meta.recordCount, SERVED_CARDS.length);
});

test('a timeout with NO servable cards still writes an immediate error', async () => {
  const store = {};
  __setRedisStoreForTests(store);
  // No canonical payload at all — nothing is being served, so the panel is
  // genuinely broken and the operator must be told now, not in two hours.
  armTimingOutProvider();
  captureRedisCommands();

  await buildAndSeedMarketImplications({});

  const meta = store[META_KEY];
  assert.equal(meta.status, 'error', 'with nothing to serve, degrading would hide a real outage');
  assert.equal(meta.recordCount, 0);
  assert.equal(meta.errorReason, 'llm_no_response');
});

test('an empty-card last-good payload counts as nothing to serve', async () => {
  const store = {};
  __setRedisStoreForTests(store);
  store[CARDS_KEY] = { cards: [], generatedAt: SERVED_GENERATED_AT, model: 'm' };
  store[META_KEY] = { fetchedAt: SERVED_MS, recordCount: 0, status: 'ok' };
  armTimingOutProvider();
  captureRedisCommands();

  await buildAndSeedMarketImplications({});

  assert.equal(store[META_KEY].status, 'error', 'an empty cards array is not last-good data');
});

test('an unreadable last-good payload fails closed to error', async () => {
  const store = {};
  __setRedisStoreForTests(store);
  seedLastGood(store);
  // A payload whose generatedAt cannot be parsed gives no trustworthy content
  // clock; holding fetchedAt on a guess would silently freeze the age gate.
  store[CARDS_KEY] = { cards: SERVED_CARDS, generatedAt: 'not-a-date', model: 'm' };
  armTimingOutProvider();
  captureRedisCommands();

  await buildAndSeedMarketImplications({});

  assert.equal(store[META_KEY].status, 'error', 'an unusable content clock must fail closed, not degrade silently');
});

test('every LLM-failure guard routes through the same degrade-or-error writer', async () => {
  // Guards 2 and 3 (unparseable response, all cards rejected) are reached only
  // through a successful completion, so they are driven here rather than
  // asserted as source text.
  for (const [label, text, code] of [
    ['no_parseable_cards', 'the model apologised instead of answering', 'MARKET_IMPLICATIONS_NO_PARSEABLE_CARDS'],
    ['all_cards_failed_validation', JSON.stringify([{ ticker: 'NOT_A_TICKER', direction: 'sideways' }]), 'MARKET_IMPLICATIONS_VALIDATION'],
  ]) {
    const store = {};
    __setRedisStoreForTests(store);
    seedLastGood(store);
    captureRedisCommands();
    __setForecastLlmRunDeadlineForTests(Date.now() + 60_000);
    __setForecastLlmCallOverrideForTests(() => ({ text, model: 'm' }));

    await buildAndSeedMarketImplications({});

    const meta = store[META_KEY];
    assert.equal(meta.status, 'ok', `${label}: fresh last-good must survive this guard too`);
    assert.equal(meta.consecutiveFailures, 1, `${label}: the miss is recorded`);
    assert.equal(meta.lastSynthesisFailureCode, code, `${label}: the reason reaches health`);
    __setForecastLlmCallOverrideForTests(null);
    __setRedisStoreForTests(null);
  }
});

// ── an unreadable streak is not a cleared streak ────────────────────────────
// These run against the real HTTP path (no store shim) because the defect
// lives in the transport: redisGet returns null for BOTH "key absent" and
// "read failed" — a non-ok response never throws. The failure writer DERIVES
// the streak from absence, so a plain redisGet would read a transient Upstash
// 5xx as "no misses recorded" and quietly restart the count, suppressing the
// escalation exactly when Redis is unhealthy too.

function armFailingRedisRead(failingKey, previousMeta, { fault = 'http-500' } = {}) {
  process.env.UPSTASH_REDIS_REST_URL = 'http://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const writes = [];
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const ok = (result) => ({ ok: true, status: 200, json: async () => ({ result }), text: async () => '' });
    // Reads arrive either as GET /get/<key> (redisGet) or as a POST ['GET', key]
    // (redisCommand); handle both so this test cannot pass by transport shape.
    const key = url.includes('/get/')
      ? decodeURIComponent(url.split('/get/')[1])
      : (body?.[0] === 'GET' ? body[1] : null);
    if (key === failingKey) {
      // 'corrupt' is the quieter fault: HTTP 200 carrying a body that will not
      // parse. It must fail closed exactly like a 5xx rather than reading as
      // an empty key.
      if (fault === 'missing-result') {
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
      }
      return fault === 'corrupt'
        ? ok('{"cards": [truncated mid-write')
        : { ok: false, status: 500, json: async () => ({}), text: async () => 'upstash 500' };
    }
    if (key === META_KEY) return ok(JSON.stringify(previousMeta));
    if (key === CARDS_KEY) return ok(JSON.stringify({ cards: SERVED_CARDS, generatedAt: SERVED_GENERATED_AT, model: 'm' }));
    if (key) return ok(null); // stage-cache lookup
    if (body?.[0] === 'SET') { writes.push({ key: body[1], value: JSON.parse(body[2]) }); return ok('OK'); }
    return ok(1); // EXPIRE and friends
  };
  __setForecastLlmRunDeadlineForTests(Date.now() + 60_000);
  __setForecastLlmCallOverrideForTests(() => ({ text: '', model: '', provider: '', failureReason: 'provider_failed' }));
  return writes;
}

test('an unreadable previous meta fails closed instead of restarting the streak', async () => {
  const writes = armFailingRedisRead(META_KEY, {
    fetchedAt: SERVED_MS, recordCount: 5, status: 'ok',
    lastSuccessAt: SERVED_MS, consecutiveFailures: 4,
  });

  await buildAndSeedMarketImplications({});

  const metaWrite = writes.find((w) => w.key === META_KEY);
  assert.ok(metaWrite, 'the failure writer must still record something');
  assert.equal(metaWrite.value.status, 'error', 'a streak we cannot read is not a streak we may clear');
  assert.notEqual(metaWrite.value.consecutiveFailures, 1, 'silently restarting at 1 would erase four recorded misses');
});

test('an HTTP 200 Redis response missing result fails closed', async () => {
  const writes = armFailingRedisRead(META_KEY, {
    fetchedAt: SERVED_MS, recordCount: 5, status: 'ok', consecutiveFailures: 4,
  }, { fault: 'missing-result' });

  await buildAndSeedMarketImplications({});

  const metaWrite = writes.find((w) => w.key === META_KEY);
  assert.ok(metaWrite, 'the failure writer must still record an error meta');
  assert.equal(metaWrite.value.status, 'error', 'missing result is not proof of a Redis miss');
  assert.equal(metaWrite.value.recordCount, 0, 'an unreadable response must not justify retained cards');
});

test('a corrupt meta body fails closed rather than reading as an empty key', async () => {
  const writes = armFailingRedisRead(
    META_KEY,
    { fetchedAt: SERVED_MS, recordCount: 5, status: 'ok', consecutiveFailures: 4 },
    { fault: 'corrupt' },
  );

  await buildAndSeedMarketImplications({});

  const metaWrite = writes.find((w) => w.key === META_KEY);
  assert.ok(metaWrite);
  assert.equal(metaWrite.value.status, 'error', 'a 200 carrying garbage is still not proof the streak is zero');
  assert.notEqual(metaWrite.value.consecutiveFailures, 1);
});

test('an unreadable last-good payload fails closed too', async () => {
  const writes = armFailingRedisRead(CARDS_KEY, {
    fetchedAt: SERVED_MS, recordCount: 5, status: 'ok', consecutiveFailures: 4,
  });

  await buildAndSeedMarketImplications({});

  const metaWrite = writes.find((w) => w.key === META_KEY);
  assert.ok(metaWrite);
  assert.equal(metaWrite.value.status, 'error', 'cards we cannot read cannot justify softening the alarm');
});

test('a semantically malformed last-good card payload fails closed', () => {
  const meta = buildMarketImplicationsFailureMeta({
    previousMeta: { fetchedAt: SERVED_MS, recordCount: 5, status: 'ok' },
    lastGoodPayload: {
      cards: [{ ticker: 'NOT A TICKER', direction: 'LONG', timeframe: '1M', confidence: 'HIGH', title: 'A valid-looking title', narrative: 'This narrative is long enough to pass its minimum length.' }],
      generatedAt: SERVED_GENERATED_AT,
    },
    reason: 'llm_no_response',
    nowMs: SERVED_MS + 60_000,
  });

  assert.equal(meta.status, 'error', 'a non-card entry must not be retained as last-good data');
  assert.equal(meta.recordCount, 0);
});

test('a future-dated last-good payload fails closed beyond the clock-skew allowance', () => {
  const nowMs = SERVED_MS + 60 * 60 * 1000;
  const futureGeneratedAt = new Date(nowMs + 5 * 60 * 1000 + 1).toISOString();
  const meta = buildMarketImplicationsFailureMeta({
    previousMeta: { fetchedAt: SERVED_MS, recordCount: 5, status: 'ok' },
    lastGoodPayload: { cards: SERVED_CARDS, generatedAt: futureGeneratedAt },
    reason: 'llm_no_response',
    nowMs,
  });

  assert.equal(meta.status, 'error', 'a future content clock must not pin the retained-data age gate');
  assert.equal(meta.recordCount, 0);

  const withinSkew = buildMarketImplicationsFailureMeta({
    previousMeta: { fetchedAt: SERVED_MS, recordCount: 5, status: 'ok' },
    lastGoodPayload: { cards: SERVED_CARDS, generatedAt: new Date(nowMs + 2 * 60 * 1000).toISOString() },
    reason: 'llm_no_response',
    nowMs,
  });
  assert.equal(withinSkew.status, 'ok', 'a small explicit clock skew remains retainable');
});

test('a valid dynamic live-ticker card remains retainable without a ticker read', () => {
  const meta = buildMarketImplicationsFailureMeta({
    previousMeta: { fetchedAt: SERVED_MS, recordCount: 1, status: 'ok' },
    lastGoodPayload: { cards: [{ ...SERVED_CARDS[0], ticker: 'NFLX' }], generatedAt: SERVED_GENERATED_AT },
    reason: 'llm_no_response',
    nowMs: SERVED_MS + 60_000,
  });

  assert.equal(meta.status, 'ok', 'valid runtime-added equity symbols must survive a provider miss');
  assert.equal(meta.recordCount, 1);
});

// ── the decision itself, exercised directly ─────────────────────────────────
// Cases the three live call sites cannot reach: an unmapped reason, and the
// pre-contract meta shape that exists in Redis right now.

test('an unmapped failure reason normalizes rather than emitting a raw string', () => {
  const meta = buildMarketImplicationsFailureMeta({
    previousMeta: { fetchedAt: SERVED_MS, recordCount: 5, status: 'ok' },
    lastGoodPayload: { cards: SERVED_CARDS, generatedAt: SERVED_GENERATED_AT },
    reason: 'something nobody mapped yet',
    nowMs: SERVED_MS + 60_000,
  });

  assert.equal(meta.lastSynthesisFailureCode, 'MARKET_IMPLICATIONS_UNKNOWN', 'health validates a closed vocabulary — an unmapped reason must land inside it, not be dropped');
  assert.equal(meta.consecutiveFailures, 1, 'and the miss still counts');
});

test('a pre-contract error meta counts as the miss it recorded', () => {
  // The meta shape in Redis today is `{recordCount:0, status:'error'}` with no
  // streak field. It is still the record of a real miss, so the first
  // post-deploy failure is the SECOND consecutive one — counting it as the
  // first would undercount across the deploy boundary and delay escalation by
  // a full cron tick. lastSuccessAt is derived from the served payload so the
  // same legacy meta does not read as a producer that never succeeded.
  const meta = buildMarketImplicationsFailureMeta({
    previousMeta: { fetchedAt: Date.now(), recordCount: 0, status: 'error', errorReason: 'llm_no_response' },
    lastGoodPayload: { cards: SERVED_CARDS, generatedAt: SERVED_GENERATED_AT },
    reason: 'llm_no_response',
    nowMs: SERVED_MS + 60_000,
  });

  assert.equal(meta.status, 'ok');
  assert.equal(meta.lastSuccessAt, SERVED_MS, 'the served payload is itself the proof of an earlier publish');
  assert.equal(meta.consecutiveFailures, 2, 'the legacy error meta IS a recorded prior miss');
});

test('a corrupt streak value cannot poison the counter', () => {
  for (const poison of [-5, 1.5, '3', Number.NaN, null]) {
    const meta = buildMarketImplicationsFailureMeta({
      previousMeta: { consecutiveFailures: poison, lastSuccessAt: SERVED_MS },
      lastGoodPayload: { cards: SERVED_CARDS, generatedAt: SERVED_GENERATED_AT },
      reason: 'llm_no_response',
      nowMs: SERVED_MS + 60_000,
    });
    assert.equal(meta.consecutiveFailures, 1, `previous streak ${String(poison)} must reset to a clean count`);
  }
});

test('every code the seeder can emit is one /api/health will accept', () => {
  // The producer's vocabulary and health's validation pattern live in
  // different files and different deploy targets. Health DROPS a code that
  // fails its pattern, so drift is silent — the streak would still escalate
  // but the operator would lose the reason. Assert the coupling instead of
  // documenting it: this reads both real definitions, so adding a code on one
  // side without the other turns this red.
  const { failureCodePattern } = healthTesting.SEED_META.marketImplications.synthesisFailure;
  const emittable = [...Object.values(MARKET_IMPLICATIONS_FAILURE_CODES), MARKET_IMPLICATIONS_UNKNOWN_FAILURE_CODE];
  assert.ok(emittable.length >= 4, 'guard against an accidentally empty vocabulary making this vacuous');
  for (const code of emittable) {
    assert.ok(failureCodePattern.test(code), `health would silently drop the seeder's ${code}`);
  }
});

test('a failure, a recovery, and a fresh failure keep the streak honest across runs', () => {
  // Each single-run test pins one transition. This walks the sequence the
  // hourly cron actually produces, so a reset that only works on a fixture
  // shaped by hand cannot pass.
  const payload = { cards: SERVED_CARDS, generatedAt: SERVED_GENERATED_AT };
  const first = buildMarketImplicationsFailureMeta({
    previousMeta: { fetchedAt: SERVED_MS, recordCount: 5, status: 'ok', consecutiveFailures: 0, lastSuccessAt: SERVED_MS },
    lastGoodPayload: payload, reason: 'llm_no_response', nowMs: SERVED_MS + 3_600_000,
  });
  assert.equal(first.consecutiveFailures, 1);

  const second = buildMarketImplicationsFailureMeta({
    previousMeta: first, lastGoodPayload: payload, reason: 'llm_no_response', nowMs: SERVED_MS + 7_200_000,
  });
  assert.equal(second.consecutiveFailures, 2, 'the streak accumulates off its own prior output, not just a hand-built fixture');

  // A real publish lands: the seeder writes success meta, which must clear it.
  const recovered = { fetchedAt: SERVED_MS + 10_800_000, recordCount: 3, status: 'ok', lastAttemptAt: SERVED_MS + 10_800_000, lastSuccessAt: SERVED_MS + 10_800_000, consecutiveFailures: 0, lastSynthesisFailureCode: null };
  const third = buildMarketImplicationsFailureMeta({
    previousMeta: recovered, lastGoodPayload: payload, reason: 'llm_no_response', nowMs: SERVED_MS + 14_400_000,
  });
  assert.equal(third.consecutiveFailures, 1, 'a recovery resets the count — the next miss starts over, it does not resume at 3');
  assert.equal(third.lastSuccessAt, SERVED_MS + 10_800_000, 'and the recovery timestamp survives the next miss');
});

test('market_implications runs before the best-effort R2 trace export (#4978 tail-stage budget)', () => {
  const startIndex = seederSource.indexOf('afterPublish: async (data, meta)');
  assert.notEqual(startIndex, -1, 'missing source marker: afterPublish');
  const endIndex = seederSource.indexOf('extraKeys: FORECAST_EXTRA_KEYS', startIndex);
  assert.notEqual(endIndex, -1, 'missing source marker: extraKeys');
  const afterPublish = seederSource.slice(startIndex, endIndex);
  const miIndex = afterPublish.indexOf('await buildAndSeedMarketImplications(');
  const traceIndex = afterPublish.indexOf('[Trace] Starting R2 export');
  assert.notEqual(miIndex, -1, 'market_implications must be invoked in afterPublish');
  assert.notEqual(traceIndex, -1, 'the R2 trace export marker must exist in afterPublish');
  // The tail LLM stage shares the 150s run budget; it must run BEFORE the ~20s
  // trace export so best-effort telemetry cannot push it past the run deadline.
  assert.ok(
    miIndex < traceIndex,
    'market_implications must run BEFORE the R2 trace export (#4978), else telemetry wall-clock starves the tail LLM stage',
  );
});
