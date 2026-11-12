/**
 * Dashboard focus on the map (#10453): the chosen countries outlined solid,
 * neighbours lighter, the view fitted to the chosen countries only, and
 * markers never filtered. Covers the three renderers (DeckGL desktop, SVG
 * mobile/fallback, globe) and the MapContainer facade that orders the fit
 * against other viewport commands.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeckGLMap } from '@/components/DeckGLMap';
import { GlobeMap } from '@/components/GlobeMap';
import { MapComponent } from '@/components/Map';
import { MapContainer } from '@/components/MapContainer';
import { focusFitBounds, focusSingleWorldFitBounds } from '@/utils/focus-map';

const OUTLINE = { chosen: ['TH', 'VN', 'ID'], neighbours: ['KH', 'LA', 'MY'] };

type Filter = unknown[];

function codesOf(filter: Filter): string[] {
  // ['in', ['get', 'ISO3166-1-Alpha-2'], ['literal', codes]]
  return ((filter[2] as unknown[])[1] as string[]).slice();
}

function fakeMapLibre() {
  const layers = new Map<string, { paint: Record<string, unknown>; filter: Filter; order: number }>();
  const filters = new Map<string, Filter>();
  let order = 0;
  return {
    layers,
    filters,
    addLayer: vi.fn((layer: { id: string; paint: Record<string, unknown>; filter: Filter }) => {
      layers.set(layer.id, { paint: layer.paint, filter: layer.filter, order: order++ });
    }),
    getLayer: vi.fn((id: string) => (layers.has(id) ? { id } : undefined)),
    setFilter: vi.fn((id: string, filter: Filter) => { filters.set(id, filter); }),
    setPaintProperty: vi.fn(),
    cameraForBounds: vi.fn(() => ({ center: { lng: 235.18, lat: 6.49 }, zoom: 4.2 })),
    flyTo: vi.fn(),
    getZoom: () => 2,
  };
}

function deckHost(map = fakeMapLibre()) {
  const container = document.createElement('div');
  const deck = Object.assign(Object.create(DeckGLMap.prototype), {
    maplibreMap: map,
    countryGeoJsonLoaded: true,
    focusOutline: null,
    container,
    state: { zoom: 2 },
    pendingCenter: null,
    markViewportMoving: vi.fn(() => 7),
    onStateChange: vi.fn(),
    getState: () => ({ zoom: deck.state.zoom }),
  });
  return { deck, map };
}

describe('DeckGL focus outline', () => {
  it('adds a solid chosen border above a lighter neighbour border, separate from the country-brief highlight', () => {
    const { deck, map } = deckHost();
    deck.addFocusOutlineLayers();
    const chosen = map.layers.get('country-focus-chosen-border')!;
    const neighbour = map.layers.get('country-focus-neighbour-border')!;
    const fill = map.layers.get('country-focus-chosen-fill')!;
    expect(chosen && neighbour && fill).toBeTruthy();
    expect(chosen.paint['line-width']).toBeGreaterThan(neighbour.paint['line-width'] as number);
    expect(chosen.paint['line-opacity']).toBeGreaterThan(neighbour.paint['line-opacity'] as number);
    expect(neighbour.paint['line-dasharray']).toBeUndefined();
    // Drawn after the neighbours, so a shared border shows the chosen style.
    expect(chosen.order).toBeGreaterThan(neighbour.order);
    expect(map.layers.has('country-highlight-border')).toBe(false);
  });

  it('filters the chosen layers to the chosen countries and the neighbour layer to the neighbours', () => {
    const { deck, map } = deckHost();
    deck.addFocusOutlineLayers();
    deck.setFocusOutline(OUTLINE);
    expect(codesOf(map.filters.get('country-focus-chosen-border')!)).toEqual(['TH', 'VN', 'ID']);
    expect(codesOf(map.filters.get('country-focus-chosen-fill')!)).toEqual(['TH', 'VN', 'ID']);
    expect(codesOf(map.filters.get('country-focus-neighbour-border')!)).toEqual(['KH', 'LA', 'MY']);
  });

  it('outlines only the chosen countries when neighbours are off, and nothing once cleared', () => {
    const { deck, map } = deckHost();
    deck.addFocusOutlineLayers();
    deck.setFocusOutline({ chosen: ['TH'], neighbours: [] });
    expect(codesOf(map.filters.get('country-focus-chosen-border')!)).toEqual(['TH']);
    expect(codesOf(map.filters.get('country-focus-neighbour-border')!)).toEqual([]);
    deck.setFocusOutline(null);
    expect(codesOf(map.filters.get('country-focus-chosen-border')!)).toEqual([]);
    expect(codesOf(map.filters.get('country-focus-neighbour-border')!)).toEqual([]);
  });

  it('keeps a focus set before the boundaries load and applies it when they do', () => {
    const { deck, map } = deckHost();
    deck.setFocusOutline(OUTLINE);
    expect(map.setFilter).not.toHaveBeenCalled();
    deck.addFocusOutlineLayers();
    deck.applyFocusOutline();
    expect(codesOf(map.filters.get('country-focus-chosen-border')!)).toEqual(['TH', 'VN', 'ID']);
  });

  it('fits the given bounds with the zoom cap and flies to a normalized centre', () => {
    const { deck, map } = deckHost();
    const fit = focusSingleWorldFitBounds(['FJ', 'US'])!;
    deck.fitFocusBounds(fit, 6);
    expect(map.cameraForBounds).toHaveBeenCalledWith(
      [[fit.west, fit.south], [fit.east, fit.north]],
      expect.objectContaining({ maxZoom: 6 }),
    );
    // One world (renderWorldCopies: false): the bounds stay in [-180, 180]
    // and cover Fiji (177.34..180) and the US (-168.08..-66.98).
    expect(fit.west).toBeGreaterThanOrEqual(-180);
    expect(fit.west).toBeLessThanOrEqual(-168.08);
    expect(fit.east).toBe(180);
    const [options] = map.flyTo.mock.calls[0]!;
    expect(options.center[0]).toBeCloseTo(235.18 - 360, 6);
    expect(options.zoom).toBe(4.2);
    expect(deck.onStateChange).toHaveBeenCalledOnce();
  });
});

describe('SVG focus outline', () => {
  function svgHost(ids: string[]) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    document.body.append(svg);
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('class', 'map-base');
    svg.append(group);
    for (const id of ids) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('class', 'country');
      path.dataset.id = id;
      (path as unknown as { __data__: unknown }).__data__ = { id };
      group.append(path);
    }
    return { svg, group };
  }

  afterEach(() => document.body.replaceChildren());

  it('classes chosen and neighbour paths by their M49 id and draws chosen last', async () => {
    const d3 = await import('d3');
    // TH 764, VN 704, ID 360 chosen; LA 418, KH 116, MY 458 neighbours; FR 250 neither.
    const { group } = svgHost(['764', '418', '250', '704', '116', '360', '458']);
    const map = Object.assign(Object.create(MapComponent.prototype), {
      baseLayerGroup: d3.select(group),
      focusOutline: null,
    });
    map.setFocusOutline(OUTLINE);
    const classed = (cls: string) => [...group.querySelectorAll(`.${cls}`)].map((el) => (el as SVGElement).dataset.id).sort();
    expect(classed('country-focus-chosen')).toEqual(['360', '704', '764']);
    expect(classed('country-focus-neighbour')).toEqual(['116', '418', '458']);
    const order = [...group.children].map((el) => (el as SVGElement).dataset.id);
    expect(order.slice(-3).sort()).toEqual(['360', '704', '764']);
    expect(order[0]).toBe('250');

    map.setFocusOutline({ chosen: ['TH'], neighbours: [] });
    expect(classed('country-focus-chosen')).toEqual(['764']);
    expect(classed('country-focus-neighbour')).toEqual([]);

    map.setFocusOutline(null);
    expect(group.querySelectorAll('.country-focus-chosen, .country-focus-neighbour')).toHaveLength(0);
  });

  it('fits by zoom and centre with the SVG zoom cap', () => {
    const setCenter = vi.fn();
    const map = Object.assign(Object.create(MapComponent.prototype), {
      state: { zoom: 1 },
      readContainerSize: () => ({ width: 390, height: 300 }),
      setCenter,
      resumeMobileLabelVisibility: vi.fn(),
    });
    const fit = focusFitBounds(['TH', 'VN', 'ID'])!;
    map.fitFocusBounds(fit);
    expect(setCenter).toHaveBeenCalledWith(fit.center.lat, fit.center.lon);
    expect(map.state.zoom).toBeGreaterThan(1);
    expect(map.state.zoom).toBeLessThanOrEqual(6);

    map.state.zoom = 1;
    map.fitFocusBounds(focusFitBounds(['RU', 'US'])!);
    expect(map.state.zoom).toBeLessThan(2);
  });

  it('rings missing small-country boundaries at their projected centres and clears them', async () => {
    const d3 = await import('d3');
    const { group } = svgHost(['764', '458']);
    const map = Object.assign(Object.create(MapComponent.prototype), {
      baseLayerGroup: d3.select(group), focusOutline: null,
      readContainerSize: () => ({ width: 390, height: 300 }),
    });
    map.setFocusOutline({ chosen: ['SG', 'BH', 'MT', 'TH'], neighbours: ['AD'] });
    const rings = [...group.querySelectorAll<SVGCircleElement>('.focus-centre-ring')];
    expect(rings.map(el => el.dataset.id).sort()).toEqual(['020', '048', '470', '702']);
    const singapore = group.querySelector<SVGCircleElement>('[data-id="702"]')!;
    expect(singapore.classList.contains('country-focus-chosen')).toBe(true);
    const [x, y] = map.getProjection(390, 300)([103.82, 1.36]);
    expect(Number(singapore.getAttribute('cx'))).toBeCloseTo(x);
    expect(Number(singapore.getAttribute('cy'))).toBeCloseTo(y);
    expect(singapore.getAttribute('pointer-events')).toBe('none');
    map.setFocusOutline({ chosen: ['AD'], neighbours: [] });
    expect(group.querySelectorAll('.focus-centre-ring')).toHaveLength(1);
    expect(group.querySelector('.focus-centre-ring.country-focus-chosen')).toBeTruthy();
    map.setFocusOutline(null);
    expect(group.querySelectorAll('.focus-centre-ring')).toHaveLength(0);
  });

  function hiddenSvg() {
    let size = { width: 0, height: 0 };
    const map = Object.assign(Object.create(MapComponent.prototype), {
      state: { zoom: 2.5 },
      readContainerSize: () => size,
      setCenter: vi.fn(function (this: { pendingFocusFit: unknown }) { this.pendingFocusFit = null; }),
      resumeMobileLabelVisibility: vi.fn(),
      scheduleRender: vi.fn(),
      pendingCenter: null,
      pendingFocusFit: null,
    });
    return { map, show: () => { size = { width: 390, height: 300 }; } };
  }

  it('waits for a collapsed mobile map to open, then fits', () => {
    const { map, show } = hiddenSvg();
    const fit = focusFitBounds(['TH', 'VN', 'ID'])!;
    map.fitFocusBounds(fit);
    expect(map.state.zoom).toBe(2.5);
    expect(map.setCenter).not.toHaveBeenCalled();
    show();
    map.resize(); // "Show map" dispatches a resize
    expect(map.setCenter).toHaveBeenCalledWith(fit.center.lat, fit.center.lon);
    expect(map.state.zoom).toBeGreaterThan(2.5);
  });

  it('drops a waiting fit when the focus is cleared first', () => {
    const { map, show } = hiddenSvg();
    Object.assign(map, { baseLayerGroup: null, focusOutline: null });
    map.fitFocusBounds(focusFitBounds(['TH'])!);
    map.setFocusOutline(null);
    show();
    map.resize();
    expect(map.setCenter).not.toHaveBeenCalled();
    expect(map.state.zoom).toBe(2.5);
  });
});

describe('Globe focus outline', () => {
  function feature(code: string) {
    return {
      type: 'Feature',
      properties: { 'ISO3166-1-Alpha-2': code, name: code },
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    };
  }

  it('adds chosen and neighbour polygons, neighbours first, and removes them on clear', () => {
    const polygonsData = vi.fn();
    const map = Object.assign(Object.create(GlobeMap.prototype), {
      globe: { polygonsData },
      initialized: true,
      destroyed: false,
      webglLost: false,
      layers: {},
      scenarioPolygons: [],
      focusOutline: null,
      reversedRingCache: new Map(),
      countriesGeoData: { type: 'FeatureCollection', features: ['TH', 'LA', 'FR', 'VN'].map(feature) },
      wakeGlobe: vi.fn(),
    });
    map.setFocusOutline({ chosen: ['TH', 'VN'], neighbours: ['LA'] });
    const polys = polygonsData.mock.lastCall![0] as Array<{ name: string; _kind: string }>;
    expect(polys.map((p) => [p.name, p._kind])).toEqual([
      ['LA', 'focusNeighbour'],
      ['TH', 'focusChosen'],
      ['VN', 'focusChosen'],
    ]);
    map.setFocusOutline(null);
    expect(polygonsData.mock.lastCall![0]).toEqual([]);
  });

  it('uses the same globe ring winding for CII fills and focus outlines without mutating the boundary', () => {
    const boundary = feature('TH');
    const original = structuredClone(boundary.geometry.coordinates);
    const polygonsData = vi.fn();
    const map = Object.assign(Object.create(GlobeMap.prototype), {
      globe: { polygonsData }, initialized: true, destroyed: false, webglLost: false,
      layers: { ciiChoropleth: true }, scenarioPolygons: [], focusOutline: null,
      reversedRingCache: new Map(), ciiScoresMap: new Map(), wakeGlobe: vi.fn(),
      countriesGeoData: { type: 'FeatureCollection', features: [boundary] },
    });
    map.setCIIScores([{ code: 'TH', score: 73, level: 'high' }]);
    map.setFocusOutline({ chosen: ['TH'], neighbours: [] });
    const polys = polygonsData.mock.lastCall![0];
    expect(polys.find((p: { _kind: string }) => p._kind === 'cii').coords)
      .toEqual(polys.find((p: { _kind: string }) => p._kind === 'focusChosen').coords);
    expect(boundary.geometry.coordinates).toEqual(original);
  });

  it('builds the outline once countries load after the focus was set', () => {
    const polygonsData = vi.fn();
    const map = Object.assign(Object.create(GlobeMap.prototype), {
      globe: { polygonsData },
      initialized: true, destroyed: false, webglLost: false, layers: {}, scenarioPolygons: [],
      focusOutline: null, reversedRingCache: new Map(), countriesGeoData: null, wakeGlobe: vi.fn(),
    });
    map.setFocusOutline({ chosen: ['TH'], neighbours: [] });
    expect(polygonsData.mock.lastCall![0]).toEqual([]);
    map.countriesGeoData = { type: 'FeatureCollection', features: [feature('TH')] };
    map.flushPolygons();
    expect((polygonsData.mock.lastCall![0] as Array<{ _kind: string }>).map((p) => p._kind)).toEqual(['focusChosen']);
  });
});

describe('MapContainer focus scope', () => {
  function renderer() {
    return {
      setFocusOutline: vi.fn(),
      fitFocusBounds: vi.fn(),
      setCenter: vi.fn(),
      setView: vi.fn(),
      setZoom: vi.fn(),
      openReservoir: vi.fn(),
      openChokepoint: vi.fn(),
    };
  }

  function container(options: { ready?: boolean; renderer?: 'deck' | 'svg' | 'globe' } = {}) {
    const deck = renderer();
    const svg = renderer();
    const globe = renderer();
    const kind = options.renderer ?? 'deck';
    const map = Object.assign(Object.create(MapContainer.prototype), {
      useDeckGL: kind === 'deck',
      useGlobe: kind === 'globe',
      deckGLMap: kind === 'deck' ? deck : null,
      svgMap: kind === 'svg' ? svg : null,
      globeMap: kind === 'globe' ? globe : null,
      rendererReady: options.ready ?? true,
      destroyed: false,
      rendererInitToken: 1,
      rendererInitError: null,
      rendererReadyWaiters: new Set(),
      rendererDemandRequested: false,
      releaseRendererDemand: null,
      pendingChokepointOpen: null,
      pendingReservoirOpen: null,
      viewportActionToken: 0,
      humanViewportInteractionToken: 0,
      pendingViewportActions: [],
      pendingCenter: null,
      initialState: {},
      focusOutline: null,
      focusFitSeq: 0,
    });
    return { map, deck, svg, globe };
  }

  it('outlines on the active renderer and fits the chosen countries only', async () => {
    const { map, deck } = container();
    map.setFocusScope(OUTLINE, { fit: true });
    expect(deck.setFocusOutline).toHaveBeenCalledWith(OUTLINE);
    await vi.dynamicImportSettled();
    expect(deck.fitFocusBounds).toHaveBeenCalledOnce();
    const [fit, maxZoom] = deck.fitFocusBounds.mock.calls[0]!;
    expect(fit).toEqual(focusFitBounds(['TH', 'VN', 'ID']));
    expect(maxZoom).toBe(6);
  });

  it('uses the SVG fit on the mobile renderer and the globe fit with an altitude on the globe', async () => {
    const svg = container({ renderer: 'svg' });
    svg.map.setFocusScope(OUTLINE, { fit: true });
    const globe = container({ renderer: 'globe' });
    globe.map.setFocusScope(OUTLINE, { fit: true });
    await vi.dynamicImportSettled();
    expect(svg.svg.setFocusOutline).toHaveBeenCalledWith(OUTLINE);
    expect(svg.svg.fitFocusBounds).toHaveBeenCalledWith(focusFitBounds(['TH', 'VN', 'ID']));
    expect(globe.globe.setFocusOutline).toHaveBeenCalledWith(OUTLINE);
    expect(globe.globe.fitFocusBounds).toHaveBeenCalledWith(focusFitBounds(['TH', 'VN', 'ID']), expect.any(Number));
  });

  it('outlines without moving when fit is off, and clears without moving', async () => {
    const { map, deck } = container();
    map.setFocusScope(OUTLINE, { fit: false });
    map.setFocusScope(null, { fit: false });
    await vi.dynamicImportSettled();
    expect(deck.setFocusOutline).toHaveBeenLastCalledWith(null);
    expect(deck.fitFocusBounds).not.toHaveBeenCalled();
    expect(deck.setCenter).not.toHaveBeenCalled();
  });

  it('drops a fit that a clear overtook', async () => {
    const { map, deck } = container();
    map.setFocusScope(OUTLINE, { fit: true });
    map.setFocusScope(null, { fit: false });
    await vi.dynamicImportSettled();
    expect(deck.fitFocusBounds).not.toHaveBeenCalled();
  });

  it.each([true, false])('drops an older fit when an outline-only update changes countries (ready=%s)', async (ready) => {
    const { map, deck } = container({ ready });
    map.setFocusScope({ chosen: ['TH'], neighbours: [] }, { fit: true });
    if (!ready) await vi.dynamicImportSettled();
    map.setFocusScope({ chosen: ['FJ'], neighbours: [] }, { fit: false });
    await vi.dynamicImportSettled();
    if (!ready) map.markRendererReady(1);
    expect(deck.fitFocusBounds).not.toHaveBeenCalled();
    expect(deck.setFocusOutline).toHaveBeenLastCalledWith({ chosen: ['FJ'], neighbours: [] });
  });

  it('keeps a pending fit for the same chosen set when only neighbours or order change', async () => {
    const { map, deck } = container();
    map.setFocusScope(OUTLINE, { fit: true });
    map.setFocusScope({ chosen: ['ID', 'TH', 'VN'], neighbours: [] }, { fit: false });
    await vi.dynamicImportSettled();
    expect(deck.fitFocusBounds).toHaveBeenCalledOnce();
  });

  it.each(['deck', 'svg', 'globe'] as const)('direct navigation supersedes a loading focus fit on %s', async (kind) => {
    for (const destination of ['reservoir', 'chokepoint']) {
      const host = container({ renderer: kind });
      const active = host[kind];
      host.map.setFocusScope(OUTLINE, { fit: true });
      if (destination === 'reservoir') host.map.openReservoir({ id: 'test' });
      else host.map.openChokepoint('hormuz');
      await vi.dynamicImportSettled();
      expect(active.fitFocusBounds).not.toHaveBeenCalled();
      expect(destination === 'reservoir' ? active.openReservoir : active.openChokepoint).toHaveBeenCalledOnce();
    }
  });

  it.each(['reservoir', 'chokepoint'])('direct %s navigation supersedes a queued focus fit before renderer readiness', async (destination) => {
    const { map, deck } = container({ ready: false });
    map.setFocusScope(OUTLINE, { fit: true });
    await vi.dynamicImportSettled();
    if (destination === 'reservoir') map.openReservoir({ id: 'test' });
    else map.openChokepoint('hormuz');
    map.markRendererReady(1);
    expect(deck.fitFocusBounds).not.toHaveBeenCalled();
    expect(destination === 'reservoir' ? deck.openReservoir : deck.openChokepoint).toHaveBeenCalledOnce();
  });

  it.each(['reservoir', 'chokepoint'])('replaying an older %s open preserves a newer loading focus fit', async (destination) => {
    const { map, deck } = container({ ready: false });
    if (destination === 'reservoir') map.openReservoir({ id: 'test' });
    else map.openChokepoint('hormuz');
    map.setFocusScope(OUTLINE, { fit: true });
    map.markRendererReady(1);
    const open = destination === 'reservoir' ? deck.openReservoir : deck.openChokepoint;
    expect(open).toHaveBeenCalledOnce();
    await vi.dynamicImportSettled();
    expect(deck.fitFocusBounds).toHaveBeenCalledWith(focusFitBounds(OUTLINE.chosen), 6);
    expect(open.mock.invocationCallOrder[0]).toBeLessThan(deck.fitFocusBounds.mock.invocationCallOrder[0]!);
  });

  it('a team dashboard\'s stored view, applied after the focus, wins over the fit', async () => {
    const { map, deck } = container();
    // Even without FocusMapSync's hold, a later viewport command supersedes
    // a fit that has not run yet.
    map.setFocusScope(OUTLINE, { fit: true });
    map.setCenter(13.7, 100.5, 5);
    await vi.dynamicImportSettled();
    expect(deck.setCenter).toHaveBeenCalledWith(13.7, 100.5, 5);
    expect(deck.fitFocusBounds).not.toHaveBeenCalled();
    expect(deck.setFocusOutline).toHaveBeenCalledWith(OUTLINE);
  });

  it('drops the fit when the user moves the map before it runs', async () => {
    const { map, deck } = container();
    map.setFocusScope(OUTLINE, { fit: true });
    map.markHumanViewportInteraction();
    await vi.dynamicImportSettled();
    expect(deck.fitFocusBounds).not.toHaveBeenCalled();
  });

  it('queues the fit until the renderer is ready, after earlier viewport commands', async () => {
    const { map, deck } = container({ ready: false });
    map.setView('global', 2); // the URL's view, applied before the focus
    map.setFocusScope(OUTLINE, { fit: true });
    await vi.dynamicImportSettled();
    expect(deck.fitFocusBounds).not.toHaveBeenCalled();
    map.markRendererReady(1);
    expect(deck.setView).toHaveBeenCalledWith('global', 2);
    expect(deck.fitFocusBounds).toHaveBeenCalledOnce();
    expect(deck.setView.mock.invocationCallOrder[0]).toBeLessThan(deck.fitFocusBounds.mock.invocationCallOrder[0]!);
  });

  it('drops a queued fit when a later viewport command was queued after it', async () => {
    const { map, deck } = container({ ready: false });
    map.setFocusScope(OUTLINE, { fit: true });
    await vi.dynamicImportSettled();
    map.setZoom(2); // queued after the fit, before the renderer is ready
    map.markRendererReady(1);
    expect(deck.setZoom).toHaveBeenCalledWith(2);
    expect(deck.fitFocusBounds).not.toHaveBeenCalled();

    const later = container({ ready: false });
    later.map.setFocusScope(OUTLINE, { fit: true });
    await vi.dynamicImportSettled();
    later.map.setView('eu');
    later.map.markRendererReady(1);
    expect(later.deck.setView).toHaveBeenCalledWith('eu', undefined);
    expect(later.deck.fitFocusBounds).not.toHaveBeenCalled();
  });

  it('drops a queued fit when the user moved the map before the renderer was ready', async () => {
    const { map, deck } = container({ ready: false });
    map.setFocusScope(OUTLINE, { fit: true });
    await vi.dynamicImportSettled();
    map.markHumanViewportInteraction();
    map.markRendererReady(1);
    expect(deck.fitFocusBounds).not.toHaveBeenCalled();
  });

  it('a clear before the renderer is ready cancels the queued fit', async () => {
    const { map, deck } = container({ ready: false });
    map.setFocusScope(OUTLINE, { fit: true });
    await vi.dynamicImportSettled();
    map.setFocusScope(null, { fit: false });
    map.markRendererReady(1);
    expect(deck.fitFocusBounds).not.toHaveBeenCalled();
  });

  it('a newer fit replaces an older queued one', async () => {
    const { map, deck } = container({ ready: false });
    map.setFocusScope(OUTLINE, { fit: true });
    await vi.dynamicImportSettled();
    map.setFocusScope({ chosen: ['FJ'], neighbours: [] }, { fit: true });
    await vi.dynamicImportSettled();
    map.markRendererReady(1);
    expect(deck.fitFocusBounds).toHaveBeenCalledOnce();
  });

  it('fits a small state without a boundary box around its centre', async () => {
    const { map, deck } = container();
    map.setFocusScope({ chosen: ['SG'], neighbours: ['MY', 'ID'] }, { fit: true });
    await vi.dynamicImportSettled();
    expect(deck.setFocusOutline).toHaveBeenCalledWith({ chosen: ['SG'], neighbours: ['MY', 'ID'] });
    expect(deck.fitFocusBounds).toHaveBeenCalledWith(focusFitBounds(['SG']), 6);
  });

  it('does not fit when no chosen country can be placed, but still outlines', async () => {
    const { map, deck } = container();
    map.setFocusScope({ chosen: ['XX'], neighbours: ['MY'] }, { fit: true });
    await vi.dynamicImportSettled();
    expect(deck.setFocusOutline).toHaveBeenCalledWith({ chosen: ['XX'], neighbours: ['MY'] });
    expect(deck.fitFocusBounds).not.toHaveBeenCalled();
  });

  it('gives the one-world flat renderers a fit inside [-180, 180] and the globe the short arc', async () => {
    const pacific = { chosen: ['FJ', 'US'], neighbours: [] };
    const deck = container({ renderer: 'deck' });
    deck.map.setFocusScope(pacific, { fit: true });
    const svg = container({ renderer: 'svg' });
    svg.map.setFocusScope(pacific, { fit: true });
    const globe = container({ renderer: 'globe' });
    globe.map.setFocusScope(pacific, { fit: true });
    await vi.dynamicImportSettled();
    const flat = focusSingleWorldFitBounds(['FJ', 'US'])!;
    expect(flat.east).toBeLessThanOrEqual(180);
    expect(deck.deck.fitFocusBounds).toHaveBeenCalledWith(flat, 6);
    expect(svg.svg.fitFocusBounds).toHaveBeenCalledWith(flat);
    const arc = focusFitBounds(['FJ', 'US'])!;
    expect(arc.east).toBeGreaterThan(180);
    expect(globe.globe.fitFocusBounds).toHaveBeenCalledWith(arc, expect.any(Number));
  });

  it('re-applies the outline to a renderer created after a switch', () => {
    const { map, globe } = container({ renderer: 'deck' });
    map.setFocusScope(OUTLINE, { fit: false });
    Object.assign(map, {
      useDeckGL: false, useGlobe: true, deckGLMap: null, globeMap: globe,
      emergencyLayer: { setEnabled: vi.fn() }, notamAirspaceLayer: { setEnabled: vi.fn() },
      cachedNotamAirspace: [], layerLoadingState: new Map(), layerReadyState: new Map(), hiddenLayerToggles: new Set(),
    });
    Object.assign(globe, { getState: () => ({ layers: {} }) });
    map.rehydrateActiveMap();
    expect(globe.setFocusOutline).toHaveBeenCalledWith(OUTLINE);
    expect(globe.fitFocusBounds).not.toHaveBeenCalled();
  });
});
