/**
 * The SVG map paints its first frame from the 110m world topology and swaps in the 50m topology
 * when a desktop user zooms in. Marker clustering uses a spatial grid and must return exactly what
 * the original pairwise scan returned.
 *
 * The component runs on a prototype instance so the constructor's network and d3 boot stay out of
 * the test. `fetch` is stubbed, and `applyTransform()`, `loadMapData()`, and `clusterMarkers()`
 * run for real.
 */
import * as d3 from 'd3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MapComponent } from '@/components/Map';
import { worldTopologyUrl } from '@/config/geo-map';

const TOPOLOGY_ONE_COUNTRY = {
  type: 'Topology',
  arcs: [[[0, 0], [10, 0], [10, 10], [0, 0]]],
  objects: {
    countries: { type: 'GeometryCollection', geometries: [{ type: 'Polygon', arcs: [[0]], properties: { name: 'X' } }] },
  },
};
const TOPOLOGY_EMPTY = { type: 'Topology', arcs: [], objects: { countries: { type: 'GeometryCollection', geometries: [] } } };

type ZoomHarness = {
  applyTransform: () => void;
  loadMapData: () => Promise<void>;
  countryFeatures: unknown[] | null;
  baseRendered: boolean;
  worldData: unknown;
  state: { zoom: number };
  scheduleRender: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  isMobile: boolean;
  destroyed: boolean;
};

function createMap(overrides: Partial<ZoomHarness> = {}, zoom = 1): ZoomHarness {
  const map = Object.create(MapComponent.prototype) as Record<string, unknown>;
  Object.assign(map, {
    destroyed: false,
    isMobile: false,
    worldData: TOPOLOGY_EMPTY,
    countryFeatures: null,
    baseRendered: true,
    hiResWorldLoaded: false,
    hiResWorldLoading: false,
    hiResWorldFailures: 0,
    state: { zoom, pan: { x: 0, y: 0 } },
    wrapper: { style: { transform: '', setProperty: vi.fn() } },
    lastOverlayVarZoom: '',
    naturalEventTextsZoom: zoom,
    getKnownContainerSize: () => ({ width: 800, height: 600 }),
    clampPan: vi.fn(),
    overlayBudgetPlanIsStale: () => false,
    declutterNaturalEventTexts: vi.fn(),
    shouldUpdateLabelVisibility: () => false,
    updateLabelVisibility: vi.fn(),
    updateZoomLayerVisibility: () => false,
    emitStateChange: vi.fn(),
    scheduleRender: vi.fn(),
    scheduleOverlayBudgetReplan: vi.fn(),
    render: vi.fn(),
    ...overrides,
  });
  return map as unknown as ZoomHarness;
}

function respondWith(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const HIGH_RES_URL = worldTopologyUrl(false);
const LOW_RES_URL = worldTopologyUrl(true);

let fetchMock: ReturnType<typeof vi.fn>;
const fetchedUrls = (): string[] => fetchMock.mock.calls.map(([url]) => String(url));

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('progressive world topology', () => {
  it('paints the first frame from the 110m topology and fetches nothing sharper at the default zoom', async () => {
    fetchMock.mockImplementation(async () => respondWith(TOPOLOGY_EMPTY));
    const map = createMap({ worldData: null });

    await map.loadMapData();
    await settle();

    expect(fetchedUrls()).toEqual([LOW_RES_URL]);
    expect(map.render).toHaveBeenCalled();
  });

  it('requests the 50m topology once when a desktop user zooms in, then swaps it in', async () => {
    fetchMock.mockImplementation(async () => respondWith(TOPOLOGY_ONE_COUNTRY));
    const map = createMap({}, 3);

    map.applyTransform();
    map.applyTransform();
    await settle();

    expect(fetchedUrls()).toEqual([HIGH_RES_URL]);
    expect(map.countryFeatures).toHaveLength(1);
    expect(map.baseRendered).toBe(false);
    expect(map.scheduleRender).toHaveBeenCalled();

    map.applyTransform();
    await settle();
    expect(fetchedUrls()).toEqual([HIGH_RES_URL]);
  });

  it('does not request the 50m topology below zoom 2', async () => {
    const map = createMap({}, 1.9);

    map.applyTransform();
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never upgrades on mobile, which already draws the 110m topology', async () => {
    const map = createMap({ isMobile: true }, 4);

    map.applyTransform();
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('waits for the 110m base map before asking for the 50m one', async () => {
    const map = createMap({ worldData: null }, 4);

    map.applyTransform();
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops asking after two failed upgrades so an offline tab does not refetch on every render', async () => {
    fetchMock.mockImplementation(async () => respondWith({}, false));
    const map = createMap({}, 3);

    for (let i = 0; i < 6; i++) {
      map.applyTransform();
      await settle();
    }

    expect(fetchedUrls()).toEqual([HIGH_RES_URL, HIGH_RES_URL]);
    expect(map.countryFeatures).toBeNull();
  });

  it('counts an empty 200 response as a failed upgrade', async () => {
    fetchMock.mockImplementation(async () => new Response('null', { status: 200 }));
    const map = createMap({}, 3);

    for (let i = 0; i < 6; i++) {
      map.applyTransform();
      await settle();
    }

    expect(fetchedUrls()).toEqual([HIGH_RES_URL, HIGH_RES_URL]);
    expect(map.countryFeatures).toBeNull();
  });

  it('counts a network error as a failed upgrade', async () => {
    fetchMock.mockImplementation(async () => { throw new TypeError('offline'); });
    const map = createMap({}, 3);

    for (let i = 0; i < 6; i++) {
      map.applyTransform();
      await settle();
    }

    expect(fetchedUrls()).toHaveLength(2);
  });
});

type Pt = { lat: number; lon: number; id: number; city: string };
type Cluster = { items: Pt[]; center: [number, number]; pos: [number, number] };

// The pairwise scan this grid replaced. It defines the expected output, including item order.
function referenceCluster(
  items: readonly Pt[],
  projection: d3.GeoProjection,
  pixelRadius: number,
  getGroupKey?: (item: Pt) => string,
): Cluster[] {
  const clusters: Cluster[] = [];
  const assigned = new Set<number>();
  for (let i = 0; i < items.length; i++) {
    if (assigned.has(i)) continue;
    const item = items[i]!;
    if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) continue;
    const pos = projection([item.lon, item.lat]);
    if (!pos || !Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) continue;
    const cluster: Pt[] = [item];
    assigned.add(i);
    const itemKey = getGroupKey?.(item);
    for (let j = i + 1; j < items.length; j++) {
      if (assigned.has(j)) continue;
      const other = items[j]!;
      if (getGroupKey && getGroupKey(other) !== itemKey) continue;
      if (!Number.isFinite(other.lat) || !Number.isFinite(other.lon)) continue;
      const otherPos = projection([other.lon, other.lat]);
      if (!otherPos || !Number.isFinite(otherPos[0]) || !Number.isFinite(otherPos[1])) continue;
      const dx = pos[0] - otherPos[0];
      const dy = pos[1] - otherPos[1];
      if (Math.sqrt(dx * dx + dy * dy) <= pixelRadius) {
        cluster.push(other);
        assigned.add(j);
      }
    }
    let sumLat = 0;
    let sumLon = 0;
    for (const c of cluster) {
      sumLat += c.lat;
      sumLon += c.lon;
    }
    const centerLat = sumLat / cluster.length;
    const centerLon = sumLon / cluster.length;
    const centerPos = projection([centerLon, centerLat]);
    const finalPos: [number, number] = centerPos && Number.isFinite(centerPos[0]) && Number.isFinite(centerPos[1])
      ? [centerPos[0], centerPos[1]]
      : [pos[0], pos[1]];
    clusters.push({ items: cluster, center: [centerLon, centerLat], pos: finalPos });
  }
  return clusters;
}

function seededMarkers(count: number, seed: number): Pt[] {
  let state = seed;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  const cities = ['Berlin', 'Paris', 'Cairo'];
  return Array.from({ length: count }, (_, id) => ({
    id,
    lat: 30 + next() * 25,
    lon: -5 + next() * 40,
    city: cities[Math.floor(next() * cities.length)]!,
  }));
}

describe('marker clustering', () => {
  const projection = d3.geoEquirectangular().scale(300).translate([400, 300]);
  const cluster = (items: Pt[], radius: number, key?: (item: Pt) => string): Cluster[] =>
    (MapComponent.prototype as unknown as {
      clusterMarkers: (i: Pt[], p: d3.GeoProjection, r: number, k?: (item: Pt) => string) => Cluster[];
    }).clusterMarkers.call({}, items, projection, radius, key);

  it('returns the same clusters, item order, and centers as the pairwise scan', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const items = seededMarkers(300, seed);
      expect(cluster(items, 24)).toEqual(referenceCluster(items, projection, 24));
    }
  });

  it('only groups markers that share a group key, in input order', () => {
    const items = seededMarkers(300, 9);
    const byCity = (item: Pt): string => item.city;
    const result = cluster(items, 30, byCity);

    expect(result).toEqual(referenceCluster(items, projection, 30, byCity));
    for (const { items: members } of result) {
      expect(new Set(members.map(byCity)).size).toBe(1);
      expect(members.map((m) => m.id)).toEqual([...members.map((m) => m.id)].sort((a, b) => a - b));
    }
  });

  it('skips markers with non-finite coordinates and keeps the rest', () => {
    const items = seededMarkers(60, 11);
    items[3] = { ...items[3]!, lat: Number.NaN };
    items[7] = { ...items[7]!, lon: Number.POSITIVE_INFINITY };

    const result = cluster(items, 24);

    expect(result).toEqual(referenceCluster(items, projection, 24));
    expect(result.flatMap((c) => c.items).some((m) => m.id === 3 || m.id === 7)).toBe(false);
  });

  it('returns no clusters for no markers', () => {
    expect(cluster([], 24)).toEqual([]);
  });
});
