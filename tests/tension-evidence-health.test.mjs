import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { __testing__ } from '../api/health.js';
import { TENSION_EVIDENCE_ACTIVATION_KEY, TENSION_EVIDENCE_KEY } from '../scripts/_tension-evidence.mjs';

const NOW = 1_792_929_600_000;
const NAME = 'tensionEvidence';
const META_KEY = 'seed-meta:intelligence:tension-evidence';

function classify(overrides) {
  return __testing__.classifyKey(NAME, TENSION_EVIDENCE_KEY, { allowOnDemand: true }, {
    keyStrens: new Map(),
    keyErrors: new Map(),
    keyMetaValues: new Map(),
    keyMetaErrors: new Map(),
    now: NOW,
    ...overrides,
  });
}

describe('tension evidence health registration', () => {
  it('is an on-demand standalone check bound to the seeder key and activation marker', () => {
    assert.equal(__testing__.STANDALONE_KEYS[NAME], TENSION_EVIDENCE_KEY);
    assert.equal(__testing__.SEED_META[NAME].key, META_KEY);
    assert.equal(__testing__.SEED_META[NAME].maxStaleMin, 45);
    assert.equal(__testing__.SEED_META[NAME].activationKey, TENSION_EVIDENCE_ACTIVATION_KEY);
    assert.equal(__testing__.SEED_META[NAME].cutover.activationKey, TENSION_EVIDENCE_ACTIVATION_KEY);
    assert.equal(__testing__.ACTIVATION_MARKERS[NAME], TENSION_EVIDENCE_ACTIVATION_KEY);
    assert.ok(__testing__.ON_DEMAND_KEYS.has(NAME));
  });

  it('reports OK for a fresh publish', () => {
    const entry = classify({
      keyStrens: new Map([[TENSION_EVIDENCE_KEY, 4096]]),
      keyMetaValues: new Map([[META_KEY, JSON.stringify({ fetchedAt: NOW - 10 * 60_000, recordCount: 22 })]]),
    });
    assert.equal(entry.status, 'OK');
  });

  it('never reports a critical status before the first publish', () => {
    assert.notEqual(__testing__.STATUS_COUNTS[classify({}).status], 'crit');
  });

  it('reports STALE_SEED once three 15-minute runs are missed', () => {
    const entry = classify({
      keyStrens: new Map([[TENSION_EVIDENCE_KEY, 4096]]),
      keyMetaValues: new Map([[META_KEY, JSON.stringify({ fetchedAt: NOW - 46 * 60_000, recordCount: 22 })]]),
    });
    assert.equal(entry.status, 'STALE_SEED');
  });
});
