import '../styles/main.css';
import { MapComponent } from '../components/Map';
import { initI18n } from '../services/i18n';

type MobileMapIntegrationHarness = {
  ready: boolean;
  pendingDeferredCallbacks: number;
  flushDeferredCallbacks: () => void;
  destroyMap: () => void;
  getDynamicLayerChildCount: () => number;
  getInitialDynamicRendered: () => boolean;
  getWrapperTransform: () => string;
  seedOverlayMarkerStress: (perFeed: number) => void;
  seedOverlayViewportStress: (count: number) => void;
  setOverlayViewport: (lat: number, lon: number) => void;
  setOverlayZoom: (zoom: number) => void;
  seedTimeFilteredEarthquakes: (recent: number, stale: number) => void;
  getOverlayMarkerCount: () => number;
  getOverlayMarkerClassCount: (selector: string) => number;
  getOverlayPositionSignature: (selector: string) => string;
  seedWeatherAlerts: (withCentroid: number, withoutCentroid: number) => void;
  forceRender: () => void;
  burstFlashes: (count: number) => void;
  clearOverlayFeeds: () => void;
  getActiveFlashCount: () => number;
  getFlashNodeCount: () => number;
  getKeptHotspotCoords: () => Array<{ lat: number; lon: number }>;
  getSeededHotspotCoords: () => Array<{ lat: number; lon: number }>;
  getOverlayBudgetState: () => {
    rendered: number;
    renders: number;
    truncated: Record<string, { shown: number; total: number }>;
    undisclosed: string[];
  };
  getPopupRect: () => {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
    viewportWidth: number;
    viewportHeight: number;
  } | null;
};

declare global {
  interface Window {
    __mobileMapIntegrationHarness?: MobileMapIntegrationHarness;
  }
}

const app = document.getElementById('app');
if (!app) {
  throw new Error('Missing #app container for mobile map integration harness');
}

const controlDeferredCallbacks = new URLSearchParams(window.location.search).get('defer-control') === '1';
const deferredCallbacks: IdleRequestCallback[] = [];
if (controlDeferredCallbacks) {
  window.requestIdleCallback = ((callback: IdleRequestCallback) => {
    deferredCallbacks.push(callback);
    return deferredCallbacks.length;
  }) as typeof window.requestIdleCallback;
}

document.body.style.margin = '0';
document.body.style.overflow = 'hidden';

app.className = 'map-container';
app.style.width = '100vw';
app.style.height = '100vh';
app.style.position = 'relative';
app.style.overflow = 'hidden';

const MINIMAL_WORLD_TOPOLOGY = {
  type: 'Topology',
  objects: {
    countries: {
      type: 'GeometryCollection',
      geometries: [
        {
          type: 'Polygon',
          id: 1,
          arcs: [[0]],
        },
      ],
    },
  },
  arcs: [
    [
      [0, 0],
      [3600, 0],
      [0, 1800],
      [-3600, 0],
      [0, -1800],
    ],
  ],
  transform: {
    scale: [0.1, 0.1],
    translate: [-180, -90],
  },
};

const originalFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;

  if (url.includes('/data/countries-50m.json')) {
    return new Response(JSON.stringify(MINIMAL_WORLD_TOPOLOGY), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return originalFetch(input, init);
}) as typeof fetch;

const layers = {
  gpsJamming: false,
  satellites: false,

  conflicts: false,
  bases: false,
  cables: false,
  pipelines: false,
  hotspots: true,
  ais: false,
  nuclear: false,
  irradiators: false,
  sanctions: false,
  weather: false,
  canadaRoads: false,
  canadaAlerts: false,
  economic: false,
  waterways: false,
  outages: false,
  cyberThreats: false,
  datacenters: false,
  protests: false,
  flights: false,
  military: false,
  natural: false,
  spaceports: false,
  minerals: false,
  fires: false,
  ucdpEvents: false,
  displacement: false,
  climate: false,
  startupHubs: false,
  cloudRegions: false,
  accelerators: false,
  techHQs: false,
  techEvents: false,
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  commodityHubs: false,
  gulfInvestments: false,
  positiveEvents: false,
  kindness: false,
  happiness: false,
  speciesRecovery: false,
  renewableInstallations: false,
  tradeRoutes: false,
  iranAttacks: false,

  ciiChoropleth: false,
  resilienceScore: false,
  dayNight: false,
  miningSites: false,
  processingPlants: false,
  commodityPorts: false,
  webcams: false,
  diseaseOutbreaks: false,
};

await initI18n();

// #7112: `?mobile=1` builds the component on its mobile branch, which selects
// MAP_OVERLAY_MARKER_BUDGET_MOBILE (150/400) instead of the desktop 300/800.
// Without this the mobile ceiling has no test at all — every harness page runs
// `isMobile: false`, so the branch in planOverlayMarkerBudget is never taken.
const harnessParams = new URLSearchParams(window.location.search);
const isMobileHarness = harnessParams.get('mobile') === '1';
// #7112: `?chrome=0` reproduces the embed surface (src/embed/panels/map.ts builds
// MapContainer with `chrome: false`), which has no #layerToggles rail and so no
// place to show a shown/total badge.
const chromeHarness = harnessParams.get('chrome') !== '0';

const map = new MapComponent(app, {
  zoom: 2.7,
  pan: { x: 0, y: 0 },
  view: 'global',
  layers,
  timeRange: 'all',
}, { isMobile: isMobileHarness, chrome: chromeHarness });

let ready = false;
let fallbackInjected = false;
const ensureHotspotsRendered = (): void => {
  if (document.querySelector('.hotspot')) {
    ready = true;
    return;
  }

  // Fallback for deterministic tests if the async world fetch is delayed.
  if (!fallbackInjected) {
    const mapInternals = map as unknown as {
      worldData: unknown;
      countryFeatures: unknown;
      baseRendered: boolean;
      hotspots: Array<{
        id: string;
        name: string;
        lat: number;
        lon: number;
        keywords: string[];
        level: 'low' | 'elevated' | 'high';
        description: string;
        status: string;
      }>;
      state: { layers: { hotspots: boolean } };
    };
    mapInternals.worldData = MINIMAL_WORLD_TOPOLOGY;
    mapInternals.countryFeatures = [
      {
        type: 'Feature',
        properties: { name: 'E2E Country' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[-180, -90], [180, -90], [180, 90], [-180, 90], [-180, -90]]],
        },
      },
    ];
    mapInternals.hotspots = [
      {
        id: 'e2e-map-hotspot',
        name: 'E2E Map Hotspot',
        lat: 20,
        lon: 10,
        keywords: ['e2e', 'integration'],
        level: 'high',
        description: 'Integration harness hotspot',
        status: 'monitoring',
      },
    ];
    mapInternals.state.layers.hotspots = true;
    mapInternals.baseRendered = false;
    map.render();
    fallbackInjected = true;
  }

  requestAnimationFrame(ensureHotspotsRendered);
};
ensureHotspotsRendered();

window.__mobileMapIntegrationHarness = {
  get ready() {
    return ready;
  },
  get pendingDeferredCallbacks() {
    return deferredCallbacks.length;
  },
  flushDeferredCallbacks: () => {
    const callbacks = deferredCallbacks.splice(0);
    callbacks.forEach((callback) => {
      callback({
        didTimeout: false,
        timeRemaining: () => 50,
      });
    });
  },
  destroyMap: () => {
    map.destroy();
  },
  getDynamicLayerChildCount: () =>
    document.querySelector('.map-dynamic')?.childElementCount ?? 0,
  getInitialDynamicRendered: () =>
    Boolean((map as unknown as { initialDynamicRendered?: boolean }).initialDynamicRendered),
  getWrapperTransform: () =>
    (document.querySelector('.map-wrapper') as HTMLElement | null)?.style.transform ?? '',
  // #7112: drives the overlay marker budget with feeds far larger than anything
  // production has produced, so the ceiling is exercised rather than assumed.
  seedOverlayMarkerStress: (perFeed: number) => {
    const spread = (index: number): { lat: number; lon: number } => ({
      // A deterministic spiral, so markers are spread across the projection
      // instead of stacking on one pixel (which would make the proximity
      // tie-break meaningless and let clustering hide the count).
      lat: ((index * 7) % 170) - 85,
      lon: ((index * 13) % 358) - 179,
    });
    const vessels = Array.from({ length: perFeed }, (_, index) => ({
      id: `stress-vessel-${index}`,
      mmsi: String(200000000 + index),
      name: `Stress Vessel ${index}`,
      vesselType: index % 100 === 0 ? 'carrier' : 'destroyer',
      operator: 'usn',
      operatorCountry: 'US',
      ...spread(index),
      heading: index % 360,
      speed: 12,
      lastAisUpdate: new Date(0),
      confidence: 'high',
    }));
    const flights = Array.from({ length: perFeed }, (_, index) => ({
      id: `stress-flight-${index}`,
      callsign: `STRESS${index}`,
      hexCode: (index + 0x100000).toString(16),
      aircraftType: 'fighter',
      operator: 'usaf',
      operatorCountry: 'US',
      ...spread(index + 3),
      altitude: 30000,
      heading: index % 360,
      speed: 400,
      onGround: false,
      lastSeen: new Date(0),
    }));
    const quakes = Array.from({ length: perFeed }, (_, index) => ({
      id: `stress-quake-${index}`,
      magnitude: 1 + (index % 60) / 10,
      place: `Stress Quake ${index}`,
      occurredAt: 0,
      location: { latitude: spread(index + 5).lat, longitude: spread(index + 5).lon },
    }));

    const mapInternals = map as unknown as {
      state: { layers: Record<string, boolean> };
    };
    mapInternals.state.layers.military = true;
    mapInternals.state.layers.natural = true;
    map.setMilitaryVessels(vessels as never, []);
    map.setMilitaryFlights(flights as never, []);
    map.setEarthquakes(quakes as never);
    map.render();
  },
  // #7112: create one over-budget, proximity-ranked feed so pan/zoom can prove
  // that the selected marker set follows the transformed viewport centre.
  seedOverlayViewportStress: (count: number) => {
    const hotspots = Array.from({ length: count }, (_, index) => ({
      id: `viewport-hotspot-${index}`,
      name: `Viewport Hotspot ${index}`,
      lat: ((index * 7) % 170) - 85,
      lon: ((index * 13) % 358) - 179,
      keywords: ['viewport'],
      level: 'low' as const,
      description: 'Viewport budget stress marker',
      status: 'monitoring',
    }));
    const mapInternals = map as unknown as {
      hotspots: typeof hotspots;
      state: { layers: Record<string, boolean> };
    };
    mapInternals.hotspots = hotspots;
    mapInternals.state.layers.hotspots = true;
    map.render();
  },
  setOverlayViewport: (lat: number, lon: number) => map.setCenter(lat, lon),
  setOverlayZoom: (zoom: number) => map.setZoom(zoom),
  // #7112: the budget plan must be computed over the SAME time-filtered slice
  // the render loop iterates. The stale events here carry the HIGHEST
  // magnitudes, so a plan that ranked the unfiltered feed would spend its whole
  // fair share on events the 24h filter then discards.
  seedTimeFilteredEarthquakes: (recent: number, stale: number) => {
    const now = Date.now();
    const quakes = [
      ...Array.from({ length: stale }, (_, index) => ({
        id: `stale-quake-${index}`,
        magnitude: 6 + (index % 30) / 100,
        place: `Stale Quake ${index}`,
        occurredAt: now - 30 * 24 * 60 * 60 * 1000,
        location: { latitude: ((index * 7) % 170) - 85, longitude: ((index * 13) % 358) - 179 },
      })),
      ...Array.from({ length: recent }, (_, index) => ({
        id: `recent-quake-${index}`,
        magnitude: 1 + (index % 30) / 100,
        place: `Recent Quake ${index}`,
        occurredAt: now - 60 * 1000,
        location: { latitude: ((index * 11) % 170) - 85, longitude: ((index * 17) % 358) - 179 },
      })),
    ];
    const mapInternals = map as unknown as { state: { layers: Record<string, boolean> } };
    mapInternals.state.layers.natural = true;
    map.setEarthquakes(quakes as never);
    map.setTimeRange('24h');
  },
  getOverlayMarkerCount: () =>
    document.getElementById('mapOverlays')?.childElementCount ?? -1,
  getOverlayMarkerClassCount: (selector: string) =>
    document.getElementById('mapOverlays')?.querySelectorAll(selector).length ?? -1,
  getOverlayPositionSignature: (selector: string) =>
    Array.from(document.querySelectorAll<HTMLElement>(`#mapOverlays ${selector}`))
      .map((element) => `${element.style.left},${element.style.top}`)
      .sort()
      .join('|'),
  // #7112: the budget's proximity ranking is a claim about WHICH markers survive,
  // not merely that the set changes on pan/zoom — a centre computed from the
  // wrong inverse transform also changes the set. These expose the geography of
  // the surviving hotspots so a test can assert the kept set actually clusters
  // on the requested view centre.
  // #7112: WeatherAlert.centroid is optional and the render loop skips an alert
  // without one, so an alert that can never be drawn must not be budgeted or
  // counted in the shown/total badge.
  seedWeatherAlerts: (withCentroid: number, withoutCentroid: number) => {
    const alerts = [
      ...Array.from({ length: withCentroid }, (_, index) => ({
        id: `wx-centroid-${index}`,
        event: 'Severe Thunderstorm Warning',
        severity: 'Severe',
        headline: `Renderable alert ${index}`,
        description: '',
        areaDesc: '',
        onset: new Date(0),
        expires: new Date(0),
        coordinates: [],
        centroid: [((index * 13) % 358) - 179, ((index * 7) % 170) - 85],
      })),
      ...Array.from({ length: withoutCentroid }, (_, index) => ({
        id: `wx-no-centroid-${index}`,
        event: 'Flood Watch',
        severity: 'Moderate',
        headline: `Unrenderable alert ${index}`,
        description: '',
        areaDesc: '',
        onset: new Date(0),
        expires: new Date(0),
        coordinates: [],
        // no centroid — cannot be projected, so never becomes a marker
      })),
    ];
    const internals = map as unknown as { state: { layers: Record<string, boolean> } };
    internals.state.layers.weather = true;
    map.setWeatherAlerts(alerts as never);
    map.render();
  },
  // #7112: renderOverlays() passes, so a test can assert that a settled view does
  // NOT trigger another full rebuild.
  // Stands in for the data setters that call render() continuously in production
  // (setEarthquakes, setMilitaryVessels, ...), so a test can land a render inside
  // the budget replan's settle window.
  forceRender: () => map.render(),
  // #7112: news flashes are #mapOverlays children created outside the marker
  // budget. flashMapForNews() fires them "in bursts across load passes (hundreds
  // of calls shortly after load)", so the burst is what the ceiling must survive.
  burstFlashes: (count: number) => {
    for (let index = 0; index < count; index += 1) {
      map.flashLocation(((index * 7) % 170) - 85, ((index * 13) % 358) - 179, 60000);
    }
  },
  // #7112: drop the seeded feeds so nothing is over budget any more — proves the
  // disclosure is removed when the cut clears, not stranded over a complete map.
  clearOverlayFeeds: () => {
    const internals = map as unknown as {
      hotspots: unknown[];
      state: { layers: Record<string, boolean> };
    };
    internals.hotspots = [];
    map.setMilitaryVessels([] as never, []);
    map.setMilitaryFlights([] as never, []);
    map.setEarthquakes([] as never);
    map.setWeatherAlerts([] as never);
    internals.state.layers.military = false;
    internals.state.layers.natural = false;
    map.render();
  },
  getActiveFlashCount: () => map.getActiveFlashCount(),
  getFlashNodeCount: () =>
    document.getElementById('mapOverlays')?.querySelectorAll('.map-flash').length ?? -1,
  getKeptHotspotCoords: () => {
    const internals = map as unknown as {
      hotspots: Array<{ lat: number; lon: number }>;
      overlayMarkerCut: Set<unknown>;
    };
    return internals.hotspots
      .filter((spot) => !internals.overlayMarkerCut.has(spot))
      .map((spot) => ({ lat: spot.lat, lon: spot.lon }));
  },
  getSeededHotspotCoords: () => {
    const internals = map as unknown as { hotspots: Array<{ lat: number; lon: number }> };
    return internals.hotspots.map((spot) => ({ lat: spot.lat, lon: spot.lon }));
  },
  getOverlayBudgetState: () => map.getOverlayMarkerBudgetState(),
  getPopupRect: () => {
    const element = document.querySelector('.map-popup') as HTMLElement | null;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  },
};
