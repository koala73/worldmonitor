// Regression test for comtrade seeders' 5xx retry behavior.
// See Railway log 2026-04-14 bilateral-hs4: India (699) hit HTTP 503 on both
// batches with no retry → dropped silently from the snapshot. This test pins
// the retry contract.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { isTransientComtrade, fetchBilateral, __setSleepForTests } from '../scripts/seed-comtrade-bilateral-hs4.mjs';
import { fetchFlows, __setSleepForTests as __setFlowsSleep } from '../scripts/seed-trade-flows.mjs';
import { fetchImportsForReporter, __setSleepForTests as __setHhiSleep } from '../scripts/seed-recovery-import-hhi.mjs';

const ORIGINAL_FETCH = globalThis.fetch;

let fetchCalls;
let fetchResponses; // queue of { status, body } per call
let sleepCalls;

beforeEach(() => {
  fetchCalls = [];
  fetchResponses = [];
  sleepCalls = [];
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    const next = fetchResponses.shift() ?? { status: 200, body: { data: [] } };
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
  };
  // Swap the retry sleep for a no-op that records the requested delay across
  // all three seeders so tests can assert the production backoff cadence
  // without actually waiting.
  const stub = (ms) => { sleepCalls.push(ms); return Promise.resolve(); };
  __setSleepForTests(stub);
  __setFlowsSleep(stub);
  __setHhiSleep(stub);
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  __setSleepForTests(null);
  __setFlowsSleep(null);
  __setHhiSleep(null);
});

test('isTransientComtrade: recognizes 500/502/503/504 only', () => {
  for (const s of [500, 502, 503, 504]) {
    assert.equal(isTransientComtrade(s), true, `${s} should be transient`);
  }
  for (const s of [200, 400, 401, 403, 404, 429, 418, 499, 505]) {
    assert.equal(isTransientComtrade(s), false, `${s} should NOT be transient`);
  }
});

test('fetchBilateral: succeeds on first attempt with 200', async () => {
  fetchResponses = [
    { status: 200, body: { data: [{ cmdCode: '2709', partnerCode: '156', primaryValue: 1000, period: 2024 }] } },
  ];
  const result = await fetchBilateral('699', ['2709']);
  assert.equal(fetchCalls.length, 1, 'one fetch, no retries');
  assert.equal(result.length, 1);
  assert.equal(result[0].cmdCode, '2709');
});

test('fetchBilateral: retries once after a single 503, succeeds on second attempt', async () => {
  fetchResponses = [
    { status: 503, body: {} },
    { status: 200, body: { data: [{ cmdCode: '2709', partnerCode: '156', primaryValue: 500, period: 2024 }] } },
  ];
  const result = await fetchBilateral('699', ['2709']);
  assert.equal(fetchCalls.length, 2, 'one initial + one retry');
  assert.equal(result.length, 1, 'data recovered on retry');
});

test('fetchBilateral: retries twice on consecutive 503s, succeeds on third', async () => {
  fetchResponses = [
    { status: 503, body: {} },
    { status: 503, body: {} },
    // Real partner code (China=156), NOT '000': groupByProduct() downstream
    // filters 0/000 partners, so a test asserting "data recovered" with '000'
    // would pass here while the user-visible seeder would still drop the row.
    { status: 200, body: { data: [{ cmdCode: '2709', partnerCode: '156', primaryValue: 999, period: 2024 }] } },
  ];
  const result = await fetchBilateral('699', ['2709']);
  assert.equal(fetchCalls.length, 3, 'initial + two retries');
  assert.equal(result.length, 1);
  assert.deepEqual(sleepCalls, [5_000, 15_000]);
});

test('fetchBilateral: gives up (returns []) after 3 consecutive 5xx', async () => {
  fetchResponses = [
    { status: 503, body: {} },
    { status: 502, body: {} },
    { status: 500, body: {} },
  ];
  const result = await fetchBilateral('699', ['2709']);
  assert.equal(fetchCalls.length, 3, 'caps at 3 attempts');
  assert.deepEqual(result, [], 'empty array after exhausting retries — caller can skip write');
  assert.deepEqual(sleepCalls, [5_000, 15_000], 'no sleep after final attempt');
});

test('fetchBilateral: does NOT retry on 4xx (non-transient)', async () => {
  fetchResponses = [{ status: 403, body: {} }];
  const result = await fetchBilateral('699', ['2709']);
  assert.equal(fetchCalls.length, 1, 'no retry on client error');
  assert.deepEqual(result, []);
});

test('fetchBilateral: 429 then 503 still consumes the 5xx retries (regression for PR review)', async () => {
  // Previously the 429 branch would return immediately if its retry came back
  // 5xx, bypassing the bounded transient retries. Now the classification loop
  // reclassifies each response: 429 waits → retry hits 503 → 5s backoff → 15s
  // backoff → 200 success.
  fetchResponses = [
    { status: 429, body: {} },
    { status: 503, body: {} },
    { status: 502, body: {} },
    { status: 200, body: { data: [{ cmdCode: '2709', partnerCode: '156', primaryValue: 42, period: 2024 }] } },
  ];
  const result = await fetchBilateral('699', ['2709']);
  assert.equal(fetchCalls.length, 4, '1 initial 429 + 1 post-429 retry + 2 transient-5xx retries');
  assert.equal(result.length, 1, 'recovered after mixed 429+5xx sequence');
  // Pin the production backoff cadence so a future refactor that changes
  // these numbers has to update the test too.
  assert.deepEqual(sleepCalls, [60_000, 5_000, 15_000], '60s 429 wait, then 5s and 15s transient backoffs');
});

test('fetchBilateral: 429 once → 429 again does NOT re-wait 60s (one 429 cap)', async () => {
  fetchResponses = [
    { status: 429, body: {} },
    { status: 429, body: {} },
  ];
  const result = await fetchBilateral('699', ['2709']);
  assert.equal(fetchCalls.length, 2, 'cap 429 retries at one wait');
  assert.deepEqual(result, []);
  assert.deepEqual(sleepCalls, [60_000], 'only one 60s wait, no second 429 backoff');
});

// -----------------------------------------------------------------------------
// seed-trade-flows.mjs — fetchFlows
// -----------------------------------------------------------------------------

test('fetchFlows: succeeds on first 200', async () => {
  fetchResponses = [{ status: 200, body: { data: [{ period: 2024, flowCode: 'M', primaryValue: 100, partnerCode: '156' }] } }];
  const result = await fetchFlows({ code: '699', name: 'India' }, { code: '2709', desc: 'Crude' });
  assert.equal(fetchCalls.length, 1);
  assert.ok(result.length >= 1, 'returns aggregated flows');
  assert.deepEqual(sleepCalls, []);
});

test('fetchFlows: retries twice on 503s, succeeds on third', async () => {
  fetchResponses = [
    { status: 503, body: {} },
    { status: 502, body: {} },
    { status: 200, body: { data: [{ period: 2024, flowCode: 'X', primaryValue: 500, partnerCode: '156' }] } },
  ];
  const result = await fetchFlows({ code: '699', name: 'India' }, { code: '2709', desc: 'Crude' });
  assert.equal(fetchCalls.length, 3);
  assert.ok(result.length >= 1, 'recovered after transient 5xx');
  assert.deepEqual(sleepCalls, [5_000, 15_000]);
});

test('fetchFlows: throws after 3 consecutive 5xx (caller catches via allSettled)', async () => {
  fetchResponses = [{ status: 503 }, { status: 502 }, { status: 500 }];
  await assert.rejects(
    () => fetchFlows({ code: '699', name: 'India' }, { code: '2709', desc: 'Crude' }),
    /HTTP 500/,
  );
  assert.equal(fetchCalls.length, 3, 'caps at 3 attempts');
  assert.deepEqual(sleepCalls, [5_000, 15_000]);
});

// -----------------------------------------------------------------------------
// seed-recovery-import-hhi.mjs — fetchImportsForReporter
// -----------------------------------------------------------------------------

test('fetchImportsForReporter: succeeds on first 200', async () => {
  fetchResponses = [{ status: 200, body: { data: [{ period: 2024, primaryValue: 1_000_000, partnerCode: '156' }] } }];
  const { records, status } = await fetchImportsForReporter('699', 'fake-key');
  assert.equal(fetchCalls.length, 1);
  assert.equal(status, 200);
  assert.ok(records.length >= 0);
  assert.deepEqual(sleepCalls, []);
});

test('fetchImportsForReporter: retries twice on 503s, succeeds on third', async () => {
  fetchResponses = [
    { status: 503, body: {} },
    { status: 503, body: {} },
    { status: 200, body: { data: [{ period: 2024, primaryValue: 999, partnerCode: '156' }] } },
  ];
  const { records, status } = await fetchImportsForReporter('699', 'fake-key');
  assert.equal(fetchCalls.length, 3);
  assert.equal(status, 200);
  assert.ok(records.length >= 0);
  assert.deepEqual(sleepCalls, [5_000, 10_000], 'import-hhi uses 10s not 15s for second retry (tighter bundle budget)');
});

test('fetchImportsForReporter: 429 then 503 still consumes the 5xx retries', async () => {
  fetchResponses = [
    { status: 429, body: {} },
    { status: 503, body: {} },
    { status: 502, body: {} },
    { status: 200, body: { data: [{ period: 2024, primaryValue: 42, partnerCode: '156' }] } },
  ];
  const { records, status } = await fetchImportsForReporter('699', 'fake-key');
  assert.equal(fetchCalls.length, 4, 'classification loop: 429 + 3 transient 5xx attempts (of which 2 retried)');
  assert.equal(status, 200);
  assert.ok(records.length >= 0);
  assert.deepEqual(sleepCalls, [15_000, 5_000, 10_000], '15s 429 + 5s/10s transient backoffs');
});

test('fetchImportsForReporter: gives up ({records:[], status:503}) after 3 consecutive 5xx', async () => {
  fetchResponses = [{ status: 503 }, { status: 502 }, { status: 500 }];
  const { records, status } = await fetchImportsForReporter('699', 'fake-key');
  assert.deepEqual(records, []);
  assert.equal(status, 500, 'returns the final upstream status so caller can log it');
  assert.equal(fetchCalls.length, 3);
});
