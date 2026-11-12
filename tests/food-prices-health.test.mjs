import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { __testing__ } from '../api/health.js';

const sources = JSON.parse(readFileSync(new URL('../shared/food-price-sources.json', import.meta.url), 'utf8'));
const healthName = id => `foodPrices${id[0].toUpperCase()}${id.slice(1)}`;

test('food-price health probes the cache GetFoodPrices reads, with metadata only for freshness', () => {
  const { classifyKey, SEED_META, STANDALONE_KEYS, ACTIVATION_MARKERS } = __testing__;
  const now = Date.parse('2026-11-01T12:00:00Z');
  for (const { id } of sources) {
    const name = healthName(id);
    const key = STANDALONE_KEYS[name];
    assert.equal(key, `economic:food-prices:${id}:v1`, name);
    assert.equal(SEED_META[name].key, `seed-meta:economic:food-prices-${id}`, name);
    assert.equal(ACTIVATION_MARKERS[name], SEED_META[name].activationKey, name);
    const classify = (active, dataBytes) => classifyKey(name, key, { allowOnDemand: true }, {
      now, activationStates: new Map([[name, active]]), keyErrors: new Map(), keyMetaErrors: new Map(),
      keyStrens: new Map(dataBytes ? [[key, dataBytes]] : []),
      keyMetaValues: new Map([[SEED_META[name].key, JSON.stringify({ fetchedAt: now - 60_000, recordCount: 10, sourceState: 'ok' })]]),
    });
    // A source cache that was evicted while its metadata survived must not report OK.
    assert.equal(classify(true, 0).status, 'EMPTY', name);
    assert.equal(classify(true, 500).status, 'OK', name);
    assert.equal(classify(false, 0).status, 'EMPTY_ON_DEMAND', name);
  }
});
