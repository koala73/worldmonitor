/**
 * A panel's freshness badge describes the data that panel shows. Whether the
 * matching map layer is on is a map concern: the climate, displacement,
 * ucdp-events and radiation-watch panels render current data with their layers
 * off by default, and read "Disabled" when the layer state leaked into the badge.
 *
 * The layer writes go through the real app paths: DataLoaderManager's boot sync
 * and EventHandlerManager's layer toggle. The badge is the real Panel header badge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from '@/app/app-context';
import type { MapLayers } from '@/types';

const mocks = vi.hoisted(() => ({
  outagesConfigured: null as boolean | null,
  aisConfigured: true,
  outagesFeatureAvailable: true,
}));

vi.mock('@/services/analysis-worker', () => ({
  analysisWorker: { clusterNews: vi.fn(), analyzeCorrelations: vi.fn() },
}));
vi.mock('@/services', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services')>(),
  isOutagesConfigured: () => mocks.outagesConfigured,
  isAisConfigured: () => mocks.aisConfigured,
  initAisStream: vi.fn(),
  disconnectAisStream: vi.fn(),
}));
vi.mock('@/services/runtime-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/runtime-config')>();
  return {
    ...actual,
    isFeatureAvailable: (id: Parameters<typeof actual.isFeatureAvailable>[0]) =>
      id === 'internetOutages' ? mocks.outagesFeatureAvailable : actual.isFeatureAvailable(id),
  };
});

const { Panel } = await import('@/components/Panel');
const { dataFreshness } = await import('@/services/data-freshness');
const { EventHandlerManager } = await import('@/app/event-handlers');
const { DataLoaderManager } = await import('@/app/data-loader');
const { fetchInternetOutages } = await import('@/services/infrastructure');

const LAYER_PANELS = [
  { layer: 'climate', panelId: 'climate', sourceId: 'climate' },
  { layer: 'displacement', panelId: 'displacement', sourceId: 'unhcr' },
  { layer: 'ucdpEvents', panelId: 'ucdp-events', sourceId: 'ucdp_events' },
  { layer: 'radiationWatch', panelId: 'radiation-watch', sourceId: 'radiation' },
  { layer: 'sanctions', panelId: 'sanctions-pressure', sourceId: 'sanctions_pressure' },
  { layer: 'outages', panelId: 'internet-disruptions', sourceId: 'outages' },
] as const;

const panels: InstanceType<typeof Panel>[] = [];

function seedHealthy(): void {
  dataFreshness.recordSeedHealth(LAYER_PANELS.map(({ sourceId }) => ({
    sourceId,
    status: 'OK',
    records: 12,
    seedAgeMin: 5,
    maxStaleMin: 60,
    checkedAtMs: Date.now(),
  })));
}

function badgeOf(panelId: string): { text: string; status: string } {
  const panel = new Panel({ id: panelId, title: panelId });
  panels.push(panel);
  const badge = panel.getElement().querySelector('.panel-freshness-badge');
  expect(badge, `${panelId} renders a freshness badge`).not.toBeNull();
  const status = [...badge!.classList].find(c => c.startsWith('panel-freshness-') && c !== 'panel-freshness-badge');
  return { text: badge!.textContent ?? '', status: status?.replace('panel-freshness-', '') ?? '' };
}

function makeLoader(mapLayers: Partial<MapLayers>) {
  const ctx = { mapLayers, disabledSources: new Set<string>(), panels: {} } as unknown as AppContext;
  return new DataLoaderManager(ctx, { renderCriticalBanner: () => undefined, refreshOpenCountryBrief: () => undefined });
}

function makeEventHandlers(mapLayers: Partial<MapLayers>) {
  const container = document.createElement('div');
  document.body.append(container);
  return new EventHandlerManager({
    container,
    isDesktopApp: false,
    panels: {},
    panelSettings: {},
    mapLayers,
  } as never, {
    loadDataForLayer: vi.fn(),
    clearLayerData: vi.fn(),
    waitForAisData: vi.fn(),
  } as never);
}

const allLayersOff = (): Partial<MapLayers> =>
  Object.fromEntries(LAYER_PANELS.map(({ layer }) => [layer, false])) as Partial<MapLayers>;

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  mocks.outagesConfigured = null;
  mocks.aisConfigured = true;
  mocks.outagesFeatureAvailable = true;
  seedHealthy();
});

afterEach(() => {
  for (const panel of panels.splice(0)) panel.destroy();
  makeLoader(Object.fromEntries(LAYER_PANELS.map(({ layer }) => [layer, true]))).syncDataFreshnessWithLayers();
});

describe('panel freshness badge with its map layer off', () => {
  it('reports the loaded data as fresh when the boot sync sees every layer off', () => {
    makeLoader(allLayersOff()).syncDataFreshnessWithLayers();

    for (const { panelId } of LAYER_PANELS) {
      const badge = badgeOf(panelId);
      expect(badge.status, panelId).toBe('fresh');
      expect(badge.text, panelId).not.toMatch(/Disabled/);
    }
  });

  it('keeps the badge on the data freshness while the layer toggles on and off', () => {
    const mapLayers = allLayersOff();
    makeLoader(mapLayers).syncDataFreshnessWithLayers();
    const handlers = makeEventHandlers(mapLayers);
    const badges = LAYER_PANELS.map(({ panelId }) => {
      const panel = new Panel({ id: panelId, title: panelId });
      panels.push(panel);
      return { panelId, el: panel.getElement().querySelector('.panel-freshness-badge')! };
    });

    for (const { layer } of LAYER_PANELS) {
      handlers.applyMapLayerChange(layer, true, 'user');
      handlers.applyMapLayerChange(layer, false, 'user');
    }
    for (const { panelId, el } of badges) {
      expect(el.classList.contains('panel-freshness-fresh'), `${panelId}: ${el.className}`).toBe(true);
    }

    handlers.destroy();
  });

  it('still hides a layer-off source from the monitoring summary', () => {
    makeLoader(allLayersOff()).syncDataFreshnessWithLayers();

    const climate = dataFreshness.getAllSources().find(source => source.id === 'climate');
    expect(climate?.status).toBe('disabled');
  });

  it('still reads Disabled when the client cannot collect the source at all', () => {
    mocks.outagesConfigured = false;
    makeLoader({ outages: true }).syncDataFreshnessWithLayers();

    expect(badgeOf('internet-disruptions').status).toBe('disabled');
  });

  it('reads Disabled once the outage fetch finds the feature unavailable after boot', async () => {
    makeLoader({ outages: true }).syncDataFreshnessWithLayers();
    expect(badgeOf('internet-disruptions').status).toBe('fresh');

    mocks.outagesFeatureAvailable = false;
    await fetchInternetOutages();

    expect(badgeOf('internet-disruptions').status).toBe('disabled');
  });

  it('keeps outages Disabled when a request started before the feature was turned off settles later', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ outages: [{ id: 'gy-1', title: 'Guyana outage', country: 'Guyana' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    try {
      const inFlight = fetchInternetOutages();
      mocks.outagesFeatureAvailable = false;
      await fetchInternetOutages();
      release();
      await inFlight;

      expect(badgeOf('internet-disruptions').status).toBe('disabled');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('marks AIS collectable when its layer turns on after AIS became available', () => {
    mocks.aisConfigured = false;
    const mapLayers: Partial<MapLayers> = { ais: false };
    makeLoader(mapLayers).syncDataFreshnessWithLayers();
    const handlers = makeEventHandlers(mapLayers);

    mocks.aisConfigured = true;
    handlers.applyMapLayerChange('ais', true, 'user');

    expect(dataFreshness.getAllSources().find(source => source.id === 'ais')?.status).not.toBe('disabled');
    handlers.destroy();
  });
});
