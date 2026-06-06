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

const XSS_KEY = 'intelligence:cross-source-signals:v1';

// The real Redis shape: { _seed: {...}, data: { signals: [...] } }, with the
// enum-form severity strings the seeder actually emits.
function envelopedSignals() {
  return {
    _seed: { fetchedAt: Date.now(), recordCount: 3, sourceVersion: 'cross-source-v1', schemaVersion: 1, state: 'OK' },
    data: {
      evaluatedAt: Date.now(),
      compositeCount: 3,
      signals: [
        { id: 'sig1', type: 'CROSS_SOURCE_SIGNAL_TYPE_MILITARY_FLIGHT_SURGE', theater: 'Middle East', severity: 'CROSS_SOURCE_SIGNAL_SEVERITY_CRITICAL', severityScore: 90 },
        { id: 'sig2', type: 'CROSS_SOURCE_SIGNAL_TYPE_GPS_JAMMING', theater: 'Middle East', severity: 'CROSS_SOURCE_SIGNAL_SEVERITY_HIGH', severityScore: 70 },
        { id: 'sig3', type: 'CROSS_SOURCE_SIGNAL_TYPE_NEWS_SPIKE', theater: 'Middle East', severity: 'CROSS_SOURCE_SIGNAL_SEVERITY_HIGH', severityScore: 60 },
      ],
    },
  };
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

test('unwrapEnvelope passes through objects that lack _seed or data', () => {
  const onlyData = { data: { a: 1 } };          // no _seed → not an envelope
  const onlySeed = { _seed: { fetchedAt: 1 } }; // no data  → not an envelope
  assert.equal(unwrapEnvelope(onlyData), onlyData);
  assert.equal(unwrapEnvelope(onlySeed), onlySeed);
});

test('unwrapEnvelope passes through arrays, null, and primitives', () => {
  const arr = [1, 2, 3];
  assert.equal(unwrapEnvelope(arr), arr);
  assert.equal(unwrapEnvelope(null), null);
  assert.equal(unwrapEnvelope(7), 7);
  assert.equal(unwrapEnvelope('s'), 's');
  // an envelope whose data is null still unwraps to null (data present)
  assert.equal(unwrapEnvelope({ _seed: {}, data: null }), null);
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
