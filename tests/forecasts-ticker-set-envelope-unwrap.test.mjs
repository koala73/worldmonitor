// loadTickerSet envelope unwrap — regression test.
//
// Production bug (Railway seed-forecasts log 2026-07-01): market:stocks-bootstrap:v1
// is written in contract mode ({ _seed, data: { quotes } }) by BOTH
// seed-market-quotes.mjs (runSeed declareRecords) and the AIS relay (envelopeWrite),
// but loadTickerSet read `.quotes` off the raw parse — undefined inside an envelope.
// Result: the MarketImplications live ticker set was empty on EVERY run
// ("Redis ticker set empty — using static allowlist only"; 0/18 successful loads),
// silently degrading card validation to the static allowlist.
//
// loadTickerSet now unwraps via unwrapEnvelope (legacy bare shapes pass through).
// These tests pin the envelope + legacy shapes and the empty/missing/malformed paths.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadTickerSet } from '../scripts/_ticker-validation.mjs';

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

// Mirrors the Upstash REST /get response: { result: <stringified value> | null }.
function stubRedisGet(result) {
  global.fetch = async () => ({ ok: true, json: async () => ({ result }) });
}

function seedEnvelope(data) {
  return { _seed: { fetchedAt: Date.now(), recordCount: 1, sourceVersion: 'test', schemaVersion: 1, state: 'OK' }, data };
}

const quotes = [
  { symbol: 'nflx', name: 'Netflix' },
  { symbol: 'WMT' },
  { symbol: 'aapl' },
];

test('BUG REPRO + FIX: enveloped stocks-bootstrap populates the ticker set', async () => {
  const raw = JSON.stringify(seedEnvelope({ quotes }));
  // What the buggy loader did: JSON.parse, then read `.quotes` off the top level.
  assert.equal(JSON.parse(raw).quotes, undefined, 'quotes live under .data.quotes — raw .quotes is undefined');
  // The fixed loader unwraps the envelope and finds them (uppercased).
  stubRedisGet(raw);
  const set = await loadTickerSet('https://redis.example', 'tok');
  assert.deepEqual([...set].sort(), ['AAPL', 'NFLX', 'WMT']);
});

test('legacy bare { quotes } shape still works (envelope passthrough)', async () => {
  stubRedisGet(JSON.stringify({ quotes }));
  const set = await loadTickerSet('https://redis.example', 'tok');
  assert.deepEqual([...set].sort(), ['AAPL', 'NFLX', 'WMT']);
});

test('missing key returns an empty set', async () => {
  stubRedisGet(null);
  const set = await loadTickerSet('https://redis.example', 'tok');
  assert.equal(set.size, 0);
});

test('malformed JSON returns an empty set (no throw)', async () => {
  stubRedisGet('{not json');
  const set = await loadTickerSet('https://redis.example', 'tok');
  assert.equal(set.size, 0);
});

test('envelope with non-array quotes returns an empty set', async () => {
  stubRedisGet(JSON.stringify(seedEnvelope({ quotes: 'nope' })));
  const set = await loadTickerSet('https://redis.example', 'tok');
  assert.equal(set.size, 0);
});
