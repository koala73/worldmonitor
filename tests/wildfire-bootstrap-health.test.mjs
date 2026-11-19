import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ } from '../api/health.js';

const { BOOTSTRAP_KEYS, STANDALONE_KEYS, SEED_META, ON_DEMAND_KEYS, ACTIVATION_MARKERS, classifyKey } = __testing__;
const NOW = 1_700_000_000_000;

// The CII and temporal-anomaly rebuilds read this derived key instead of the
// 2-5 MB canonical payload (#9509). Its probe is softened only until the seeder
// writes the durable activation marker on its first publish.
test('health monitors the fires summary with an activation-marker cutover', () => {
  const name = 'wildfiresSummary';
  const key = STANDALONE_KEYS[name];
  assert.equal(key, 'wildfire:fires-summary:v1');
  assert.equal(SEED_META[name].key, 'seed-meta:wildfire:fires-summary');
  assert.equal(SEED_META[name].maxStaleMin, SEED_META.wildfires.maxStaleMin, 'same staleness budget as the canonical probe');
  assert.equal(SEED_META[name].activationKey, 'seed-activated:wildfire:fires-summary');
  assert.deepEqual(SEED_META[name].cutover, {
    mode: 'activation-marker',
    fromKey: null,
    issue: 9509,
    activationKey: 'seed-activated:wildfire:fires-summary',
  });
  assert.equal(ACTIVATION_MARKERS[name], SEED_META[name].activationKey);
  assert.ok(ON_DEMAND_KEYS.has(name), 'pre-activation absence must soften to EMPTY_ON_DEMAND');

  const ctx = ({ bytes = 0, meta, activated } = {}) => ({
    keyStrens: new Map([[key, bytes]]),
    keyErrors: new Map(),
    keyMetaValues: new Map(meta ? [[SEED_META[name].key, JSON.stringify(meta)]] : []),
    keyMetaErrors: new Map(),
    activationStates: new Map([[name, activated]]),
    now: NOW,
  });
  assert.equal(classifyKey(name, key, { allowOnDemand: true }, ctx({ activated: false })).status, 'EMPTY_ON_DEMAND');
  assert.equal(classifyKey(name, key, { allowOnDemand: true }, ctx({ activated: true })).status, 'EMPTY');
  assert.equal(classifyKey(name, key, { allowOnDemand: true }, ctx({
    activated: true, bytes: 150_000, meta: { fetchedAt: NOW - 60_000, recordCount: 5716 },
  })).status, 'OK');
  assert.equal(classifyKey(name, key, { allowOnDemand: true }, ctx({
    activated: true, bytes: 150_000, meta: { fetchedAt: NOW - 361 * 60_000, recordCount: 5716 },
  })).status, 'STALE_SEED');
});

function makeCtx({ compactBytes = 0, canonicalBytes = 0, meta } = {}) {
  return {
    keyStrens: new Map([
      [BOOTSTRAP_KEYS.wildfiresBootstrap, compactBytes],
      [BOOTSTRAP_KEYS.wildfires, canonicalBytes],
    ]),
    keyErrors: new Map(),
    keyMetaValues: new Map(meta ? [[SEED_META.wildfiresBootstrap.key, JSON.stringify(meta)]] : []),
    keyMetaErrors: new Map(),
    now: NOW,
  };
}

test('health monitors the compact wildfire publish independently of canonical fallback', () => {
  assert.equal(BOOTSTRAP_KEYS.wildfiresBootstrap, 'wildfire:fires-bootstrap:v1');
  assert.deepEqual(SEED_META.wildfiresBootstrap, {
    key: 'seed-meta:wildfire:fires-bootstrap',
    maxStaleMin: 360,
  });

  const freshMeta = { fetchedAt: NOW - 60_000, recordCount: 500 };
  const healthy = classifyKey(
    'wildfiresBootstrap',
    BOOTSTRAP_KEYS.wildfiresBootstrap,
    { allowOnDemand: false },
    makeCtx({ compactBytes: 64_000, canonicalBytes: 1_360_000, meta: freshMeta }),
  );
  assert.equal(healthy.status, 'OK');

  const missingBeforeFirstSeed = classifyKey(
    'wildfiresBootstrap',
    BOOTSTRAP_KEYS.wildfiresBootstrap,
    { allowOnDemand: false },
    makeCtx({ canonicalBytes: 1_360_000 }),
  );
  assert.equal(missingBeforeFirstSeed.status, 'STALE_SEED');

  const missingCanonical = classifyKey(
    'wildfires',
    BOOTSTRAP_KEYS.wildfires,
    { allowOnDemand: false },
    makeCtx(),
  );
  assert.equal(missingCanonical.status, 'EMPTY');
});
