import assert from 'node:assert/strict';
import test from 'node:test';

import { __testing__ } from '../api/health.js';

const {
  BOOTSTRAP_KEYS,
  CANADA_ALERTS_CUTOVER_FALLBACK_KEY,
  SEED_META,
  applyCanadaAlertsDataPresenceFallback,
  classifyKey,
} = __testing__;

const PRIMARY_KEY = BOOTSTRAP_KEYS.canadaAlerts;
const NOW = Date.parse('2026-08-18T00:00:00.000Z');

function classify({ primaryLength = 0, fallbackLength = 0, primaryError, fallbackError } = {}) {
  const keyStrens = new Map([
    [PRIMARY_KEY, primaryLength],
    [CANADA_ALERTS_CUTOVER_FALLBACK_KEY, fallbackLength],
  ]);
  const keyErrors = new Map();
  if (primaryError) keyErrors.set(PRIMARY_KEY, primaryError);
  if (fallbackError) keyErrors.set(CANADA_ALERTS_CUTOVER_FALLBACK_KEY, fallbackError);

  applyCanadaAlertsDataPresenceFallback(keyStrens, keyErrors);
  return classifyKey('canadaAlerts', PRIMARY_KEY, { allowOnDemand: false }, {
    keyStrens,
    keyErrors,
    keyMetaValues: new Map([[
      SEED_META.canadaAlerts.key,
      JSON.stringify({ fetchedAt: NOW, recordCount: 1 }),
    ]]),
    keyMetaErrors: new Map(),
    now: NOW,
  });
}

test('keeps the aggregate authoritative when primary data is present', () => {
  const entry = classify({
    primaryLength: 128,
    fallbackLength: 256,
    fallbackError: 'legacy read failed',
  });

  assert.equal(entry.status, 'OK');
  assert.equal(entry.records, 1);
});

test('uses healthy legacy data presence when the aggregate is cleanly absent', () => {
  const entry = classify({ primaryLength: 0, fallbackLength: 256 });

  assert.equal(entry.status, 'OK');
  assert.equal(entry.records, 1);
});

test('does not let healthy legacy data mask a primary Redis error', () => {
  const entry = classify({
    primaryLength: 0,
    fallbackLength: 256,
    primaryError: 'primary read failed',
  });

  assert.equal(entry.status, 'REDIS_PARTIAL');
  assert.equal(entry.records, null);
});
