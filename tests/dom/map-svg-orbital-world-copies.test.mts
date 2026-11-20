import * as d3 from 'd3';
import { describe, expect, it } from 'vitest';

import { MapComponent } from '@/components/Map';
import type { PassTrack } from '@/services/orbital/track-geometry';

type TrackMap = {
  renderOrbitalTrack: (projection: d3.GeoProjection) => void;
  renderOrbitalTarget: (projection: d3.GeoProjection) => void;
};

const FIJI = { lat: -16.85, lon: 179.95, lines: [] as string[] };
// 360 px wide: one pixel per degree, -180 at x=0 and 180 at x=360.
const projection = d3.geoEquirectangular().scale(360 / (2 * Math.PI)).translate([180, 90]);
const EAST_EDGE = 360;

const track = {
  key: '62261:1', name: 'SENTINEL-2B', startMs: 0, endMs: 1000,
  closest: { lon: 179.95, lat: -16.85, timeMs: 500 },
  segments: [[{ lon: 179, lat: -10, timeMs: 0 }, { lon: 180, lat: -16.85, timeMs: 500 }, { lon: -179, lat: -24, timeMs: 1000 }]],
  footprint: [],
  swath: [{ timesMs: [0, 1000], inner: [[179.5, -10], [180.5, -24]], outer: [[178.5, -10], [179.5, -24]] }],
} as unknown as PassTrack;

function svgMap(): { map: TrackMap; svg: SVGSVGElement } {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  document.body.append(svg);
  const map = Object.assign(Object.create(MapComponent.prototype), {
    container: document.createElement('div'),
    dynamicLayerGroup: d3.select(svg).append('g'),
    state: { zoom: 1, pan: { x: 0, y: 0 } },
    orbitalTrack: track,
    orbitalTrackMarker: { lon: 180, lat: -16.85, timeMs: 500 },
    orbitalTarget: FIJI,
    orbitalSweptNodes: [], orbitalEdgeNodes: [], orbitalMarkerNodes: [],
  }) as TrackMap;
  return { map, svg };
}

const xs = (d: string | null) => [...(d ?? '').matchAll(/[ML](-?[\d.]+),/g)].map((m) => Number(m[1]));

describe('orbital pass on the one-world SVG map near the antimeridian', () => {
  it('draws the track and swath unbroken past 180 and repeats them a world width either side', () => {
    const { map, svg } = svgMap();
    map.renderOrbitalTrack(projection);
    const copies = [...svg.querySelectorAll('.orbital-world')];
    expect(copies.map((g) => g.getAttribute('transform'))).toEqual([null, 'translate(-360,0)', 'translate(360,0)']);
    const [primary] = copies;
    const ring = xs(primary!.querySelector('path')!.getAttribute('d'));
    expect(Math.min(...ring), 'swath reaches west of 180').toBeLessThan(EAST_EDGE);
    expect(Math.max(...ring), 'swath continues east of 180 instead of wrapping to x=0').toBeGreaterThan(EAST_EDGE);
    expect(Math.max(...ring) - Math.min(...ring), 'no jump across the map').toBeLessThan(5);
    const path = xs(primary!.querySelectorAll('path')[1]!.getAttribute('d'));
    expect(path).toEqual([359, 360, 361]);
    const swept = xs(primary!.querySelector('.orbital-swept')!.getAttribute('d'));
    expect(swept.length).toBeGreaterThan(0);
    expect(Math.max(...swept) - Math.min(...swept)).toBeLessThan(5);
    expect(svg.querySelectorAll('.orbital-swept')).toHaveLength(3);
    expect([...svg.querySelectorAll('.orbital-world circle')].map((c) => c.getAttribute('cx'))).toEqual(['360', '360', '360']);
  });

  it('repeats the reticle a world width either side', () => {
    const { map, svg } = svgMap();
    map.renderOrbitalTarget(projection);
    expect(svg.querySelector('.orbital-target')?.getAttribute('transform')).toMatch(/^translate\(359\.95/);
    const copies = [...svg.querySelectorAll('.orbital-target-copy')].map((g) => Number(g.getAttribute('transform')!.match(/translate\(([-\d.]+)/)![1]));
    expect(copies).toHaveLength(2);
    expect(copies[0]).toBeCloseTo(-0.05);
    expect(copies[1]).toBeCloseTo(719.95);
  });
});
