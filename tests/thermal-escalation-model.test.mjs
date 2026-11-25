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

  it('takes cluster country and context from the detection country label', () => {
    const nowMs = Date.UTC(2026, 2, 17, 12, 0, 0);
    const result = computeThermalEscalationWatch([
      makeDetection('iq', 30.2813, 47.3688, nowMs - 60 * 60 * 1000, { region: 'Iraq' }),
      makeDetection('ae', 24.45, 54.38, nowMs - 60 * 60 * 1000, { region: 'United Arab Emirates' }),
      makeDetection('sea', 24.85722, 53.71148, nowMs - 60 * 60 * 1000, { region: 'Other' }),
    ], emptyThermalEscalationWatch(), { nowMs });
    const byRegion = Object.fromEntries(result.watch.clusters.map((c) => [c.regionLabel, c]));
    assert.equal(byRegion.Iraq.countryCode, 'IQ');
    assert.equal(byRegion.Iraq.countryName, 'Iraq');
    assert.equal(byRegion.Iraq.context, 'THERMAL_CONTEXT_CONFLICT_ADJACENT');
    assert.equal(byRegion['United Arab Emirates'].countryCode, 'AE');
    assert.equal(byRegion['United Arab Emirates'].context, 'THERMAL_CONTEXT_WILDLAND');
    assert.equal(byRegion.Other.countryCode, 'XX');
    assert.equal(byRegion.Other.context, 'THERMAL_CONTEXT_WILDLAND');
  });

  it('keeps a separate baseline for each country when clusters on both sides of a border share a cell', () => {
    const hour = 60 * 60 * 1000;
    const run1Ms = Date.UTC(2026, 2, 17, 12, 0, 0);
    const run2Ms = run1Ms + 3 * hour;
    const side = (prefix, region, lat, lon, count, frp, atMs) => Array.from({ length: count }, (_, i) =>
      makeDetection(`${prefix}${i}`, lat + i * 0.001, lon, atMs - hour, { region, frp }));
    const run1 = computeThermalEscalationWatch([
      ...side('iq', 'Iraq', 30.25, 47.4, 4, 20, run1Ms),
      ...side('ir', 'Iran', 30.3, 47.6, 4, 20, run1Ms),
    ], emptyThermalEscalationWatch(), { nowMs: run1Ms });
    const run2 = computeThermalEscalationWatch(
      side('iq2-', 'Iraq', 30.25, 47.4, 6, 140 / 6, run2Ms),
      run1.history,
      { nowMs: run2Ms },
    );
    const [iraq] = run2.watch.clusters;
    assert.equal(iraq.baselineExpectedCount, 4);
    assert.equal(iraq.baselineExpectedFrp, 80);
    assert.equal(iraq.frpDelta, 60);
  });

  it('takes the Lebanon context as conflict-adjacent', () => {
    const nowMs = Date.UTC(2026, 2, 17, 12, 0, 0);
    const result = computeThermalEscalationWatch([
      makeDetection('lb', 33.27, 35.4, nowMs - 60 * 60 * 1000, { region: 'Lebanon' }),
    ], emptyThermalEscalationWatch(), { nowMs });
    assert.equal(result.watch.clusters[0].countryCode, 'LB');
    assert.equal(result.watch.clusters[0].context, 'THERMAL_CONTEXT_CONFLICT_ADJACENT');
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

  it('does not page CWFIS prescribed burns as thermal emergencies', () => {
    const nowMs = Date.UTC(2026, 7, 13, 12, 0, 0);
    const prescribed = {
      ...makeDetection('cwfis:prescribed:2026_PC_2026JA2', 52.8813, -118.1002, nowMs, {
        region: 'Parks Canada',
        frp: 999,
        brightness: 400,
      }),
      kind: 'prescribed',
      emergency: false,
      source: 'cwfis',
    };
    const result = computeThermalEscalationWatch([prescribed], { cells: {} }, { nowMs });
    assert.equal(result.watch.clusters.length, 0);
  });
});
