import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Feature, Geometry } from 'geojson';

import {
  type BBox,
  type BoundedFeature,
  bboxIntersects,
  CULL_PAD_FRACTION,
  culledIndices,
  cullToViewport,
  geometryBounds,
  isWorldViewport,
  padViewport,
  SIMPLIFY_ZOOM_THRESHOLD,
  simplifyGeometry,
  simplifyRing,
  zoomToSimplifyTolerance,
} from '../src/components/map/conflict-zone-cull.ts';
import type { Position } from 'geojson';

function polygon(id: string, bounds: BBox): BoundedFeature {
  const [w, s, e, n] = bounds;
  const feature: Feature = {
    type: 'Feature',
    properties: { id },
    geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
  };
  return { bounds, feature };
}

const idsOf = (features: Feature[]): string[] => features.map((f) => String(f.properties?.id));

describe('geometryBounds (#4561 U1)', () => {
  it('computes bounds of a Polygon', () => {
    const geom: Geometry = { type: 'Polygon', coordinates: [[[10, 20], [30, 20], [30, 40], [10, 40], [10, 20]]] };
    assert.deepEqual(geometryBounds(geom), [10, 20, 30, 40]);
  });

  it('computes bounds spanning a MultiPolygon', () => {
    const geom: Geometry = {
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]]],
        [[[-10, -8], [-6, -8], [-6, -4], [-10, -4], [-10, -8]]],
      ],
    };
    assert.deepEqual(geometryBounds(geom), [-10, -8, 5, 5]);
  });

  it('spans a GeometryCollection and returns null for empty coordinates', () => {
    const gc: Geometry = {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Polygon', coordinates: [[[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]] },
        { type: 'Point', coordinates: [8, 9] },
      ],
    };
    assert.deepEqual(geometryBounds(gc), [1, 1, 8, 9]);
    assert.equal(geometryBounds({ type: 'Polygon', coordinates: [] }), null);
    assert.equal(geometryBounds(null), null);
  });
});

describe('bboxIntersects (#4561 U1)', () => {
  it('detects overlap, non-overlap, and edge-touch', () => {
    assert.equal(bboxIntersects([0, 0, 10, 10], [5, 5, 15, 15]), true); // overlap
    assert.equal(bboxIntersects([0, 0, 10, 10], [20, 20, 30, 30]), false); // disjoint
    assert.equal(bboxIntersects([0, 0, 10, 10], [10, 10, 20, 20]), true); // corner touch (boundary)
  });
});

describe('isWorldViewport (#4561 U1)', () => {
  it('treats near-global, antimeridian-crossing, and non-finite viewports as world', () => {
    assert.equal(isWorldViewport([-160, -70, 160, 70]), true); // 320deg span
    assert.equal(isWorldViewport([170, -10, -170, 10]), true); // east <= west (antimeridian)
    assert.equal(isWorldViewport([Number.NaN, 0, 10, 10]), true); // non-finite
    assert.equal(isWorldViewport([10, 0, 40, 20]), false); // regional
  });
});

describe('padViewport (#4561 U1)', () => {
  it('expands by the configured fraction on each side', () => {
    assert.deepEqual(padViewport([0, 0, 10, 20], 0.5), [-5, -10, 15, 30]);
    assert.deepEqual(padViewport([0, 0, 10, 20]), [
      -10 * CULL_PAD_FRACTION, -20 * CULL_PAD_FRACTION, 10 + 10 * CULL_PAD_FRACTION, 20 + 20 * CULL_PAD_FRACTION,
    ]);
  });
});

describe('cullToViewport (#4561 U1)', () => {
  const zones: BoundedFeature[] = [
    polygon('inside', [12, 12, 18, 18]), // well inside a [10,10,40,30] viewport
    polygon('straddle', [8, 9, 11, 11]), // straddles the west/south edge
    polygon('outside', [80, 60, 90, 70]), // far outside, beyond padding
  ];

  it('includes overlapping and edge-straddling zones, excludes far-outside ones', () => {
    const visible = cullToViewport(zones, [10, 10, 40, 30]);
    const ids = idsOf(visible);
    assert.ok(ids.includes('inside'), 'inside zone rendered');
    assert.ok(ids.includes('straddle'), 'edge-straddling zone rendered');
    assert.ok(!ids.includes('outside'), 'far-outside zone culled');
  });

  it('returns an empty list (no throw) when no zone intersects', () => {
    const visible = cullToViewport([polygon('far', [80, 60, 90, 70])], [10, 10, 40, 30]);
    assert.deepEqual(visible, []);
  });

  it('returns every zone at world / antimeridian viewports (never under-culls)', () => {
    assert.equal(cullToViewport(zones, [-160, -80, 160, 80]).length, zones.length);
    assert.equal(cullToViewport(zones, [170, -10, -170, 10]).length, zones.length);
  });

  it('keeps a zone just outside the raw viewport but within the pad margin', () => {
    // viewport [0,0,10,10], pad 0.5 -> padded [-5,-5,15,15]; zone at [12,12,14,14] is
    // outside the raw viewport but inside the padded box, so it stays (no pop-in on pan).
    const near = [polygon('near', [12, 12, 14, 14])];
    assert.deepEqual(idsOf(cullToViewport(near, [0, 0, 10, 10])), ['near']);
  });
});

describe('culledIndices (#4561 U1/P2)', () => {
  const zones: BoundedFeature[] = [
    polygon('inside', [12, 12, 18, 18]),
    polygon('straddle', [8, 9, 11, 11]),
    polygon('outside', [80, 60, 90, 70]),
  ];

  it('returns the intersecting indices (identity), preserving order', () => {
    assert.deepEqual(culledIndices(zones, [10, 10, 40, 30]), [0, 1]);
  });

  it('returns identical index sets for two viewports sharing the same visible zones (content short-circuit basis)', () => {
    // Both viewports show only zones 0 and 1, none of 2 -> same content key upstream.
    assert.deepEqual(culledIndices(zones, [10, 10, 40, 30]), culledIndices(zones, [11, 11, 39, 29]));
  });

  it('distinguishes different visible sets (keys must differ)', () => {
    const withOutside = culledIndices(zones, [78, 58, 92, 72]);
    assert.notDeepEqual(culledIndices(zones, [10, 10, 40, 30]), withOutside);
    assert.ok(withOutside.includes(2));
  });

  it('returns all indices at a world viewport', () => {
    assert.deepEqual(culledIndices(zones, [-170, -80, 170, 80]), [0, 1, 2]);
  });
});

// ── U2: low-zoom simplification ────────────────────────────────────────────────

/** A closed ring densely sampled along a circle (many near-collinear vertices). */
function denseCircle(cx: number, cy: number, r: number, n: number): Position[] {
  const pts: Position[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  pts.push(pts[0]); // close
  return pts;
}

const pointKey = (p: Position): string => `${p[0]},${p[1]}`;

describe('zoomToSimplifyTolerance (#4561 U2)', () => {
  it('is monotonic decreasing and zero at/above the threshold', () => {
    const t0 = zoomToSimplifyTolerance(0);
    const t2 = zoomToSimplifyTolerance(2);
    const t3 = zoomToSimplifyTolerance(3);
    assert.ok(t0 > t2 && t2 > t3, 'coarser at lower zoom');
    assert.equal(zoomToSimplifyTolerance(SIMPLIFY_ZOOM_THRESHOLD), 0, 'no simplify at threshold');
    assert.equal(zoomToSimplifyTolerance(8), 0, 'no simplify when zoomed in');
    assert.equal(zoomToSimplifyTolerance(Number.NaN), 0);
  });
});

describe('simplifyRing (#4561 U2)', () => {
  it('materially reduces a high-vertex ring while preserving closure and using only input vertices', () => {
    const ring = denseCircle(0, 0, 10, 200); // 201 points incl. closure
    const inputKeys = new Set(ring.map(pointKey));
    const simplified = simplifyRing(ring, 0.5);
    assert.ok(simplified.length < ring.length * 0.5, `materially fewer vertices (${simplified.length} < ${ring.length})`);
    assert.ok(simplified.length >= 4, 'still a valid ring');
    assert.deepEqual(simplified[0], simplified[simplified.length - 1], 'ring stays closed');
    // RDP only removes vertices — every output point came from the input (no new geometry).
    for (const p of simplified) assert.ok(inputKeys.has(pointKey(p)), 'output vertex is from the input');
  });

  it('leaves a low-vertex ring unchanged (no over-simplification)', () => {
    const square: Position[] = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]];
    assert.deepEqual(simplifyRing(square, 0.5), square);
  });

  it('is a passthrough at tolerance 0', () => {
    const ring = denseCircle(0, 0, 5, 50);
    assert.equal(simplifyRing(ring, 0), ring);
  });

  it('handles large rings without recursive call-stack growth', () => {
    const ring = denseCircle(0, 0, 10, 12_000);
    const simplified = simplifyRing(ring, 0.05);
    assert.ok(simplified.length >= 4, 'still returns a valid ring');
    assert.deepEqual(simplified[0], simplified[simplified.length - 1], 'ring stays closed');
  });
});

describe('simplifyGeometry (#4561 U2)', () => {
  it('simplifies every ring of a MultiPolygon and preserves ring/polygon counts', () => {
    const poly = [denseCircle(0, 0, 10, 120)];
    const geom = { type: 'MultiPolygon' as const, coordinates: [poly, [denseCircle(50, 50, 8, 120)]] };
    const out = simplifyGeometry(geom, 0.5);
    assert.equal(out.type, 'MultiPolygon');
    if (out.type !== 'MultiPolygon') return;
    assert.equal(out.coordinates.length, 2, 'polygon count preserved');
    assert.equal(out.coordinates[0].length, 1, 'ring count preserved');
    assert.ok(out.coordinates[0][0].length < geom.coordinates[0][0].length, 'vertices reduced');
    // bounds are preserved within tolerance (shape not grossly distorted)
    const before = geometryBounds(geom);
    const after = geometryBounds(out);
    assert.ok(before && after);
    for (let i = 0; i < 4; i++) assert.ok(Math.abs((before as BBox)[i] - (after as BBox)[i]) <= 0.5);
  });

  it('simplifies polygon children inside a GeometryCollection', () => {
    const polygonChild = { type: 'Polygon' as const, coordinates: [denseCircle(0, 0, 10, 120)] };
    const pointChild = { type: 'Point' as const, coordinates: [1, 2] };
    const geom: Geometry = { type: 'GeometryCollection', geometries: [polygonChild, pointChild] };
    const out = simplifyGeometry(geom, 0.5);
    assert.equal(out.type, 'GeometryCollection');
    if (out.type !== 'GeometryCollection') return;
    const firstGeometry = out.geometries[0];
    const secondGeometry = out.geometries[1];
    assert.ok(firstGeometry);
    assert.ok(secondGeometry);
    assert.equal(firstGeometry.type, 'Polygon');
    if (firstGeometry.type === 'Polygon') {
      const simplifiedRing = firstGeometry.coordinates[0];
      const originalRing = polygonChild.coordinates[0];
      assert.ok(simplifiedRing);
      assert.ok(originalRing);
      assert.ok(simplifiedRing.length < originalRing.length, 'polygon child simplified');
    }
    assert.deepEqual(secondGeometry, pointChild);
  });

  it('returns non-polygon geometry untouched', () => {
    const point = { type: 'Point' as const, coordinates: [1, 2] };
    assert.equal(simplifyGeometry(point, 0.5), point);
  });

  it('never mutates the source geometry (deep-frozen input does not throw)', () => {
    // Guards Risk #3: the culled features alias the shared country geometry, so
    // simplifyGeometry must only read it. A frozen input would throw on any write.
    const deepFreeze = (v: unknown): void => {
      if (Array.isArray(v)) {
        v.forEach(deepFreeze);
        Object.freeze(v);
      } else if (v && typeof v === 'object') {
        Object.values(v).forEach(deepFreeze);
        Object.freeze(v);
      }
    };
    const geom: Geometry = { type: 'Polygon', coordinates: [denseCircle(0, 0, 10, 120)] };
    deepFreeze(geom);
    const out = simplifyGeometry(geom, 0.5); // must not throw
    assert.equal(geom.type, 'Polygon');
    if (geom.type === 'Polygon') assert.equal(geom.coordinates[0]?.length, 121, 'source ring length unchanged');
    assert.notEqual(out, geom, 'returns a new geometry object');
  });
});
