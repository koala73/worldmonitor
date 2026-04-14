// Regression test for comtrade seeders' 5xx retry behavior.
// See Railway log 2026-04-14 bilateral-hs4: India (699) hit HTTP 503 on both
// batches with no retry → dropped silently from the snapshot. This test pins
// the retry contract.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { isTransientComtrade, fetchBilateral } from '../scripts/seed-comtrade-bilateral-hs4.mjs';

const ORIGINAL_FETCH = globalThis.fetch;

let fetchCalls;
let fetchResponses; // queue of { status, body } per call

beforeEach(() => {
  fetchCalls = [];
  fetchResponses = [];
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push(String(url));
    const next = fetchResponses.shift() ?? { status: 200, body: { data: [] } };
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
  };
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
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
    { status: 200, body: { data: [{ cmdCode: '2709', partnerCode: '000', primaryValue: 999, period: 2024 }] } },
  ];
  const result = await fetchBilateral('699', ['2709']);
  assert.equal(fetchCalls.length, 3, 'initial + two retries');
  assert.equal(result.length, 1);
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
});

test('fetchBilateral: does NOT retry on 4xx (non-transient)', async () => {
  fetchResponses = [{ status: 403, body: {} }];
  const result = await fetchBilateral('699', ['2709']);
  assert.equal(fetchCalls.length, 1, 'no retry on client error');
  assert.deepEqual(result, []);
});
