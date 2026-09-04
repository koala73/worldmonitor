import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyAgentBusAction } from '../src/app/agent-bus-applier.ts';
import type { AppContext } from '../src/app/app-context.ts';
import type { MapLayers, PanelConfig } from '../src/types/index.ts';
import { DASHBOARD_TIME_RANGES } from '../shared/agent-bus-contract.ts';

function makePanel() {
  let showCalls = 0;
  let scrollCalls = 0;
  const element = {
    scrollIntoView: () => { scrollCalls += 1; },
  } as unknown as HTMLElement;
  return {
    panel: {
      show: () => { showCalls += 1; },
      getElement: () => element,
    },
    get showCalls() { return showCalls; },
    get scrollCalls() { return scrollCalls; },
  };
}

function makeCtx(overrides: Partial<AppContext> = {}): AppContext {
  const setCenterCalls: Array<[number, number, number | undefined]> = [];
  const setViewCalls: Array<[string, number | undefined]> = [];
  const setLayersCalls: MapLayers[] = [];
  const setTimeRangeCalls: string[] = [];
  const switchToGlobeCalls: number[] = [];
  const switchToFlatCalls: number[] = [];
  let globeMode = false;
  let deckActive = false;
  const mapLayers = {
    conflicts: false,
    weather: false,
    ciiChoropleth: false,
    resilienceScore: false,
    storageFacilities: false,
  } as unknown as MapLayers;
  return {
    panels: {},
    panelSettings: {},
    mapLayers,
    map: {
      setCenter: (lat: number, lon: number, zoom?: number) => { setCenterCalls.push([lat, lon, zoom]); return setCenterCalls.length; },
      setView: (view: string, zoom?: number) => { setViewCalls.push([view, zoom]); },
      setLayers: (layers: MapLayers) => { setLayersCalls.push(layers); },
      setTimeRange: (range: string) => { setTimeRangeCalls.push(range); },
      getTimeRange: () => setTimeRangeCalls.at(-1) ?? '7d',
      switchToGlobe: () => { globeMode = true; deckActive = false; switchToGlobeCalls.push(1); },
      switchToFlat: () => { globeMode = false; deckActive = true; switchToFlatCalls.push(1); },
      isDeckGLActive: () => deckActive,
      isGlobeMode: () => globeMode,
      _calls: { setCenterCalls, setViewCalls, setLayersCalls, setTimeRangeCalls, switchToGlobeCalls, switchToFlatCalls },
    },
    ...overrides,
  } as unknown as AppContext;
}

const entitled = {
  getPanelConfig: (panelId: string): PanelConfig => ({ name: panelId, enabled: true }),
  isPanelAllowed: () => true,
  hasPremiumAccess: () => false,
  applyLayerChange: () => {},
};

describe('agent bus applier', () => {
  it('opens only live, enabled, entitled panels', () => {
    const panel = makePanel();
    const ctx = makeCtx({
      panels: { forecast: panel.panel as never },
      panelSettings: { forecast: { name: 'Forecasts', enabled: true, premium: 'locked' } },
    });
    const result = applyAgentBusAction(ctx, { type: 'open_panel', panelId: 'forecast' }, entitled);

    assert.equal(result.ok, true);
    assert.equal(result.status, 'applied');
    assert.equal(panel.showCalls, 1);
    assert.equal(panel.scrollCalls, 1);
    assert.equal(ctx.panelSettings.forecast.enabled, true);
  });

  it('denies configured disabled lazy panels before requiring a live instance', () => {
    const panel = makePanel();
    const ctx = makeCtx({
      panels: {},
      panelSettings: { forecast: { name: 'Forecasts', enabled: false } },
    });
    const result = applyAgentBusAction(ctx, { type: 'open_panel', panelId: 'forecast' }, entitled);

    assert.equal(result.ok, false);
    assert.equal(result.status, 'denied');
    assert.equal(result.reason, 'panel_disabled');
    assert.deepEqual(result.targets, [
      { target: 'forecast', status: 'denied', reason: 'panel_disabled' },
    ]);
    assert.equal(panel.showCalls, 0);
    assert.equal(panel.scrollCalls, 0);
    assert.equal(ctx.panelSettings.forecast.enabled, false);
  });

  it('rejects unknown or lazy-not-live panels before mutation', () => {
    const lazyCtx = makeCtx({
      panels: {},
      panelSettings: { forecast: { name: 'Forecasts', enabled: true } },
    });
    const lazyResult = applyAgentBusAction(
      lazyCtx,
      { type: 'open_panel', panelId: 'forecast' },
      entitled,
    );
    const unknownResult = applyAgentBusAction(
      makeCtx({ panels: {}, panelSettings: {} }),
      { type: 'open_panel', panelId: 'not-known' },
      entitled,
    );

    assert.equal(lazyResult.ok, false);
    assert.equal(lazyResult.reason, 'panel_not_live');
    assert.equal(unknownResult.ok, false);
    assert.equal(unknownResult.reason, 'panel_not_live');
  });

  it('enforces premium panel entitlement in the applier', () => {
    const panel = makePanel();
    const ctx = makeCtx({
      panels: { forecast: panel.panel as never },
      panelSettings: { forecast: { name: 'Forecasts', enabled: true, premium: 'locked' } },
    });
    const result = applyAgentBusAction(ctx, { type: 'open_panel', panelId: 'forecast' }, {
      ...entitled,
      isPanelAllowed: () => false,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'panel_not_entitled');
    assert.equal(panel.showCalls, 0);
  });

  it('uses canonical security metadata instead of stale saved panel config', () => {
    const panel = makePanel();
    const ctx = makeCtx({
      panels: { forecast: panel.panel as never },
      panelSettings: { forecast: { name: 'Saved Forecasts', enabled: true } },
    });
    let checkedConfig: PanelConfig | undefined;
    const result = applyAgentBusAction(ctx, { type: 'open_panel', panelId: 'forecast' }, {
      ...entitled,
      getPanelConfig: () => ({
        name: 'AI Forecasts',
        enabled: true,
        premium: 'locked',
      }),
      isPanelAllowed: (_panelId, config) => {
        checkedConfig = config;
        return config.premium !== 'locked';
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'panel_not_entitled');
    assert.equal(checkedConfig?.premium, 'locked');
    assert.equal(panel.showCalls, 0);
    assert.equal(panel.scrollCalls, 0);
  });

  it('keeps dynamic custom-widget and MCP panels Pro-only without canonical metadata', () => {
    for (const panelId of ['cw-risk-chart', 'mcp-risk-feed']) {
      const deniedPanel = makePanel();
      const freeCtx = makeCtx({
        panels: { [panelId]: deniedPanel.panel as never },
        panelSettings: { [panelId]: { name: 'Dynamic panel', enabled: true } },
      });
      const deniedResult = applyAgentBusAction(
        freeCtx,
        { type: 'open_panel', panelId },
        {
          ...entitled,
          getPanelConfig: (id) => ({ name: id, enabled: false }),
          isPanelAllowed: () => true,
          hasPremiumAccess: () => false,
        },
      );

      assert.equal(deniedResult.ok, false, panelId);
      assert.equal(deniedResult.reason, 'panel_not_entitled', panelId);
      assert.equal(deniedPanel.showCalls, 0, panelId);
    }

    const allowedPanel = makePanel();
    const proCtx = makeCtx({
      panels: { 'cw-risk-chart': allowedPanel.panel as never },
      panelSettings: { 'cw-risk-chart': { name: 'Risk chart', enabled: true } },
    });
    const allowedResult = applyAgentBusAction(
      proCtx,
      { type: 'open_panel', panelId: 'cw-risk-chart' },
      {
        ...entitled,
        getPanelConfig: (panelId) => ({ name: panelId, enabled: false }),
        hasPremiumAccess: () => true,
      },
    );

    assert.equal(allowedResult.ok, true);
    assert.equal(allowedPanel.showCalls, 1);
  });

  it('moves the map only after action validation', () => {
    const ctx = makeCtx();
    const viewChanges: Array<[string | undefined, 'programmatic']> = [];
    const result = applyAgentBusAction(ctx, { type: 'set_view', view: 'mena', zoom: 4 }, {
      ...entitled,
      applyViewChange: (action, source) => { viewChanges.push([action.view, source]); },
    });
    const mapCalls = (ctx.map as never as { _calls: { setViewCalls: Array<[string, number | undefined]> } })._calls;

    assert.equal(result.ok, true);
    assert.deepEqual(mapCalls.setViewCalls, [['mena', 4]]);
    assert.deepEqual(viewChanges, [['mena', 'programmatic']]);
    assert.equal(applyAgentBusAction(ctx, { type: 'set_view', lat: 91, lon: 0 }, entitled).status, 'invalid');
  });

  it('treats missing map as a denied no-op', () => {
    const ctx = makeCtx({ map: null });
    const result = applyAgentBusAction(ctx, { type: 'set_view', view: 'eu' }, entitled);

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'map_unavailable');
  });

  it('filters layers by live state, entitlement, variant, and renderer executability', () => {
    const ctx = makeCtx();
    const result = applyAgentBusAction(ctx, {
      type: 'set_layers',
      layers: {
        conflicts: true,
        resilienceScore: true,
        storageFacilities: true,
        notARealLayer: true,
      },
    }, entitled);
    const mapCalls = (ctx.map as never as { _calls: { setLayersCalls: MapLayers[] } })._calls;

    assert.equal(result.ok, true);
    assert.equal(ctx.mapLayers.conflicts, true);
    assert.equal(ctx.mapLayers.resilienceScore, false);
    assert.equal(ctx.mapLayers.storageFacilities, false);
    assert.equal(mapCalls.setLayersCalls.length, 1);
    assert.deepEqual(
      result.targets.map((target) => [target.target, target.status, target.reason ?? '']),
      [
        ['conflicts', 'applied', ''],
        ['resilienceScore', 'denied', 'layer_not_entitled'],
        ['storageFacilities', 'denied', 'layer_not_executable'],
        ['notARealLayer', 'denied', 'unknown_layer'],
      ],
    );
  });

  it('allows free enhanced layers and clears stale locked layers', () => {
    // DeckGL-active context (kind 'deck'): the enhanced CII choropleth renders
    // on deck + globe, so it must be executable here. The default makeCtx mock
    // models the SVG fallback (kind 'svg'), where CII has no paint path.
    const ctx = makeCtx({
      map: {
        setCenter: () => {},
        setView: () => {},
        setLayers: () => {},
        isDeckGLActive: () => true,
        isGlobeMode: () => false,
      } as never,
    });
    ctx.mapLayers.resilienceScore = true;
    const layerChanges: Array<[keyof MapLayers, boolean, 'programmatic']> = [];
    const result = applyAgentBusAction(ctx, {
      type: 'set_layers',
      layers: { ciiChoropleth: true, resilienceScore: false },
    }, {
      ...entitled,
      applyLayerChange: (layer, enabled, source) => { layerChanges.push([layer, enabled, source]); },
    });

    assert.equal(result.ok, true);
    assert.equal(ctx.mapLayers.ciiChoropleth, true,
      'enhanced layers remain available to free users');
    assert.equal(ctx.mapLayers.resilienceScore, false,
      'free users must be able to clear stale locked state');
    assert.deepEqual(layerChanges, [
      ['ciiChoropleth', true, 'programmatic'],
      ['resilienceScore', false, 'programmatic'],
    ]);
  });

  it('denies layer updates when the normal layer-change side effects are unavailable', () => {
    const ctx = makeCtx();
    const result = applyAgentBusAction(ctx, {
      type: 'set_layers',
      layers: { conflicts: true },
    }, {
      getPanelConfig: entitled.getPanelConfig,
      isPanelAllowed: entitled.isPanelAllowed,
      hasPremiumAccess: entitled.hasPremiumAccess,
    });
    const mapCalls = (ctx.map as never as { _calls: { setLayersCalls: MapLayers[] } })._calls;

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'layer_change_unavailable');
    assert.equal(result.targets[0]?.status, 'denied');
    assert.equal(result.targets[0]?.reason, 'layer_change_unavailable');
    assert.equal(ctx.mapLayers.conflicts, false);
    assert.equal(mapCalls.setLayersCalls.length, 0);
  });

  it('does not partially mutate when every requested layer is denied', () => {
    const ctx = makeCtx();
    const before = ctx.mapLayers;
    const result = applyAgentBusAction(ctx, {
      type: 'set_layers',
      layers: { resilienceScore: true },
    }, entitled);
    const mapCalls = (ctx.map as never as { _calls: { setLayersCalls: MapLayers[] } })._calls;

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_allowed_layers');
    assert.equal(ctx.mapLayers, before);
    assert.equal(ctx.mapLayers.resilienceScore, false);
    assert.equal(mapCalls.setLayersCalls.length, 0);
  });

  it('rejects resilienceScore outside DeckGL even for premium users', () => {
    const ctx = makeCtx();
    const result = applyAgentBusAction(ctx, {
      type: 'set_layers',
      layers: { resilienceScore: true },
    }, { ...entitled, hasPremiumAccess: () => true });
    const mapCalls = (ctx.map as never as { _calls: { setLayersCalls: MapLayers[] } })._calls;

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_allowed_layers');
    assert.equal(result.targets[0]?.reason, 'layer_not_executable');
    assert.equal(ctx.mapLayers.resilienceScore, false);
    assert.equal(mapCalls.setLayersCalls.length, 0);
  });

  it('normalizes mutually exclusive choropleth layers before applying', () => {
    const layerChanges: Array<[keyof MapLayers, boolean, 'programmatic']> = [];
    const ctx = makeCtx({
      map: {
        setCenter: () => {},
        setView: () => {},
        setLayers: () => {},
        isDeckGLActive: () => true,
        isGlobeMode: () => false,
      } as never,
    });
    ctx.mapLayers.ciiChoropleth = true;

    const result = applyAgentBusAction(ctx, {
      type: 'set_layers',
      layers: { resilienceScore: true },
    }, {
      ...entitled,
      hasPremiumAccess: () => true,
      applyLayerChange: (layer, enabled, source) => { layerChanges.push([layer, enabled, source]); },
    });

    assert.equal(result.ok, true);
    assert.equal(ctx.mapLayers.resilienceScore, true);
    assert.equal(ctx.mapLayers.ciiChoropleth, false);
    assert.deepEqual(layerChanges, [
      ['ciiChoropleth', false, 'programmatic'],
      ['resilienceScore', true, 'programmatic'],
    ]);
  });

  it('reports a normalized-off requested choropleth as an exclusive conflict', () => {
    const layerChanges: Array<[keyof MapLayers, boolean, 'programmatic']> = [];
    const ctx = makeCtx({
      map: {
        setCenter: () => {},
        setView: () => {},
        setLayers: () => {},
        isDeckGLActive: () => true,
        isGlobeMode: () => false,
      } as never,
    });

    const result = applyAgentBusAction(ctx, {
      type: 'set_layers',
      layers: { ciiChoropleth: true, resilienceScore: true },
    }, {
      ...entitled,
      hasPremiumAccess: () => true,
      applyLayerChange: (layer, enabled, source) => { layerChanges.push([layer, enabled, source]); },
    });

    assert.equal(result.ok, true);
    assert.equal(ctx.mapLayers.ciiChoropleth, true);
    assert.equal(ctx.mapLayers.resilienceScore, false);
    assert.deepEqual(result.targets, [
      { target: 'ciiChoropleth', status: 'applied' },
      {
        target: 'resilienceScore',
        status: 'denied',
        reason: 'exclusive_layer_conflict',
      },
    ]);
    assert.deepEqual(layerChanges, [
      ['ciiChoropleth', true, 'programmatic'],
    ]);
  });

  it('denies feature-disabled cyber and unconfigured AIS/outages even when keys exist', () => {
    const ctx = makeCtx();
    ctx.mapLayers.cyberThreats = false;
    ctx.mapLayers.ais = false;
    ctx.mapLayers.outages = false;
    const result = applyAgentBusAction(ctx, {
      type: 'set_layers',
      layers: {
        conflicts: true,
        cyberThreats: true,
        ais: true,
        outages: true,
      },
    }, {
      ...entitled,
      getMapLayerRuntimeAvailability: () => ({
        cyberLayerEnabled: false,
        aisConfigured: false,
        outagesAvailable: false,
      }),
    });
    const mapCalls = (ctx.map as never as { _calls: { setLayersCalls: MapLayers[] } })._calls;

    assert.equal(result.ok, true);
    assert.equal(ctx.mapLayers.conflicts, true);
    assert.equal(ctx.mapLayers.cyberThreats, false);
    assert.equal(ctx.mapLayers.ais, false);
    assert.equal(ctx.mapLayers.outages, false);
    assert.equal(mapCalls.setLayersCalls.length, 1);
    assert.deepEqual(
      result.targets.map((target) => [target.target, target.status, target.reason ?? '']),
      [
        ['conflicts', 'applied', ''],
        ['cyberThreats', 'denied', 'layer_feature_disabled'],
        ['ais', 'denied', 'layer_not_configured'],
        ['outages', 'denied', 'layer_not_configured'],
      ],
    );
  });
  it('applies every dashboard time-range enum through the map control', () => {
    const ctx = makeCtx();
    const ranges = DASHBOARD_TIME_RANGES;
    for (const timeRange of ranges) {
      const result = applyAgentBusAction(ctx, { type: 'set_time_range', timeRange });
      assert.equal(result.ok, true, timeRange);
      assert.equal(result.actionType, 'set_time_range');
      assert.deepEqual(result.requested, { timeRange });
      assert.deepEqual(result.effective, { timeRange });
      assert.deepEqual(result.compatibility, { adjusted: false });
    }
    assert.deepEqual(
      (ctx.map as { _calls: { setTimeRangeCalls: string[] } })._calls.setTimeRangeCalls,
      [...ranges],
    );
  });

  it('rejects unknown time ranges and map modes before mutation', () => {
    const ctx = makeCtx();
    const invalidRange = applyAgentBusAction(ctx, { type: 'set_time_range', timeRange: '12h' });
    const invalidMode = applyAgentBusAction(ctx, { type: 'set_map_mode', mode: 'globe' });

    assert.equal(invalidRange.ok, false);
    assert.equal(invalidRange.status, 'invalid');
    assert.equal(invalidMode.ok, false);
    assert.equal(invalidMode.status, 'invalid');
    assert.deepEqual((ctx.map as { _calls: { setTimeRangeCalls: string[] } })._calls.setTimeRangeCalls, []);
    assert.deepEqual((ctx.map as { _calls: { switchToGlobeCalls: number[] } })._calls.switchToGlobeCalls, []);
  });

  it('focuses a country bounding box without opening a briefing', () => {
    const ctx = makeCtx();
    const briefCalls: string[] = [];
    const result = applyAgentBusAction(ctx, { type: 'focus_country', iso2: 'DE' }, {
      ...entitled,
      getCountryMapFocus: (iso2) => iso2 === 'DE'
        ? { iso2: 'DE', lat: 51.1, lon: 10.4, zoom: 5, bbox: [5.8, 47.2, 15.0, 55.0] }
        : null,
    });

    assert.equal(result.ok, true);
    assert.equal(result.actionType, 'focus_country');
    assert.equal(result.viewportActionToken, 1);
    assert.deepEqual(result.requested, { iso2: 'DE' });
    assert.deepEqual(result.effective, { iso2: 'DE', lat: 51.1, lon: 10.4, zoom: 5 });
    assert.deepEqual(
      (ctx.map as { _calls: { setViewCalls: Array<[string, number | undefined]> } })._calls.setViewCalls,
      [['global', undefined]],
    );
    assert.deepEqual(
      (ctx.map as { _calls: { setCenterCalls: Array<[number, number, number | undefined]> } })._calls.setCenterCalls,
      [[51.1, 10.4, 5]],
    );
    assert.deepEqual(briefCalls, []);
  });

  it('denies focus_country as geometry_unavailable when country GeoJSON is not loaded', () => {
    const ctx = makeCtx();
    const result = applyAgentBusAction(ctx, { type: 'focus_country', iso2: 'DE' }, {
      ...entitled,
      isCountryGeometryLoaded: () => false,
      getCountryMapFocus: () => ({
        iso2: 'DE', lat: 51.1, lon: 10.4, zoom: 5, bbox: [5.8, 47.2, 15.0, 55.0],
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'denied');
    assert.equal(result.reason, 'geometry_unavailable');
    assert.deepEqual(result.requested, { iso2: 'DE' });
    assert.deepEqual(
      (ctx.map as { _calls: { setCenterCalls: unknown[] } })._calls.setCenterCalls,
      [],
    );
  });

  it('denies unknown country codes with a structured unknown_country result', () => {
    const ctx = makeCtx();
    const result = applyAgentBusAction(ctx, { type: 'focus_country', iso2: 'XX' }, {
      ...entitled,
      isCountryGeometryLoaded: () => true,
      getCountryMapFocus: () => null,
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'denied');
    assert.equal(result.reason, 'unknown_country');
    assert.deepEqual(result.requested, { iso2: 'XX' });
    assert.deepEqual(
      (ctx.map as { _calls: { setCenterCalls: unknown[] } })._calls.setCenterCalls,
      [],
    );
  });

  it('switches 2d and 3d through the visible map-dimension control', async () => {
    const ctx = makeCtx();

    const to3d = await applyAgentBusAction(ctx, { type: 'set_map_mode', mode: '3d' });
    assert.equal(to3d.ok, true);
    assert.deepEqual(to3d.requested, { mode: '3d' });
    assert.deepEqual(to3d.effective, { mode: '3d', renderer: 'globe' });
    assert.deepEqual(to3d.compatibility, { adjusted: false });
    assert.equal((ctx.map as { _calls: { switchToGlobeCalls: number[] } })._calls.switchToGlobeCalls.length, 1);

    const already3d = await applyAgentBusAction(ctx, { type: 'set_map_mode', mode: '3d' });
    assert.equal(already3d.ok, true);
    assert.match(already3d.message ?? '', /already/);
    assert.equal((ctx.map as { _calls: { switchToGlobeCalls: number[] } })._calls.switchToGlobeCalls.length, 1);

    const to2d = await applyAgentBusAction(ctx, { type: 'set_map_mode', mode: '2d' });
    assert.equal(to2d.ok, true);
    assert.deepEqual(to2d.effective, { mode: '2d', renderer: 'deck' });
    assert.equal((ctx.map as { _calls: { switchToFlatCalls: number[] } })._calls.switchToFlatCalls.length, 1);
  });

  it('disables resilienceScore when switching away from DeckGL, matching the UI', async () => {
    const ctx = makeCtx();
    ctx.map.switchToFlat();
    ctx.mapLayers = { ...ctx.mapLayers, resilienceScore: true };

    const result = await applyAgentBusAction(ctx, { type: 'set_map_mode', mode: '3d' });
    assert.equal(result.ok, true);
    assert.equal(ctx.mapLayers.resilienceScore, false);
    assert.equal(result.compatibility?.adjusted, true);
    assert.deepEqual(result.compatibility?.layers, [{
      layer: 'resilienceScore',
      from: true,
      to: false,
      reason: 'layer_not_executable',
    }]);
    assert.deepEqual(
      (ctx.map as { _calls: { setLayersCalls: MapLayers[] } })._calls.setLayersCalls,
      [ctx.mapLayers],
    );
  });

  it('denies 3d and reports the 2d renderer when globe startup falls back', async () => {
    let globeMode = false;
    let deckActive = true;
    let failGlobe!: () => void;
    const ctx = makeCtx();
    ctx.map.switchToGlobe = () => {
      globeMode = true;
      deckActive = false;
      (ctx.map as { _calls: { switchToGlobeCalls: number[] } })._calls.switchToGlobeCalls.push(1);
      return new Promise((resolve) => {
        failGlobe = () => {
          globeMode = false;
          deckActive = false;
          resolve({ renderer: 'svg', mode: 'flat', fallback: true });
        };
      });
    };
    ctx.map.isGlobeMode = () => globeMode;
    ctx.map.isDeckGLActive = () => deckActive;

    const pending = applyAgentBusAction(ctx, { type: 'set_map_mode', mode: '3d' });
    failGlobe();
    const result = await pending;

    assert.equal(result.ok, false);
    assert.equal(result.status, 'denied');
    assert.equal(result.reason, 'globe_unavailable');
    assert.deepEqual(result.requested, { mode: '3d' });
    assert.deepEqual(result.effective, { mode: '2d', renderer: 'svg' });
    assert.equal(result.compatibility?.adjusted, true);
  });
});
