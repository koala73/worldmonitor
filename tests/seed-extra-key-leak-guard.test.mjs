// Guard against the forecast:predictions-bootstrap:v1 incident (2026-07-14).
//
// runSeed feeds `publishTransform(data)` to the CANONICAL key but feeds RAW `data` to
// every extraKey transform. An extraKey transform written as `{ ...data, <tweak> }`
// therefore re-exports the seeder's entire internal pipeline state — which is exactly
// what publishTransform exists to strip. That published an 11.5 MB dashboard key, 66x
// larger than the 172 KB canonical key it was meant to compact, and the bootstrap fast
// tier pulled all of it on every CDN origin miss.
//
// findLeakedPrePublishFields is the generic detector: it flags fields that publishTransform
// REMOVED from the canonical payload but that reappear in an extra key.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extraKeyPayloadBytes,
  findLeakedPrePublishFields,
  MAX_SEEDED_VALUE_BYTES,
} from '../scripts/_seed-utils.mjs';

// The real thing: seed-forecasts' raw fetcher output vs its published projection.
const RAW = {
  generatedAt: 1,
  predictions: [{ id: 'f1', caseFile: { prose: 'x' } }],
  fullRunPredictions: [1, 2, 3],
  inputs: { big: 'blob' },
  publishSelectionPool: [1, 2],
  situationClusters: [1],
  stateUnits: [1],
  publishTelemetry: { t: 1 },
};
const PUBLISHED = { generatedAt: 1, predictions: [{ id: 'f1', caseFile: { prose: 'x' } }] };

test('catches the exact bug that shipped: a spread of the raw pipeline object', () => {
  // `{ ...data, predictions }` — the transform that published 11.5 MB.
  const ekData = { ...RAW, predictions: [{ id: 'f1' }], detailStripped: 1 };

  const leaked = findLeakedPrePublishFields(RAW, PUBLISHED, ekData);
  assert.deepEqual(leaked.sort(), [
    'fullRunPredictions', 'inputs', 'publishSelectionPool',
    'publishTelemetry', 'situationClusters', 'stateUnits',
  ]);
});

test('passes the fixed transform: project to the canonical shape first', () => {
  // compactForecastDashboardPayload(buildPublishedSeedPayload(data))
  const ekData = { generatedAt: 1, predictions: [{ id: 'f1', hasCaseFile: true }], detailStripped: 1 };
  assert.deepEqual(findLeakedPrePublishFields(RAW, PUBLISHED, ekData), []);
});

test('a marker the extra key ADDS is never flagged', () => {
  // detailStripped/hasCaseFile do not exist in raw `data`, so they are not internals.
  const ekData = { generatedAt: 1, predictions: [], detailStripped: 0, somethingNew: true };
  assert.deepEqual(findLeakedPrePublishFields(RAW, PUBLISHED, ekData), []);
});

test('a field the canonical key KEEPS is never flagged', () => {
  const ekData = { generatedAt: 1, predictions: [] };
  assert.deepEqual(findLeakedPrePublishFields(RAW, PUBLISHED, ekData), []);
});

test('no publishTransform means nothing was stripped, so nothing can leak', () => {
  // runSeed passes publishData === data by reference in this case (seed-thermal-escalation).
  assert.deepEqual(findLeakedPrePublishFields(RAW, RAW, { ...RAW }), []);
});

test('a seeder can opt out per-key for a field it genuinely must re-export', () => {
  const ekData = { ...RAW };
  const leaked = findLeakedPrePublishFields(RAW, PUBLISHED, ekData, {
    allowPrePublishFields: [
      'fullRunPredictions', 'inputs', 'publishSelectionPool',
      'publishTelemetry', 'situationClusters', 'stateUnits',
    ],
  });
  assert.deepEqual(leaked, []);
});

// ─── False-positive protection ────────────────────────────────────────────────
// The guard crashes the seeder, so a false positive takes a healthy feed down. These
// pin the shapes of the four OTHER seeders that have both publishTransform and extraKeys.

test('array-returning publishTransform is skipped, not flagged (seed-jodi-gas)', () => {
  // publishTransform: (records) => records.map(r => r.iso2)
  const raw = [{ iso2: 'DE', vol: 1 }];
  assert.deepEqual(findLeakedPrePublishFields(raw, ['DE'], { tokens: [] }), []);
});

test('a sub-object extra key is not flagged (seed-sanctions-pressure)', () => {
  // publishTransform strips _state/_entityIndex/_countryCounts; the extra key IS data._state.
  const raw = { entities: [1], _state: { cursor: 5 }, _entityIndex: {}, _countryCounts: {} };
  const published = { entities: [1] };
  assert.deepEqual(findLeakedPrePublishFields(raw, published, raw._state), []);
});

test('a from-scratch extra key is not flagged (seed-iea-oil-stocks)', () => {
  // raw {members, dataMonth, seededAt}; canonical buildIndex → {dataMonth, updatedAt, members}.
  // The only flaggable field is `seededAt`, and no extra-key payload carries it.
  const raw = { members: [{ iso2: 'DE' }], dataMonth: '2026-06', seededAt: 123 };
  const published = { dataMonth: '2026-06', updatedAt: 123, members: [{ iso2: 'DE' }] };
  const analysis = { updatedAt: 123, dataMonth: '2026-06', ieaMembers: [], belowObligation: [], regionalSummary: {}, shockScenario: null };

  assert.deepEqual(findLeakedPrePublishFields(raw, published, analysis), []);
  assert.deepEqual(findLeakedPrePublishFields(raw, published, { fetchedAt: 1, recordCount: 0 }), []);
  assert.deepEqual(findLeakedPrePublishFields(raw, published, raw.members[0]), []);
});

test('a null/non-object extra-key payload never throws', () => {
  // COUNTRY_EXTRA_KEYS returns `?? null` when a country is missing this cycle.
  for (const bad of [null, undefined, 'str', 42, []]) {
    assert.deepEqual(findLeakedPrePublishFields(RAW, PUBLISHED, bad), []);
    assert.deepEqual(findLeakedPrePublishFields(bad, PUBLISHED, { a: 1 }), []);
  }
});

test('the byte ceiling sits above every real payload and below the incident', () => {
  // Full production scan 2026-07-14: largest seeded value is 3.14 MB
  // (health:vpd-tracker:realtime:v1). The incident was 11,467,558 bytes.
  const LARGEST_REAL = 3_144_590;
  const INCIDENT = 11_467_558;

  assert.ok(MAX_SEEDED_VALUE_BYTES > LARGEST_REAL * 2, 'must leave headroom for normal growth');
  assert.ok(MAX_SEEDED_VALUE_BYTES < INCIDENT, 'must still refuse the 11.5 MB payload');
});

test('the byte ceiling measures the UTF-8 value Redis receives, not JavaScript code units', () => {
  const payload = { prose: '漢'.repeat(3_000_000) };

  assert.ok(JSON.stringify(payload).length < MAX_SEEDED_VALUE_BYTES, 'fixture stays below the ceiling in UTF-16 code units');
  assert.ok(extraKeyPayloadBytes('test:unicode:v1', payload) > MAX_SEEDED_VALUE_BYTES, 'fixture exceeds the ceiling in UTF-8 bytes');
});
