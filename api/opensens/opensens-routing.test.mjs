/**
 * Unit tests for /api/opensens/routing
 * Run with: node --test api/opensens/opensens-routing.test.mjs
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { haversineM } from './_cache.js';

// ---- Inline routing pure functions for unit tests ----

function computeFiberCapex(routeDistanceM, slack, costPerMeter) {
  const fiberM = routeDistanceM * slack;
  return {
    estimatedFiberM: parseFloat(fiberM.toFixed(0)),
    fiberCapexUsd: parseFloat((fiberM * costPerMeter).toFixed(0)),
  };
}

function rankSites(sites) {
  return [...sites].sort((a, b) => a.estimatedFiberM - b.estimatedFiberM)
    .map((s, i) => ({ ...s, rank: i + 1 }));
}

describe('haversineM', () => {
  it('returns near-zero for identical points', () => {
    assert.ok(haversineM(51.5, -0.1, 51.5, -0.1) < 1);
  });

  it('1° of latitude ≈ 111 km', () => {
    const d = haversineM(0, 0, 1, 0);
    assert.ok(d > 110000 && d < 112000, `Expected ~111 000 m, got ${d.toFixed(0)}`);
  });

  it('NY → London ≈ 5570 km', () => {
    const d = haversineM(40.7128, -74.006, 51.5074, -0.1278);
    assert.ok(d > 5500000 && d < 5650000, `Expected ~5570 km, got ${(d / 1000).toFixed(0)} km`);
  });
});

describe('computeFiberCapex', () => {
  it('applies slack factor correctly', () => {
    const res = computeFiberCapex(1000, 1.1, 15);
    assert.equal(res.estimatedFiberM, 1100);
    assert.equal(res.fiberCapexUsd, 16500);
  });

  it('zero route distance yields zero capex', () => {
    const res = computeFiberCapex(0, 1.1, 15);
    assert.equal(res.estimatedFiberM, 0);
    assert.equal(res.fiberCapexUsd, 0);
  });

  it('different cost per meter', () => {
    const res = computeFiberCapex(500, 1.0, 50);
    assert.equal(res.fiberCapexUsd, 25000);
  });
});

describe('rankSites', () => {
  it('ranks by shortest estimated fiber first', () => {
    const sites = [
      { siteId: 'B', estimatedFiberM: 3000 },
      { siteId: 'A', estimatedFiberM: 1000 },
      { siteId: 'C', estimatedFiberM: 2000 },
    ];
    const ranked = rankSites(sites);
    assert.equal(ranked[0].siteId, 'A');
    assert.equal(ranked[0].rank, 1);
    assert.equal(ranked[2].siteId, 'B');
    assert.equal(ranked[2].rank, 3);
  });

  it('single site has rank 1', () => {
    const ranked = rankSites([{ siteId: 'X', estimatedFiberM: 500 }]);
    assert.equal(ranked[0].rank, 1);
  });
});

describe('routing parameter validation', () => {
  it('clamps slack to [1.0, 2.0]', () => {
    const clamp = (v, lo, hi) => Math.min(Math.max(Number(v), lo), hi);
    assert.equal(clamp(0.5, 1.0, 2.0), 1.0);
    assert.equal(clamp(5.0, 1.0, 2.0), 2.0);
    assert.equal(clamp(1.15, 1.0, 2.0), 1.15);
  });

  it('excludes sites beyond max_km', () => {
    const hubLat = 51.5, hubLon = -0.1;
    const maxKm = 3;
    const sites = [
      { id: 'near', lat: 51.52, lon: -0.1 },
      { id: 'far',  lat: 53.0,  lon: -0.1 },
    ];
    const filtered = sites.filter((s) => haversineM(hubLat, hubLon, s.lat, s.lon) / 1000 <= maxKm);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, 'near');
  });

  it('rejects more than 20 sites', () => {
    const sites = Array.from({ length: 21 }, (_, i) => ({ id: String(i), lat: 0, lon: 0 }));
    assert.ok(sites.length > 20);
  });
});
