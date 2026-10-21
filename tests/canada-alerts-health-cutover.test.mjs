import assert from 'node:assert/strict';
import test from 'node:test';

import { __testing__ } from '../api/health.js';
import {
  CANADA_ALERTS_LEGACY_KEY,
  CANADA_ALERTS_SIBLING_KEY,
} from '../api/_canada-alerts-cutover.js';

const {
  BOOTSTRAP_KEYS,
  CANADA_ALERTS_CUTOVER_FALLBACK_KEYS,
  SEED_META,
  STANDALONE_KEYS,
  applyCanadaAlertsDataPresenceFallback,
  applyCanadaAlertsSeedMetaFallback,
  classifyKey,
} = __testing__;

const PRIMARY_KEY = BOOTSTRAP_KEYS.canadaAlerts;
const NOW = Date.parse('2026-08-18T00:00:00.000Z');

function classify({
  primaryLength = 0,
  siblingLength = 0,
  legacyLength = 0,
  primaryError,
  siblingError,
  legacyError,
  unionMeta = { fetchedAt: NOW, recordCount: 1 },
  albertaMeta,
  overlayFallbackMeta = false,
} = {}) {
  const keyStrens = new Map([
    [PRIMARY_KEY, primaryLength],
    [CANADA_ALERTS_SIBLING_KEY, siblingLength],
    [CANADA_ALERTS_LEGACY_KEY, legacyLength],
  ]);
  const keyErrors = new Map();
  if (primaryError) keyErrors.set(PRIMARY_KEY, primaryError);
  if (siblingError) keyErrors.set(CANADA_ALERTS_SIBLING_KEY, siblingError);
  if (legacyError) keyErrors.set(CANADA_ALERTS_LEGACY_KEY, legacyError);

  const usedFallback = applyCanadaAlertsDataPresenceFallback(keyStrens, keyErrors);
  const keyMetaValues = new Map();
  if (unionMeta != null) {
    keyMetaValues.set(SEED_META.canadaAlerts.key, JSON.stringify(unionMeta));
  }
  if (albertaMeta != null) {
    keyMetaValues.set(SEED_META.canadaAlertsAbSource.key, JSON.stringify(albertaMeta));
  }
  if (overlayFallbackMeta) {
    applyCanadaAlertsSeedMetaFallback(keyMetaValues, new Map(), usedFallback);
  }

  return classifyKey('canadaAlerts', PRIMARY_KEY, { allowOnDemand: false }, {
    keyStrens,
    keyErrors,
    keyMetaValues,
    keyMetaErrors: new Map(),
    now: NOW,
  });
}

test('points canadaAlerts health at the union seed-meta and monitors the Alberta sibling', () => {
  assert.equal(SEED_META.canadaAlerts.key, 'seed-meta:alerts:canada-union');
  assert.equal(SEED_META.canadaAlertsAbSource.key, 'seed-meta:alerts:alberta-aea');
  assert.equal(STANDALONE_KEYS.canadaAlertsAbSource, CANADA_ALERTS_SIBLING_KEY);
  assert.deepEqual(
    [...CANADA_ALERTS_CUTOVER_FALLBACK_KEYS],
    [CANADA_ALERTS_SIBLING_KEY, CANADA_ALERTS_LEGACY_KEY],
  );
});

test('keeps the aggregate authoritative when primary data is present', () => {
  const entry = classify({
    primaryLength: 128,
    siblingLength: 256,
    legacyLength: 256,
    legacyError: 'legacy read failed',
  });

  assert.equal(entry.status, 'OK');
  assert.equal(entry.records, 1);
});

test('uses the Alberta sibling before the abandoned legacy key when the aggregate is cleanly absent', () => {
  const siblingFirst = classify({
    primaryLength: 0,
    siblingLength: 256,
    legacyLength: 64,
  });
  assert.equal(siblingFirst.status, 'OK');
  assert.equal(siblingFirst.records, 1);

  const legacyOnly = classify({ primaryLength: 0, legacyLength: 256 });
  assert.equal(legacyOnly.status, 'OK');
  assert.equal(legacyOnly.records, 1);
});

test('does not let healthy fallback data mask a primary Redis error', () => {
  const entry = classify({
    primaryLength: 0,
    siblingLength: 256,
    legacyLength: 256,
    primaryError: 'primary read failed',
  });

  assert.equal(entry.status, 'REDIS_PARTIAL');
  assert.equal(entry.records, null);
});

test('classifies canadaAlerts from union cardinality, not Alberta seed-meta', () => {
  const entry = classify({
    primaryLength: 128,
    siblingLength: 256,
    unionMeta: { fetchedAt: NOW, recordCount: 0 },
    albertaMeta: { fetchedAt: NOW, recordCount: 4 },
    overlayFallbackMeta: true,
  });

  assert.equal(entry.status, 'OK');
  assert.equal(entry.records, 0);
});

test('overlays Alberta seed-meta only while serving a cutover fallback payload', () => {
  const fallback = classify({
    primaryLength: 0,
    siblingLength: 256,
    unionMeta: null,
    albertaMeta: { fetchedAt: NOW, recordCount: 3 },
    overlayFallbackMeta: true,
  });
  assert.equal(fallback.status, 'OK');
  assert.equal(fallback.records, 3);

  const presentUnion = classify({
    primaryLength: 128,
    siblingLength: 256,
    unionMeta: { fetchedAt: NOW, recordCount: 1 },
    albertaMeta: { fetchedAt: NOW, recordCount: 99 },
    overlayFallbackMeta: true,
  });
  assert.equal(presentUnion.records, 1);
});
