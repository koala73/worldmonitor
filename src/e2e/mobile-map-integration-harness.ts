import '../styles/main.css';
import { MapComponent } from '../components/Map';
import { initI18n } from '../services/i18n';

type MobileMapIntegrationHarness = {
  ready: boolean;
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

  if (url.includes('world-atlas@2/countries-50m.json')) {
    return new Response(JSON.stringify(MINIMAL_WORLD_TOPOLOGY), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return originalFetch(input, init);
}) as typeof fetch;

const layers = {
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
};

await initI18n();

const map = new MapComponent(app, {
  zoom: 2.7,
  pan: { x: 0, y: 0 },
  view: 'global',
  layers,
  timeRange: 'all',
});

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
