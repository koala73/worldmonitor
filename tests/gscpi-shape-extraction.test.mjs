import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractGscpiObservations } from '../scripts/seed-economy.mjs';

describe('extractGscpiObservations', () => {
  it('reads the ais-relay FRED-compatible shape (observations under .series)', () => {
    // This is the actual shape ais-relay.cjs writes — see seedGscpi() in that file.
    const parsed = {
      series: {
        series_id: 'GSCPI',
        title: 'Global Supply Chain Pressure Index',
        units: 'Standard Deviations',
        frequency: 'Monthly',
        observations: [
          { date: '2026-02-01', value: 0.42 },
          { date: '2026-03-01', value: 0.68 },
        ],
      },
    };
    const result = extractGscpiObservations(parsed);
    assert.ok(result, 'should return non-null');
    assert.equal(result.observations.length, 2);
    assert.equal(result.observations[1].value, 0.68);
  });

  it('reads the legacy flat shape (top-level observations) for back-compat', () => {
    // Earlier ais-relay versions stored this shape — keep working if any
    // long-lived Redis key still has it.
    const parsed = {
      observations: [
        { date: '2026-03-01', value: 0.68 },
      ],
    };
    const result = extractGscpiObservations(parsed);
    assert.ok(result, 'should return non-null');
    assert.equal(result.observations.length, 1);
  });

  it('returns null when neither shape is present', () => {
    assert.equal(extractGscpiObservations(null), null);
    assert.equal(extractGscpiObservations({}), null);
    assert.equal(extractGscpiObservations({ series: {} }), null);
    assert.equal(extractGscpiObservations({ observations: 'not-an-array' }), null);
    assert.equal(extractGscpiObservations({ series: { observations: 'nope' } }), null);
  });
});
