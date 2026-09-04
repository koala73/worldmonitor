/**
 * Manager-level regression coverage for programmatic dashboard search (#6212).
 *
 * SearchManager cannot be imported by node:test without loading the complete
 * browser/worker graph. Extract the production class (the same technique used
 * by other manager tests) and provide narrow doubles for its module globals.
 * The public searchDashboard/openSearchResult methods and their real selection,
 * visibility, entitlement, renderer, and capability code all run unchanged.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import ts from 'typescript';

import {
  LAYER_REGISTRY,
  getAllowedLayerKeys,
  isLayerCommandAllowed,
  isLayerEntitled,
  isLayerExecutable,
} from '../src/config/map-layer-definitions.ts';
import {
  classifySearchMatchEffect,
  isSearchResultEffectHostExecutable,
  searchResultEffectRequiresCancellation,
} from '../src/app/webmcp-search-effects.ts';
import { searchMatchIdentity, type SearchMatch, type SearchResult } from '../src/components/search-types.ts';
import { OpaqueResultCache } from '../src/services/opaque-result-cache.ts';
import {
  raceWebMcpAbort,
  throwIfWebMcpAborted,
  WEBMCP_UNSUPPORTED_CANCELLATION_MESSAGE,
} from '../src/services/webmcp.ts';
import { withTimeout } from '../src/utils/with-timeout.ts';

type Variant = 'full' | 'tech' | 'finance' | 'happy' | 'commodity' | 'energy';

const managerSource = readFileSync(
  new URL('../src/app/search-manager.ts', import.meta.url),
  'utf8',
);

const sourceFile = ts.createSourceFile(
  'search-manager.ts',
  managerSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const managerNode = sourceFile.statements.find((statement): statement is ts.ClassDeclaration => (
  ts.isClassDeclaration(statement) && statement.name?.text === 'SearchManager'
));
assert.ok(managerNode, 'SearchManager class must remain in src/app/search-manager.ts');
const managerClassSource = managerNode.getText(sourceFile).replace(/^export\s+/, '');
const managerClassJs = ts.transpileModule(managerClassSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    useDefineForClassFields: true,
  },
}).outputText;

function extractClassJs(path: string, className: string): string {
  const moduleSource = readFileSync(new URL(path, import.meta.url), 'utf8');
  const parsed = ts.createSourceFile(path, moduleSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = parsed.statements.find((statement): statement is ts.ClassDeclaration => (
    ts.isClassDeclaration(statement) && statement.name?.text === className
  ));
  assert.ok(declaration, `${className} must remain in ${path}`);
  return ts.transpileModule(declaration.getText(parsed).replace(/^export\s+/, ''), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      useDefineForClassFields: true,
    },
  }).outputText;
}

const selectionDispatcherClassJs = extractClassJs(
  '../src/app/search-selection-dispatcher.ts',
  'SearchSelectionDispatcher',
);
const webMcpSearchControllerClassJs = extractClassJs(
  '../src/app/webmcp-search-controller.ts',
  'WebMcpSearchController',
);

interface Runtime {
  auth: { user?: { id: string; role?: string } };
  premium: boolean;
  pro: boolean;
  panelEntitled: boolean;
  selectedResultTypes: string[];
  detailedCountryAnalytics: Array<[string, string, string]>;
  authListeners: Set<() => void>;
  entitlementListeners: Set<() => void>;
  runtimeConfigListeners: Set<() => void>;
  widgetAccessListeners: Set<() => void>;
  liveFlightQueries: string[];
  liveFlightSignals: Array<AbortSignal | undefined>;
  liveFlightError: Error | null;
  liveFlightPending: boolean;
  releaseLiveFlight: (() => void) | null;
  deferTimers: boolean;
  nextTimerId: number;
  pendingTimers: Map<number, () => void>;
}

interface ModalDouble {
  matches: SearchMatch[];
  revision: number;
  openCalls: number;
  closeCalls: number;
  isOpen: boolean;
  cancelCalls: number;
  clearedSources: string[];
  flightCallsign: string | null;
  humanInteractionCallback: (() => void) | null;
  search(query: string, scope: string): {
    orderedMatches: SearchMatch[];
    flightCallsign: string | null;
  };
  getSearchIndexRevision(): number;
  resolveMatchByIdentity(identity: string): SearchMatch | undefined;
  registerSource(type: string, items: unknown[]): void;
  refreshSearch(): void;
  open(): void;
  closeForProgrammaticSelection(): void;
  cancelPendingWork(): void;
  setOnHumanInteraction(callback: () => void): void;
  triggerHumanInteraction(): void;
}

interface Scenario {
  manager: any;
  runtime: Runtime;
  modal: ModalDouble;
  ctx: any;
  calls: {
    views: string[];
    layers: string[];
    centers: Array<[number, number, number]>;
    timeRanges: string[];
    hotspotIds: string[];
    conflictIds: string[];
    pipelineIds: string[];
    countryBriefs: Array<[
      string,
      string,
      { trackDetailedAnalytics?: boolean; signal?: AbortSignal } | undefined,
    ]>;
    enabledPanels: Array<[string, { trackDetailedAnalytics?: boolean } | undefined]>;
    scrolledPanels: string[];
  };
  state: {
    globe: boolean;
    deckGL: boolean;
    updateCount: number;
    onUpdate?: (count: number) => void;
  };
}

function createHarness(variant: Variant, runtime: Runtime): new (ctx: any, callbacks: any) => any {
  const dependencyNames = [
    'OpaqueResultCache',
    'SEARCH_RESULT_CACHE_MAX_ENTRIES',
    'SEARCH_RESULT_CACHE_TTL_MS',
    'FLIGHT_SEARCH_SOURCE_TTL_MS',
    'LAYER_PRESET_PRIMARY_LAYERS',
    'SITE_VARIANT',
    'DASHBOARD_SEARCH_OUTPUT_TARGET_CHARS',
    'DASHBOARD_SEARCH_TYPE_MAX_CHARS',
    'DASHBOARD_SEARCH_TITLE_MAX_CHARS',
    'DASHBOARD_SEARCH_SUBTITLE_MAX_CHARS',
    'searchMatchIdentity',
    'getAuthState',
    'hasPremiumAccess',
    'subscribeAuthState',
    'onEntitlementChange',
    'subscribeRuntimeConfig',
    'subscribeWidgetAccess',
    'ALL_PANELS',
    'getEffectivePanelConfig',
    'isPanelEntitled',
    'isProUser',
    'isFreePanelCapCounted',
    'countFreePanelCapUsage',
    'FREE_MAX_PANELS',
    'getAllowedLayerKeys',
    'isLayerCommandAllowed',
    'isLayerExecutable',
    'isLayerEntitled',
    'LAYER_PRESETS',
    'LAYER_KEY_MAP',
    'trackSearchResultSelected',
    'trackCountrySelected',
    'runWithAgentAnalyticsSuppressed',
    'suppressNextAgentPanelView',
    'saveToStorage',
    'STORAGE_KEYS',
    'setTheme',
    'TIER1_COUNTRIES',
    'CURATED_COUNTRIES',
    'getCountryBbox',
    't',
    'setTimeout',
    'clearTimeout',
    'withTimeout',
    'fetchAircraftPositions',
    'raceWebMcpAbort',
    'throwIfWebMcpAborted',
    'classifySearchMatchEffect',
    'isSearchResultEffectHostExecutable',
    'searchResultEffectRequiresCancellation',
    'WEBMCP_UNSUPPORTED_CANCELLATION_MESSAGE',
  ];
  // Regular `function`s, not arrow functions: the receiver check below only
  // reflects how the caller invoked us (arrow functions ignore call-site
  // `this` entirely, which would make this double unable to reproduce the
  // bug). Mirrors the browser's native `window.setTimeout`/`clearTimeout`,
  // which throw `TypeError: Illegal invocation` when invoked as a method on
  // some object other than the global (WORLDMONITOR-ZT) but tolerate a bare,
  // unqualified call (`this === undefined`).
  function nativeLikeSetTimeout(this: unknown, callback: () => void): number {
    if (this !== undefined) throw new TypeError('Illegal invocation');
    if (!runtime.deferTimers) {
      queueMicrotask(callback);
      return 0;
    }
    const timer = runtime.nextTimerId++;
    runtime.pendingTimers.set(timer, callback);
    return timer;
  }
  function nativeLikeClearTimeout(this: unknown, timer: number): void {
    if (this !== undefined) throw new TypeError('Illegal invocation');
    runtime.pendingTimers.delete(timer);
  }

  const dependencyValues = [
    OpaqueResultCache,
    64,
    120_000,
    120_000,
    {
      military: ['bases', 'flights', 'military'],
      finance: ['stockExchanges', 'financialCenters', 'centralBanks', 'commodityHubs', 'economic'],
      infra: ['cables', 'pipelines', 'datacenters', 'spaceports', 'minerals'],
      intel: ['conflicts', 'hotspots', 'protests', 'ucdpEvents', 'displacement'],
      minimal: ['conflicts', 'hotspots'],
    },
    variant,
    10_000,
    80,
    240,
    320,
    searchMatchIdentity,
    () => runtime.auth,
    () => runtime.premium,
    (listener: () => void) => {
      runtime.authListeners.add(listener);
      return () => runtime.authListeners.delete(listener);
    },
    (listener: () => void) => {
      runtime.entitlementListeners.add(listener);
      return () => runtime.entitlementListeners.delete(listener);
    },
    (listener: () => void) => {
      runtime.runtimeConfigListeners.add(listener);
      return () => runtime.runtimeConfigListeners.delete(listener);
    },
    (listener: () => void) => {
      runtime.widgetAccessListeners.add(listener);
      return () => runtime.widgetAccessListeners.delete(listener);
    },
    { 'test-panel': { id: 'test-panel' } },
    (panelId: string) => panelId === 'test-panel' ? { id: panelId } : undefined,
    () => runtime.panelEntitled,
    () => runtime.pro,
    () => true,
    () => 0,
    6,
    getAllowedLayerKeys,
    isLayerCommandAllowed,
    isLayerExecutable,
    isLayerEntitled,
    {
      military: ['bases', 'nuclear', 'flights', 'military', 'waterways'],
      finance: ['stockExchanges', 'financialCenters', 'centralBanks', 'commodityHubs', 'economic', 'tradeRoutes'],
      infra: ['cables', 'pipelines', 'datacenters', 'spaceports', 'minerals'],
      intel: ['conflicts', 'hotspots', 'protests', 'ucdpEvents', 'displacement'],
      minimal: ['conflicts', 'hotspots'],
    },
    {},
    (type: string) => runtime.selectedResultTypes.push(type),
    (code: string, name: string, source: string) => {
      runtime.detailedCountryAnalytics.push([code, name, source]);
    },
    <T>(callback: () => T) => callback(),
    () => {},
    () => {},
    { mapLayers: 'mapLayers' },
    () => {},
    { US: 'United States' },
    {},
    () => null,
    (key: string) => key,
    nativeLikeSetTimeout,
    nativeLikeClearTimeout,
    withTimeout,
    (request: { callsign?: string }, signal?: AbortSignal) => {
      runtime.liveFlightQueries.push(request.callsign ?? '');
      runtime.liveFlightSignals.push(signal);
      if (runtime.liveFlightError) return Promise.reject(runtime.liveFlightError);
      const livePosition = {
        icao24: 'abc123',
        callsign: request.callsign ?? 'AB123',
        lat: 1,
        lon: 2,
        altitudeFt: 30_000,
        groundSpeedKts: 450,
        observedAt: Date.now(),
        onGround: false,
      };
      if (runtime.liveFlightPending) {
        return new Promise<typeof livePosition[]>((resolve) => {
          runtime.releaseLiveFlight = () => resolve([livePosition]);
        });
      }
      return Promise.resolve([livePosition]);
    },
    raceWebMcpAbort,
    throwIfWebMcpAborted,
    classifySearchMatchEffect,
    isSearchResultEffectHostExecutable,
    searchResultEffectRequiresCancellation,
    WEBMCP_UNSUPPORTED_CANCELLATION_MESSAGE,
  ];

  // eslint-disable-next-line no-new-func
  return new Function(
    ...dependencyNames,
    `${selectionDispatcherClassJs}\n${webMcpSearchControllerClassJs}\n${managerClassJs}\nreturn SearchManager;`,
  )(...dependencyValues) as new (ctx: any, callbacks: any) => any;
}

function resultMatch(
  type: SearchResult['type'],
  id: string,
  title: string,
  data: unknown,
  subtitle?: string,
): SearchMatch {
  return {
    kind: 'result',
    score: 2,
    result: { type, id, title, subtitle, data },
  };
}

function commandMatch(id: string, category: string, title = id): SearchMatch {
  return {
    kind: 'command',
    score: 2,
    title,
    subtitle: category,
    command: {
      id,
      category,
      label: title,
      keywords: [title.toLowerCase()],
      icon: '',
    },
  } as SearchMatch;
}

function makeScenario(
  matches: SearchMatch[],
  variant: Variant = 'full',
): Scenario {
  const runtime: Runtime = {
    auth: { user: { id: 'user-a', role: 'pro' } },
    premium: true,
    pro: true,
    panelEntitled: true,
    selectedResultTypes: [],
    detailedCountryAnalytics: [],
    authListeners: new Set(),
    entitlementListeners: new Set(),
    runtimeConfigListeners: new Set(),
    widgetAccessListeners: new Set(),
    liveFlightQueries: [],
    liveFlightSignals: [],
    liveFlightError: null,
    liveFlightPending: false,
    releaseLiveFlight: null,
    deferTimers: false,
    nextTimerId: 1,
    pendingTimers: new Map(),
  };
  const calls: Scenario['calls'] = {
    views: [],
    layers: [],
    centers: [],
    timeRanges: [],
    hotspotIds: [],
    conflictIds: [],
    pipelineIds: [],
    countryBriefs: [],
    enabledPanels: [],
    scrolledPanels: [],
  };
  const state: Scenario['state'] = {
    globe: false,
    deckGL: true,
    updateCount: 0,
  };
  const modal: ModalDouble = {
    matches: [...matches],
    revision: 1,
    openCalls: 0,
    closeCalls: 0,
    isOpen: false,
    cancelCalls: 0,
    clearedSources: [],
    flightCallsign: null,
    humanInteractionCallback: null,
    search: () => ({
      orderedMatches: [...modal.matches],
      flightCallsign: modal.flightCallsign,
    }),
    getSearchIndexRevision: () => modal.revision,
    resolveMatchByIdentity: (identity) => modal.matches.find(
      (match) => searchMatchIdentity(match) === identity,
    ),
    registerSource: (type, items) => {
      if (items.length === 0) modal.clearedSources.push(type);
      if (type === 'flight' && items.length > 0) {
        modal.matches = (items as Array<{
          id: string;
          title: string;
          subtitle?: string;
          data: unknown;
        }>).map((item) => resultMatch('flight', item.id, item.title, item.data, item.subtitle));
      }
    },
    refreshSearch: () => {},
    open: () => {
      modal.openCalls += 1;
      modal.isOpen = true;
    },
    closeForProgrammaticSelection: () => {
      modal.closeCalls += 1;
      modal.isOpen = false;
    },
    cancelPendingWork: () => { modal.cancelCalls += 1; },
    setOnHumanInteraction: (callback) => { modal.humanInteractionCallback = callback; },
    triggerHumanInteraction: () => { modal.humanInteractionCallback?.(); },
  };
  const mapLayers = Object.fromEntries(
    Object.keys(LAYER_REGISTRY).map((key) => [key, false]),
  );
  const ctx = {
    searchModal: modal,
    mapLayers,
    map: {
      isGlobeMode: () => state.globe,
      isDeckGLActive: () => state.deckGL,
      setView: (view: string) => calls.views.push(view),
      enableLayer: (layer: string) => calls.layers.push(layer),
      setLayers: () => {},
      setCenter: (lat: number, lon: number, zoom: number) => calls.centers.push([lat, lon, zoom]),
      setTimeRange: (range: string) => calls.timeRanges.push(range),
      triggerHotspotClick: (id: string) => calls.hotspotIds.push(id),
      triggerConflictClick: (id: string) => calls.conflictIds.push(id),
      triggerPipelineClick: (id: string) => calls.pipelineIds.push(id),
    },
    panelSettings: {
      'test-panel': { enabled: false },
      markets: { enabled: true },
      polymarket: { enabled: true },
    },
    panels: {},
    newsPanels: {},
    allNews: [],
    latestPredictions: [],
    latestMarkets: [],
    latestTechEvents: [],
  };
  const Harness = createHarness(variant, runtime);
  const manager = new Harness(ctx, {
    openCountryBriefByCode: (
      code: string,
      name: string,
      options?: { trackDetailedAnalytics?: boolean; signal?: AbortSignal },
    ) => {
      calls.countryBriefs.push([code, name, options]);
      return true;
    },
    enablePanel: (
      panelId: string,
      options?: { trackDetailedAnalytics?: boolean },
    ) => {
      calls.enabledPanels.push([panelId, options]);
      return true;
    },
  });
  // Mirrors SearchManager.setupSearchModal's production authority seam while
  // retaining this test's lightweight prebuilt modal double.
  modal.setOnHumanInteraction(() => manager.cancelPendingProgrammaticSelection());
  manager.updateSearchIndex = () => {
    state.updateCount += 1;
    state.onUpdate?.(state.updateCount);
  };
  manager.searchSelection.scrollToPanel = (panelId: string) => {
    calls.scrolledPanels.push(panelId);
    return true;
  };
  manager.searchSelection.scrollToPanelWhenReady = (panelId: string) => {
    calls.scrolledPanels.push(panelId);
    return true;
  };
  manager.searchSelection.dispatchPanelTabAfterPresentation = () => true;
  manager.destroyed = false;

  // Existing tests omit the host signal the way a capable caller would. Chrome
  // 149–151 passes explicit `undefined`; those cases must keep being able to
  // name the missing signal, so only an omitted argument is filled in.
  const searchDashboard = manager.searchDashboard.bind(manager);
  manager.searchDashboard = (
    query: string,
    scope: string,
    limit: number,
    ...rest: Array<AbortSignal | undefined>
  ) => searchDashboard(
    query,
    scope,
    limit,
    rest.length === 0 ? new AbortController().signal : rest[0],
  );
  const openSearchResult = manager.openSearchResult.bind(manager);
  manager.openSearchResult = (
    resultKey: string,
    waitForMapReady?: () => Promise<void>,
    ...rest: Array<AbortSignal | undefined>
  ) => openSearchResult(
    resultKey,
    waitForMapReady,
    rest.length === 0 ? new AbortController().signal : rest[0],
  );

  return { manager, runtime, modal, ctx, calls, state };
}

async function searchThenOpen(scenario: Scenario, index = 0) {
  const response = await scenario.manager.searchDashboard('needle', 'all', 10);
  const descriptor = response.results[index];
  assert.ok(descriptor, `expected search result at index ${index}`);
  const opened = await scenario.manager.openSearchResult(descriptor.key, async () => {});
  return { response, descriptor, opened };
}

function flushTimers(runtime: Runtime): void {
  while (runtime.pendingTimers.size > 0) {
    const callbacks = [...runtime.pendingTimers.values()];
    runtime.pendingTimers.clear();
    for (const callback of callbacks) callback();
  }
}

function summarizeCountryBriefs(calls: Scenario['calls']['countryBriefs']): unknown[] {
  return calls.map(([code, name, options]) => [
    code,
    name,
    options ? {
      trackDetailedAnalytics: options.trackDetailedAnalytics,
      ...(options.signal ? { hasSignal: true } : {}),
    } : undefined,
  ]);
}

describe('SearchManager programmatic dashboard search (#6212)', () => {
  it('denies forged keys and consumes issued keys before selection', async () => {
    const scenario = makeScenario([
      resultMatch('country', 'US', 'United States', { code: 'US', name: 'United States' }),
    ]);

    assert.deepEqual(await scenario.manager.openSearchResult(`sr_${'f'.repeat(32)}`), {
      ok: false,
      status: 'denied',
      reason: 'invalid_or_expired_key',
    });

    const first = await searchThenOpen(scenario);
    assert.deepEqual(first.opened, { ok: true, status: 'opened', type: 'country' });
    assert.deepEqual(await scenario.manager.openSearchResult(first.descriptor.key), {
      ok: false,
      status: 'denied',
      reason: 'invalid_or_expired_key',
    });
    assert.equal(scenario.calls.countryBriefs.length, 1, 'replay must not repeat selection');
    assert.equal(scenario.modal.openCalls, 0, 'programmatic search must not open CMD+K');
  });

  it('cancels delayed work from an earlier programmatic selection', async () => {
    const scenario = makeScenario([
      resultMatch('hotspot', 'old-hotspot', 'Old hotspot', { id: 'old-hotspot' }),
      resultMatch('country', 'CA', 'Canada', { code: 'CA', name: 'Canada' }),
    ]);
    scenario.runtime.deferTimers = true;
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);

    let staleOpenSettled = false;
    const staleOpen = scenario.manager.openSearchResult(response.results[0].key)
      .then((result: unknown) => {
        staleOpenSettled = true;
        return result;
      });
    await Promise.resolve();
    assert.equal(scenario.runtime.pendingTimers.size, 1);
    assert.equal(staleOpenSettled, false, 'scheduled map work must keep the opener pending');
    assert.deepEqual(
      await scenario.manager.openSearchResult(response.results[1].key),
      { ok: true, status: 'opened', type: 'country' },
    );
    assert.deepEqual(await staleOpen, {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });

    flushTimers(scenario.runtime);
    assert.deepEqual(scenario.calls.hotspotIds, []);
    assert.deepEqual(scenario.calls.views, []);
    assert.deepEqual(summarizeCountryBriefs(scenario.calls.countryBriefs), [[
      'CA',
      'Canada',
      { trackDetailedAnalytics: false, hasSignal: true },
    ]]);
  });

  it('rejects an aborted delayed selection without applying its map effect', async () => {
    const scenario = makeScenario([
      resultMatch('hotspot', 'cancelled-hotspot', 'Cancelled hotspot', { id: 'cancelled-hotspot' }),
    ]);
    scenario.runtime.deferTimers = true;
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);

    const controller = new AbortController();
    const pendingOpen = scenario.manager.openSearchResult(key, undefined, controller.signal);
    await Promise.resolve();
    assert.equal(scenario.runtime.pendingTimers.size, 1);

    controller.abort();
    await assert.rejects(pendingOpen, (error: unknown) => (
      error instanceof Error && error.name === 'AbortError'
    ));
    flushTimers(scenario.runtime);
    assert.deepEqual(scenario.calls.hotspotIds, []);
    assert.deepEqual(scenario.calls.views, []);
  });

  it('aborts promptly while renderer readiness is still pending', async () => {
    const scenario = makeScenario([
      resultMatch('pipeline', 'pipe-pending', 'Pending pipeline', { id: 'pipe-pending' }),
    ]);
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    let releaseRenderer!: () => void;
    const rendererReady = new Promise<void>((resolve) => {
      releaseRenderer = resolve;
    });
    const controller = new AbortController();
    const pendingOpen = scenario.manager.openSearchResult(
      key,
      () => rendererReady,
      controller.signal,
    );
    await Promise.resolve();
    assert.equal(scenario.modal.closeCalls, 0);

    controller.abort();
    await assert.rejects(pendingOpen, (error: unknown) => error === controller.signal.reason);
    assert.deepEqual(scenario.calls.pipelineIds, []);
    assert.deepEqual(scenario.calls.views, []);
    assert.equal(scenario.modal.closeCalls, 0);
    releaseRenderer();
    await Promise.resolve();
    assert.deepEqual(scenario.calls.pipelineIds, []);
  });

  it('lets an existing palette interaction cancel an open before renderer readiness', async () => {
    const scenario = makeScenario([
      resultMatch('pipeline', 'pipe-human-cancel', 'Human-cancelled pipeline', { id: 'pipe-human-cancel' }),
    ]);
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    let releaseRenderer!: () => void;
    const rendererReady = new Promise<void>((resolve) => { releaseRenderer = resolve; });
    scenario.modal.open();
    const pendingOpen = scenario.manager.openSearchResult(key, () => rendererReady);
    await Promise.resolve();

    scenario.modal.triggerHumanInteraction();
    assert.deepEqual(await pendingOpen, {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
    assert.equal(scenario.modal.isOpen, true, 'human interaction keeps the existing palette open');
    assert.equal(scenario.modal.closeCalls, 0);

    releaseRenderer();
    await Promise.resolve();
    assert.deepEqual(scenario.calls.pipelineIds, [], 'released stale readiness must not mutate the map');
    assert.equal(scenario.modal.closeCalls, 0, 'released stale readiness must not close the palette');
  });

  it('lets a newer result supersede an older open held in renderer readiness', async () => {
    const scenario = makeScenario([
      resultMatch('pipeline', 'pipe-old', 'Old pipeline', { id: 'pipe-old' }),
      resultMatch('pipeline', 'pipe-new', 'New pipeline', { id: 'pipe-new' }),
    ]);
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const oldKey = response.results[0]?.key;
    const newKey = response.results[1]?.key;
    assert.ok(oldKey);
    assert.ok(newKey);
    let releaseOldRenderer!: () => void;
    const oldRendererReady = new Promise<void>((resolve) => { releaseOldRenderer = resolve; });
    const oldOpen = scenario.manager.openSearchResult(oldKey, () => oldRendererReady);
    await Promise.resolve();

    assert.deepEqual(
      await scenario.manager.openSearchResult(newKey, async () => {}),
      { ok: true, status: 'opened', type: 'pipeline' },
    );
    assert.deepEqual(await oldOpen, {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });

    releaseOldRenderer();
    await Promise.resolve();
    assert.deepEqual(scenario.calls.pipelineIds, ['pipe-new']);
    assert.equal(scenario.modal.closeCalls, 1, 'only the newer successful result may close the palette');
  });

  it('cancels renderer-held opens on security invalidation and destroy', async () => {
    for (const cause of ['security', 'destroy'] as const) {
      const scenario = makeScenario([
        resultMatch('pipeline', `pipe-${cause}`, `${cause} pipeline`, { id: `pipe-${cause}` }),
      ]);
      if (cause === 'security') scenario.manager.observeSecurityContext();
      const response = await scenario.manager.searchDashboard('needle', 'all', 10);
      const key = response.results[0]?.key;
      assert.ok(key);
      let releaseRenderer!: () => void;
      const rendererReady = new Promise<void>((resolve) => { releaseRenderer = resolve; });
      const pendingOpen = scenario.manager.openSearchResult(key, () => rendererReady);
      await Promise.resolve();

      if (cause === 'security') {
        scenario.runtime.auth = {};
        scenario.runtime.premium = false;
        for (const listener of scenario.runtime.authListeners) listener();
      } else {
        scenario.manager.destroy();
      }

      assert.deepEqual(await pendingOpen, cause === 'destroy'
        ? { ok: false, status: 'denied', reason: 'search_state_changed' }
        : { ok: false, status: 'denied', reason: 'result_no_longer_executable' });
      releaseRenderer();
      await Promise.resolve();
      assert.deepEqual(scenario.calls.pipelineIds, [], cause);
      assert.equal(scenario.modal.closeCalls, 0, cause);
    }
  });

  it('passes cancellation into an in-flight country presentation', async () => {
    const scenario = makeScenario([
      resultMatch('country', 'US', 'United States', { code: 'US', name: 'United States' }),
    ]);
    let capturedSignal: AbortSignal | undefined;
    let releaseCountry!: () => void;
    let presented = 0;
    scenario.manager.callbacks.openCountryBriefByCode = (
      code: string,
      name: string,
      options?: { trackDetailedAnalytics?: boolean; signal?: AbortSignal },
    ) => {
      scenario.calls.countryBriefs.push([code, name, options]);
      capturedSignal = options?.signal;
      return new Promise<boolean>((resolve, reject) => {
        const signal = options?.signal;
        const handleAbort = (): void => reject(signal?.reason);
        signal?.addEventListener('abort', handleAbort, { once: true });
        releaseCountry = () => {
          signal?.removeEventListener('abort', handleAbort);
          if (signal?.aborted) return;
          presented += 1;
          resolve(true);
        };
      });
    };

    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    scenario.modal.open();
    const controller = new AbortController();
    const pendingOpen = scenario.manager.openSearchResult(key, undefined, controller.signal);
    await Promise.resolve();
    assert.notEqual(capturedSignal, controller.signal, 'the presentation uses a linked internal signal');
    assert.equal(capturedSignal?.aborted, false);
    assert.equal(scenario.calls.countryBriefs[0]?.[2]?.trackDetailedAnalytics, false);
    assert.equal(scenario.modal.isOpen, true, 'selection entry must not close the human palette');

    controller.abort();
    await assert.rejects(pendingOpen, (error: unknown) => error === controller.signal.reason);
    assert.equal(capturedSignal?.aborted, true, 'caller abort must propagate to the internal signal');
    releaseCountry();
    await Promise.resolve();
    assert.equal(presented, 0, 'aborted country work must not present later');
    assert.equal(scenario.modal.isOpen, true, 'cancellation must leave the human palette open');
    assert.equal(scenario.modal.closeCalls, 0);
    assert.deepEqual(await scenario.manager.openSearchResult(key), {
      ok: false,
      status: 'denied',
      reason: 'invalid_or_expired_key',
    }, 'an entered selection must remain one-use after cancellation');
  });

  it('aborts an in-flight country presentation when a newer selection starts', async () => {
    const scenario = makeScenario([
      resultMatch('country', 'US', 'United States', { code: 'US', name: 'United States' }),
      resultMatch('country', 'CA', 'Canada', { code: 'CA', name: 'Canada' }),
    ]);
    let firstSignal: AbortSignal | undefined;
    let firstPresented = 0;
    let releaseFirst!: () => void;
    scenario.manager.callbacks.openCountryBriefByCode = (
      code: string,
      name: string,
      options?: { trackDetailedAnalytics?: boolean; signal?: AbortSignal },
    ) => {
      scenario.calls.countryBriefs.push([code, name, options]);
      if (code !== 'US') return true;
      firstSignal = options?.signal;
      return new Promise<boolean>((resolve, reject) => {
        const handleAbort = (): void => reject(firstSignal?.reason);
        firstSignal?.addEventListener('abort', handleAbort, { once: true });
        releaseFirst = () => {
          firstSignal?.removeEventListener('abort', handleAbort);
          if (firstSignal?.aborted) return;
          firstPresented += 1;
          resolve(true);
        };
      });
    };

    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const firstKey = response.results[0]?.key;
    const secondKey = response.results[1]?.key;
    assert.ok(firstKey);
    assert.ok(secondKey);
    const firstOpen = scenario.manager.openSearchResult(firstKey);
    await Promise.resolve();
    assert.equal(firstSignal?.aborted, false);

    assert.deepEqual(await scenario.manager.openSearchResult(secondKey), {
      ok: true,
      status: 'opened',
      type: 'country',
    });
    assert.equal(firstSignal?.aborted, true, 'the newer selection must abort prior presentation work');
    assert.deepEqual(await firstOpen, {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
    releaseFirst();
    assert.equal(firstPresented, 0);
  });

  it('denies a panel result when enabling it never produces a visible target', async () => {
    const scenario = makeScenario([
      commandMatch('panel:test-panel', 'panels', 'Test panel'),
    ]);
    scenario.runtime.deferTimers = true;
    delete scenario.manager.searchSelection.scrollToPanelWhenReady;
    delete scenario.manager.searchSelection.scrollToPanel;
    delete scenario.manager.searchSelection.dispatchPanelTabAfterPresentation;
    const runtimeGlobal = globalThis as unknown as {
      document?: { querySelector: () => null };
    };
    const previousDocument = runtimeGlobal.document;
    runtimeGlobal.document = { querySelector: () => null };

    try {
      const response = await scenario.manager.searchDashboard('needle', 'all', 10);
      const key = response.results[0]?.key;
      assert.ok(key);
      const pendingOpen = scenario.manager.openSearchResult(key);
      await Promise.resolve();
      assert.ok(scenario.runtime.pendingTimers.size > 0);
      flushTimers(scenario.runtime);

      assert.deepEqual(await pendingOpen, {
        ok: false,
        status: 'denied',
        reason: 'result_no_longer_executable',
      });
      assert.deepEqual(scenario.calls.enabledPanels, [[
        'test-panel',
        { trackDetailedAnalytics: false },
      ]]);
      assert.deepEqual(scenario.calls.scrolledPanels, []);
    } finally {
      if (previousDocument === undefined) delete runtimeGlobal.document;
      else runtimeGlobal.document = previousDocument;
    }
  });

  it('re-arms agent view suppression when a slow deferred-panel retry finally mounts', async () => {
    const scenario = makeScenario([
      commandMatch('panel:test-panel', 'panels', 'Test panel'),
    ]);
    scenario.runtime.deferTimers = true;
    delete scenario.manager.searchSelection.scrollToPanelWhenReady;
    delete scenario.manager.searchSelection.scrollToPanel;
    delete scenario.manager.searchSelection.dispatchPanelTabAfterPresentation;
    let mounted = false;
    let notifyMutation = (): void => {};
    let simulatedElapsedMs = 0;
    let observerObserved = false;
    const suppressionTimes: number[] = [];
    scenario.manager.searchSelection.bindings.suppressNextAgentPanelView = () => {
      suppressionTimes.push(simulatedElapsedMs);
    };
    const target = {
      classList: { add: () => {}, remove: () => {} },
      isConnected: true,
      offsetWidth: 1,
      scrollIntoView: () => scenario.calls.scrolledPanels.push('test-panel'),
    };
    const shell = {
      isConnected: true,
      scrollIntoView: () => scenario.calls.scrolledPanels.push('deferred-shell'),
    };
    const runtimeGlobal = globalThis as unknown as {
      document?: {
        body: object;
        querySelector: (selector: string) => typeof target | typeof shell | null;
      };
      MutationObserver?: typeof MutationObserver;
    };
    const previousDocument = runtimeGlobal.document;
    const previousMutationObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');
    runtimeGlobal.document = {
      body: {},
      querySelector: (selector) => {
        if (selector.includes(':not([data-deferred-panel])')) return mounted ? target : null;
        return selector.includes('[data-deferred-panel]') ? shell : null;
      },
    };
    class MutationObserverDouble {
      constructor(callback: () => void) {
        notifyMutation = callback;
      }

      observe(): void { observerObserved = true; }
      disconnect(): void {}
      takeRecords(): MutationRecord[] { return []; }
    }
    Object.defineProperty(globalThis, 'MutationObserver', {
      configurable: true,
      writable: true,
      value: MutationObserverDouble as unknown as typeof MutationObserver,
    });

    try {
      const response = await scenario.manager.searchDashboard('needle', 'all', 10);
      const key = response.results[0]?.key;
      assert.ok(key);
      const pendingOpen = scenario.manager.openSearchResult(key);
      await Promise.resolve();
      assert.deepEqual(scenario.calls.scrolledPanels, ['deferred-shell']);
      assert.equal(observerObserved, true, 'the deferred wait must observe panel mounts');
      assert.equal(
        scenario.runtime.pendingTimers.size,
        1,
        'waiting uses one deadline rather than polling PanelLayout retry timing',
      );
      assert.deepEqual(
        suppressionTimes,
        [],
        'a shell-only wait must not leave privacy suppression behind if the agent is cancelled',
      );

      let settled = false;
      void pendingOpen.then(() => { settled = true; });
      simulatedElapsedMs = 5_500;
      notifyMutation();
      await Promise.resolve();
      assert.equal(settled, false, 'the failed initial load must keep waiting for PanelLayout retry');

      simulatedElapsedMs += 1_000;
      mounted = true;
      notifyMutation();

      assert.deepEqual(await pendingOpen, {
        ok: true,
        status: 'opened',
        type: 'command',
      });
      assert.equal(simulatedElapsedMs, 6_500, 'the real panel mounted after the privacy TTL and retry gap');
      assert.deepEqual(
        suppressionTimes,
        [6_500],
        'privacy suppression must be armed at the real-panel scroll boundary',
      );
      assert.deepEqual(scenario.calls.scrolledPanels, ['deferred-shell', 'test-panel']);
    } finally {
      if (previousDocument === undefined) delete runtimeGlobal.document;
      else runtimeGlobal.document = previousDocument;
      if (previousMutationObserver) {
        Object.defineProperty(globalThis, 'MutationObserver', previousMutationObserver);
      } else {
        delete runtimeGlobal.MutationObserver;
      }
    }
  });

  it('disconnects a human deferred-panel wait when the dispatcher is destroyed', async () => {
    const scenario = makeScenario([]);
    scenario.runtime.deferTimers = true;
    delete scenario.manager.searchSelection.scrollToPanelWhenReady;
    let notifyMutation = (): void => {};
    let observerDisconnected = false;
    let observerObserved = false;
    const shell = {
      isConnected: true,
      scrollIntoView: () => scenario.calls.scrolledPanels.push('deferred-shell'),
    };
    const target = {
      classList: { add: () => {}, remove: () => {} },
      isConnected: true,
      offsetWidth: 1,
      scrollIntoView: () => scenario.calls.scrolledPanels.push('real-panel'),
    };
    let mounted = false;
    const runtimeGlobal = globalThis as unknown as {
      document?: {
        body: object;
        querySelector: (selector: string) => typeof target | typeof shell | null;
      };
      MutationObserver?: typeof MutationObserver;
    };
    const previousDocument = runtimeGlobal.document;
    const previousMutationObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');
    runtimeGlobal.document = {
      body: {},
      querySelector: (selector) => {
        if (selector.includes(':not([data-deferred-panel])')) return mounted ? target : null;
        return selector.includes('[data-deferred-panel]') ? shell : null;
      },
    };
    class MutationObserverDouble {
      constructor(callback: () => void) { notifyMutation = callback; }
      observe(): void { observerObserved = true; }
      disconnect(): void { observerDisconnected = true; }
      takeRecords(): MutationRecord[] { return []; }
    }
    Object.defineProperty(globalThis, 'MutationObserver', {
      configurable: true,
      writable: true,
      value: MutationObserverDouble as unknown as typeof MutationObserver,
    });

    try {
      const pendingScroll = scenario.manager.searchSelection.scrollToPanelWhenReady(
        'test-panel',
        true,
      );
      await Promise.resolve();
      assert.deepEqual(scenario.calls.scrolledPanels, ['deferred-shell']);
      assert.equal(observerObserved, true, 'the deferred wait must observe panel mounts');
      assert.equal(scenario.runtime.pendingTimers.size, 1);

      scenario.manager.searchSelection.destroy();
      assert.equal(await pendingScroll, false);
      assert.equal(observerDisconnected, true);
      assert.equal(scenario.runtime.pendingTimers.size, 0);

      mounted = true;
      notifyMutation();
      assert.deepEqual(
        scenario.calls.scrolledPanels,
        ['deferred-shell'],
        'a late mount must not scroll after dispatcher teardown',
      );
    } finally {
      if (previousDocument === undefined) delete runtimeGlobal.document;
      else runtimeGlobal.document = previousDocument;
      if (previousMutationObserver) {
        Object.defineProperty(globalThis, 'MutationObserver', previousMutationObserver);
      } else {
        delete runtimeGlobal.MutationObserver;
      }
    }
  });

  it('cancels an older human deferred-panel wait when a newer human selection begins', async () => {
    const scenario = makeScenario([]);
    scenario.runtime.deferTimers = true;
    delete scenario.manager.searchSelection.scrollToPanelWhenReady;
    delete scenario.manager.searchSelection.scrollToPanel;
    delete scenario.manager.searchSelection.dispatchPanelTabAfterPresentation;
    let notifyMutation = (): void => {};
    let mounted = false;
    let highlightCount = 0;
    let observerObserved = false;
    const shell = {
      isConnected: true,
      scrollIntoView: () => scenario.calls.scrolledPanels.push('deferred-shell'),
    };
    const target = {
      classList: {
        add: () => { highlightCount += 1; },
        remove: () => {},
      },
      isConnected: true,
      offsetWidth: 1,
      scrollIntoView: () => scenario.calls.scrolledPanels.push('stale-real-panel'),
    };
    const runtimeGlobal = globalThis as unknown as {
      document?: {
        body: object;
        querySelector: (selector: string) => typeof target | typeof shell | null;
      };
      MutationObserver?: typeof MutationObserver;
    };
    const previousDocument = runtimeGlobal.document;
    const previousMutationObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');
    runtimeGlobal.document = {
      body: {},
      querySelector: (selector) => {
        if (selector.includes(':not([data-deferred-panel])')) return mounted ? target : null;
        return selector.includes('[data-deferred-panel]') ? shell : null;
      },
    };
    class MutationObserverDouble {
      constructor(callback: () => void) { notifyMutation = callback; }
      observe(): void { observerObserved = true; }
      disconnect(): void {}
      takeRecords(): MutationRecord[] { return []; }
    }
    Object.defineProperty(globalThis, 'MutationObserver', {
      configurable: true,
      writable: true,
      value: MutationObserverDouble as unknown as typeof MutationObserver,
    });

    try {
      const pendingPanelOpen = scenario.manager.searchSelection.handleCommand(
        commandMatch('panel:test-panel', 'panels', 'Test panel').command,
      );
      await Promise.resolve();
      assert.deepEqual(scenario.calls.scrolledPanels, ['deferred-shell']);
      assert.equal(observerObserved, true, 'the deferred wait must observe panel mounts');

      assert.equal(
        scenario.manager.searchSelection.handleCommand(
          commandMatch('time:week', 'time', 'Past week').command,
        ),
        true,
      );
      assert.equal(await pendingPanelOpen, false, 'the superseded panel wait must be denied');
      assert.deepEqual(scenario.calls.timeRanges, ['week']);

      mounted = true;
      notifyMutation();
      assert.deepEqual(
        scenario.calls.scrolledPanels,
        ['deferred-shell'],
        'a late panel mount must not override the newer human selection',
      );
      assert.equal(highlightCount, 0, 'the stale panel must not be highlighted');
    } finally {
      if (previousDocument === undefined) delete runtimeGlobal.document;
      else runtimeGlobal.document = previousDocument;
      if (previousMutationObserver) {
        Object.defineProperty(globalThis, 'MutationObserver', previousMutationObserver);
      } else {
        delete runtimeGlobal.MutationObserver;
      }
    }
  });

  it('scrolls a deferred panel shell but waits for the real panel before reporting opened', async () => {
    const scenario = makeScenario([
      commandMatch('panel:test-panel', 'panels', 'Test panel'),
    ]);
    scenario.runtime.deferTimers = true;
    delete scenario.manager.searchSelection.scrollToPanelWhenReady;
    delete scenario.manager.searchSelection.scrollToPanel;
    delete scenario.manager.searchSelection.dispatchPanelTabAfterPresentation;
    let virtualElapsedMs = 0;
    scenario.manager.searchSelection.bindings.setTimeout = (
      callback: () => void,
      delay: number,
    ) => {
      const timer = scenario.runtime.nextTimerId++;
      scenario.runtime.pendingTimers.set(timer, () => {
        virtualElapsedMs += delay;
        callback();
      });
      return timer;
    };
    scenario.manager.searchSelection.bindings.clearTimeout = (timer: number) => {
      scenario.runtime.pendingTimers.delete(timer);
    };
    const shell = {
      isConnected: true,
      scrollIntoView: () => scenario.calls.scrolledPanels.push('deferred-shell'),
    };
    const panel = {
      classList: { add: () => {}, remove: () => {} },
      isConnected: true,
      offsetWidth: 1,
      scrollIntoView: () => scenario.calls.scrolledPanels.push('real-panel'),
    };
    const runtimeGlobal = globalThis as unknown as {
      document?: { querySelector: (selector: string) => typeof shell | typeof panel | null };
    };
    const previousDocument = runtimeGlobal.document;
    runtimeGlobal.document = {
      querySelector: (selector) => {
        if (selector.includes(':not([data-deferred-panel])')) {
          return virtualElapsedMs > 960 ? panel : null;
        }
        return selector.includes('[data-deferred-panel]') ? shell : null;
      },
    };

    try {
      const response = await scenario.manager.searchDashboard('needle', 'all', 10);
      const key = response.results[0]?.key;
      assert.ok(key);
      const pendingOpen = scenario.manager.openSearchResult(key);
      await Promise.resolve();
      assert.equal(scenario.calls.scrolledPanels[0], 'deferred-shell');
      assert.equal(scenario.modal.closeCalls, 0, 'a shell is not a successful presentation');
      flushTimers(scenario.runtime);

      assert.deepEqual(await pendingOpen, {
        ok: true,
        status: 'opened',
        type: 'command',
      });
      assert.deepEqual(scenario.calls.scrolledPanels, ['deferred-shell', 'real-panel']);
      assert.ok(virtualElapsedMs >= 1_000, 'the real panel mounted after the old 960 ms window');
      assert.equal(scenario.modal.closeCalls, 1);
    } finally {
      if (previousDocument === undefined) delete runtimeGlobal.document;
      else runtimeGlobal.document = previousDocument;
    }
  });

  it('denies a deferred panel shell that never resolves to a real panel', async () => {
    const scenario = makeScenario([
      commandMatch('panel:test-panel', 'panels', 'Test panel'),
    ]);
    scenario.runtime.deferTimers = true;
    delete scenario.manager.searchSelection.scrollToPanelWhenReady;
    delete scenario.manager.searchSelection.scrollToPanel;
    delete scenario.manager.searchSelection.dispatchPanelTabAfterPresentation;
    const shell = {
      isConnected: true,
      scrollIntoView: () => scenario.calls.scrolledPanels.push('deferred-shell'),
    };
    const runtimeGlobal = globalThis as unknown as {
      document?: { querySelector: (selector: string) => typeof shell | null };
    };
    const previousDocument = runtimeGlobal.document;
    runtimeGlobal.document = {
      querySelector: (selector) => (
        selector.includes(':not([data-deferred-panel])') ? null : shell
      ),
    };

    try {
      const response = await scenario.manager.searchDashboard('needle', 'all', 10);
      const key = response.results[0]?.key;
      assert.ok(key);
      scenario.modal.open();
      const pendingOpen = scenario.manager.openSearchResult(key);
      await Promise.resolve();
      flushTimers(scenario.runtime);

      assert.deepEqual(await pendingOpen, {
        ok: false,
        status: 'denied',
        reason: 'result_no_longer_executable',
      });
      assert.deepEqual(scenario.calls.scrolledPanels, ['deferred-shell']);
      assert.equal(scenario.modal.isOpen, true, 'an unresolved shell must not close the palette');
      assert.equal(scenario.modal.closeCalls, 0);
    } finally {
      if (previousDocument === undefined) delete runtimeGlobal.document;
      else runtimeGlobal.document = previousDocument;
    }
  });

  it('does not acknowledge deferred market or prediction shells as opened results', async () => {
    for (const testCase of [
      { type: 'market', panelId: 'markets' },
      { type: 'prediction', panelId: 'polymarket' },
    ] as const) {
      const scenario = makeScenario([
        resultMatch(testCase.type, `${testCase.type}-1`, testCase.type, {}),
      ]);
      scenario.runtime.deferTimers = true;
      delete scenario.manager.searchSelection.scrollToPanelWhenReady;
      delete scenario.manager.searchSelection.scrollToPanel;
      const shell = {
        dataset: { panel: testCase.panelId },
        isConnected: true,
        scrollIntoView: () => scenario.calls.scrolledPanels.push(testCase.panelId),
      };
      const runtimeGlobal = globalThis as unknown as {
        document?: {
          querySelector: (selector: string) => typeof shell | null;
          querySelectorAll: () => typeof shell[];
        };
      };
      const previousDocument = runtimeGlobal.document;
      runtimeGlobal.document = {
        querySelector: (selector) => (
          selector.includes(':not([data-deferred-panel])') ? null : shell
        ),
        querySelectorAll: () => [shell],
      };

      try {
        const response = await scenario.manager.searchDashboard('needle', 'all', 10);
        const key = response.results[0]?.key;
        assert.ok(key);
        scenario.modal.open();
        const pendingOpen = scenario.manager.openSearchResult(key);
        await Promise.resolve();
        flushTimers(scenario.runtime);

        assert.deepEqual(await pendingOpen, {
          ok: false,
          status: 'denied',
          reason: 'result_no_longer_executable',
        }, testCase.type);
        assert.deepEqual(scenario.calls.scrolledPanels, [testCase.panelId], testCase.type);
        assert.equal(scenario.modal.isOpen, true, testCase.type);
        assert.equal(scenario.modal.closeCalls, 0, testCase.type);
      } finally {
        if (previousDocument === undefined) delete runtimeGlobal.document;
        else runtimeGlobal.document = previousDocument;
      }
    }
  });

  it('denies market and prediction selections when their visible panel target disappears', () => {
    const scenario = makeScenario([]);
    delete scenario.manager.searchSelection.scrollToPanel;
    const runtimeGlobal = globalThis as unknown as {
      document?: { querySelector: () => null };
    };
    const previousDocument = runtimeGlobal.document;
    runtimeGlobal.document = { querySelector: () => null };

    try {
      assert.equal(scenario.manager.searchSelection.handleSearchResult(
        resultMatch('market', 'market-1', 'Market', {}).result,
      ), false);
      assert.equal(scenario.manager.searchSelection.handleSearchResult(
        resultMatch('prediction', 'prediction-1', 'Prediction', {}).result,
      ), false);
    } finally {
      if (previousDocument === undefined) delete runtimeGlobal.document;
      else runtimeGlobal.document = previousDocument;
    }
  });

  it('cancels delayed programmatic selection work on destroy', async () => {
    const scenario = makeScenario([
      resultMatch('hotspot', 'stale-hotspot', 'Stale hotspot', { id: 'stale-hotspot' }),
    ]);
    scenario.runtime.deferTimers = true;
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);

    let openSettled = false;
    const pendingOpen = scenario.manager.openSearchResult(response.results[0].key)
      .then((result: unknown) => {
        openSettled = true;
        return result;
      });
    await Promise.resolve();
    assert.equal(scenario.runtime.pendingTimers.size, 1);
    assert.equal(openSettled, false, 'scheduled map work must keep the opener pending');
    scenario.manager.destroy();
    assert.deepEqual(await pendingOpen, {
      ok: false,
      status: 'denied',
      reason: 'search_state_changed',
    });
    flushTimers(scenario.runtime);

    assert.deepEqual(scenario.calls.hotspotIds, []);
    assert.deepEqual(scenario.calls.views, []);
    assert.equal(scenario.modal.cancelCalls, 1);
  });

  it('re-resolves a refreshed target and dispatches its fresh non-indexed payload', async () => {
    const oldMatch = resultMatch(
      'country',
      'XZ',
      'Example Republic',
      { code: 'XZ', name: 'Old display name' },
      'CII: 42',
    );
    const freshMatch = resultMatch(
      'country',
      'XZ',
      'Example Republic',
      { code: 'XZ', name: 'Fresh display name' },
      'CII: 42',
    );
    const scenario = makeScenario([oldMatch]);
    scenario.state.onUpdate = (count) => {
      if (count === 2) {
        scenario.modal.matches = [freshMatch];
      }
    };

    const { opened } = await searchThenOpen(scenario);
    assert.deepEqual(opened, { ok: true, status: 'opened', type: 'country' });
    assert.deepEqual(summarizeCountryBriefs(scenario.calls.countryBriefs), [[
      'XZ',
      'Fresh display name',
      { trackDetailedAnalytics: false, hasSignal: true },
    ]]);
    assert.deepEqual(
      scenario.runtime.detailedCountryAnalytics,
      [],
      'agent selection must suppress detailed country analytics',
    );
  });

  it('keeps the latest aircraft snapshot and republishes it on premium restoration', () => {
    const scenario = makeScenario([]);
    scenario.manager.observeSecurityContext();

    scenario.runtime.premium = false;
    scenario.runtime.pro = false;
    for (const listener of scenario.runtime.entitlementListeners) listener();

    scenario.manager.updateFlightSource([{
      icao24: 'abc123',
      callsign: 'AB123',
      lat: 1,
      lon: 2,
      altitudeFt: 30_000,
      groundSpeedKts: 450,
      observedAt: Date.now(),
      onGround: false,
    }], [], Date.now());

    scenario.runtime.premium = true;
    scenario.runtime.pro = true;
    for (const listener of scenario.runtime.entitlementListeners) listener();

    assert.equal(scenario.modal.matches[0]?.result.type, 'flight');
    assert.equal(scenario.modal.matches[0]?.result.id, 'abc123');
  });

  it('uses the live callsign fallback for programmatic search', async () => {
    const scenario = makeScenario([]);
    scenario.modal.flightCallsign = 'AB123';

    const response = await scenario.manager.searchDashboard('flight ab123', 'signals', 10);

    assert.deepEqual(scenario.runtime.liveFlightQueries, ['AB123']);
    assert.equal(response.results[0]?.type, 'flight');
    assert.equal(response.results[0]?.title, 'AB123');
  });

  it('passes caller cancellation to the live callsign transport', async () => {
    const scenario = makeScenario([]);
    scenario.runtime.liveFlightPending = true;
    const controller = new AbortController();
    const pending = scenario.manager.fetchAndPublishLiveFlight(
      'AB123',
      scenario.manager.liveFlightLookupGeneration,
      controller.signal,
    );
    await Promise.resolve();

    assert.deepEqual(scenario.runtime.liveFlightQueries, ['AB123']);
    assert.equal(scenario.runtime.liveFlightSignals[0], controller.signal);

    controller.abort();
    scenario.runtime.releaseLiveFlight?.();
    await assert.rejects(pending, (error) => (
      error instanceof Error && error.name === 'AbortError'
    ));
  });

  it('bounds a hung live callsign lookup before returning search results', async () => {
    const scenario = makeScenario([]);
    scenario.modal.flightCallsign = 'AB123';
    scenario.runtime.liveFlightPending = true;
    scenario.manager.constructor.SEARCH_INDEX_READY_TIMEOUT_MS = 20;

    const response = await withTimeout(
      scenario.manager.searchDashboard('flight ab123', 'signals', 10),
      250,
      'search-dashboard-test',
    );

    assert.deepEqual(scenario.runtime.liveFlightQueries, ['AB123']);
    assert.deepEqual(response.results, []);

    scenario.runtime.releaseLiveFlight?.();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(
      scenario.modal.matches,
      [],
      'a timed-out live lookup must not mutate the shared flight index later',
    );
  });

  it('cancels a delayed agent hotspot when a human command takes authority', async () => {
    const scenario = makeScenario([
      resultMatch('hotspot', 'agent-hotspot', 'Agent hotspot', { id: 'agent-hotspot' }),
    ]);
    scenario.runtime.deferTimers = true;

    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    const pendingAgentOpen = scenario.manager.openSearchResult(key);
    await Promise.resolve();
    assert.ok(scenario.runtime.pendingTimers.size > 0, 'agent hotspot should be awaiting its commit timer');

    assert.equal(
      scenario.manager.searchSelection.handleCommand(
        commandMatch('time:week', 'time', 'Past week').command,
      ),
      true,
    );
    flushTimers(scenario.runtime);

    assert.deepEqual(await pendingAgentOpen, {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
    assert.deepEqual(scenario.calls.hotspotIds, [], 'superseded agent timer must not mutate the map');
    assert.deepEqual(scenario.calls.timeRanges, ['week'], 'the human command remains authoritative');
  });

  it('lets a human country choice supersede an in-flight agent country presentation', async () => {
    const agentMatch = resultMatch(
      'country',
      'US',
      'United States',
      { code: 'US', name: 'United States' },
    );
    const humanMatch = resultMatch(
      'country',
      'CA',
      'Canada',
      { code: 'CA', name: 'Canada' },
    );
    const scenario = makeScenario([agentMatch]);
    let resolveAgentSelection!: (opened: boolean) => void;
    let agentSignal: AbortSignal | undefined;
    let selectionCount = 0;
    scenario.manager.callbacks.openCountryBriefByCode = (
      code: string,
      name: string,
      options?: { trackDetailedAnalytics?: boolean; signal?: AbortSignal },
    ) => {
      scenario.calls.countryBriefs.push([code, name, options]);
      selectionCount += 1;
      if (selectionCount === 1) {
        agentSignal = options?.signal;
        return new Promise<boolean>((resolve) => {
          resolveAgentSelection = resolve;
        });
      }
      return true;
    };

    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    const pendingAgentOpen = scenario.manager.openSearchResult(key);
    assert.equal(scenario.calls.countryBriefs.length, 1, 'agent selection should be awaiting presentation');

    assert.equal(scenario.manager.searchSelection.handleSearchResult(humanMatch.result), true);
    assert.equal(agentSignal?.aborted, true, 'human selection must abort the older agent presentation');
    assert.deepEqual(scenario.runtime.detailedCountryAnalytics, [[
      'CA',
      'Canada',
      'search',
    ]]);
    assert.deepEqual(summarizeCountryBriefs(scenario.calls.countryBriefs), [
      ['US', 'United States', { trackDetailedAnalytics: false, hasSignal: true }],
      ['CA', 'Canada', { trackDetailedAnalytics: true }],
    ]);

    resolveAgentSelection(true);
    assert.deepEqual(await pendingAgentOpen, {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
  });

  it('keeps a key valid across a benign index refresh', async () => {
    const match = resultMatch(
      'country',
      'XZ',
      'Example Republic',
      { code: 'XZ', name: 'Example Republic' },
      'CII: 42',
    );
    const scenario = makeScenario([match]);
    scenario.state.onUpdate = (count) => {
      if (count === 2) scenario.modal.revision += 1;
    };

    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    assert.deepEqual(await scenario.manager.openSearchResult(key), {
      ok: true,
      status: 'opened',
      type: 'country',
    });
    assert.equal(scenario.calls.countryBriefs.length, 1);
  });

  it('does not consume a map-target key while the renderer is still becoming ready', async () => {
    const scenario = makeScenario([
      resultMatch('pipeline', 'pipe-1', 'Needle pipeline', { id: 'pipe-1' }),
    ]);
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);

    let releaseReady!: () => void;
    const pendingOpen = scenario.manager.openSearchResult(key, () => new Promise<void>((resolve) => {
      releaseReady = resolve;
    }));
    await Promise.resolve();
    scenario.modal.revision += 1;
    releaseReady();
    assert.deepEqual(await pendingOpen, {
      ok: true,
      status: 'opened',
      type: 'pipeline',
    });
    assert.deepEqual(scenario.calls.pipelineIds, ['pipe-1']);
  });

  it('waits for async source hydration before issuing capabilities', async () => {
    const match = resultMatch(
      'country',
      'XZ',
      'Example Republic',
      { code: 'XZ', name: 'Example Republic' },
    );
    const scenario = makeScenario([match]);
    let releaseHydration!: () => void;
    scenario.manager.searchIndexReady = new Promise<void>((resolve) => {
      releaseHydration = resolve;
    });
    let settled = false;
    const pendingSearch = scenario.manager.searchDashboard('needle', 'all', 10)
      .then((response: unknown) => {
        settled = true;
        return response;
      });
    await Promise.resolve();
    assert.equal(settled, false);
    releaseHydration();
    const response = await pendingSearch;
    const key = (response as { results: Array<{ key: string }> }).results[0]?.key;
    assert.ok(key);
    const opened = await scenario.manager.openSearchResult(key);
    assert.deepEqual(opened, { ok: true, status: 'opened', type: 'country' });
    assert.equal(scenario.calls.countryBriefs.length, 1);
  });

  it('denies without selection when destroyed during renderer readiness', async () => {
    const scenario = makeScenario([
      resultMatch('pipeline', 'pipe-1', 'Needle pipeline', { id: 'pipe-1' }),
    ]);
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);

    const opened = await scenario.manager.openSearchResult(key, async () => {
      scenario.manager.destroy();
    });
    assert.deepEqual(opened, {
      ok: false,
      status: 'denied',
      reason: 'search_state_changed',
    });
    assert.deepEqual(scenario.calls.pipelineIds, []);
  });

  it('denies a key when an index revision removes its logical target', async () => {
    const scenario = makeScenario([
      resultMatch('hotspot', 'removed', 'Removed hotspot', { id: 'removed' }),
    ]);
    scenario.state.onUpdate = (count) => {
      if (count === 2) {
        scenario.modal.revision += 1;
        scenario.modal.matches = [];
      }
    };

    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    assert.deepEqual(await scenario.manager.openSearchResult(key), {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_available',
    });
    assert.deepEqual(scenario.calls.hotspotIds, []);
  });

  it('invalidates capabilities across an A -> signed-out -> A security-context cycle', async () => {
    const scenario = makeScenario([
      resultMatch('country', 'US', 'United States', { code: 'US', name: 'United States' }),
    ]);
    scenario.manager.observeSecurityContext();
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);

    scenario.runtime.auth = {};
    scenario.runtime.premium = false;
    for (const listener of scenario.runtime.authListeners) listener();
    scenario.runtime.auth = { user: { id: 'user-a', role: 'pro' } };
    scenario.runtime.premium = true;
    for (const listener of scenario.runtime.authListeners) listener();

    assert.deepEqual(await scenario.manager.openSearchResult(key), {
      ok: false,
      status: 'denied',
      reason: 'invalid_or_expired_key',
    });
    assert.ok(scenario.modal.clearedSources.includes('flight'));
    assert.deepEqual(scenario.calls.countryBriefs, []);
    scenario.manager.destroy();
  });

  it('invalidates capabilities across a same-user entitlement downgrade and restoration', async () => {
    const scenario = makeScenario([
      resultMatch('country', 'US', 'United States', { code: 'US', name: 'United States' }),
    ]);
    scenario.manager.observeSecurityContext();
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);

    scenario.runtime.premium = false;
    scenario.runtime.pro = false;
    for (const listener of scenario.runtime.entitlementListeners) listener();
    scenario.runtime.premium = true;
    scenario.runtime.pro = true;
    for (const listener of scenario.runtime.entitlementListeners) listener();

    assert.deepEqual(await scenario.manager.openSearchResult(key), {
      ok: false,
      status: 'denied',
      reason: 'invalid_or_expired_key',
    });
    assert.deepEqual(scenario.calls.countryBriefs, []);
    scenario.manager.destroy();
  });

  it('revalidates executability after a renderer flip', async () => {
    const scenario = makeScenario([
      resultMatch('pipeline', 'pipe-1', 'Needle pipeline', { id: 'pipe-1' }),
    ]);
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    assert.equal(response.results[0]?.executable, true);
    const key = response.results[0]?.key;
    assert.ok(key);

    scenario.state.globe = true;
    let readinessCalls = 0;
    assert.deepEqual(await scenario.manager.openSearchResult(key, async () => {
      readinessCalls += 1;
    }), {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
    assert.equal(readinessCalls, 0, 'a denied key must not wake the deferred renderer');
    assert.deepEqual(scenario.calls.layers, []);
    assert.deepEqual(scenario.calls.pipelineIds, []);
  });

  it('revalidates renderer compatibility at the delayed mutation boundary', async () => {
    const scenario = makeScenario([
      resultMatch('pipeline', 'pipe-delayed', 'Delayed pipeline', { id: 'pipe-delayed' }),
    ]);
    scenario.runtime.deferTimers = true;
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    const pendingOpen = scenario.manager.openSearchResult(key);
    await Promise.resolve();
    assert.equal(scenario.runtime.pendingTimers.size, 1);

    scenario.state.globe = true;
    flushTimers(scenario.runtime);
    assert.deepEqual(await pendingOpen, {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
    assert.deepEqual(scenario.calls.layers, []);
    assert.deepEqual(scenario.calls.pipelineIds, []);
    assert.deepEqual(scenario.calls.views, []);
  });

  it('denies a delayed selection removed from the live search index before commit', async () => {
    const scenario = makeScenario([
      resultMatch('hotspot', 'removed-hotspot', 'Removed hotspot', { id: 'removed-hotspot' }),
    ]);
    scenario.runtime.deferTimers = true;
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    const pendingOpen = scenario.manager.openSearchResult(key);
    await Promise.resolve();
    assert.equal(scenario.runtime.pendingTimers.size, 1);

    scenario.modal.matches = [];
    flushTimers(scenario.runtime);
    assert.deepEqual(await pendingOpen, {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
    assert.deepEqual(scenario.calls.hotspotIds, []);
    assert.deepEqual(scenario.calls.views, []);
  });

  it('dispatches refreshed same-identity flight coordinates at the delayed commit', async () => {
    const staleFlight = resultMatch(
      'flight',
      'abc123',
      'NEEDLE1',
      { kind: 'adsb', lat: 1, lon: 2, layer: 'flights' },
    );
    const freshFlight = resultMatch(
      'flight',
      'abc123',
      'NEEDLE1',
      { kind: 'adsb', lat: 33, lon: 44, layer: 'flights' },
    );
    const scenario = makeScenario([staleFlight]);
    scenario.runtime.deferTimers = true;
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    const pendingOpen = scenario.manager.openSearchResult(key);
    await Promise.resolve();
    assert.equal(scenario.runtime.pendingTimers.size, 1);

    scenario.modal.revision += 1;
    scenario.modal.matches = [freshFlight];
    flushTimers(scenario.runtime);

    assert.deepEqual(await pendingOpen, {
      ok: true,
      status: 'opened',
      type: 'flight',
    });
    assert.deepEqual(scenario.calls.centers, [[33, 44, 9]]);
    assert.deepEqual(scenario.calls.layers, ['flights']);
  });

  it('denies cached civilian aircraft after a globe switch while retaining military aircraft', async () => {
    const civilian = resultMatch(
      'flight',
      'civilian-1',
      'NEEDLE1',
      { kind: 'adsb', lat: 1, lon: 2, layer: 'flights' },
    );
    const military = resultMatch(
      'flight',
      'military-1',
      'NEEDLE2',
      { kind: 'military', lat: 3, lon: 4, layer: 'military' },
    );
    const scenario = makeScenario([civilian, military]);
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    assert.deepEqual(response.results.map((result: { executable: boolean }) => result.executable), [
      true,
      true,
    ]);

    scenario.state.globe = true;
    let readinessCalls = 0;
    assert.deepEqual(await scenario.manager.openSearchResult(
      response.results[0].key,
      async () => { readinessCalls += 1; },
    ), {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
    assert.equal(readinessCalls, 0, 'an invisible civilian target must not wake the renderer');

    assert.deepEqual(await scenario.manager.openSearchResult(
      response.results[1].key,
      async () => { readinessCalls += 1; },
    ), {
      ok: true,
      status: 'opened',
      type: 'flight',
    });
    assert.equal(readinessCalls, 1);
    assert.deepEqual(scenario.calls.layers, ['military']);
    assert.deepEqual(scenario.calls.centers, [[3, 4, 9]]);
  });

  it('denies tech-event centering after a globe switch', async () => {
    const scenario = makeScenario([
      resultMatch(
        'techevent',
        'event-1',
        'Needle tech event',
        { id: 'event-1', lat: 37.8, lng: -122.4 },
      ),
    ], 'tech');
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    assert.equal(response.results[0]?.executable, true);

    scenario.state.globe = true;
    assert.deepEqual(await scenario.manager.openSearchResult(response.results[0].key), {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
    assert.deepEqual(scenario.calls.layers, []);
    assert.deepEqual(scenario.calls.centers, []);
  });

  it('denies globe time commands that only mutate hidden renderer state', async () => {
    const scenario = makeScenario([
      commandMatch('time:24h', 'actions', 'Last 24 hours'),
    ]);
    scenario.state.globe = true;
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    assert.equal(response.results[0]?.executable, false);
    const key = response.results[0]?.key;
    assert.ok(key);
    assert.deepEqual(await scenario.manager.openSearchResult(key, async () => {}), {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
    assert.deepEqual(scenario.calls.timeRanges, []);
  });

  it('denies news retained only by a disabled hidden panel', () => {
    const news = resultMatch('news', 'story', 'Needle story', { link: 'https://example.test/story' });
    const scenario = makeScenario([news]);
    scenario.ctx.newsPanels = {
      politics: { hasNewsItem: () => true },
    };
    scenario.ctx.panelSettings.politics = { enabled: false };
    assert.equal(scenario.manager.isSearchResultExecutable(news.result), false);
  });

  it('opens a duplicate news link in an enabled live panel instead of a disabled first match', async () => {
    const link = 'https://example.test/duplicate-story';
    const news = resultMatch('news', 'duplicate-story', 'Needle story', { link });
    const scenario = makeScenario([news]);
    const itemScrolls: string[] = [];
    scenario.ctx.newsPanels = {
      disabled: {
        hasNewsItem: () => true,
        scrollToNewsItem: () => itemScrolls.push('disabled'),
      },
      enabled: {
        hasNewsItem: () => true,
        scrollToNewsItem: () => itemScrolls.push('enabled'),
      },
    };
    scenario.ctx.panelSettings.disabled = { enabled: false };
    scenario.ctx.panelSettings.enabled = { enabled: true };
    scenario.ctx.panels.enabled = {
      getElement: () => ({ isConnected: true }),
    };

    const { opened } = await searchThenOpen(scenario);

    assert.deepEqual(opened, { ok: true, status: 'opened', type: 'news' });
    assert.deepEqual(scenario.calls.scrolledPanels, ['enabled']);
    assert.deepEqual(itemScrolls, ['enabled']);
  });

  it('does not report a country opened when the lazy brief surface fails', async () => {
    const scenario = makeScenario([
      resultMatch('country', 'US', 'United States', { code: 'US', name: 'United States' }),
    ]);
    scenario.manager.callbacks.openCountryBriefByCode = async () => false;

    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    assert.deepEqual(await scenario.manager.openSearchResult(key), {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
    assert.deepEqual(
      scenario.runtime.detailedCountryAnalytics,
      [],
      'a failed country open must not emit detailed country analytics',
    );
  });

  it('treats a superseded country brief as not executable and keeps analytics empty', async () => {
    const scenario = makeScenario([
      resultMatch('country', 'US', 'United States', { code: 'US', name: 'United States' }),
    ]);
    scenario.manager.callbacks.openCountryBriefByCode = (
      code: string,
      name: string,
      options?: { trackDetailedAnalytics?: boolean; signal?: AbortSignal },
    ) => {
      scenario.calls.countryBriefs.push([code, name, options]);
      // Mirrors App.ts finish(false) when the requested page was superseded.
      return Promise.resolve(false);
    };

    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    assert.deepEqual(await scenario.manager.openSearchResult(key), {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
    assert.deepEqual(summarizeCountryBriefs(scenario.calls.countryBriefs), [[
      'US',
      'United States',
      { trackDetailedAnalytics: false, hasSignal: true },
    ]]);
    assert.deepEqual(scenario.runtime.detailedCountryAnalytics, []);
  });

  it('keeps an open palette visible when a country command fails to present', async () => {
    const scenario = makeScenario([
      commandMatch('country:US', 'actions', 'United States'),
    ]);
    scenario.manager.callbacks.openCountryBriefByCode = async () => false;

    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    scenario.modal.open();
    assert.deepEqual(await scenario.manager.openSearchResult(key), {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
    assert.equal(scenario.modal.isOpen, true);
    assert.equal(scenario.modal.closeCalls, 0);
    assert.deepEqual(await scenario.manager.openSearchResult(key), {
      ok: false,
      status: 'denied',
      reason: 'invalid_or_expired_key',
    }, 'a failed entered selection must remain one-use');
  });

  it('keeps human-only commands visible while denying agent no-op or unsafe paths', () => {
    const scenario = makeScenario([]);
    for (const action of ['settings', 'route-explorer', 'refresh', 'fullscreen']) {
      const command = commandMatch(`view:${action}`, 'view', action).command;
      assert.equal(scenario.manager.isModalCommandVisible(command), true, action);
      assert.equal(scenario.manager.isCommandExecutable(command), false, action);
    }

    const themeCommand = commandMatch('view:dark', 'view', 'dark').command;
    assert.equal(scenario.manager.isModalCommandVisible(themeCommand), true);
    assert.equal(scenario.manager.isCommandExecutable(themeCommand), true);

    const unloadedCountryMap = commandMatch('country-map:US', 'country-map', 'United States').command;
    assert.equal(scenario.manager.isModalCommandVisible(unloadedCountryMap), false);
    assert.equal(scenario.manager.isCommandExecutable(unloadedCountryMap), false);
  });

  it('reports successful synchronous healing of stale locked resilience state for free users', async () => {
    for (const command of [
      commandMatch('layer:resilienceScore', 'layers', 'Resilience layer'),
      commandMatch('view:resilience', 'view', 'Resilience view'),
    ]) {
      if (command.kind !== 'command') throw new Error('expected command match');
      const commandId = command.command.id;
      const scenario = makeScenario([command]);
      scenario.runtime.auth = {};
      scenario.runtime.premium = false;
      scenario.runtime.pro = false;
      scenario.ctx.mapLayers.resilienceScore = true;

      const response = await scenario.manager.searchDashboard('needle', 'all', 10);
      const issued = response.results[0];
      assert.ok(issued);
      assert.equal(issued.executable, true, `${commandId} must remain available to turn off`);
      assert.deepEqual(await scenario.manager.openSearchResult(issued.key), {
        ok: true,
        status: 'opened',
        type: 'command',
      }, commandId);
      assert.equal(
        scenario.ctx.mapLayers.resilienceScore,
        false,
        `${commandId} must heal stale enabled state`,
      );
      assert.equal(scenario.modal.closeCalls, 1, commandId);
    }
  });

  it('does not treat an incidental preset overlap as a meaningful agent action', () => {
    const finance = makeScenario([], 'finance');
    const militaryPreset = commandMatch('layers:military', 'layers', 'Military layers').command;
    assert.equal(finance.manager.isModalCommandVisible(militaryPreset), true);
    assert.equal(finance.manager.isCommandExecutable(militaryPreset), false);

    const full = makeScenario([], 'full');
    assert.equal(full.manager.isCommandExecutable(militaryPreset), true);
  });

  it('routes country, panel, map, infrastructure, finance, and command selections through shared handlers', async () => {
    const cases: Array<{
      label: string;
      variant?: Variant;
      match: SearchMatch;
      verify(scenario: Scenario): void;
    }> = [
      {
        label: 'country',
        match: resultMatch('country', 'US', 'United States', { code: 'US', name: 'United States' }),
        verify: ({ calls, runtime }) => {
          assert.deepEqual(summarizeCountryBriefs(calls.countryBriefs), [[
            'US',
            'United States',
            { trackDetailedAnalytics: false, hasSignal: true },
          ]]);
          assert.deepEqual(runtime.detailedCountryAnalytics, []);
        },
      },
      {
        label: 'panel',
        match: commandMatch('panel:test-panel', 'panels', 'Test panel'),
        verify: ({ calls }) => {
          assert.deepEqual(calls.enabledPanels, [[
            'test-panel',
            { trackDetailedAnalytics: false },
          ]]);
          assert.deepEqual(calls.scrolledPanels, ['test-panel']);
        },
      },
      {
        label: 'hotspot',
        match: resultMatch('hotspot', 'hs-1', 'Needle hotspot', { id: 'hs-1' }),
        verify: ({ calls }) => assert.deepEqual(calls.hotspotIds, ['hs-1']),
      },
      {
        label: 'conflict',
        match: resultMatch('conflict', 'conflict-1', 'Needle conflict', { id: 'conflict-1' }),
        verify: ({ calls }) => assert.deepEqual(calls.conflictIds, ['conflict-1']),
      },
      {
        label: 'infrastructure',
        match: resultMatch('pipeline', 'pipe-1', 'Needle pipeline', { id: 'pipe-1' }),
        verify: ({ calls }) => {
          assert.ok(calls.layers.includes('pipelines'));
          assert.deepEqual(calls.pipelineIds, ['pipe-1']);
        },
      },
      {
        label: 'finance',
        variant: 'finance',
        match: resultMatch(
          'exchange',
          'xnas',
          'Needle exchange',
          { id: 'xnas', lat: 40.7, lon: -74 },
        ),
        verify: ({ calls }) => {
          assert.ok(calls.layers.includes('stockExchanges'));
          assert.deepEqual(calls.centers, [[40.7, -74, 4]]);
        },
      },
      {
        label: 'tech event',
        variant: 'tech',
        match: resultMatch(
          'techevent',
          'event-1',
          'Needle tech event',
          { id: 'event-1', lat: 37.8, lng: -122.4 },
        ),
        verify: ({ calls }) => {
          assert.ok(calls.layers.includes('techEvents'));
          assert.deepEqual(calls.centers, [[37.8, -122.4, 5]]);
        },
      },
      {
        label: 'command',
        match: commandMatch('time:7d', 'actions', 'Last seven days'),
        verify: ({ calls }) => assert.deepEqual(calls.timeRanges, ['7d']),
      },
    ];

    for (const testCase of cases) {
      const scenario = makeScenario([testCase.match], testCase.variant);
      const { opened } = await searchThenOpen(scenario);
      assert.deepEqual(
        opened,
        {
          ok: true,
          status: 'opened',
          type: testCase.match.kind === 'command' ? 'command' : testCase.match.result.type,
        },
        testCase.label,
      );
      testCase.verify(scenario);
      assert.equal(scenario.modal.openCalls, 0, `${testCase.label} must not open CMD+K`);
    }
  });

  it('keeps same-id flight capabilities bound to their exact civilian or military target', async () => {
    const civilian = resultMatch(
      'flight',
      'abc123',
      'NEEDLE1',
      { kind: 'adsb', lat: 1, lon: 2, layer: 'flights' },
    );
    const military = resultMatch(
      'flight',
      'abc123',
      'NEEDLE1',
      { kind: 'military', lat: 3, lon: 4, layer: 'military' },
    );
    assert.notEqual(searchMatchIdentity(civilian), searchMatchIdentity(military));
    const scenario = makeScenario([civilian, military]);
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    assert.equal(response.resultCount, 2);

    assert.deepEqual(
      await scenario.manager.openSearchResult(response.results[0].key, async () => {}),
      { ok: true, status: 'opened', type: 'flight' },
    );
    assert.deepEqual(
      await scenario.manager.openSearchResult(response.results[1].key, async () => {}),
      { ok: true, status: 'opened', type: 'flight' },
    );
    assert.deepEqual(scenario.calls.layers, ['flights', 'military']);
    assert.deepEqual(scenario.calls.centers, [[1, 2, 9], [3, 4, 9]]);
  });

  it('clears an expired live-flight source before search or selection', () => {
    const scenario = makeScenario([]);
    scenario.manager.flightSourceExpiresAt = Date.now() - 1;
    scenario.manager.updateSearchIndex = undefined;

    // Run the production refresh method now that the narrow harness state is
    // configured. Unrelated index helpers are replaced with no-ops.
    scenario.manager.syncPanelSearchIndex = () => {};
    scenario.manager.buildCountrySearchItems = () => [];
    scenario.ctx.allNews = [];
    scenario.ctx.latestPredictions = [];
    scenario.ctx.latestMarkets = [];
    const productionUpdate = Object.getPrototypeOf(scenario.manager).updateSearchIndex;
    productionUpdate.call(scenario.manager, { updateVisibleMetrics: false });

    assert.ok(scenario.modal.clearedSources.includes('flight'));
    assert.equal(scenario.manager.flightSourceExpiresAt, 0);
  });

  it('populates flight search for every premium access path, including runtime API keys', () => {
    const scenario = makeScenario([]);
    scenario.runtime.pro = false;
    scenario.runtime.premium = true;

    scenario.manager.updateFlightSource([{
      icao24: 'abc123',
      callsign: 'NEEDLE1',
      altitudeFt: 30_000,
      groundSpeedKts: 420,
      onGround: false,
      lat: 1,
      lon: 2,
    }], [], Date.now());

    assert.ok(scenario.manager.flightSourceExpiresAt > Date.now());
    assert.equal(scenario.modal.clearedSources.includes('flight'), false);
    const flightSearchWiring = managerSource.slice(
      managerSource.indexOf("setOnFlightSearch((callsign)"),
      managerSource.indexOf("private async registerBaseSearchSource"),
    );
    assert.match(flightSearchWiring, /if \(!hasPremiumAccess\(getAuthState\(\)\)\) return;/);
    assert.doesNotMatch(flightSearchWiring, /if \(!isProUser\(\)/);
  });

  it('merges a live callsign hit without dropping viewport or military flights', async () => {
    const scenario = makeScenario([]);
    const now = Date.now();
    scenario.manager.updateFlightSource([
      {
        icao24: 'stale123',
        callsign: 'LIVE1',
        lat: 10,
        lon: 11,
        altitudeFt: 20_000,
        groundSpeedKts: 300,
        observedAt: now,
        onGround: false,
      },
      {
        icao24: 'keep123',
        callsign: 'KEEP1',
        lat: 12,
        lon: 13,
        altitudeFt: 25_000,
        groundSpeedKts: 350,
        observedAt: now,
        onGround: false,
      },
    ], [{
      id: 'military-1',
      callsign: 'MIL1',
      hexCode: 'mil123',
      aircraftType: 'fighter',
      lat: 14,
      lon: 15,
      altitude: 30_000,
      onGround: false,
      lastSeen: new Date(now),
    }], now);

    await scenario.manager.fetchAndPublishLiveFlight('LIVE1');

    assert.deepEqual(scenario.runtime.liveFlightQueries, ['LIVE1']);
    assert.deepEqual(
      scenario.modal.matches.map((match) => match.kind === 'result'
        ? [match.result.id, match.result.data.kind]
        : null),
      [
        ['keep123', 'adsb'],
        ['abc123', 'adsb'],
        ['mil123', 'military'],
      ],
    );

    scenario.manager.updateFlightSource([{
      icao24: 'keep123',
      callsign: 'KEEP1',
      lat: 12,
      lon: 13,
      altitudeFt: 25_000,
      groundSpeedKts: 350,
      observedAt: now,
      onGround: false,
    }], [{
      id: 'military-1',
      callsign: 'MIL1',
      hexCode: 'mil123',
      aircraftType: 'fighter',
      lat: 14,
      lon: 15,
      altitude: 30_000,
      onGround: false,
      lastSeen: new Date(now),
    }], now);

    assert.deepEqual(
      scenario.modal.matches.map((match) => match.kind === 'result'
        ? [match.result.id, match.result.data.kind]
        : null),
      [
        ['keep123', 'adsb'],
        ['abc123', 'adsb'],
        ['mil123', 'military'],
      ],
      'a later viewport snapshot must keep the TTL-bounded live lookup',
    );
  });

  it('ignores a late DeckGL flight publish after destroy', () => {
    const scenario = makeScenario([]);
    scenario.manager.destroy();
    scenario.manager.updateFlightSource([{
      icao24: 'late123',
      callsign: 'LATE1',
      lat: 1,
      lon: 2,
      altitudeFt: 30_000,
      groundSpeedKts: 400,
      observedAt: Date.now(),
      onGround: false,
    }], [], Date.now());

    assert.deepEqual(scenario.modal.matches, []);
    assert.equal(scenario.manager.flightSearchItems.length, 0);
  });

  it('aborts and denies an in-flight country presentation after a security-context change', async () => {
    const scenario = makeScenario([
      resultMatch('country', 'US', 'United States', { code: 'US', name: 'United States' }),
    ]);
    scenario.manager.observeSecurityContext();
    let resolveBrief!: (opened: boolean) => void;
    let presentationSignal: AbortSignal | undefined;
    scenario.manager.callbacks.openCountryBriefByCode = (
      code: string,
      name: string,
      options?: { trackDetailedAnalytics?: boolean; signal?: AbortSignal },
    ) => {
      scenario.calls.countryBriefs.push([code, name, options]);
      presentationSignal = options?.signal;
      return new Promise<boolean>((resolve) => {
        resolveBrief = resolve;
      });
    };

    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    const pendingOpen = scenario.manager.openSearchResult(key);
    await Promise.resolve();
    assert.equal(scenario.calls.countryBriefs.length, 1);

    scenario.runtime.auth = {};
    scenario.runtime.premium = false;
    for (const listener of scenario.runtime.authListeners) listener();
    assert.equal(presentationSignal?.aborted, true);
    resolveBrief(true);

    assert.deepEqual(await pendingOpen, {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
    assert.deepEqual(scenario.runtime.detailedCountryAnalytics, []);
  });

  it('resolves a desktop-issued key after the ranked window recaps', async () => {
    const matches = Array.from({ length: 8 }, (_, index) => resultMatch(
      'country',
      `C${index}`,
      `Country ${index}`,
      { code: `C${index}`, name: `Country ${index}` },
    ));
    const scenario = makeScenario(matches);
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const issued = response.results[response.results.length - 1];
    assert.ok(issued);
    scenario.modal.search = () => ({
      orderedMatches: matches.slice(0, 5),
      flightCallsign: null,
    });

    assert.deepEqual(await scenario.manager.openSearchResult(issued.key), {
      ok: true,
      status: 'opened',
      type: 'country',
    });
    assert.deepEqual(summarizeCountryBriefs(scenario.calls.countryBriefs), [[
      'C7',
      'Country 7',
      { trackDetailedAnalytics: false, hasSignal: true },
    ]]);
  });

  it('keeps the current flight index when optional live enrichment fails', async () => {
    const scenario = makeScenario([]);
    const now = Date.now();
    scenario.manager.updateFlightSource([], [{
      id: 'military-1',
      callsign: 'MIL1',
      hexCode: 'mil123',
      aircraftType: 'fighter',
      lat: 14,
      lon: 15,
      altitude: 30_000,
      onGround: false,
      lastSeen: new Date(now),
    }], now);
    scenario.runtime.liveFlightError = new Error('lookup failed');

    scenario.manager.handleLiveFlightSearch('FAIL1');
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(
      scenario.modal.matches.map((match) => match.kind === 'result' ? match.result.id : null),
      ['mil123'],
    );
    assert.equal(scenario.modal.clearedSources.includes('flight'), false);
  });

  it('uses the same premium policy for panel entitlement and free-cap bypass', () => {
    const scenario = makeScenario([
      commandMatch('panel:test-panel', 'panels', 'Needle panel'),
    ]);
    scenario.runtime.pro = false;
    scenario.runtime.premium = true;
    scenario.runtime.panelEntitled = true;

    assert.equal(scenario.manager.isCommandExecutable(
      commandMatch('panel:test-panel', 'panels').command,
    ), true);
  });

  it('enforces the six-variant entity visibility matrix without leaking foreign domains', () => {
    const probes: Record<string, SearchResult> = {
      country: {
        type: 'country', id: 'US', title: 'United States', data: { code: 'US', name: 'United States' },
      },
      hotspot: { type: 'hotspot', id: 'hs', title: 'Hotspot', data: { id: 'hs' } },
      pipeline: { type: 'pipeline', id: 'pipe', title: 'Pipeline', data: { id: 'pipe' } },
      techcompany: { type: 'techcompany', id: 'tech', title: 'Tech', data: { id: 'tech' } },
      exchange: { type: 'exchange', id: 'exchange', title: 'Exchange', data: { id: 'exchange' } },
      commodityhub: { type: 'commodityhub', id: 'hub', title: 'Hub', data: { id: 'hub' } },
    };
    const expected: Record<Variant, string[]> = {
      full: ['country', 'hotspot', 'pipeline'],
      tech: ['country', 'techcompany'],
      finance: ['country', 'pipeline', 'exchange', 'commodityhub'],
      happy: ['country'],
      commodity: ['country', 'pipeline', 'commodityhub'],
      energy: ['country', 'pipeline', 'commodityhub'],
    };

    for (const variant of Object.keys(expected) as Variant[]) {
      const scenario = makeScenario([], variant);
      const visible = Object.entries(probes)
        .filter(([, result]) => scenario.manager.isSearchResultVisible(result))
        .map(([name]) => name);
      assert.deepEqual(visible, expected[variant], variant);
      assert.equal(scenario.modal.openCalls, 0, variant);
    }
  });

  it('registers commodity hubs through the shared variant-layer policy', () => {
    const enabledVariants = (['full', 'tech', 'finance', 'happy', 'commodity', 'energy'] as Variant[])
      .filter((variant) => getAllowedLayerKeys(variant).has('commodityHubs'));
    assert.deepEqual(enabledVariants, ['finance', 'commodity', 'energy']);

    let commodityRegistration: ts.CallExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'registerSource'
        && ts.isStringLiteral(node.arguments[0])
        && node.arguments[0].text === 'commodityhub'
      ) {
        commodityRegistration = node;
      }
      ts.forEachChild(node, visit);
    };
    visit(managerNode);
    assert.ok(commodityRegistration, 'commodityhub source must be registered');

    let parent: ts.Node | undefined = commodityRegistration.parent;
    while (parent && !ts.isIfStatement(parent)) parent = parent.parent;
    assert.ok(parent && ts.isIfStatement(parent), 'commodityhub registration must be policy-gated');
    assert.match(
      parent.expression.getText(sourceFile),
      /getAllowedLayerKeys[\s\S]+?\.has\('commodityHubs'\)/,
    );
  });

  it('preloads military bases only for variants where base results are visible', () => {
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'registerBaseSearchSource'
      ) calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(managerNode);
    assert.equal(calls.length, 1);
    let parent: ts.Node | undefined = calls[0]?.parent;
    while (parent && !ts.isIfStatement(parent)) parent = parent.parent;
    assert.ok(parent && ts.isIfStatement(parent));
    assert.match(parent.expression.getText(sourceFile), /\.has\('bases'\)/);
    assert.deepEqual(
      (['full', 'tech', 'finance', 'happy', 'commodity', 'energy'] as Variant[])
        .filter((variant) => getAllowedLayerKeys(variant).has('bases')),
      ['full'],
    );
  });

  it('opens view-state results without a target signal and blocks persistent ones', async () => {
    const viewScenario = makeScenario([
      resultMatch('hotspot', 'view-hotspot', 'View hotspot', { id: 'view-hotspot' }),
    ]);
    const viewResponse = await viewScenario.manager.searchDashboard(
      'needle',
      'all',
      10,
      undefined,
    );
    assert.equal(viewResponse.results[0]?.executable, true);
    assert.deepEqual(
      await viewScenario.manager.openSearchResult(
        viewResponse.results[0]!.key,
        async () => {},
        undefined,
      ),
      { ok: true, status: 'opened', type: 'hotspot' },
    );
    assert.deepEqual(viewScenario.calls.hotspotIds, ['view-hotspot']);

    const layerScenario = makeScenario([
      commandMatch('layer:conflicts', 'layers', 'Toggle conflict zones'),
    ]);
    const layerResponse = await layerScenario.manager.searchDashboard(
      'needle',
      'all',
      10,
      undefined,
    );
    const layerKey = layerResponse.results[0]?.key;
    assert.ok(layerKey);
    assert.equal(layerResponse.results[0]?.executable, false);
    assert.deepEqual(
      await layerScenario.manager.openSearchResult(layerKey, async () => {}, undefined),
      {
        ok: false,
        status: 'denied',
        reason: 'target_cancellation_unsupported',
        message: WEBMCP_UNSUPPORTED_CANCELLATION_MESSAGE,
      },
    );
    assert.deepEqual(layerScenario.calls.layers, []);
    const capable = new AbortController();
    assert.deepEqual(
      await layerScenario.manager.openSearchResult(layerKey, async () => {}, capable.signal),
      { ok: true, status: 'opened', type: 'command' },
    );
    assert.deepEqual(layerScenario.calls.layers, ['conflicts']);
  });
});
