// A chokepoint that ArcGIS fails to return keeps its previous entry instead of
// vanishing from supply_chain:portwatch:v1.
//
// WM 2026-10-31: ArcGIS rejected 5 to 12 of the 13 chokepoints per run
// ("Invalid query parameters" / "fetch failed"). Each run published only the
// survivors and replaced the complete set, so suez, hormuz_strait and bosphorus
// disappeared from energy:chokepoint-flows:v1. seed-supply-vulnerability then
// saw an `unknown` flow status on every route through them, rankable countries
// fell from 197 to 77 (floor 110), and seed-bundle-static-ref-heavy crashed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARRY_FORWARD_MAX_AGE_MS, fetchAll, mergeWithPrevious } from '../scripts/seed-portwatch.mjs';

const NOW = Date.parse('2026-11-01T01:06:00Z');
const HOUR = 60 * 60 * 1000;
const entry = (fetchedAt, extra = {}) => ({
  history: [{ date: '2026-10-25', total: 50 }],
  wowChangePct: 1.5,
  baseline: null,
  fetchedAt,
  ...extra,
});

test('a chokepoint missing from this run is carried from the previous snapshot', () => {
  const fresh = { suez: entry(NOW) };
  const previous = { data: { suez: entry(NOW - 6 * HOUR), bosphorus: entry(NOW - 6 * HOUR) }, meta: { fetchedAt: NOW - 6 * HOUR } };
  const { result, carried, expired } = mergeWithPrevious(fresh, previous, ['suez', 'bosphorus'], NOW);
  assert.deepEqual(Object.keys(result).sort(), ['bosphorus', 'suez']);
  assert.deepEqual(carried, ['bosphorus']);
  assert.deepEqual(expired, []);
  assert.equal(result.bosphorus.carriedForward, true);
  assert.equal(result.bosphorus.fetchedAt, NOW - 6 * HOUR, 'carried entry keeps its original fetch time');
  assert.equal(result.suez.carriedForward, undefined, 'fresh entries are not marked carried');
  assert.equal(result.suez.fetchedAt, NOW);
});

test('a fresh entry always wins over the previous one', () => {
  const fresh = { suez: entry(NOW, { wowChangePct: 9 }) };
  const previous = { data: { suez: entry(NOW - HOUR, { wowChangePct: 1 }) }, meta: { fetchedAt: NOW - HOUR } };
  const { result, carried } = mergeWithPrevious(fresh, previous, ['suez'], NOW);
  assert.equal(result.suez.wowChangePct, 9);
  assert.deepEqual(carried, []);
});

test('an entry older than the carry-forward limit is dropped, so carrying cannot chain forever', () => {
  const old = NOW - CARRY_FORWARD_MAX_AGE_MS - 1;
  const previous = { data: { bosphorus: entry(old, { carriedForward: true }) }, meta: { fetchedAt: NOW - 6 * HOUR } };
  const { result, carried, expired } = mergeWithPrevious({}, previous, ['bosphorus'], NOW);
  assert.equal(result.bosphorus, undefined);
  assert.deepEqual(carried, []);
  assert.deepEqual(expired, ['bosphorus']);
});

test('a legacy entry without fetchedAt is aged by the snapshot envelope', () => {
  const legacy = { history: [{ date: '2026-10-25', total: 50 }], wowChangePct: 0, baseline: null };
  const recent = mergeWithPrevious({}, { data: { panama: legacy }, meta: { fetchedAt: NOW - 6 * HOUR } }, ['panama'], NOW);
  assert.equal(recent.result.panama.fetchedAt, NOW - 6 * HOUR);
  const stale = mergeWithPrevious({}, { data: { panama: legacy }, meta: { fetchedAt: NOW - CARRY_FORWARD_MAX_AGE_MS - 1 } }, ['panama'], NOW);
  assert.equal(stale.result.panama, undefined);
  const undated = mergeWithPrevious({}, { data: { panama: legacy }, meta: null }, ['panama'], NOW);
  assert.equal(undated.result.panama, undefined, 'an entry with no provable age is not carried');
});

test('ids outside the chokepoint list, empty histories and a missing snapshot are ignored', () => {
  const previous = {
    data: { retired: entry(NOW - HOUR), suez: entry(NOW - HOUR, { history: [] }) },
    meta: { fetchedAt: NOW - HOUR },
  };
  assert.deepEqual(mergeWithPrevious({}, previous, ['suez'], NOW).result, {});
  assert.deepEqual(mergeWithPrevious({ suez: entry(NOW) }, null, ['suez'], NOW).carried, []);
});

// A failed read must not look like a cold start: publishing the fresh subset
// would overwrite the stored entries this change exists to keep.
test('fetchAll refuses to publish when the previous snapshot cannot be read', async (t) => {
  const env = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN };
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('https://redis.test')) return new Response('upstream error', { status: 503 });
    if (url.includes('outStatistics')) return Response.json({ features: [] });
    return Response.json({ features: [{ attributes: { date: Date.parse('2026-10-25'), n_total: 10 } }] });
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    if (env.url === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = env.url;
    if (env.token === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = env.token;
  });
  await assert.rejects(fetchAll(), /Redis snapshot read failed/);
});
