import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  clusterDetections,
  computeThermalEscalationWatch,
  emptyThermalEscalationWatch,
} from '../scripts/lib/thermal-escalation.mjs';

function makeDetection(id, lat, lon, detectedAt, overrides = {}) {
  return {
    id,
    location: { latitude: lat, longitude: lon },
    brightness: overrides.brightness ?? 360,
    frp: overrides.frp ?? 30,
    satellite: overrides.satellite ?? 'VIIRS_SNPP_NRT',
    detectedAt,
    region: overrides.region ?? 'Ukraine',
    dayNight: overrides.dayNight ?? 'N',
  };
}

describe('thermal escalation model', () => {
  it('clusters nearby detections together by region', () => {
    const clusters = clusterDetections([
      makeDetection('a', 50.45, 30.52, 1),
      makeDetection('b', 50.46, 30.54, 2),
      makeDetection('c', 41.0, 29.0, 3, { region: 'Turkey' }),
    ]);

    assert.equal(clusters.length, 2);
    assert.equal(clusters[0].detections.length, 2);
    assert.equal(clusters[1].detections.length, 1);
  });

  it('builds an elevated or stronger conflict-adjacent cluster from raw detections', () => {
    const nowMs = Date.UTC(2026, 2, 17, 12, 0, 0);
    const detections = [
      makeDetection('a', 50.45, 30.52, nowMs - 90 * 60 * 1000, { frp: 35 }),
      makeDetection('b', 50.46, 30.53, nowMs - 80 * 60 * 1000, { frp: 42, satellite: 'VIIRS_NOAA20_NRT' }),
      makeDetection('c', 50.47, 30.55, nowMs - 70 * 60 * 1000, { frp: 38 }),
      makeDetection('d', 50.45, 30.56, nowMs - 60 * 60 * 1000, { frp: 44 }),
      makeDetection('e', 50.44, 30.57, nowMs - 50 * 60 * 1000, { frp: 48 }),
    ];

    const previousHistory = {
      cells: {
        '50.5:30.5': {
          entries: [
            { observedAt: '2026-03-16T12:00:00.000Z', observationCount: 1, totalFrp: 10, status: 'THERMAL_STATUS_NORMAL' },
            { observedAt: '2026-03-15T12:00:00.000Z', observationCount: 1, totalFrp: 12, status: 'THERMAL_STATUS_NORMAL' },
          ],
        },
      },
    };

    const result = computeThermalEscalationWatch(detections, previousHistory, { nowMs });
    assert.equal(result.watch.clusters.length, 1);
    const cluster = result.watch.clusters[0];
    assert.equal(cluster.countryCode, 'UA');
    assert.equal(cluster.context, 'THERMAL_CONTEXT_CONFLICT_ADJACENT');
    assert.ok(['THERMAL_STATUS_ELEVATED', 'THERMAL_STATUS_SPIKE', 'THERMAL_STATUS_PERSISTENT'].includes(cluster.status));
    assert.ok(cluster.totalFrp > cluster.baselineExpectedFrp);
  });

  it('returns an empty watch shape when no data exists', () => {
    const empty = emptyThermalEscalationWatch();
    assert.deepEqual(empty.summary, {
      clusterCount: 0,
      elevatedCount: 0,
      spikeCount: 0,
      persistentCount: 0,
      conflictAdjacentCount: 0,
      highRelevanceCount: 0,
    });
    assert.equal(empty.clusters.length, 0);
  });
});
