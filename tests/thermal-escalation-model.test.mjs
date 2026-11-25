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

  it('records one history sample per cell when clusters on both sides of a border share it', () => {
    const nowMs = Date.UTC(2026, 2, 17, 12, 0, 0);
    const result = computeThermalEscalationWatch([
      makeDetection('iq', 30.25, 47.4, nowMs - 60 * 60 * 1000, { region: 'Iraq', frp: 20 }),
      makeDetection('ir', 30.3, 47.6, nowMs - 60 * 60 * 1000, { region: 'Iran', frp: 30 }),
    ], emptyThermalEscalationWatch(), { nowMs });
    assert.equal(result.watch.clusters.length, 2);
    assert.deepEqual(result.history.cells['30.5:47.5'].entries.map((e) => [e.observationCount, e.totalFrp]), [[2, 50]]);
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
