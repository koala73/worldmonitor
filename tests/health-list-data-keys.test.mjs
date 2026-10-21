// Health data keys that are Redis LISTS, not strings (#5233 regression).
//
// /api/health measures every registered data key with STRLEN. STRLEN against a
// LIST returns a WRONGTYPE error, which the handler records in keyErrors and
// classifyKey turns into REDIS_PARTIAL (records: null) — permanently, for a
// seeder that is perfectly healthy. `forecast:bets:history:v1` is written with
// LPUSH/LTRIM (scripts/seed-forecast-bets.mjs) and shipped into STANDALONE_KEYS
// with #5233, so prod has reported forecastBets: REDIS_PARTIAL ever since.
//
// Two halves must hold, and this file pins both:
//   1. the pipeline must issue LLEN (not STRLEN) for list-typed keys, and
//   2. presence for a list must be `len > 0` — the NEG_SENTINEL byte-length
//      rule in strlenIsData() is a STRING concept, so a 10-ELEMENT list must
//      not be mistaken for the 10-BYTE '__WM_NEG__' sentinel.
//
// node:test to match the repo's data-test runner (tsx --test tests/*.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ } from '../api/health.js';

const { classifyKey, LIST_DATA_KEYS, dataLenCommand, STANDALONE_KEYS, SEED_META } = __testing__;

const NOW = 1_700_000_000_000;
const ONE_MIN_MS = 60_000;
const BETS_KEY = STANDALONE_KEYS.forecastBets;

function makeCtx({ strens = {}, errors = {}, metaValues = {}, metaErrors = {} } = {}) {
  return {
    keyStrens: new Map(Object.entries(strens)),
    keyErrors: new Map(Object.entries(errors)),
    keyMetaValues: new Map(Object.entries(metaValues).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])),
    keyMetaErrors: new Map(Object.entries(metaErrors)),
    now: NOW,
  };
}

const freshBetsMeta = (over = {}) => ({
  [SEED_META.forecastBets.key]: JSON.stringify({ fetchedAt: NOW - ONE_MIN_MS, recordCount: 4, ...over }),
});

// ── the registry itself ─────────────────────────────────────────────────────

test('forecast:bets:history:v1 is registered as a LIST key', () => {
  assert.ok(LIST_DATA_KEYS.has(BETS_KEY), `${BETS_KEY} must be in LIST_DATA_KEYS — it is written with LPUSH/LTRIM`);
});

// ── half 1: the pipeline command ────────────────────────────────────────────

test('dataLenCommand issues LLEN for list keys and STRLEN for string keys', () => {
  assert.deepEqual(dataLenCommand(BETS_KEY), ['LLEN', BETS_KEY]);
  // A representative string key must be untouched.
  const stringKey = STANDALONE_KEYS.defensePatents;
  assert.deepEqual(dataLenCommand(stringKey), ['STRLEN', stringKey]);
});

// ── half 2: presence semantics ──────────────────────────────────────────────

test('a populated bets list with fresh seed-meta classifies OK (not REDIS_PARTIAL)', () => {
  const entry = classifyKey('forecastBets', BETS_KEY, {}, makeCtx({
    strens: { [BETS_KEY]: 1 },          // LLEN = 1 snapshot
    metaValues: freshBetsMeta(),        // seeder healthy, recordCount 4
  }));
  assert.equal(entry.status, 'OK');
  assert.equal(entry.records, 4);
});

test('a 10-ELEMENT list is data, not the 10-BYTE NEG_SENTINEL', () => {
  // The trap: strlenIsData() rejects exactly 10 bytes as '__WM_NEG__'. Reusing
  // it for LLEN would silently declare a 10-entry history EMPTY (crit).
  const entry = classifyKey('forecastBets', BETS_KEY, {}, makeCtx({
    strens: { [BETS_KEY]: 10 },
    metaValues: freshBetsMeta({ recordCount: 7 }),
  }));
  assert.equal(entry.status, 'OK');
  assert.equal(entry.records, 7);
});

test('an empty bets list (LLEN 0) still reports absent', () => {
  const entry = classifyKey('forecastBets', BETS_KEY, {}, makeCtx({
    strens: { [BETS_KEY]: 0 },
    metaValues: freshBetsMeta(),
  }));
  // forecastBets is in EMPTY_DATA_OK_KEYS (#5233: tolerated as STALE_SEED/OK
  // while fresh), so assert only that it is NOT scored as present-with-records.
  assert.notEqual(entry.status, 'OK_LIST_PRESENT');
  assert.equal(entry.records, 0);
});

// ── regressions the fix must not break ──────────────────────────────────────

test('a REAL per-command Redis error on the list key still surfaces REDIS_PARTIAL', () => {
  const entry = classifyKey('forecastBets', BETS_KEY, {}, makeCtx({
    errors: { [BETS_KEY]: 'ERR something broke' },
    metaValues: freshBetsMeta(),
  }));
  assert.equal(entry.status, 'REDIS_PARTIAL');
  assert.equal(entry.records, null);
});

test('string keys keep NEG_SENTINEL semantics: strlen 10 is NOT data', () => {
  const key = STANDALONE_KEYS.defensePatents;
  const entry = classifyKey('defensePatents', key, {}, makeCtx({
    strens: { [key]: 10 },  // exactly '__WM_NEG__'
    metaValues: { [SEED_META.defensePatents.key]: JSON.stringify({ fetchedAt: NOW - ONE_MIN_MS, recordCount: 3 }) },
  }));
  assert.equal(entry.status, 'EMPTY');
  assert.equal(entry.records, 0);
});
