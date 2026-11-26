import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { finalizeObservationGroup, toSafecastObservation } from '../scripts/seed-radiation-watch.mjs';

const FUKUSHIMA = { anchorId: 'jp-fukushima', name: 'Fukushima', country: 'Japan', lat: 37.7608, lon: 140.4747 };
const HOUR = 60 * 60 * 1000;

function measurements(values) {
  const start = Date.now() - values.length * HOUR;
  return values.map((value, i) => ({
    id: i + 1,
    locationName: 'Fukushima',
    observedAt: start + i * HOUR,
    lat: FUKUSHIMA.lat,
    lon: FUKUSHIMA.lon,
    value,
    unit: 'nSv/h',
    convertedFromCpm: false,
    directUnit: true,
  }));
}

function published(values) {
  const observation = toSafecastObservation(FUKUSHIMA, measurements(values));
  return JSON.parse(JSON.stringify(finalizeObservationGroup([observation])));
}

describe('radiation watch z-score availability', () => {
  it('marks the z-score unavailable when the baseline has too few samples', () => {
    const observation = published([68, 69.2, 68.6, 74.3]);
    assert.equal(observation.delta, 5.7);
    assert.equal(observation.zScoreAvailable, false);
  });

  it('marks the z-score unavailable when the baseline has zero variance', () => {
    const observation = published([...Array(30).fill(68.5), 74.5]);
    assert.equal(observation.delta, 6);
    assert.equal(observation.zScoreAvailable, false);
  });

  it('publishes the z-score when the baseline can standardize the reading', () => {
    const baseline = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 67.6 : 69.6));
    const observation = published([...baseline, 74.3]);
    assert.equal(observation.zScoreAvailable, true);
    assert.equal(observation.zScore, 5.6);
  });
});
