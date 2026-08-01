import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ } from '../api/health.js';

const { BOOTSTRAP_KEYS, SEED_META, classifyKey } = __testing__;
const NOW = 1_700_000_000_000;

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
