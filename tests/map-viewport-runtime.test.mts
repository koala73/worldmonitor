import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { build, type Plugin } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDashboardActionBinding } from '../src/app/dashboard-action-binding.ts';
import type { AppContext } from '../src/app/app-context.ts';
import type { MapLayers, PanelConfig } from '../src/types/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface MapContainerHarness {
  createMapContainerHarness: () => {
    map: {
      setView: (view: string, zoom?: number) => number;
      setCenter: (lat: number, lon: number, zoom?: number) => number;
      getViewportAuthorityToken: () => number;
      whenRendererReady: () => Promise<void>;
      whenViewportSettled: (viewportActionToken?: number) => Promise<void>;
      switchToGlobe: () => Promise<{ renderer: 'globe' | 'deck' | 'svg'; mode: 'globe' | 'flat'; fallback: boolean }>;
      isGlobeMode: () => boolean;
      isDeckGLActive: () => boolean;
      destroy: () => void;
    };
    internals: Record<string, unknown>;
  };
}

let harness: MapContainerHarness;

before(async () => {
  const lifecycleOnlyStubs: Plugin = {
    name: 'map-viewport-lifecycle-stubs',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^@\/(utils|config\/map-layer-definitions|services\/widget-store|services\/auth-state|services\/panel-gating|services\/analytics|services\/i18n|utils\/lcp-debug)$/ }, (args) => ({
        path: args.path,
        namespace: 'viewport-stub',
      }));
      buildApi.onLoad({ filter: /.*/, namespace: 'viewport-stub' }, (args) => {
        const modules: Record<string, string> = {
          '@/utils': `
            export const isMobileDevice = () => false;
            export const getCSSColor = () => '#000';
            export const rssProxyUrl = (url) => url;
            export const createCircuitBreaker = () => ({ execute: (fn) => fn() });
            export const toUniqueSortedLowercase = (values) => [...new Set(values.map((v) => String(v).toLowerCase()))].sort();
          `,
          '@/utils/lcp-debug': 'export const markLcpDebug = () => {};',
          '@/config/map-layer-definitions': `
            export const isLayerToggleAllowed = () => true;
            export const isLayerEntitled = () => true;
            export const sanitizeLockedLayers = (layers) => layers;
            export const shouldSanitizeLockedLayers = () => false;
            export const getLayersForVariant = () => [];
            export const resolveLayerLabel = (key) => key;
            export const bindLayerSearch = () => () => {};
            export const getLayerExplanation = () => null;
            export const hasCuratedLayerExplanation = () => false;
          `,
          '@/services/widget-store': 'export const isProTierResolved = () => true;',
          '@/services/auth-state': `
            export const getAuthState = () => ({});
            export const subscribeAuthState = () => () => {};
          `,
          '@/services/panel-gating': 'export const hasPremiumAccess = () => false;',
          '@/services/analytics': 'export const trackGateHit = () => {};',
          '@/services/i18n': `
            export const t = (key) => key;
            export const getCurrentLanguage = () => 'en';
          `,
        };
        return { contents: modules[args.path] ?? '', loader: 'js' };
      });
    },
  };
  const result = await build({
    stdin: {
      contents: `
        import { MapContainer } from './src/components/MapContainer.ts';

        export function createMapContainerHarness() {
          const map = Object.create(MapContainer.prototype);
          const internals = {
            container: { removeEventListener() {} },
            rendererReady: false,
            rendererReadyWaiters: new Set(),
            rendererDemandRequested: false,
            releaseRendererDemand: null,
            rendererInitToken: 7,
            viewportActionToken: 0,
            humanViewportInteractionToken: 0,
            destroyed: false,
            pendingViewportActions: [],
            pendingCenter: null,
            pendingChokepointOpen: null,
            initialState: { view: 'global', zoom: 2, pan: { x: 0, y: 0 }, layers: {}, timeRange: '24h' },
            useGlobe: false,
            useDeckGL: true,
            globeMap: null,
            svgMap: null,
            deckGLMap: null,
            rendererDemandCleanup: null,
            resizeObserver: null,
            globeInitToken: 0,
            clearCache() {},
          };
          Object.assign(map, internals);
          return { map, internals: map };
        }
      `,
      loader: 'ts',
      resolveDir: root,
      sourcefile: 'map-viewport-runtime-entry.ts',
    },
    bundle: true,
    define: { 'import.meta.env': '{"DEV":false,"PROD":true,"VITE_VARIANT":"full"}' },
    format: 'esm',
    logLevel: 'silent',
    platform: 'node',
    plugins: [lifecycleOnlyStubs],
    target: 'node20',
    external: [
      './Map',
      './DeckGLMap',
      './GlobeMap',
      'maplibre-gl/dist/maplibre-gl.css',
    ],
    write: false,
  });
  const source = result.outputFiles[0]?.text;
  assert.ok(source, 'esbuild must emit the viewport harness');
  harness = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) as MapContainerHarness;
});

describe('map viewport runtime lifecycle', () => {
  it('invalidates delayed agent authority when direct map interaction starts', () => {
    const { map, internals } = harness.createMapContainerHarness();

    assert.equal(map.getViewportAuthorityToken(), 0);
    (internals.markHumanViewportInteraction as () => void).call(map);
    assert.equal(map.getViewportAuthorityToken(), 1);
  });

  it('replays pre-ready viewport work before waking readiness callers', async () => {
    const { map, internals } = harness.createMapContainerHarness();
    const calls: unknown[][] = [];
    map.setView('eu', 4);
    map.setCenter(50, 10, 5);

    let ready = false;
    const pending = map.whenRendererReady().then(() => { ready = true; });
    assert.equal(ready, false);
    assert.equal(internals.rendererDemandRequested, true);

    internals.deckGLMap = {
      setView: (...args: unknown[]) => calls.push(['view', ...args]),
      setCenter: (...args: unknown[]) => calls.push(['center', ...args]),
    };
    (internals.markRendererReady as (token: number) => void).call(map, 7);
    await pending;

    assert.deepEqual(calls, [
      ['view', 'eu', 4],
      ['center', 50, 10, 5],
    ]);
    assert.equal(ready, true);
  });

  it('ignores stale renderer generations and rejects waiters on teardown', async () => {
    const { map, internals } = harness.createMapContainerHarness();
    internals.deckGLMap = { setView() {}, setCenter() {}, destroy() {} };
    const pending = map.whenRendererReady();
    (internals.markRendererReady as (token: number) => void).call(map, 6);
    assert.equal(internals.rendererReady, false);

    map.destroy();
    await assert.rejects(pending, /no longer available/);
  });

  it('awaits the active renderer settlement promise', async () => {
    const { map, internals } = harness.createMapContainerHarness();
    let resolveSettled!: (completed: boolean) => void;
    const settled = new Promise<boolean>((resolve) => { resolveSettled = resolve; });
    internals.rendererReady = true;
    internals.deckGLMap = { whenViewportSettled: () => settled };

    let completed = false;
    const pending = map.whenViewportSettled().then(() => { completed = true; });
    await Promise.resolve();
    assert.equal(completed, false);
    resolveSettled(true);
    await pending;
    assert.equal(completed, true);
  });

  it('keeps a coordinate binding on the replacement renderer through settlement and URL sync', async () => {
    const { map, internals } = harness.createMapContainerHarness();
    const staleCalls: unknown[][] = [];
    const replacementCalls: unknown[][] = [];
    let resolveSettled!: (completed: boolean) => void;
    const settled = new Promise<boolean>((resolve) => { resolveSettled = resolve; });
    let urlSyncs = 0;
    const ctx = {
      isDestroyed: false,
      panels: {},
      panelSettings: {},
      mapLayers: {} as MapLayers,
      map,
    } as unknown as AppContext;

    const pending = runDashboardActionBinding(
      ctx,
      { type: 'set_view', lat: 12.5, lon: 42.25, zoom: 6 },
      {
        waitForUiReady: () => Promise.resolve(),
        waitForMapReady: () => map.whenRendererReady(),
        applierOptions: {
          getPanelConfig: (panelId: string): PanelConfig => ({ name: panelId, enabled: true }),
          isPanelAllowed: () => true,
          hasPremiumAccess: () => false,
          applyLayerChange: () => {},
        },
        syncUrlStateNow: () => { urlSyncs += 1; },
      },
    );

    await Promise.resolve();
    internals.rendererInitToken = 8;
    internals.deckGLMap = {
      setCenter: (...args: unknown[]) => staleCalls.push(args),
      whenViewportSettled: () => Promise.resolve(),
    };
    (internals.markRendererReady as (token: number) => void).call(map, 7);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(staleCalls, []);
    assert.equal(urlSyncs, 0);

    internals.deckGLMap = {
      setCenter: (...args: unknown[]) => replacementCalls.push(args),
      whenViewportSettled: () => settled,
    };
    (internals.markRendererReady as (token: number) => void).call(map, 8);
    for (let attempt = 0; replacementCalls.length === 0 && attempt < 20; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(replacementCalls, [[12.5, 42.25, 6]]);
    assert.equal(urlSyncs, 0, 'URL sync must wait for the replacement renderer animation');

    resolveSettled(true);
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(urlSyncs, 1);
  });

  it('rejects an older viewport action after a newer action supersedes it', async () => {
    const { map, internals } = harness.createMapContainerHarness();
    let resolveFirst!: () => void;
    const firstSettled = new Promise<void>((resolve) => { resolveFirst = resolve; });
    internals.rendererReady = true;
    internals.deckGLMap = {
      setView() {},
      setCenter() {},
      whenViewportSettled: () => firstSettled,
    };
    const firstToken = map.setView('eu', 4);
    const first = map.whenViewportSettled(firstToken);

    map.setCenter(12.5, 42.25, 6);
    resolveFirst();
    await assert.rejects(
      first,
      (error: unknown) => error instanceof Error
        && error.name === 'ViewportTransitionError'
        && (error as Error & { reason?: string }).reason === 'viewport_superseded',
    );
  });

  it('rejects a transition when its renderer is replaced before settlement', async () => {
    const { map, internals } = harness.createMapContainerHarness();
    let resolveSettled!: (completed: boolean) => void;
    const settled = new Promise<boolean>((resolve) => { resolveSettled = resolve; });
    internals.rendererReady = true;
    internals.deckGLMap = {
      setView() {},
      whenViewportSettled: () => settled,
    };
    const token = map.setView('eu', 4);
    const pending = map.whenViewportSettled(token);

    internals.rendererInitToken = 8;
    resolveSettled(false);
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof Error
        && error.name === 'ViewportTransitionError'
        && (error as Error & { reason?: string }).reason === 'renderer_changed',
    );
  });

  it('denies set_map_mode 3d after handleGlobeInitFailure falls back to SVG', async () => {
    const { map, internals } = harness.createMapContainerHarness();
    internals.destroyFlatMap = () => {
      internals.deckGLMap = null;
      internals.svgMap = null;
    };
    internals.showRendererShell = () => {};
    internals.init = async () => {
      internals.rendererReady = false;
    };
    internals.initSvgMap = async (_log: string, token: number) => {
      internals.svgMap = { destroy() {} };
      (internals.markRendererReady as (token: number) => void).call(map, token);
    };

    const ctx = {
      isDestroyed: false,
      panels: {},
      panelSettings: {},
      mapLayers: {} as MapLayers,
      map,
    } as unknown as AppContext;

    const pending = runDashboardActionBinding(
      ctx,
      { type: 'set_map_mode', mode: '3d' },
      {
        waitForUiReady: () => Promise.resolve(),
        waitForMapReady: () => Promise.resolve(),
        applierOptions: {
          getPanelConfig: (panelId: string): PanelConfig => ({ name: panelId, enabled: true }),
          isPanelAllowed: () => true,
          hasPremiumAccess: () => false,
          applyLayerChange: () => {},
        },
        syncUrlStateNow: () => {},
      },
    );

    for (let attempt = 0; internals.useGlobe !== true && attempt < 20; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(internals.useGlobe, true, 'switchToGlobe must start before the failure path');
    (internals.handleGlobeInitFailure as (token: number, error: unknown) => void).call(
      map,
      internals.globeInitToken as number,
      new Error('globe failed'),
    );

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.status, 'denied');
    assert.equal(result.reason, 'globe_unavailable');
    assert.deepEqual(result.requested, { mode: '3d' });
    assert.deepEqual(result.effective, { mode: '2d', renderer: 'svg' });
    assert.equal(internals.useGlobe, false);
    assert.equal(map.isGlobeMode(), false);
  });

});
