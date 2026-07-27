import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';

const findTool = (name) => CACHE_TOOLS.find((t) => t.name === name);

describe('get_temporal_anomalies cache tool', () => {
  const tool = findTool('get_temporal_anomalies');

  const snapshot = () => ({
    snapshot: {
      anomalies: [
        { type: 'news', region: 'Middle East', currentCount: 90, expectedCount: 30, zScore: 3.4, severity: 'critical', multiplier: 3.0, message: 'News velocity 3.0x normal' },
        { type: 'news', region: 'Europe', currentCount: 45, expectedCount: 30, zScore: 2.1, severity: 'high', multiplier: 1.5, message: 'News velocity 1.5x normal' },
        { type: 'satellite_fires', region: 'Southeast Asia', currentCount: 22, expectedCount: 15, zScore: 1.7, severity: 'medium', multiplier: 1.5, message: 'Fires 1.5x normal' },
      ],
      trackedTypes: ['news', 'satellite_fires'],
      computedAt: '2026-07-28T00:00:00.000Z',
    },
  });

  it('is registered with the cache-tool contract fields', () => {
    assert.ok(tool, 'tool must exist in CACHE_TOOLS');
    assert.deepEqual(tool._cacheKeys, ['temporal:anomalies:v1']);
    assert.equal(tool._seedMetaKey, 'seed-meta:temporal:anomalies');
    assert.equal(tool._maxStaleMin, 45);
    assert.deepEqual(tool._apiPaths, []);
    assert.equal(tool._outputBudgetBytes, 65536);
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
  });

  it('filters by stream type', () => {
    const data = snapshot();
    tool._postFilter(data, { type: 'news' });
    assert.equal(data.snapshot.anomalies.length, 2);
    assert.ok(data.snapshot.anomalies.every((a) => a.type === 'news'));
  });

  it('filters by region case-insensitively', () => {
    const data = snapshot();
    tool._postFilter(data, { region: 'middle east' });
    assert.equal(data.snapshot.anomalies.length, 1);
    assert.equal(data.snapshot.anomalies[0].region, 'Middle East');
  });

  it('applies the min_severity floor', () => {
    const data = snapshot();
    tool._postFilter(data, { min_severity: 'high' });
    assert.deepEqual(
      data.snapshot.anomalies.map((a) => a.severity).sort(),
      ['critical', 'high'],
    );
  });

  it('caps at 30 by default and honors limit 0 as no cap', () => {
    const wide = {
      snapshot: {
        anomalies: Array.from({ length: 40 }, (_, i) => ({
          type: 'news', region: `R${i}`, currentCount: i, expectedCount: 1,
          zScore: 2.5, severity: 'high', multiplier: 2, message: 'm',
        })),
        trackedTypes: ['news'],
        computedAt: '2026-07-28T00:00:00.000Z',
      },
    };
    const capped = structuredClone(wide);
    tool._postFilter(capped, {});
    assert.equal(capped.snapshot.anomalies.length, 30);

    const uncapped = structuredClone(wide);
    tool._postFilter(uncapped, { limit: 0 });
    assert.equal(uncapped.snapshot.anomalies.length, 40);
  });

  it('tolerates a null payload', () => {
    const data = { snapshot: null };
    assert.doesNotThrow(() => tool._postFilter(data, { type: 'news' }));
  });
});

describe('get_test_site_seismicity cache tool', () => {
  const tool = findTool('get_test_site_seismicity');

  const quake = (over = {}) => ({
    id: 'q1', place: 'somewhere', magnitude: 4.2, depthKm: 5,
    location: { latitude: 41.28, longitude: 129.09 }, occurredAt: 1753600000000,
    ...over,
  });

  const payload = () => ({
    earthquakes: {
      earthquakes: [
        quake({ id: 'p1', nearTestSite: true, testSiteName: 'Punggye-ri', concernScore: 82, concernLevel: 'critical', magnitude: 5.1 }),
        quake({ id: 'p2', nearTestSite: true, testSiteName: 'Punggye-ri', concernScore: 44, concernLevel: 'moderate', magnitude: 3.9 }),
        quake({ id: 'l1', nearTestSite: true, testSiteName: 'Lop Nur', concernScore: 61, concernLevel: 'elevated' }),
        quake({ id: 'bg', place: 'unrelated ocean ridge' }),
      ],
    },
  });

  it('is registered with the cache-tool contract fields', () => {
    assert.ok(tool, 'tool must exist in CACHE_TOOLS');
    assert.deepEqual(tool._cacheKeys, ['seismology:earthquakes:v1']);
    assert.equal(tool._seedMetaKey, 'seed-meta:seismology:earthquakes');
    assert.equal(tool._maxStaleMin, 30);
    assert.deepEqual(tool._apiPaths, []);
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
  });

  it('keeps only test-site-relevant events', () => {
    const data = payload();
    tool._postFilter(data, {});
    assert.deepEqual(data.earthquakes.earthquakes.map((q) => q.id), ['p1', 'p2', 'l1']);
  });

  it('filters by site substring case-insensitively', () => {
    const data = payload();
    tool._postFilter(data, { site: 'punggye' });
    assert.deepEqual(data.earthquakes.earthquakes.map((q) => q.id), ['p1', 'p2']);
  });

  it('applies the min_concern floor with the documented ordering', () => {
    const data = payload();
    tool._postFilter(data, { min_concern: 'elevated' });
    assert.deepEqual(data.earthquakes.earthquakes.map((q) => q.id), ['p1', 'l1']);
  });

  it('computes the per-site rollup from the filtered set, sorted by concern', () => {
    const data = payload();
    tool._postFilter(data, {});
    const summary = data.earthquakes.siteSummary;
    assert.equal(summary.length, 2);
    assert.deepEqual(summary[0], {
      site: 'Punggye-ri', eventCount: 2, maxConcernScore: 82,
      maxConcernLevel: 'critical', maxMagnitude: 5.1,
    });
    assert.equal(summary[1].site, 'Lop Nur');
  });

  it('caps the event list but keeps the full rollup', () => {
    const data = {
      earthquakes: {
        earthquakes: Array.from({ length: 35 }, (_, i) =>
          quake({ id: `e${i}`, nearTestSite: true, testSiteName: `Site ${i % 3}`, concernScore: 10 + i, concernLevel: 'low' })),
      },
    };
    tool._postFilter(data, {});
    assert.equal(data.earthquakes.earthquakes.length, 30);
    assert.equal(data.earthquakes.siteSummary.length, 3);
    const totalCounted = data.earthquakes.siteSummary.reduce((n, s) => n + s.eventCount, 0);
    assert.equal(totalCounted, 35, 'rollup must be computed before the list cap');
  });

  it('tolerates a null payload', () => {
    const data = { earthquakes: null };
    assert.doesNotThrow(() => tool._postFilter(data, { site: 'x' }));
  });
});
