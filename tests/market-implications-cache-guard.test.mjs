// market_implications input-hash cache guard (#4894).
//
// Before this guard, buildAndSeedMarketImplications was the ONLY forecast LLM
// stage with no pre-call cache: it regenerated a 2,500-token completion every
// hourly run (plus every triggered re-run) even when the world-state inputs
// had not moved. The guard fingerprints the built context (numbers quantized
// to 2 significant digits so routine price ticks don't defeat it) and
// republishes the cached cards on a hit.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMarketImplicationsFingerprint,
  buildAndSeedMarketImplications,
  __setRedisStoreForTests,
} from '../scripts/seed-forecasts.mjs';

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  __setRedisStoreForTests(null);
});

test('fingerprint is stable across routine price ticks', () => {
  const a = buildMarketImplicationsFingerprint('[COMMODITIES]\nWTI Crude: 87.42 (+1.27%)\n[EQUITIES]\nSPX: 4512.34 (+0.31%)');
  const b = buildMarketImplicationsFingerprint('[COMMODITIES]\nWTI Crude: 87.61 (+1.29%)\n[EQUITIES]\nSPX: 4515.10 (+0.33%)');
  assert.equal(a, b, 'sub-precision price moves must not change the fingerprint');
});

test('fingerprint changes on a material price move', () => {
  const a = buildMarketImplicationsFingerprint('[COMMODITIES]\nWTI Crude: 87.42 (+1.2%)');
  const b = buildMarketImplicationsFingerprint('[COMMODITIES]\nWTI Crude: 95.10 (+9.8%)');
  assert.notEqual(a, b);
});

test('fingerprint changes when signal text changes', () => {
  const a = buildMarketImplicationsFingerprint('[CRITICAL INTELLIGENCE SIGNALS]\n- Red Sea shipping disruption strength=80%');
  const b = buildMarketImplicationsFingerprint('[CRITICAL INTELLIGENCE SIGNALS]\n- Hormuz transit closure strength=80%');
  assert.notEqual(a, b);
});

test('cache hit republishes cached cards without any LLM fetch', async () => {
  const cards = [{
    ticker: 'LMT', name: 'Lockheed Martin', direction: 'long', timeframe: '1-3m',
    confidence: 0.7, title: 'Defense demand', narrative: 'n', risk_caveat: '', driver: '', transmission_chain: [],
  }];
  const store = {};
  __setRedisStoreForTests(store);

  // Seed the stage cache under the fingerprint the run will derive.
  // Empty inputs make buildMarketImplicationsContext return this literal.
  const inputs = {};
  const fingerprint = buildMarketImplicationsFingerprint('No live world state available.');
  store[`forecast:llm-market-implications:v2:${fingerprint}`] = { cards, model: 'cached-model' };

  let fetchCalls = 0;
  global.fetch = async (url) => {
    fetchCalls += 1;
    throw new Error(`unexpected fetch on cache hit: ${url}`);
  };

  await buildAndSeedMarketImplications(inputs);

  assert.equal(fetchCalls, 0, 'cache hit must not reach any provider');
  const published = store['intelligence:market-implications:v1'];
  assert.ok(published, 'canonical cards key must be republished on cache hit');
  assert.deepEqual(published.cards, cards);
  assert.equal(published.model, 'cached-model');
  const meta = store['seed-meta:intelligence:market-implications'];
  assert.ok(meta, 'seed meta must stay green on cache hit');
  assert.equal(meta.status, 'ok');
  assert.equal(meta.recordCount, 1);
});

test('cache miss with no provider writes error meta and no stage cache entry', async () => {
  const store = {};
  __setRedisStoreForTests(store);
  global.fetch = async () => { throw new Error('no providers in test'); };

  await buildAndSeedMarketImplications({});

  const meta = store['seed-meta:intelligence:market-implications'];
  assert.ok(meta, 'failure meta must be written');
  assert.equal(meta.status, 'error');
  assert.ok(
    !Object.keys(store).some((k) => k.startsWith('forecast:llm-market-implications:')),
    'no stage cache entry may be written on failure',
  );
});
