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

// The exemption must hold on EVERY problem surface, not just the compact
// `problems` map. The console failure log and the ?history=1 incident signature
// only run when overall !== 'HEALTHY' — which is precisely the state a real,
// UNRELATED crit puts the fleet in. So a NOT_CONFIGURED key that is correctly
// absent from `problems` can still be reported as a permanent problem in the
// failure log the moment anything else breaks. This mirrors production: a
// defensePatents crit holds the fleet DEGRADED while SAM is unconfigured.
test('NOT_CONFIGURED stays out of the failure log even when the fleet is degraded', () => {
  const { collectFailureLogProblems, healthResponseBody, STATUS_COUNTS } = __testing__;

  const checks = {
    globalTendersSam: { status: 'NOT_CONFIGURED', records: 0, seedAgeMin: 103 },
    defensePatents: { status: 'EMPTY', records: 0 },                 // real crit
    newsRecallBenchmark: { status: 'EMPTY_ON_DEMAND', records: 0 },  // warn-for-visibility only
    seedEarthquakes: { status: 'OK', records: 42 },
  };

  const { problemKeys, sigKeys } = collectFailureLogProblems(checks);

  // The real fault is reported...
  assert.deepEqual(problemKeys, ['defensePatents:EMPTY']);
  // ...and the dedupe signature must not carry SAM either, or every incident
  // signature is permanently salted with a non-problem.
  assert.deepEqual(sigKeys, ['defensePatents:EMPTY']);

  // EMPTY_ON_DEMAND keeps its existing asymmetry: suppressed in the failure log,
  // but still surfaced in the compact problems map (prod reports it there today).
  const body = healthResponseBody({
    status: 'DEGRADED',
    checkedAt: new Date(Date.parse('2026-07-14T00:00:00Z')).toISOString(),
    summary: { total: 4, ok: 2, warn: 1, crit: 1 },
    checks,
  }, true);
  assert.deepEqual(Object.keys(body.problems).sort(), ['defensePatents', 'newsRecallBenchmark']);
  assert.equal(STATUS_COUNTS.EMPTY_ON_DEMAND, 'warn');
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
