// Acceptance criterion 2 of issue #5870: extractWildfireEscalation must produce
// a signal from a realistic wildfire:fires:v1 payload.
//
// It could not, for three independent reasons stacked on one key:
//   1. the key is contract-mode, so the extractor was handed { _seed, data };
//   2. it read `payload.fires`, but seed-fire-detections.mjs:118 publishes
//      `fireDetections`;
//   3. it read `f.radiativePower > 5000` and `f.severity === 'extreme'`, but a
//      detection carries `frp` (MW, seed-fire-detections.mjs:96) and has no
//      severity field at all — and 5000 MW is two orders above what FIRMS
//      reports for these detections.
//
// Only the `brightness > 400` clause was ever correct, which is why the signal
// looked plausible in review and produced nothing in production.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractWildfireEscalation } from '../scripts/seed-cross-source-signals.mjs';
import { unwrapEnvelope } from '../scripts/_seed-envelope-source.mjs';

const KEY = 'wildfire:fires:v1';
const now = Date.now();

// Field-for-field the record seed-fire-detections.mjs:93-107 builds from a
// FIRMS VIIRS row.
function detection({ index = 0, region = 'Ukraine', brightness = 366.1, frp = 42.7 }) {
  return {
    id: `48.${index}-37.5-2026-07-30-0312`,
    location: { latitude: 48 + index / 10, longitude: 37.5 },
    brightness,
    frp,
    confidence: 'FIRE_CONFIDENCE_HIGH',
    satellite: 'N',
    detectedAt: now - 3 * 3600 * 1000,
    region,
    dayNight: 'D',
    // frp > 80 && brightness > 380 — the writer's own significance flag.
    possibleExplosion: frp > 80 && brightness > 380,
  };
}

// What runSeed stores for a contract-mode key (_seed-utils.mjs:499), read back
// the way readAllSourceKeys now reads it.
function storedAsSeeded(payload) {
  const envelope = {
    _seed: { fetchedAt: now, sourceVersion: 'firms-viirs-v1', schemaVersion: 1, recordCount: payload.fireDetections.length },
    data: payload,
  };
  return unwrapEnvelope(JSON.parse(JSON.stringify(envelope))).data;
}

describe('extractWildfireEscalation on a realistic wildfire:fires:v1 payload', () => {
  it('fires on a cluster of explosion-grade detections in one monitored region', () => {
    const payload = {
      fireDetections: Array.from({ length: 6 }, (_, i) =>
        detection({ index: i, region: 'Ukraine', brightness: 392.4, frp: 145.2 })),
      pagination: undefined,
    };

    const signals = extractWildfireEscalation({ [KEY]: storedAsSeeded(payload) });

    assert.equal(signals.length, 1);
    assert.equal(signals[0].type, 'CROSS_SOURCE_SIGNAL_TYPE_WILDFIRE_ESCALATION');
    assert.equal(signals[0].theater, 'Eastern Europe');
    assert.match(signals[0].summary, /6 extreme thermal detections in Eastern Europe/);
    assert.equal(signals[0].severity, 'CROSS_SOURCE_SIGNAL_SEVERITY_MEDIUM');
  });

  it('fires on brightness alone, the one clause that was already correct', () => {
    const payload = {
      fireDetections: Array.from({ length: 6 }, (_, i) =>
        // frp below the explosion flag, brightness above 400.
        detection({ index: i, region: 'Saudi Arabia', brightness: 415.8, frp: 24.1 })),
    };

    const signals = extractWildfireEscalation({ [KEY]: storedAsSeeded(payload) });
    assert.equal(signals.length, 1);
    assert.equal(signals[0].theater, 'Middle East');
  });

  it('stays silent on ordinary agricultural burns', () => {
    const payload = {
      fireDetections: Array.from({ length: 20 }, (_, i) =>
        detection({ index: i, region: 'Turkey', brightness: 341.2, frp: 12.5 })),
    };

    assert.deepEqual(extractWildfireEscalation({ [KEY]: storedAsSeeded(payload) }), []);
  });

  it('holds the per-region floor: four detections are not an escalation', () => {
    const payload = {
      fireDetections: Array.from({ length: 4 }, (_, i) =>
        detection({ index: i, region: 'Ukraine', brightness: 392.4, frp: 145.2 })),
    };

    assert.deepEqual(extractWildfireEscalation({ [KEY]: storedAsSeeded(payload) }), []);
  });

  it('produces nothing from the envelope itself, which is what production saw', () => {
    const payload = {
      fireDetections: Array.from({ length: 6 }, (_, i) =>
        detection({ index: i, region: 'Ukraine', brightness: 392.4, frp: 145.2 })),
    };
    const envelope = { _seed: { fetchedAt: now }, data: payload };

    assert.deepEqual(extractWildfireEscalation({ [KEY]: envelope }), []);
  });

  it('tolerates a payload with no detections', () => {
    assert.deepEqual(extractWildfireEscalation({ [KEY]: storedAsSeeded({ fireDetections: [] }) }), []);
    assert.deepEqual(extractWildfireEscalation({}), []);
  });
});
