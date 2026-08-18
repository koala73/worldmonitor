import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  applyWebMcpDashboardAction,
  getWebMcpDashboardContext,
  waitForWebMcpUiReady,
} from '../src/app/webmcp-dashboard.ts';
import { runDashboardActionBinding } from '../src/app/dashboard-action-binding.ts';
import { DashboardBindingError } from '../src/services/webmcp.ts';
import {
  globeAltitudeToMapZoom,
  mapZoomToGlobeAltitude,
} from '../src/utils/globe-zoom.ts';
import type { AppContext } from '../src/app/app-context.ts';
import {
  VARIANT_DEFAULTS,
  getEffectivePanelConfig,
  getInitialPanelSettingsForVariant,
} from '../src/config/panels.ts';
import type { MapLayers, PanelConfig } from '../src/types/index.ts';

const VARIANTS = ['full', 'tech', 'finance', 'commodity', 'happy', 'energy'] as const;
type DashboardVariant = (typeof VARIANTS)[number];

const EXPECTED_VARIANT_PANEL_SNAPSHOTS: Record<DashboardVariant, {
  enabledCount: number;
  enabledSha256: string;
}> = {
  full: { enabledCount: 86, enabledSha256: '8dfdf10adeab4fe49316b04558477a8bed08042563e190b304610dd1284b2348' },
  tech: { enabledCount: 38, enabledSha256: 'de9f78179aa2c75301883511ad0bab48fc67cba5cd4eb4445906abf17458a290' },
  finance: { enabledCount: 60, enabledSha256: 'e9cbe30455e107add242019de29d44335abf9da2a8a44c9c204076ed279bcfe8' },
  commodity: { enabledCount: 33, enabledSha256: 'b534510a2e814392e3966beb211e300e75a2b33f05c283613dd4f6cee50ddfe0' },
  happy: { enabledCount: 10, enabledSha256: 'f62bbf19c2f7ca75fefeb12a7ba32da991a72f494f91e6d310910d5b7a0468ad' },
  energy: { enabledCount: 26, enabledSha256: '4566c4b42ec77521cddce83cccabe91069ffb211ade9441ef0cf115f11a3cd67' },
};

const EXPECTED_VARIANT_DEFAULT_SNAPSHOTS: Record<DashboardVariant, {
  total: number;
  enabled: number;
  sha256: string;
}> = {
  full: { total: 107, enabled: 86, sha256: '4cd24491205d160561c4483cb60df5d5f7bfeb5f75e4754cd7dc8e9f7f5dab4f' },
  tech: { total: 41, enabled: 38, sha256: '43d7c788ff599baae171f7f46532653370e03ca4d322a8e6614f9f0a1cee5045' },
  finance: { total: 65, enabled: 60, sha256: 'cfcd641367902fe1966986633577763df178f5a1ea9d22038aa350276b55abbb' },
  commodity: { total: 36, enabled: 33, sha256: 'cc9e0b178dec33dff354a1eea95b5b215302fc7ce685b3d92b82a356df6d6bee' },
  happy: { total: 10, enabled: 10, sha256: '197a73a578d8734d49e844e0a83b89204d5a6fc6b973b1ed698272d846a2c308' },
  energy: { total: 28, enabled: 26, sha256: 'c29563083968049da7c1c7c0b6a856143c3797c010b9c21d2424bbbbb3febbc1' },
};

function makeContext(
  overrides: Partial<AppContext> = {},
  liveMapLayers?: MapLayers,
): AppContext {
  const mapLayers = {
    conflicts: true,
    weather: false,
    tradeRoutes: true,
    startupHubs: false,
    positiveEvents: false,
  } as unknown as MapLayers;
  return {
    isDestroyed: false,
    panels: {},
    panelSettings: {},
    mapLayers,
    map: {
      getState: () => ({
        view: 'mena',
        zoom: 4,
        pan: { x: 0, y: 0 },
        timeRange: '24h',
        layers: liveMapLayers ?? mapLayers,
      }),
      getCenter: () => ({ lat: 29.5, lon: 47.5 }),
      setCenter: () => {},
      setView: () => {},
      setLayers: () => {},
      whenRendererReady: () => Promise.resolve(),
      whenViewportSettled: () => Promise.resolve(),
      isDeckGLActive: () => false,
      isGlobeMode: () => false,
    },
    ...overrides,
  } as unknown as AppContext;
}

const applierOptions = {
  getPanelConfig: (panelId: string): PanelConfig => ({ name: panelId, enabled: true }),
  isPanelAllowed: () => true,
  hasPremiumAccess: () => false,
  applyLayerChange: () => {},
};

describe('WebMCP live dashboard bindings', () => {
  it('locks the canonical panel defaults for all six variants', () => {
    assert.deepEqual(Object.keys(VARIANT_DEFAULTS).sort(), [...VARIANTS].sort());

    for (const variant of VARIANTS) {
      const orderedPanelIds = VARIANT_DEFAULTS[variant] ?? [];
      const enabledPanelIds = orderedPanelIds.filter(
        (panelId) => getEffectivePanelConfig(panelId, variant).enabled === true,
      );
      const snapshot = JSON.stringify({ orderedPanelIds, enabledPanelIds });
      const expected = EXPECTED_VARIANT_DEFAULT_SNAPSHOTS[variant];

      assert.equal(orderedPanelIds.length, expected.total, `${variant} panel-default count changed`);
      assert.equal(enabledPanelIds.length, expected.enabled, `${variant} enabled-default count changed`);
      assert.equal(
        createHash('sha256').update(snapshot).digest('hex'),
        expected.sha256,
        `${variant} canonical panel snapshot changed`,
      );
    }
  });

  it('returns fixed snapshots from each real variant initialization seed', () => {
    for (const variant of VARIANTS) {
      const panelSettings = getInitialPanelSettingsForVariant(variant);
      const mounted = Object.entries(panelSettings)
        .filter(([, config]) => config.enabled === true)
        .map(([panelId]) => panelId);
      const panels = Object.fromEntries(
        mounted.map((panelId) => [panelId, {}]),
      );
      const context = getWebMcpDashboardContext(makeContext({
        panels: panels as AppContext['panels'],
        panelSettings,
      }), variant);

      const expected = EXPECTED_VARIANT_PANEL_SNAPSHOTS[variant];
      assert.equal(context.variant, variant);
      assert.equal(context.panels.enabled.length, expected.enabledCount, variant);
      assert.deepEqual(context.panels.mounted, context.panels.enabled, variant);
      assert.equal(
        createHash('sha256').update(JSON.stringify(context.panels.enabled)).digest('hex'),
        expected.enabledSha256,
        `${variant} initialized dashboard context changed`,
      );
    }
  });

  it('reports visible renderer layers when persisted layer settings diverge', () => {
    const liveMapLayers = {
      conflicts: false,
      weather: true,
      tradeRoutes: false,
      startupHubs: false,
    } as unknown as MapLayers;
    const ctx = makeContext({}, liveMapLayers);

    assert.deepEqual(
      getWebMcpDashboardContext(ctx, 'full').map.enabledLayers,
      ['weather'],
    );
    assert.deepEqual(
      Object.entries(ctx.mapLayers)
        .filter(([, enabled]) => enabled === true)
        .map(([layer]) => layer),
      ['conflicts', 'tradeRoutes'],
      'the regression requires live renderer state to diverge from persisted settings',
    );
  });

  it('fails honestly when live dashboard state is unavailable', () => {
    assert.throws(
      () => getWebMcpDashboardContext(makeContext({ map: null }), 'full'),
      (error) => error instanceof DashboardBindingError
        && error.reason === 'map_unavailable'
        && error.message === 'Map is not available.',
    );
    assert.throws(
      () => getWebMcpDashboardContext(makeContext({ isDestroyed: true }), 'full'),
      (error) => error instanceof DashboardBindingError
        && error.reason === 'app_destroyed'
        && error.message === 'Dashboard is no longer available.',
    );
  });

  it('converts the live globe camera altitude to the dashboard zoom scale', () => {
    assert.equal(globeAltitudeToMapZoom(1.8), 1);
    assert.equal(globeAltitudeToMapZoom(1.2), 2.5);
    assert.equal(globeAltitudeToMapZoom(0.5), 4);
    assert.equal(globeAltitudeToMapZoom(0.01), 10);
    assert.equal(globeAltitudeToMapZoom(Number.NaN), 1);
  });

  it('round-trips the full logical globe zoom range and named-view URL anchors', () => {
    for (const zoom of [1, 1.25, 2, 2.5, 3.75, 5, 6.5, 8, 9.25, 10]) {
      const roundTrip = globeAltitudeToMapZoom(mapZoomToGlobeAltitude(zoom));
      assert.ok(Math.abs(roundTrip - zoom) < 1e-10, `${zoom} round-tripped as ${roundTrip}`);
    }

    for (const presetAltitude of [1.8, 1.5, 1.2]) {
      const serializedZoom = Number(globeAltitudeToMapZoom(presetAltitude).toFixed(2));
      assert.ok(
        Math.abs(mapZoomToGlobeAltitude(serializedZoom) - presetAltitude) < 1e-10,
        `${presetAltitude} changed after URL serialization`,
      );
    }

    assert.ok(mapZoomToGlobeAltitude(8) > mapZoomToGlobeAltitude(9));
    assert.ok(mapZoomToGlobeAltitude(9) > mapZoomToGlobeAltitude(10));
  });

  it('wakes a pre-ready invocation as soon as the app is destroyed', async () => {
    const uiReady = new Promise<void>(() => {});
    let resolveDestroyed!: () => void;
    const appDestroyed = new Promise<void>((resolve) => {
      resolveDestroyed = resolve;
    });
    const wait = waitForWebMcpUiReady(uiReady, appDestroyed, 10_000);

    resolveDestroyed();
    await assert.rejects(wait, /Dashboard is no longer available/);
  });

  it('reuses the real applier and preserves its denial reason', async () => {
    const result = await applyWebMcpDashboardAction(
      makeContext(),
      { type: 'open_panel', panelId: 'not-live' },
      applierOptions,
    );

    assert.equal(result.ok, false);
    assert.equal(result.status, 'denied');
    assert.equal(result.reason, 'panel_not_live');
  });

  it('opens a live panel without waiting for concrete renderer readiness', async () => {
    let rendererReadyCalls = 0;
    let showCalls = 0;
    const ctx = makeContext({
      panels: {
        markets: {
          show: () => { showCalls += 1; },
          getElement: () => ({ scrollIntoView() {} }),
        } as unknown as AppContext['panels'][string],
      },
      panelSettings: {
        markets: { name: 'Markets', enabled: true },
      },
    });

    const result = await runDashboardActionBinding(
      ctx,
      { type: 'open_panel', panelId: 'markets' },
      {
        waitForUiReady: () => Promise.resolve(),
        waitForMapReady: () => {
          rendererReadyCalls += 1;
          return new Promise<void>(() => {});
        },
        applierOptions,
        syncUrlStateNow: () => {},
      },
    );

    assert.equal(result.ok, true);
    assert.equal(showCalls, 1);
    assert.equal(rendererReadyCalls, 0);
  });

  it('returns invalid actions without waiting for concrete renderer readiness', async () => {
    let rendererReadyCalls = 0;
    const result = await runDashboardActionBinding(
      makeContext(),
      { type: 'set_view', view: 'not-a-real-view' },
      {
        waitForUiReady: () => Promise.resolve(),
        waitForMapReady: () => {
          rendererReadyCalls += 1;
          return new Promise<void>(() => {});
        },
        applierOptions,
        syncUrlStateNow: () => {},
      },
    );

    assert.equal(result.ok, false);
    assert.equal(result.status, 'invalid');
    assert.equal(rendererReadyCalls, 0);
  });

  it('waits for concrete renderer readiness before applying layer actions', async () => {
    let resolveRendererReady!: () => void;
    const rendererReady = new Promise<void>((resolve) => {
      resolveRendererReady = resolve;
    });
    let rendererReadyCalls = 0;
    const ctx = makeContext();

    const pending = runDashboardActionBinding(
      ctx,
      { type: 'set_layers', layers: { weather: true } },
      {
        waitForUiReady: () => Promise.resolve(),
        waitForMapReady: () => {
          rendererReadyCalls += 1;
          return rendererReady;
        },
        applierOptions,
        syncUrlStateNow: () => {},
      },
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(rendererReadyCalls, 1);
    assert.equal(ctx.mapLayers.weather, false, 'layers must not mutate before renderer readiness');

    resolveRendererReady();
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(ctx.mapLayers.weather, true);
  });

  it('withholds set_view success until the visible viewport has settled', async () => {
    let center = { lat: 29.5, lon: 47.5 };
    let resolveSetViewStarted!: () => void;
    const setViewStarted = new Promise<void>((resolve) => {
      resolveSetViewStarted = resolve;
    });
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const ctx = makeContext();
    Object.assign(ctx.map!, {
      getCenter: () => center,
      setView: () => { resolveSetViewStarted(); },
      whenViewportSettled: () => settled,
    });

    let completed = false;
    const pending = applyWebMcpDashboardAction(
      ctx,
      { type: 'set_view', view: 'eu', zoom: 4 },
      applierOptions,
    ).then((result) => {
      completed = true;
      return result;
    });

    await setViewStarted;
    await Promise.resolve();
    assert.equal(completed, false, 'the tool must remain pending during the animation');

    center = { lat: 50, lon: 10 };
    resolveSettled();
    const result = await pending;
    assert.equal(result.ok, true);
    assert.deepEqual(getWebMcpDashboardContext(ctx, 'full').map.center, center);
  });

  it('orders renderer readiness, view settlement, and final URL sync', async () => {
    const events: string[] = [];
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const ctx = makeContext();
    Object.assign(ctx.map!, {
      setView: () => { events.push('set_view'); },
      whenViewportSettled: async () => {
        events.push('wait_settlement');
        await settled;
        events.push('settled');
      },
    });

    const pending = runDashboardActionBinding(
      ctx,
      { type: 'set_view', view: 'eu', zoom: 4 },
      {
        waitForUiReady: async () => {
          events.push('wait_ui');
        },
        waitForMapReady: async () => {
          events.push('wait_map');
          await ready;
          events.push('map_ready');
        },
        applierOptions: applierOptions,
        syncUrlStateNow: () => { events.push('sync_url'); },
      },
    );

    await Promise.resolve();
    assert.deepEqual(events, ['wait_ui']);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['wait_ui', 'wait_map']);
    resolveReady();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['wait_ui', 'wait_map', 'map_ready', 'set_view', 'wait_settlement']);
    resolveSettled();
    const result = await pending;

    assert.equal(result.ok, true);
    assert.deepEqual(events, [
      'wait_ui',
      'wait_map',
      'map_ready',
      'set_view',
      'wait_settlement',
      'settled',
      'sync_url',
    ]);
  });

  it('returns app_destroyed when teardown wins during viewport settlement', async () => {
    let resolveSetViewStarted!: () => void;
    const setViewStarted = new Promise<void>((resolve) => {
      resolveSetViewStarted = resolve;
    });
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const ctx = makeContext();
    Object.assign(ctx.map!, {
      setView: () => { resolveSetViewStarted(); },
      whenViewportSettled: () => settled,
    });

    const pending = applyWebMcpDashboardAction(
      ctx,
      { type: 'set_view', view: 'asia' },
      applierOptions,
    );
    await setViewStarted;
    ctx.isDestroyed = true;
    resolveSettled();

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'app_destroyed');
  });

  it('returns a structured denial when a viewport action is superseded', async () => {
    const ctx = makeContext();
    Object.assign(ctx.map!, {
      setView: () => 17,
      whenViewportSettled: async () => {
        const error = new Error('Map viewport transition was superseded.') as Error & {
          reason: string;
        };
        error.name = 'ViewportTransitionError';
        error.reason = 'viewport_superseded';
        throw error;
      },
    });

    const result = await applyWebMcpDashboardAction(
      ctx,
      { type: 'set_view', view: 'asia' },
      applierOptions,
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 'denied');
    assert.equal(result.reason, 'viewport_superseded');
    assert.deepEqual(result.targets, [{
      target: 'asia',
      status: 'denied',
      reason: 'viewport_superseded',
    }]);
  });

  it('denies actions that lose the destroy race before the lazy applier runs', async () => {
    const ctx = makeContext();
    const pending = applyWebMcpDashboardAction(
      ctx,
      { type: 'set_view', view: 'eu' },
      applierOptions,
    );
    ctx.isDestroyed = true;

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'app_destroyed');
  });

  it('rejects overbroad layer batches through the shared agent-bus schema', async () => {
    const layers = Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [`layer-${index}`, true]),
    );
    const result = await applyWebMcpDashboardAction(
      makeContext(),
      { type: 'set_layers', layers },
      applierOptions,
    );

    assert.equal(result.ok, false);
    assert.equal(result.status, 'invalid');
    assert.equal(result.reason, 'invalid_action');
    assert.match(result.message, /at most 10 layers/);
  });

  it('preserves per-target variant denials across all six variants', async () => {
    const cases: Record<DashboardVariant, {
      allowed: keyof MapLayers;
      disallowed: keyof MapLayers;
    }> = {
      full: { allowed: 'conflicts', disallowed: 'startupHubs' },
      tech: { allowed: 'startupHubs', disallowed: 'conflicts' },
      finance: { allowed: 'tradeRoutes', disallowed: 'conflicts' },
      commodity: { allowed: 'tradeRoutes', disallowed: 'conflicts' },
      happy: { allowed: 'positiveEvents', disallowed: 'conflicts' },
      energy: { allowed: 'tradeRoutes', disallowed: 'conflicts' },
    };

    for (const variant of VARIANTS) {
      const { allowed, disallowed } = cases[variant];
      // Happy's map layers are DeckGL-only; this test isolates variant policy
      // from renderer policy by giving that variant its supported renderer.
      const ctx = makeContext(variant === 'happy'
        ? {
            map: {
              ...makeContext().map,
              isDeckGLActive: () => true,
            },
          }
        : {});
      ctx.mapLayers[allowed] = false;
      ctx.mapLayers[disallowed] = false;
      const result = await applyWebMcpDashboardAction(
        ctx,
        { type: 'set_layers', layers: { [allowed]: true, [disallowed]: true } },
        { ...applierOptions, getVariant: () => variant },
      );

      assert.equal(result.ok, true, variant);
      assert.deepEqual(result.targets, [
        { target: allowed, status: 'applied' },
        { target: disallowed, status: 'denied', reason: 'variant_disallowed' },
      ], variant);
      assert.equal(ctx.mapLayers[allowed], true, variant);
      assert.equal(ctx.mapLayers[disallowed], false, variant);
    }
  });
});
