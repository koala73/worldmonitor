import test from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ } from '../api/health.js';

test('health registers and classifies per-source global tender freshness', () => {
  const { classifyKey, SEED_META, STANDALONE_KEYS, ZERO_RECORD_DATA_OK_KEYS } = __testing__;
  const sources = ['Sam', 'Ted', 'ContractsFinder', 'CanadaBuys', 'Gets', 'WorldBank'];

  for (const source of sources) {
    const name = `globalTenders${source}`;
    assert.match(STANDALONE_KEYS[name], /^economic:global-tenders:v1:source:/);
    assert.match(SEED_META[name].key, /^seed-meta:economic:global-tenders:/);
    assert.ok(ZERO_RECORD_DATA_OK_KEYS.has(name));
  }

  const name = 'globalTendersTed';
  const dataKey = STANDALONE_KEYS[name];
  const metaKey = SEED_META[name].key;
  const now = Date.parse('2026-07-13T12:00:00Z');
  const entry = classifyKey(name, dataKey, { allowOnDemand: true }, {
    keyStrens: new Map([[dataKey, 256]]),
    keyErrors: new Map(),
    keyMetaValues: new Map([[metaKey, JSON.stringify({
      fetchedAt: now - 60_000,
      recordCount: 12,
      sourceState: 'stale',
      stale: true,
    })]]),
    keyMetaErrors: new Map(),
    now,
  });

  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(entry.records, 12);
});
