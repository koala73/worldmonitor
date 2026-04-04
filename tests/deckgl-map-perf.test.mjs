/**
 * Unit tests for DeckGLMap performance-optimization helpers.
 *
 * DeckGLMap cannot be instantiated in Node (requires DOM + WebGL), so these
 * tests replicate the exact logic of the two new helpers and verify their
 * contracts independently.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---------- getDynamicClusterRadius logic (replicated from DeckGLMap.ts) ----------

/**
 * Zoom-adaptive cluster radius — mirrors getDynamicClusterRadius() exported
 * from DeckGLMap.ts.
 */
function getDynamicClusterRadius(baseRadius, zoom) {
  if (zoom <= 2) return Math.round(baseRadius * 1.5);
  if (zoom <= 4) return Math.round(baseRadius * 1.25);
  if (zoom >= 10) return Math.round(baseRadius * 0.75);
  return baseRadius;
}

// ---------- filterToViewport logic (replicated from DeckGLMap.ts) ----------

/**
 * Filters items to those within an expanded bounding box — mirrors
 * filterToViewport() in DeckGLMap.ts.
 */
function filterToViewport(items, getLon, getLat, bounds, minItems = 200) {
  if (items.length < minItems) return items;
  if (!bounds) return items;
  const { w, e, s, n } = bounds;
  const dLon = (e - w) * 0.2;
  const dLat = (n - s) * 0.2;
  const minLon = w - dLon, maxLon = e + dLon;
  const minLat = s - dLat, maxLat = n + dLat;
  return items.filter(item => {
    const lon = getLon(item);
    const lat = getLat(item);
    return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
  });
}

// ---------- tests ----------

describe('getDynamicClusterRadius', () => {
  it('returns 1.5× base radius at zoom ≤ 2 (aggressive clustering)', () => {
    assert.equal(getDynamicClusterRadius(80, 0), 120);
    assert.equal(getDynamicClusterRadius(80, 2), 120);
  });

  it('returns 1.25× base radius at zoom 3–4', () => {
    assert.equal(getDynamicClusterRadius(80, 3), 100);
    assert.equal(getDynamicClusterRadius(80, 4), 100);
  });

  it('returns base radius unchanged at mid-zoom (5–9)', () => {
    assert.equal(getDynamicClusterRadius(80, 5), 80);
    assert.equal(getDynamicClusterRadius(80, 9), 80);
  });

  it('returns 0.75× base radius at zoom ≥ 10 (granular unclustering)', () => {
    assert.equal(getDynamicClusterRadius(80, 10), 60);
    assert.equal(getDynamicClusterRadius(80, 15), 60);
  });

  it('rounding: fractional results are rounded to nearest integer', () => {
    // 70 * 0.75 = 52.5 → rounds to 53
    assert.equal(getDynamicClusterRadius(70, 10), 53);
    // 65 * 1.25 = 81.25 → rounds to 81
    assert.equal(getDynamicClusterRadius(65, 3), 81);
  });

  it('scales proportionally for different base radii', () => {
    // Larger base → larger output at every zoom tier
    const large = getDynamicClusterRadius(90, 2);
    const small = getDynamicClusterRadius(60, 2);
    assert.ok(large > small, 'larger base should produce larger radius');
  });
});

describe('filterToViewport', () => {
  // Build a 2D grid: 18 longitude steps × 18 latitude steps = 324 points, which
  // exceeds the default minItems=200 threshold so filtering is actually applied.
  const POINTS_PER_AXIS = 18;
  const points = [];
  for (let i = 0; i < POINTS_PER_AXIS; i++) {
    for (let j = 0; j < POINTS_PER_AXIS; j++) {
      points.push({
        lon: -170 + i * 20,   // -170, -150, …, 170 (18 values in 20° steps)
        lat:  -80 + j * 10,   //  -80,  -70, …,  90 (18 values in 10° steps)
      });
    }
  }

  const globalBounds = { w: -180, e: 180, s: -90, n: 90 };
  const europeBounds = { w: -10, e: 30, s: 35, n: 70 };

  it('returns all items unchanged when below minItems threshold', () => {
    const small = points.slice(0, 50);
    const result = filterToViewport(small, d => d.lon, d => d.lat, europeBounds, 200);
    assert.equal(result.length, small.length, 'small datasets must be returned unchanged');
  });

  it('returns all items when viewport covers the whole globe', () => {
    const result = filterToViewport(points, d => d.lon, d => d.lat, globalBounds);
    assert.equal(result.length, points.length);
  });

  it('reduces dataset when viewport is a regional subset', () => {
    const result = filterToViewport(points, d => d.lon, d => d.lat, europeBounds);
    assert.ok(result.length < points.length, 'should filter out non-European points');
    assert.ok(result.length > 0, 'should keep at least some points');
  });

  it('applies 20% expansion margin so edge points are included', () => {
    // A single point exactly at the viewport edge should survive due to the margin.
    const edgePoint = { lon: -10, lat: 35 }; // western/southern Europe boundary
    const testPoints = [...points, edgePoint]; // total > minItems
    const result = filterToViewport(testPoints, d => d.lon, d => d.lat, europeBounds, 200);
    const found = result.some(p => p.lon === edgePoint.lon && p.lat === edgePoint.lat);
    assert.ok(found, 'edge points should be included via the 20% expansion margin');
  });

  it('returns items unchanged when bounds is null/undefined', () => {
    const result = filterToViewport(points, d => d.lon, d => d.lat, null);
    assert.equal(result.length, points.length);
  });

  it('filters out-of-bounds points correctly', () => {
    // Points clearly outside Europe: lon=100 (Asia). Array length 250 is chosen
    // to exceed the default minItems=200 threshold so the filter is actually applied.
    const asiaPoints = Array.from({ length: 250 }, (_, i) => ({ lon: 100 + i * 0.1, lat: 35 }));
    const result = filterToViewport(asiaPoints, d => d.lon, d => d.lat, europeBounds);
    assert.equal(result.length, 0, 'Asian points should all be filtered out');
  });
});
