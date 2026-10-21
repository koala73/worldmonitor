// Energy pipeline/storage registries must not ride a universal tier (#7046).
// Startup selection and deferred-panel rendering are exercised through the
// browser and DOM suites; this file keeps only the executable tier contract.
import assert from 'node:assert/strict';
import test from 'node:test';

import { bootstrapTierKeyNames } from '../shared/bootstrap-tier-keys.js';

const ENERGY_KEYS = ['pipelinesGas', 'pipelinesOil', 'storageFacilities'] as const;

test('energy registries are on-demand, not tier freight', () => {
  const fast = new Set(bootstrapTierKeyNames('fast'));
  const slow = new Set(bootstrapTierKeyNames('slow'));
  const onDemand = new Set(bootstrapTierKeyNames('on-demand'));
  for (const key of ENERGY_KEYS) {
    assert.ok(onDemand.has(key), `${key} must be on-demand`);
    assert.equal(fast.has(key), false, `${key} must not ride FAST`);
    assert.equal(slow.has(key), false, `${key} must not ride SLOW`);
  }
});
