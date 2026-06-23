// Regional-snapshot envelope unwrap — regression test.
//
// Production bug (2026-06-06): the relay's envelopeWrite-based seeders store
// several balance-vector inputs as `{ _seed, data }` envelopes, but the compute
// modules read them flat (`xss.signals`, `fc.predictions`, `debt.entries`,
// `transitData.summaries`). So `coercive_pressure` scored 0 for EVERY region —
// the regime engine reported a flat `calm` even with active wars in Iran and
// Ukraine. The existing computeBalanceVector tests fed the FLAT shape, so they
// passed while production silently dropped the inputs.
//
// `readAllInputs` now unwraps the envelope at the loader via `unwrapEnvelope`.
// These tests pin the unwrap helper AND prove the end-to-end effect on
// coercive_pressure using the REAL enveloped payload shape from Redis.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unwrapEnvelope } from '../scripts/regional-snapshot/_helpers.mjs';
import { computeBalanceVector } from '../scripts/regional-snapshot/balance-vector.mjs';
import { scoreActors } from '../scripts/regional-snapshot/actor-scoring.mjs';
import { buildScenarioSets } from '../scripts/regional-snapshot/scenario-builder.mjs';

const XSS_KEY = 'intelligence:cross-source-signals:v1';
const FORECAST_KEY = 'forecast:predictions:v2';
const DEBT_KEY = 'economic:national-debt:v1';
const MACRO_KEY = 'economic:macro-signals:v1';
const CHOKEPOINT_KEY = 'supply_chain:chokepoints:v4';
const TRANSIT_KEY = 'supply_chain:transit-summaries:v1';

function seedEnvelope(data, sourceVersion = 'test-v1') {
  return {
    _seed: { fetchedAt: Date.now(), recordCount: 1, sourceVersion, schemaVersion: 1, state: 'OK' },
    data,
  };
}

// The real Redis shape: { _seed: {...}, data: { signals: [...] } }, with the
// enum-form severity strings the seeder actually emits.
function envelopedSignals() {
  return seedEnvelope({
    evaluatedAt: Date.now(),
    compositeCount: 3,
    signals: [
      { id: 'sig1', type: 'CROSS_SOURCE_SIGNAL_TYPE_MILITARY_FLIGHT_SURGE', theater: 'Middle East', severity: 'CROSS_SOURCE_SIGNAL_SEVERITY_CRITICAL', severityScore: 90 },
      { id: 'sig2', type: 'CROSS_SOURCE_SIGNAL_TYPE_GPS_JAMMING', theater: 'Middle East', severity: 'CROSS_SOURCE_SIGNAL_SEVERITY_HIGH', severityScore: 70 },
      { id: 'sig3', type: 'CROSS_SOURCE_SIGNAL_TYPE_NEWS_SPIKE', theater: 'Middle East', severity: 'CROSS_SOURCE_SIGNAL_SEVERITY_HIGH', severityScore: 60 },
    ],
  }, 'cross-source-v1');
}

function envelopedForecasts() {
  return seedEnvelope({
    generatedAt: Date.now(),
    predictions: [
      {
        id: 'forecast-mena-1',
        region: 'Middle East',
        trend: 'rising',
        domain: 'military',
        probability: 0.9,
        confidence: 0.8,
        timeHorizon: 'h24',
        caseFile: { summary: 'Iran military alliance coordination near Hormuz' },
      },
    ],
  }, 'forecast-v2');
}

function envelopedDebt() {
  return seedEnvelope({
    seededAt: new Date().toISOString(),
    entries: [
      { iso3: 'IRN', debtToGdp: 180 },
      { iso3: 'ISR', debtToGdp: 160 },
      { iso3: 'SAU', debtToGdp: 150 },
    ],
  }, 'national-debt-v1');
}

function envelopedTransitSummaries() {
  return seedEnvelope({
    fetchedAt: Date.now(),
    summaries: {
      hormuz: { todayTotal: 25, wowChangePct: -100 },
    },
  }, 'transit-summaries-v1');
}

// ── unwrapEnvelope unit behavior ─────────────────────────────────────────────

test('unwrapEnvelope returns .data for a { _seed, data } envelope', () => {
  const env = envelopedSignals();
  const out = unwrapEnvelope(env);
  assert.equal(out, env.data);
  assert.ok(Array.isArray(out.signals));
  assert.equal(out.signals.length, 3);
});

test('unwrapEnvelope passes flat payloads through untouched', () => {
  const flat = { signals: [{ id: 'x' }] };
  assert.equal(unwrapEnvelope(flat), flat);
});

test('unwrapEnvelope passes through objects that lack _seed', () => {
  const onlyData = { data: { a: 1 } };          // no _seed → not an envelope
  assert.equal(unwrapEnvelope(onlyData), onlyData);
});

test('unwrapEnvelope follows canonical behavior for a valid _seed with no data field', () => {
  assert.equal(unwrapEnvelope({ _seed: { fetchedAt: 1 } }), undefined);
});

test('unwrapEnvelope passes through arrays, null, and primitives', () => {
  const arr = [1, 2, 3];
  assert.equal(unwrapEnvelope(arr), arr);
  assert.equal(unwrapEnvelope(null), null);
  assert.equal(unwrapEnvelope(7), 7);
  assert.equal(unwrapEnvelope('s'), 's');
  // a well-formed envelope whose data is null still unwraps to null
  assert.equal(unwrapEnvelope({ _seed: { fetchedAt: Date.now() }, data: null }), null);
});

test('unwrapEnvelope leaves malformed _seed objects visible as legacy payloads', () => {
  const malformed = { _seed: { sourceVersion: 'missing-fetched-at' }, data: { signals: [{ id: 'x' }] } };
  assert.equal(unwrapEnvelope(malformed), malformed);
});

// ── End-to-end: the bug and its fix ──────────────────────────────────────────

test('BUG REPRO: raw enveloped signals score coercive_pressure = 0', () => {
  // Feeding the raw envelope (what readAllInputs did before the fix) — the
  // compute reads `xss.signals` which is undefined inside an envelope.
  const sources = { [XSS_KEY]: envelopedSignals() };
  const { vector } = computeBalanceVector('mena', sources);
  assert.equal(vector.coercive_pressure, 0, 'raw envelope must reproduce the starved-coercive bug');
});

test('FIX: unwrapped signals score coercive_pressure > 0 for the war region', () => {
  // After the loader unwrap, the compute sees the flat { signals } payload.
  const sources = { [XSS_KEY]: unwrapEnvelope(envelopedSignals()) };
  const { vector } = computeBalanceVector('mena', sources);
  assert.ok(vector.coercive_pressure > 0, `unwrapped signals must drive coercive_pressure > 0, got ${vector.coercive_pressure}`);
  // and the CRITICAL signal is surfaced as a driver (enum-form severity matched)
  assert.ok(
    vector.pressures.some((d) => d.axis === 'coercive_pressure'),
    'a coercive_pressure driver must be emitted from the unwrapped signals',
  );
});

test('FIX: unwrap localizes signals to the right region (other regions unaffected)', () => {
  // Middle East signals must not leak into an unrelated region.
  const sources = { [XSS_KEY]: unwrapEnvelope(envelopedSignals()) };
  const mena = computeBalanceVector('mena', sources).vector;
  const latam = computeBalanceVector('latam', sources).vector;
  assert.ok(mena.coercive_pressure > 0, 'MENA (matching theater) must score coercive');
  assert.equal(latam.coercive_pressure, 0, 'LATAM (no matching theater) must stay 0');
});

test('FIX: unwrapped forecasts reach balance, actor, and scenario consumers', () => {
  const rawSources = { [FORECAST_KEY]: envelopedForecasts() };
  const fixedSources = { [FORECAST_KEY]: unwrapEnvelope(envelopedForecasts()) };

  const rawBalance = computeBalanceVector('mena', rawSources).vector;
  const fixedBalance = computeBalanceVector('mena', fixedSources).vector;
  assert.equal(rawBalance.coercive_pressure, 0, 'raw forecast envelope must starve forecast-driven coercive pressure');
  assert.ok(fixedBalance.coercive_pressure > rawBalance.coercive_pressure, 'unwrapped forecasts must affect coercive pressure');

  assert.equal(scoreActors('mena', rawSources).actors.length, 0, 'raw forecast envelope must starve actor extraction');
  assert.ok(scoreActors('mena', fixedSources).actors.some((actor) => actor.name === 'Iran'), 'unwrapped forecasts must feed actor extraction');

  const emptyTriggers = { active: [], watching: [], dormant: [] };
  const raw24h = buildScenarioSets('mena', rawSources, emptyTriggers).find((set) => set.horizon === '24h');
  const fixed24h = buildScenarioSets('mena', fixedSources, emptyTriggers).find((set) => set.horizon === '24h');
  const rawEscalation = raw24h?.lanes.find((lane) => lane.name === 'escalation')?.probability ?? 0;
  const fixedEscalation = fixed24h?.lanes.find((lane) => lane.name === 'escalation')?.probability ?? 0;
  assert.ok(fixedEscalation > rawEscalation, 'unwrapped forecasts must raise the matching scenario lane');
});

test('FIX: unwrapped national-debt entries drive capital_stress', () => {
  const base = { [MACRO_KEY]: { verdict: 'BUY' } };
  const rawSources = { ...base, [DEBT_KEY]: envelopedDebt() };
  const fixedSources = { ...base, [DEBT_KEY]: unwrapEnvelope(envelopedDebt()) };

  const raw = computeBalanceVector('mena', rawSources).vector;
  const fixed = computeBalanceVector('mena', fixedSources).vector;
  assert.equal(raw.capital_stress, 0, 'raw debt envelope must be ignored by debt entry reads');
  assert.ok(fixed.capital_stress > raw.capital_stress, 'unwrapped debt entries must raise capital_stress');
});

test('FIX: unwrapped transit summaries drive maritime_access throughput', () => {
  const chokepoints = { chokepoints: [{ id: 'hormuz', name: 'Strait of Hormuz', threatLevel: 'normal' }] };
  const rawSources = { [CHOKEPOINT_KEY]: chokepoints, [TRANSIT_KEY]: envelopedTransitSummaries() };
  const fixedSources = { [CHOKEPOINT_KEY]: chokepoints, [TRANSIT_KEY]: unwrapEnvelope(envelopedTransitSummaries()) };

  const raw = computeBalanceVector('mena', rawSources).vector;
  const fixed = computeBalanceVector('mena', fixedSources).vector;
  assert.ok(raw.maritime_access > fixed.maritime_access, 'raw transit envelope must miss the throughput collapse');
  assert.ok(fixed.maritime_access < 0.7, 'unwrapped transit summaries must lower maritime_access when throughput collapses');
});
