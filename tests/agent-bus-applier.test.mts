import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyAgentBusAction } from '../src/app/agent-bus-applier.ts';
import type { AppContext } from '../src/app/app-context.ts';
import type { MapLayers, PanelConfig } from '../src/types/index.ts';

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
      setCenter: (lat: number, lon: number, zoom?: number) => { setCenterCalls.push([lat, lon, zoom]); },
      setView: (view: string, zoom?: number) => { setViewCalls.push([view, zoom]); },
      setLayers: (layers: MapLayers) => { setLayersCalls.push(layers); },
      isDeckGLActive: () => false,
      isGlobeMode: () => false,
      _calls: { setCenterCalls, setViewCalls, setLayersCalls },
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
  it('opens only live, entitled panels', () => {
    const panel = makePanel();
    const ctx = makeCtx({
      panels: { forecast: panel.panel as never },
      panelSettings: { forecast: { name: 'Forecasts', enabled: false, premium: 'locked' } },
    });
    const result = applyAgentBusAction(ctx, { type: 'open_panel', panelId: 'forecast' }, entitled);

    assert.equal(result.ok, true);
    assert.equal(result.status, 'applied');
    assert.equal(panel.showCalls, 1);
    assert.equal(panel.scrollCalls, 1);
    assert.equal(ctx.panelSettings.forecast.enabled, false, 'open_panel must not persistently enable settings');
  });

  it('rejects unknown or lazy-not-live panels before mutation', () => {
    const ctx = makeCtx({
      panels: {},
      panelSettings: { forecast: { name: 'Forecasts', enabled: true } },
    });
    const result = applyAgentBusAction(ctx, { type: 'open_panel', panelId: 'forecast' }, entitled);

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'panel_not_live');
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

  it('moves the map only after action validation', () => {
    const ctx = makeCtx();
    const result = applyAgentBusAction(ctx, { type: 'set_view', view: 'mena', zoom: 4 }, entitled);
    const mapCalls = (ctx.map as never as { _calls: { setViewCalls: Array<[string, number | undefined]> } })._calls;

    assert.equal(result.ok, true);
    assert.deepEqual(mapCalls.setViewCalls, [['mena', 4]]);
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
});
