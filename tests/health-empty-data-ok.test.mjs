import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ as healthTesting } from '../api/health.js';

const {
  BOOTSTRAP_KEYS,
  EMPTY_DATA_OK_KEYS,
  MISSING_DATA_IS_FAILURE_KEYS,
  SEED_META,
  STANDALONE_KEYS,
  STATUS_COUNTS,
  classifyKey,
} = healthTesting;
const NOW = 1_700_000_000_000;

// Successful publishers for these compact projections always leave a payload. A
// missing key after a fresh meta is therefore a failed publish, not quiet data.
const STRICT_PROJECTIONS = [...MISSING_DATA_IS_FAILURE_KEYS];

// These sources intentionally refresh only metadata on quiet cycles, so a missing
// payload with fresh metadata remains healthy rather than generating a false alarm.
const QUIET_META_ONLY_KEYS = [
  'ddosAttacks',
  'trafficAnomalies',
  'weatherAlerts',
  'newsThreatSummary',
];

function classifyMissing(name, meta) {
  const redisKey = BOOTSTRAP_KEYS[name] ?? STANDALONE_KEYS[name];
  const seedCfg = SEED_META[name];
  return classifyKey(name, redisKey, { allowOnDemand: false }, {
    keyStrens: new Map([[redisKey, 0]]),
    keyErrors: new Map(),
    keyMetaValues: meta == null ? new Map() : new Map([[seedCfg.key, JSON.stringify(meta)]]),
    keyMetaErrors: new Map(),
    now: NOW,
  });
}

test('published strict projections escalate when their data key vanishes', () => {
  for (const name of STRICT_PROJECTIONS) {
    const seedCfg = SEED_META[name];
    assert.ok(EMPTY_DATA_OK_KEYS.has(name), `${name} remains tolerant of a present empty payload`);
    assert.ok(seedCfg, `${name} has seed metadata that records a successful publication`);

    const entry = classifyMissing(name, {
      fetchedAt: NOW - Math.floor(seedCfg.maxStaleMin / 2) * 60_000,
      recordCount: 0,
    });
    assert.equal(entry.status, 'EMPTY', `${name}: fresh metadata + missing key is a vanished projection`);
    assert.equal(STATUS_COUNTS[entry.status], 'crit', `${name}: vanished projection must be critical`);
    assert.equal(entry.records, 0);
  }
});

test('strict projections retain cold-start and stale-seed handling', () => {
  for (const name of STRICT_PROJECTIONS) {
    const seedCfg = SEED_META[name];

    assert.equal(
      classifyMissing(name).status,
      'STALE_SEED',
      `${name}: no metadata means it has never been published, not that it vanished`,
    );
    assert.equal(
      classifyMissing(name, {
        fetchedAt: NOW - (seedCfg.maxStaleMin + 1) * 60_000,
        recordCount: 0,
      }).status,
      'STALE_SEED',
      `${name}: a late publisher remains a stale-seed warning`,
    );
  }
});

test('quiet metadata-only sources remain healthy while their payload is absent', () => {
  for (const name of QUIET_META_ONLY_KEYS) {
    const seedCfg = SEED_META[name];
    const entry = classifyMissing(name, {
      fetchedAt: NOW - Math.floor(seedCfg.maxStaleMin / 2) * 60_000,
      recordCount: 0,
    });
    assert.equal(entry.status, 'OK', `${name}: a quiet successful cycle may publish metadata without a payload`);
    assert.equal(STATUS_COUNTS[entry.status], 'ok');
  }
});
