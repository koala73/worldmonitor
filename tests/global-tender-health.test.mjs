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

// An adapter the deployment never opted into is not a fault. fetchSam writes
// sourceState:'unavailable' when SAM_GOV_API_KEY is absent — the only place any
// producer emits that state. Grading it identically to a broken source (#5266
// shipped SAM unconfigured, so /api/health warned on every run) means the health
// endpoint can never be clean until an operator obtains a government API key.
test('an unconfigured source adapter is moot, not a health problem', () => {
  const { classifyKey, STATUS_COUNTS, SEED_META, STANDALONE_KEYS, healthResponseBody } = __testing__;
  const name = 'globalTendersSam';
  const dataKey = STANDALONE_KEYS[name];
  const metaKey = SEED_META[name].key;
  const now = Date.parse('2026-07-13T12:00:00Z');

  const entry = classifyKey(name, dataKey, { allowOnDemand: true }, {
    keyStrens: new Map([[dataKey, 128]]),
    keyErrors: new Map(),
    keyMetaValues: new Map([[metaKey, JSON.stringify({
      fetchedAt: now - 60_000,
      recordCount: 0,
      sourceState: 'unavailable',
      stale: true,
    })]]),
    keyMetaErrors: new Map(),
    now,
  });

  assert.equal(entry.status, 'NOT_CONFIGURED');
  assert.equal(entry.records, 0);
  // STATUS_COUNTS[status] ?? 'warn' — an unregistered status silently buckets to
  // warn, so the mapping must be explicit for the exemption to actually hold.
  assert.equal(STATUS_COUNTS.NOT_CONFIGURED, 'ok');

  // ...and it must drop out of the compact /api/health `problems` map entirely.
  const body = healthResponseBody({
    status: 'HEALTHY',
    checkedAt: new Date(now).toISOString(),
    summary: { total: 1, ok: 1, warn: 0, crit: 0 },
    checks: { [name]: entry },
  }, true);
  assert.equal(body.problems, undefined);
});

// Guard the exemption's blast radius: only 'unavailable' (= never configured) is
// exempt. A source that was configured and then broke must still warn.
test('a source that actually failed still reports SEED_ERROR', () => {
  const { classifyKey, SEED_META, STANDALONE_KEYS } = __testing__;
  const name = 'globalTendersSam';
  const dataKey = STANDALONE_KEYS[name];
  const metaKey = SEED_META[name].key;
  const now = Date.parse('2026-07-13T12:00:00Z');

  for (const sourceState of ['stale', 'error']) {
    const entry = classifyKey(name, dataKey, { allowOnDemand: true }, {
      keyStrens: new Map([[dataKey, 128]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([[metaKey, JSON.stringify({
        fetchedAt: now - 60_000,
        recordCount: 0,
        sourceState,
        stale: true,
      })]]),
      keyMetaErrors: new Map(),
      now,
    });
    assert.equal(entry.status, 'SEED_ERROR', `sourceState=${sourceState} must still warn`);
  }
});
