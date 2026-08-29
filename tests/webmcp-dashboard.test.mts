import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  applyWebMcpDashboardAction,
  applyWebMcpOpenAlerts,
  applyWebMcpOpenSettings,
  applyWebMcpSwitchMonitor,
  getWebMcpDashboardContext,
  getWebMcpMapLayerCatalogSnapshot,
  listWebMcpDashboardPanels,
  WEBMCP_UI_READY_TIMEOUT_MS,
  waitForWebMcpUiReady,
} from '../src/app/webmcp-dashboard.ts';
import { runDashboardActionBinding } from '../src/app/dashboard-action-binding.ts';
import { DashboardBindingError } from '../src/services/webmcp.ts';
import {
  globeAltitudeToMapZoom,
  mapZoomToGlobeAltitude,
} from '../src/utils/globe-zoom.ts';
import type { AppContext, UnifiedSettingsController } from '../src/app/app-context.ts';
import { SITE_VARIANTS } from '../src/config/variant.ts';
import {
  VARIANT_DEFAULTS,
  getEffectivePanelConfig,
  getInitialPanelSettingsForVariant,
} from '../src/config/panels.ts';
import type { MapLayers, PanelConfig } from '../src/types/index.ts';

const VARIANTS = ['full', 'tech', 'finance', 'commodity', 'happy', 'energy'] as const;

it('keeps the advertised pre-ready invocation window at 30 seconds', () => {
  assert.equal(WEBMCP_UI_READY_TIMEOUT_MS, 30_000);
});
type DashboardVariant = (typeof VARIANTS)[number];

const EXPECTED_VARIANT_PANEL_SNAPSHOTS: Record<DashboardVariant, {
  enabledCount: number;
  enabledSha256: string;
}> = {
  full: { enabledCount: 87, enabledSha256: 'f88a8223a3b1ae42a80a9a4d55678b4e0dbaf942632408fe0987e3a956bd5372' },
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
  full: { total: 109, enabled: 87, sha256: '9b761c8ce3685acbcc233b25b639d1998fbdb3d303cd6d9cbc5b8da1e53d4958' },
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
      setCenter: () => 1,
      setView: () => {},
      setLayers: () => {},
      setTimeRange: () => {},
      getTimeRange: () => '24h',
      switchToGlobe: () => {},
      switchToFlat: () => {},
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

function makeSettings(calls: string[] = []): UnifiedSettingsController {
  return {
    open(tab?: string) {
      calls.push(tab ?? 'default');
    },
    close() {
      calls.push('close');
    },
    hasPendingChanges: () => false,
    refreshPanelToggles() {
      calls.push('refresh');
    },
    getButton: () => ({}) as HTMLButtonElement,
    destroy() {
      calls.push('destroy');
    },
  };
}

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
    assert.equal(getWebMcpDashboardContext(ctx, 'full').map.mode, '2d');
    assert.equal(
      getWebMcpDashboardContext(makeContext({
        map: {
          ...makeContext().map,
          isGlobeMode: () => true,
        },
      }), 'full').map.mode,
      '3d',
    );
    assert.deepEqual(
      Object.entries(ctx.mapLayers)
        .filter(([, enabled]) => enabled === true)
        .map(([layer]) => layer),
      ['conflicts', 'tradeRoutes'],
      'the regression requires live renderer state to diverge from persisted settings',
    );
  });

  it('pages live panel catalogs with entitlement and enabled-state differences', () => {
    const panelSettings = getInitialPanelSettingsForVariant('full');
    panelSettings.markets = { ...panelSettings.markets!, enabled: false };
    const enabledDefaults = Object.entries(panelSettings)
      .filter(([, config]) => config.enabled === true)
      .map(([panelId]) => panelId);
    const ctx = makeContext({
      panels: Object.fromEntries(enabledDefaults.map((panelId) => [panelId, {}])) as AppContext['panels'],
      panelSettings,
    });

    const entitled = listWebMcpDashboardPanels(ctx, 'full', { variant: 'full', limit: 8 }, {
      isPanelAllowed: () => true,
    });
    assert.equal(entitled.total, 109);
    assert.equal(entitled.variant, 'full');
    assert.equal(entitled.hasMore, true);

    const disabledPages = [];
    let disabledCursor: string | null = null;
    do {
      const page = listWebMcpDashboardPanels(ctx, 'full', {
        variant: 'full',
        enabled: false,
        ...(disabledCursor ? { cursor: disabledCursor } : {}),
        limit: 8,
      }, { isPanelAllowed: () => true });
      disabledPages.push(page);
      disabledCursor = page.nextCursor;
    } while (disabledCursor);
    assert.ok(disabledPages.flatMap((page) => page.panels).some(
      (panel) => panel.id === 'markets' && panel.unavailableReason === 'panel_disabled',
    ));

    const pages = [entitled];
    let cursor = entitled.nextCursor;
    while (cursor) {
      const page = listWebMcpDashboardPanels(ctx, 'full', { variant: 'full', cursor, limit: 8 }, {
        isPanelAllowed: () => true,
      });
      pages.push(page);
      cursor = page.nextCursor;
    }
    const ids = pages.flatMap((page) => page.panels.map((panel) => panel.id));
    assert.equal(new Set(ids).size, 109);
    assert.ok(ids.includes('windy-webcams'));

    const gatedPages = [];
    let gatedCursor: string | null = null;
    do {
      const page = listWebMcpDashboardPanels(ctx, 'full', {
        variant: 'full',
        ...(gatedCursor ? { cursor: gatedCursor } : {}),
        limit: 8,
      }, { isPanelAllowed: (panelId) => panelId !== 'strategic-risk' });
      gatedPages.push(page);
      gatedCursor = page.nextCursor;
    } while (gatedCursor);
    const strategic = gatedPages.flatMap((page) => page.panels).find((panel) => panel.id === 'strategic-risk');
    assert.equal(strategic?.entitled, false);
    assert.equal(strategic?.unavailableReason, 'panel_not_entitled');
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
    assert.throws(
      () => listWebMcpDashboardPanels(makeContext({ isDestroyed: true }), 'full', {}, {
        isPanelAllowed: () => true,
      }),
      (error) => error instanceof DashboardBindingError
        && error.reason === 'app_destroyed',
    );
  });

  it('snapshots live map-layer catalog state for list_map_layers', () => {
    const ctx = makeContext();
    const catalogSnapshot = getWebMcpMapLayerCatalogSnapshot(ctx, 'full', false);
    assert.equal(catalogSnapshot.variant, 'full');
    assert.equal(catalogSnapshot.rendererKind, 'svg');
    assert.deepEqual(catalogSnapshot.enabledLayers, ['conflicts', 'tradeRoutes']);
    assert.deepEqual(catalogSnapshot.liveLayerKeys, Object.keys(ctx.mapLayers));
    assert.equal(catalogSnapshot.hasPremium, false);
    assert.equal(catalogSnapshot.deckGlActive, false);
    assert.equal(catalogSnapshot.tFn, undefined);

    const globe = makeContext({
      map: {
        ...makeContext().map,
        isGlobeMode: () => true,
        isDeckGLActive: () => true,
      },
    });
    const globeSnapshot = getWebMcpMapLayerCatalogSnapshot(globe, 'tech', true);
    assert.equal(globeSnapshot.rendererKind, 'globe');
    assert.equal(globeSnapshot.deckGlActive, true);
    assert.equal(globeSnapshot.hasPremium, true);
    assert.equal(globeSnapshot.variant, 'tech');

    assert.throws(
      () => getWebMcpMapLayerCatalogSnapshot(makeContext({ map: null }), 'full', false),
      (error) => error instanceof DashboardBindingError
        && error.reason === 'map_unavailable',
    );
    assert.throws(
      () => getWebMcpMapLayerCatalogSnapshot(makeContext({ isDestroyed: true }), 'full', false),
      (error) => error instanceof DashboardBindingError
        && error.reason === 'app_destroyed',
    );
  });

  it('records runtime layer gates without dropping object-membership keys', () => {
    const ctx = makeContext();
    ctx.mapLayers.cyberThreats = false;
    ctx.mapLayers.ais = false;
    ctx.mapLayers.outages = false;
    const gated = {
      cyberLayerEnabled: false,
      aisConfigured: false,
      outagesAvailable: false,
    };
    const catalogSnapshot = getWebMcpMapLayerCatalogSnapshot(
      ctx,
      'full',
      false,
      undefined,
      gated,
    );
    assert.ok(catalogSnapshot.liveLayerKeys.includes('cyberThreats'));
    assert.ok(catalogSnapshot.liveLayerKeys.includes('ais'));
    assert.ok(catalogSnapshot.liveLayerKeys.includes('outages'));
    assert.deepEqual(catalogSnapshot.runtimeAvailability, gated);
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

  it('keeps a pre-ready invocation pending until UI readiness resolves', async () => {
    let resolveReady!: () => void;
    const uiReady = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const appDestroyed = new Promise<void>(() => {});
    let settled = false;
    const wait = waitForWebMcpUiReady(uiReady, appDestroyed, 10_000)
      .then(() => { settled = true; });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    resolveReady();
    await wait;
    assert.equal(settled, true);
  });

  it('rejects deterministically when UI readiness exceeds its bound', async () => {
    const never = new Promise<void>(() => {});
    await assert.rejects(
      waitForWebMcpUiReady(never, never, 5, 'Test UI'),
      /Test UI did not initialise within 5ms/,
    );
  });

  it('rejects UI readiness promptly when the invocation is cancelled', async () => {
    const never = new Promise<void>(() => {});
    const controller = new AbortController();
    const pending = waitForWebMcpUiReady(
      never,
      never,
      10_000,
      'Test UI',
      controller.signal,
    );

    controller.abort();
    await assert.rejects(pending, (error) => (
      error instanceof Error && error.name === 'AbortError'
    ));
  });

  it('does not apply an action cancelled during UI readiness', async () => {
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const never = new Promise<void>(() => {});
    const controller = new AbortController();
    const ctx = makeContext();
    const pending = runDashboardActionBinding(
      ctx,
      { type: 'set_layers', layers: { weather: true } },
      {
        waitForUiReady: () => waitForWebMcpUiReady(
          ready,
          never,
          10_000,
          'Test UI',
          controller.signal,
        ),
        waitForMapReady: () => Promise.resolve(),
        signal: controller.signal,
        applierOptions,
        syncUrlStateNow: () => {},
      },
    );

    controller.abort();
    await assert.rejects(pending, (error) => (
      error instanceof Error && error.name === 'AbortError'
    ));
    resolveReady();
    await Promise.resolve();
    assert.equal(ctx.mapLayers.weather, false);
  });

  it('does not apply an action cancelled during renderer readiness', async () => {
    let resolveRendererWaitStarted!: () => void;
    const rendererWaitStarted = new Promise<void>((resolve) => {
      resolveRendererWaitStarted = resolve;
    });
    const never = new Promise<void>(() => {});
    const controller = new AbortController();
    const ctx = makeContext();
    const pending = runDashboardActionBinding(
      ctx,
      { type: 'set_layers', layers: { weather: true } },
      {
        waitForUiReady: () => Promise.resolve(),
        waitForMapReady: () => {
          resolveRendererWaitStarted();
          return waitForWebMcpUiReady(
            never,
            never,
            10_000,
            'Test renderer',
            controller.signal,
          );
        },
        signal: controller.signal,
        applierOptions,
        syncUrlStateNow: () => {},
      },
    );

    await rendererWaitStarted;
    controller.abort();
    await assert.rejects(pending, (error) => (
      error instanceof Error && error.name === 'AbortError'
    ));
    assert.equal(ctx.mapLayers.weather, false);
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

  it('opens mixed-case catalog panel IDs through the shared action contract', async () => {
    let showCalls = 0;
    const ctx = makeContext({
      panels: {
        regionalStartups: {
          show: () => { showCalls += 1; },
          getElement: () => ({ scrollIntoView() {} }),
        } as unknown as AppContext['panels'][string],
      },
      panelSettings: {
        regionalStartups: { name: 'Global Startup News', enabled: true },
      },
    });

    const result = await runDashboardActionBinding(
      ctx,
      { type: 'open_panel', panelId: 'regionalStartups' },
      {
        waitForUiReady: () => Promise.resolve(),
        waitForMapReady: () => new Promise<void>(() => {}),
        applierOptions,
        syncUrlStateNow: () => {},
      },
    );

    assert.equal(result.ok, true);
    assert.equal(showCalls, 1);
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

  it('waits for concrete renderer readiness before applying layer actions', { timeout: 5_000 }, async () => {
    let resolveRendererReady!: () => void;
    const rendererReady = new Promise<void>((resolve) => {
      resolveRendererReady = resolve;
    });
    let resolveRendererWaitStarted!: () => void;
    const rendererWaitStarted = new Promise<void>((resolve) => {
      resolveRendererWaitStarted = resolve;
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
          resolveRendererWaitStarted();
          return rendererReady;
        },
        applierOptions,
        syncUrlStateNow: () => {},
      },
    );

    // The binding crosses a lazy import before it knows this is a map action.
    // Observe the callback itself instead of assuming that import settles in a
    // particular event-loop turn on every supported Node runtime.
    await rendererWaitStarted;
    assert.equal(rendererReadyCalls, 1);
    assert.equal(ctx.mapLayers.weather, false, 'layers must not mutate before renderer readiness');

    resolveRendererReady();
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(ctx.mapLayers.weather, true);
  });

  it('does not apply a stale set_view after newer map interaction during readiness', async () => {
    let resolveRendererReady!: () => void;
    const rendererReady = new Promise<void>((resolve) => {
      resolveRendererReady = resolve;
    });
    let resolveRendererWaitStarted!: () => void;
    const rendererWaitStarted = new Promise<void>((resolve) => {
      resolveRendererWaitStarted = resolve;
    });
    let authorityToken = 4;
    let setViewCalls = 0;
    const ctx = makeContext();
    ctx.map!.setView = (() => {
      setViewCalls += 1;
      return 5;
    }) as typeof ctx.map.setView;

    const pending = runDashboardActionBinding(
      ctx,
      { type: 'set_view', view: 'eu', zoom: 4 },
      {
        waitForUiReady: () => Promise.resolve(),
        waitForMapReady: () => {
          resolveRendererWaitStarted();
          return rendererReady;
        },
        getMapAuthorityToken: () => authorityToken,
        applierOptions,
        syncUrlStateNow: () => {},
      },
    );

    await rendererWaitStarted;
    authorityToken += 1;
    resolveRendererReady();

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.status, 'denied');
    assert.equal(result.reason, 'viewport_superseded');
    assert.equal(setViewCalls, 0);
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

  it('cancels promptly after a view commit without publishing a late URL sync', async () => {
    let resolveSetViewStarted!: () => void;
    const setViewStarted = new Promise<void>((resolve) => {
      resolveSetViewStarted = resolve;
    });
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    let setViewCalls = 0;
    let syncCalls = 0;
    const controller = new AbortController();
    const ctx = makeContext();
    Object.assign(ctx.map!, {
      setView: () => {
        setViewCalls += 1;
        resolveSetViewStarted();
      },
      whenViewportSettled: () => settled,
    });

    const pending = runDashboardActionBinding(
      ctx,
      { type: 'set_view', view: 'eu', zoom: 4 },
      {
        waitForUiReady: () => Promise.resolve(),
        waitForMapReady: () => Promise.resolve(),
        signal: controller.signal,
        applierOptions,
        syncUrlStateNow: () => { syncCalls += 1; },
      },
    );

    await setViewStarted;
    controller.abort();
    await assert.rejects(pending, (error) => (
      error instanceof Error && error.name === 'AbortError'
    ));
    assert.equal(setViewCalls, 1, 'the already-committed viewport action is not rolled back');
    assert.equal(syncCalls, 0);

    resolveSettled();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(syncCalls, 0, 'settlement after cancellation must not sync a stale URL');
  });

  it('orders renderer readiness, view settlement, and final URL sync', { timeout: 5_000 }, async () => {
    const events: string[] = [];
    let resolveUiWaitStarted!: () => void;
    const uiWaitStarted = new Promise<void>((resolve) => { resolveUiWaitStarted = resolve; });
    let resolveUiReady!: () => void;
    const uiReady = new Promise<void>((resolve) => { resolveUiReady = resolve; });
    let resolveMapWaitStarted!: () => void;
    const mapWaitStarted = new Promise<void>((resolve) => { resolveMapWaitStarted = resolve; });
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    let resolveSettlementWaitStarted!: () => void;
    const settlementWaitStarted = new Promise<void>((resolve) => {
      resolveSettlementWaitStarted = resolve;
    });
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const ctx = makeContext();
    Object.assign(ctx.map!, {
      setView: () => { events.push('set_view'); },
      whenViewportSettled: async () => {
        events.push('wait_settlement');
        resolveSettlementWaitStarted();
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
          resolveUiWaitStarted();
          await uiReady;
        },
        waitForMapReady: async () => {
          events.push('wait_map');
          resolveMapWaitStarted();
          await ready;
          events.push('map_ready');
        },
        applierOptions: applierOptions,
        syncUrlStateNow: () => { events.push('sync_url'); },
      },
    );

    await uiWaitStarted;
    assert.deepEqual(events, ['wait_ui']);
    resolveUiReady();
    await mapWaitStarted;
    assert.deepEqual(events, ['wait_ui', 'wait_map']);
    resolveReady();
    await settlementWaitStarted;
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

  it('switches every stable monitor key and overlays the destination on context', async () => {
    assert.deepEqual([...SITE_VARIANTS], ['full', 'tech', 'finance', 'happy', 'commodity', 'energy']);
    const navigated: string[] = [];
    for (const monitor of SITE_VARIANTS) {
      const result = await applyWebMcpSwitchMonitor(
        makeContext(),
        'full',
        monitor,
        async (variant) => {
          navigated.push(variant);
          return variant === 'full' ? 'none' : 'reload';
        },
      );
      assert.equal(result.ok, true, monitor);
      assert.equal(result.status, 'applied', monitor);
      assert.equal(result.destination, monitor, monitor);
      assert.equal(result.context.variant, monitor, monitor);
      assert.equal(result.navigation, monitor === 'full' ? 'none' : 'reload', monitor);
      assert.equal(result.message, monitor === 'full' ? 'Already on that monitor.' : 'Switched monitor.', monitor);
    }
    assert.deepEqual(navigated, [...SITE_VARIANTS]);
  });

  it('denies a missing visible monitor link without navigating', async () => {
    let navigated = false;
    const result = await applyWebMcpSwitchMonitor(
      makeContext(),
      'full',
      'tech',
      async () => {
        navigated = true;
        return 'unavailable';
      },
    );
    assert.equal(navigated, true);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'denied');
    assert.equal(result.reason, 'unavailable');
    assert.equal(result.destination, 'tech');
    assert.equal(result.context.variant, 'full');
    assert.match(result.message, /not available/i);
    assert.equal(/user|email|plan|account/i.test(result.message), false);
  });

  it('denies a blocked monitor switch without account details', async () => {
    const result = await applyWebMcpSwitchMonitor(
      makeContext(),
      'full',
      'tech',
      async () => 'blocked',
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 'denied');
    assert.equal(result.reason, 'unavailable');
    assert.equal(result.destination, 'tech');
    assert.match(result.message, /could not switch monitors/i);
    assert.equal(/user|email|plan|account/i.test(result.message), false);
  });

  it('opens settings and alerts without mutating overlay contents', async () => {
    const calls: string[] = [];
    const ctx = makeContext({ unifiedSettings: makeSettings(calls), isDesktopApp: false });

    const settings = await applyWebMcpOpenSettings(ctx, 'full');
    assert.equal(settings.ok, true);
    assert.equal(settings.destination, 'settings');
    assert.equal(settings.overlay, 'open');
    assert.equal(settings.tab, 'settings');
    assert.deepEqual(calls, ['settings']);

    const alerts = await applyWebMcpOpenAlerts(ctx, 'full');
    assert.equal(alerts.ok, true);
    assert.equal(alerts.destination, 'alerts');
    assert.equal(alerts.overlay, 'open');
    assert.equal(alerts.tab, 'notifications');
    assert.deepEqual(calls, ['settings', 'notifications']);
  });

  it('denies settings when the overlay fails to open', async () => {
    const ctx = makeContext({
      unifiedSettings: {
        ...makeSettings(),
        open: async () => false,
      },
    });
    const result = await applyWebMcpOpenSettings(ctx, 'full');
    assert.equal(result.ok, false);
    assert.equal(result.status, 'denied');
    assert.equal(result.reason, 'unavailable');
    assert.equal(result.destination, 'settings');
    assert.notEqual(result.overlay, 'open');
  });

  it('keeps alerts unavailable on desktop without opening settings', async () => {
    const calls: string[] = [];
    const result = await applyWebMcpOpenAlerts(
      makeContext({ unifiedSettings: makeSettings(calls), isDesktopApp: true }),
      'full',
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 'denied');
    assert.equal(result.reason, 'unavailable');
    assert.equal(result.destination, 'alerts');
    assert.deepEqual(calls, []);
    assert.equal(/user|email|plan|account/i.test(result.message), false);
  });

  it('returns dashboard context without a map and denies destroyed navigation', async () => {
    const settingsCalls: string[] = [];
    const settings = await applyWebMcpOpenSettings(makeContext({
      map: null,
      unifiedSettings: makeSettings(settingsCalls),
    }), 'full');
    assert.equal(settings.ok, true);
    assert.equal(settings.context.variant, 'full');
    assert.deepEqual(settings.context.map.enabledLayers, []);
    assert.deepEqual(settingsCalls, ['settings']);

    let navigated = false;
    const destroyed = await applyWebMcpSwitchMonitor(
      makeContext({ isDestroyed: true }),
      'full',
      'tech',
      async () => {
        navigated = true;
        return 'reload';
      },
    );
    assert.equal(navigated, false);
    assert.equal(destroyed.ok, false);
    assert.equal(destroyed.reason, 'app_destroyed');
    assert.equal((await applyWebMcpOpenSettings(makeContext({ isDestroyed: true }), 'full')).reason, 'app_destroyed');
    assert.equal((await applyWebMcpOpenAlerts(makeContext({ isDestroyed: true }), 'full')).reason, 'app_destroyed');
    assert.equal((await applyWebMcpOpenSettings(makeContext({ unifiedSettings: null }), 'full')).reason, 'unavailable');
    assert.equal((await applyWebMcpOpenAlerts(makeContext({ unifiedSettings: null }), 'full')).reason, 'unavailable');
  });

  it('waits for the map, then syncs URL for time range without waiting for viewport settlement', async () => {
    const events: string[] = [];
    const ctx = makeContext();
    Object.assign(ctx.map!, {
      setTimeRange: () => { events.push('set_time_range'); },
      whenViewportSettled: async () => { events.push('wait_settlement'); },
    });

    const result = await runDashboardActionBinding(
      ctx,
      { type: 'set_time_range', timeRange: '6h' },
      {
        waitForUiReady: async () => { events.push('wait_ui'); },
        waitForMapReady: async () => { events.push('wait_map'); },
        applierOptions,
        syncUrlStateNow: () => { events.push('sync_url'); },
      },
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.requested, { timeRange: '6h' });
    assert.deepEqual(events, ['wait_ui', 'wait_map', 'set_time_range', 'sync_url']);
  });

  it('treats focus_country as a viewport action that settles before URL sync', { timeout: 5_000 }, async () => {
    const events: string[] = [];
    let resolveSettlementWaitStarted!: () => void;
    const settlementWaitStarted = new Promise<void>((resolve) => {
      resolveSettlementWaitStarted = resolve;
    });
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const ctx = makeContext();
    Object.assign(ctx.map!, {
      setView: () => { events.push('set_view'); },
      setCenter: () => {
        events.push('set_center');
        return 7;
      },
      whenViewportSettled: async (token?: number) => {
        events.push(`wait_settlement:${token}`);
        resolveSettlementWaitStarted();
        await settled;
        events.push('settled');
      },
    });

    const pending = runDashboardActionBinding(
      ctx,
      { type: 'focus_country', iso2: 'DE' },
      {
        waitForUiReady: async () => { events.push('wait_ui'); },
        waitForMapReady: async () => { events.push('wait_map'); },
        preloadCountryGeometry: async () => { events.push('preload_geometry'); },
        applierOptions: {
          ...applierOptions,
          getCountryMapFocus: (iso2) => iso2 === 'DE'
            ? { iso2: 'DE', lat: 51, lon: 10, zoom: 5, bbox: [6, 47, 15, 55] }
            : null,
        },
        syncUrlStateNow: () => { events.push('sync_url'); },
      },
    );

    await settlementWaitStarted;
    assert.equal(events.includes('sync_url'), false);
    resolveSettled();
    const result = await pending;

    assert.equal(result.ok, true);
    assert.deepEqual(result.effective, { iso2: 'DE', lat: 51, lon: 10, zoom: 5 });
    assert.deepEqual(events, [
      'wait_ui',
      'wait_map',
      'preload_geometry',
      'set_view',
      'set_center',
      'wait_settlement:7',
      'settled',
      'sync_url',
    ]);
  });

  it('does not sync URL after set_map_mode', async () => {
    let syncCalls = 0;
    const ctx = makeContext();
    Object.assign(ctx.map!, {
      switchToGlobe: () => { (ctx.map as { isGlobeMode: () => boolean }).isGlobeMode = () => true; },
    });

    const result = await runDashboardActionBinding(
      ctx,
      { type: 'set_map_mode', mode: '3d' },
      {
        waitForUiReady: () => Promise.resolve(),
        waitForMapReady: () => Promise.resolve(),
        applierOptions,
        syncUrlStateNow: () => { syncCalls += 1; },
      },
    );

    assert.equal(result.ok, true);
    assert.equal(syncCalls, 0);
    assert.deepEqual(result.requested, { mode: '3d' });
    assert.equal(result.effective?.mode, '3d');
  });

  it('does not apply a stale focus_country after newer map interaction during readiness', async () => {
    let resolveRendererReady!: () => void;
    const rendererReady = new Promise<void>((resolve) => {
      resolveRendererReady = resolve;
    });
    let resolveRendererWaitStarted!: () => void;
    const rendererWaitStarted = new Promise<void>((resolve) => {
      resolveRendererWaitStarted = resolve;
    });
    let authorityToken = 4;
    let setCenterCalls = 0;
    const ctx = makeContext();
    ctx.map!.setCenter = (() => {
      setCenterCalls += 1;
      return 5;
    }) as typeof ctx.map.setCenter;

    const pending = runDashboardActionBinding(
      ctx,
      { type: 'focus_country', iso2: 'DE' },
      {
        waitForUiReady: () => Promise.resolve(),
        waitForMapReady: () => {
          resolveRendererWaitStarted();
          return rendererReady;
        },
        preloadCountryGeometry: async () => {},
        getMapAuthorityToken: () => authorityToken,
        applierOptions: {
          ...applierOptions,
          getCountryMapFocus: () => ({
            iso2: 'DE', lat: 51, lon: 10, zoom: 5, bbox: [6, 47, 15, 55],
          }),
        },
        syncUrlStateNow: () => {},
      },
    );

    await rendererWaitStarted;
    authorityToken += 1;
    resolveRendererReady();

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'viewport_superseded');
    assert.equal(setCenterCalls, 0);
  });
});
