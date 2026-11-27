// The correlation seeder's clusterByProximity is a copy of
// CorrelationEngine.clusterByProximity (src/services/correlation-engine/engine.ts),
// and it carried the same grid defect: each signal's column width came from its own
// latitude, so in-radius neighbours at different latitudes could land outside the
// 3x3 scan and never be compared. These cases pin the seeder to brute-force
// pairwise clustering, the same contract the engine's tests pin.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clusterByProximity } from '../scripts/seed-correlation.mjs';
import { haversineKm } from '../shared/geo-distance.ts';

const signalAt = (lat, lon, label) => ({ type: 'test', source: 'test', severity: 50, lat, lon, timestamp: 0, label });

// Cluster labels as a sorted list of sorted groups, so two partitions compare by value.
const partition = (clusters) =>
  clusters.map((c) => c.signals.map((s) => s.label).sort()).sort((a, b) => a.join().localeCompare(b.join()));

const bruteForce = (signals, radiusKm) => {
  const parent = signals.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < signals.length; i++) {
    for (let j = i + 1; j < signals.length; j++) {
      const a = signals[i], b = signals[j];
      if (haversineKm(a.lat, a.lon, b.lat, b.lon) <= radiusKm) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  signals.forEach((s, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), s]));
  return [...groups.values()].filter((g) => g.length >= 2).map((g) => ({ signals: g }));
};

describe('seed-correlation clusterByProximity', () => {
  it('clusters two signals 455 km apart at different latitudes', () => {
    const a = signalAt(32.44, 139, 'a');
    const b = signalAt(36.53, 139, 'b');
    assert.ok(haversineKm(a.lat, a.lon, b.lat, b.lon) < 500);
    assert.deepEqual(partition(clusterByProximity([a, b], 500)), [['a', 'b']]);
  });

  it('clusters a near-pole pair far apart in longitude, in either input order', () => {
    // 120° of longitude at 89.5°N is ~96 km; the row is near enough the pole that
    // the column scan must fall back to every column.
    const a = signalAt(89.5, 0, 'a');
    const b = signalAt(89.5, 120, 'b');
    assert.deepEqual(partition(clusterByProximity([a, b], 500)), [['a', 'b']]);
    assert.deepEqual(partition(clusterByProximity([b, a], 500)), [['a', 'b']]);
  });

  it('returns no clusters for a non-positive radius instead of scanning forever', () => {
    // A zero cell size makes the column span infinite; the guard must return first.
    const pair = [signalAt(10, 10, 'a'), signalAt(10, 10, 'b')];
    assert.deepEqual(clusterByProximity(pair, 0), []);
    assert.deepEqual(clusterByProximity(pair, -5), []);
  });

  it('matches brute-force pairwise clustering from mid latitudes to the poles', () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    // Longitudes stay clear of the antimeridian seam, which the grid does not wrap.
    const regions = [
      { lat: [25, 45], lon: [120, 150] },
      { lat: [50, 75], lon: [100, 170] },
      { lat: [80, 89.9], lon: [-150, 150] },
      { lat: [-60, -40], lon: [-80, -40] },
    ];
    for (const region of regions) {
      for (let scene = 0; scene < 100; scene++) {
        const signals = Array.from({ length: 12 }, (_, i) => signalAt(
          region.lat[0] + rand() * (region.lat[1] - region.lat[0]),
          region.lon[0] + rand() * (region.lon[1] - region.lon[0]),
          `s${i}`,
        ));
        assert.deepEqual(partition(clusterByProximity(signals, 500)), partition(bruteForce(signals, 500)));
      }
    }
  });
});
