import '../styles/main.css';
import { ChinaCorridorPanel } from '../components/ChinaCorridorPanel';
import { MapContainer } from '../components/MapContainer';
import {
  CHINA_CORRIDOR_SIGNAL_FAMILIES,
  CHINA_LOGISTICS_CORRIDORS,
  type ChinaCorridorSignalFamily,
} from '../../shared/china-logistics-corridors';
import type {
  ChinaCorridorCondition,
  ChinaCorridorControlTowerResponse,
  CorridorSourceSignal,
} from '../../shared/china-corridor-control-towers';

declare global {
  interface Window {
    __chinaCorridorPanelHarness?: {
      selectedCorridorId: string | null;
      rendererSupportsOverlay: boolean | null;
      switchRenderer: (renderer: 'deck' | 'globe' | 'svg') => void;
      ready: boolean;
    };
  }
}

const observedAt = '2026-07-25T10:00:00.000Z';

function signal(family: ChinaCorridorSignalFamily): CorridorSourceSignal {
  return {
    id: `signal:test:${family}`,
    family,
    selectorId: `test:${family}`,
    availability: 'available',
    publisher: {
      id: 'publisher:test',
      name: family === 'hazard' ? '<script>unsafe publisher</script>' : `Reviewed ${family} publisher`,
      type: 'official',
    },
    sourceUrl: 'https://example.com/source',
    sourceScope: 'regional',
    observationTime: observedAt,
    observationTimePrecision: 'instant',
    releaseTime: '2026-07-25T10:02:00.000Z',
    releaseTimePrecision: 'instant',
    retrievalTime: '2026-07-25T10:05:00.000Z',
    retrievalTimePrecision: 'instant',
    revision: null,
    transportFreshness: 'fresh',
    contentFreshness: 'current',
    summary: family === 'hazard' ? '<img src=x onerror=alert(1)> unsafe title' : `Reviewed ${family} condition`,
    metrics: {},
  };
}

function condition(family: ChinaCorridorSignalFamily): ChinaCorridorCondition {
  const unavailable = family === 'strategic_industry';
  return {
    family,
    providerId: `provider:${family}`,
    availability: unavailable ? 'unavailable' : family === 'hazard' ? 'stale' : 'available',
    reason: unavailable ? 'No reviewed source observation is present.' : null,
    sourceSignals: unavailable ? [] : [signal(family)],
    provenance: null,
  };
}

const response: ChinaCorridorControlTowerResponse = {
  generatedAt: '2026-07-25T12:00:00.000Z',
  corridors: CHINA_LOGISTICS_CORRIDORS.map((definition, index) => ({
    ...definition,
    availability: index === 1 ? 'stale' : 'partial',
    conditions: CHINA_CORRIDOR_SIGNAL_FAMILIES.map(condition),
  })),
};

const app = document.getElementById('app');
if (!app) throw new Error('Missing #app');

const params = new URLSearchParams(window.location.search);
const renderer = params.get('renderer') ?? 'deck';
const map = Object.create(MapContainer.prototype) as MapContainer;
const mapInternals = map as unknown as Record<string, unknown>;
Object.assign(mapInternals, {
  setCenter: () => {},
  layerLoadingState: new Map(),
  layerReadyState: new Map(),
  pendingViewportActions: [],
  hiddenLayerToggles: new Set(),
  pendingCenter: null,
});
function configureRenderer(kind: string): void {
  Object.assign(mapInternals, {
    useDeckGL: kind === 'deck' || kind === 'pending-deck',
    useGlobe: kind === 'globe',
    globeMap: kind === 'globe' ? {} : null,
    deckGLMap: kind === 'deck' ? { setChinaCorridorSelection: () => {} } : null,
    svgMap: kind === 'svg' ? {} : null,
  });
}
configureRenderer(renderer);
const harness = {
  selectedCorridorId: null as string | null,
  rendererSupportsOverlay: renderer === 'pending-deck'
    ? null
    : renderer === 'deck',
  switchRenderer: (kind: 'deck' | 'globe' | 'svg') => {
    configureRenderer(kind);
    (mapInternals.rehydrateActiveMap as () => void).call(map);
  },
  ready: false,
};
window.__chinaCorridorPanelHarness = harness;
const panel = new ChinaCorridorPanel();
panel.setOnCorridorSelect((corridor) => {
  harness.selectedCorridorId = corridor.id;
  const rendererSupportsOverlay = map.setChinaCorridorSelection(corridor);
  if (rendererSupportsOverlay !== undefined) {
    harness.rendererSupportsOverlay = rendererSupportsOverlay;
  }
  return rendererSupportsOverlay;
});
map.setOnChinaCorridorRendererCapabilityChange((supported) => {
  harness.rendererSupportsOverlay = supported;
  panel.setRendererSupportsOverlay(supported);
});
app.appendChild(panel.getElement());
panel.notifyConnected();
panel.setData(response);
harness.ready = true;
