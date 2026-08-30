import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  WEBMCP_SPA_TOOL_NAMES,
} from '../src/config/webmcp.ts';
import {
  CANCELLATION_REQUIRED_WEBMCP_TOOLS,
  WEBMCP_TOOL_CANCELLATION_POLICY,
  registerWebMcpTools,
} from '../src/services/webmcp.ts';
import { waitForWebMcpUiReady } from '../src/app/webmcp-dashboard.ts';
import {
  FakeWebMcpModelContext,
  createFakeWebMcpRuntime,
} from './helpers/fake-webmcp-model-context.mjs';

const settlePromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

function deferred() {
  let resolve;
  const promise = new Promise((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

function createBindings(overrides = {}) {
  return {
    openCountryBriefByCode: async () => true,
    resolveCountryName: (code) => `Country ${code}`,
    openSearch: async () => true,
    getDashboardContext: async () => ({
      variant: 'full',
      map: {
        view: 'global',
        center: { lat: 0, lon: 0 },
        zoom: 2,
        timeRange: '7d',
        enabledLayers: [],
      },
      panels: { mounted: ['map'], enabled: ['map'] },
    }),
    listMapLayerCatalog: async () => ({
      variant: 'full',
      rendererKind: 'deck',
      enabledLayers: [],
      liveLayerKeys: ['conflicts', 'weather', 'hotspots'],
      hasPremium: false,
      deckGlActive: true,
    }),
    listDashboardPanels: async () => ({
      variant: 'full',
      total: 1,
      hasMore: false,
      nextCursor: null,
      panels: [{
        id: 'map',
        label: 'Map',
        category: 'core',
        variants: ['full'],
        enabled: true,
        mounted: true,
        entitled: true,
        available: true,
      }],
    }),
    switchMonitor: async (monitor) => ({
      ok: true,
      status: 'applied',
      destination: monitor,
      navigation: 'none',
      message: 'Already on that monitor.',
      context: {
        variant: monitor,
        map: {
          view: 'global',
          center: { lat: 0, lon: 0 },
          zoom: 2,
          timeRange: '7d',
          enabledLayers: [],
        },
        panels: { mounted: ['map'], enabled: ['map'] },
      },
    }),
    openSettings: async () => ({
      ok: true,
      status: 'applied',
      destination: 'settings',
      overlay: 'open',
      tab: 'settings',
      message: 'Opened settings.',
      context: {
        variant: 'full',
        map: {
          view: 'global',
          center: { lat: 0, lon: 0 },
          zoom: 2,
          timeRange: '7d',
          enabledLayers: [],
        },
        panels: { mounted: ['map'], enabled: ['map'] },
      },
    }),
    openAlerts: async () => ({
      ok: true,
      status: 'applied',
      destination: 'alerts',
      overlay: 'open',
      tab: 'notifications',
      message: 'Opened alerts.',
      context: {
        variant: 'full',
        map: {
          view: 'global',
          center: { lat: 0, lon: 0 },
          zoom: 2,
          timeRange: '7d',
          enabledLayers: [],
        },
        panels: { mounted: ['map'], enabled: ['map'] },
      },
    }),
    applyDashboardAction: async (action) => ({
      ok: true,
      status: 'applied',
      actionType: action.type,
      message: 'Applied dashboard action.',
      targets: [],
    }),
    searchDashboard: async (query) => ({
      queryLength: query.length,
      results: [],
      resultCount: 0,
      truncated: false,
    }),
    openSearchResult: async () => ({ ok: true, status: 'opened' }),
    setPanelEnabled: async () => ({
      ok: true,
      status: 'applied',
      panelId: 'giving',
      requestedEnabled: true,
      effectiveEnabled: true,
      changed: true,
      message: 'Panel enabled.',
    }),
    listMissionPresets: async () => ({
      ok: true,
      variant: 'full',
      activePresetId: null,
      presets: [],
      count: 0,
    }),
    applyMissionPreset: async () => ({
      ok: true,
      status: 'applied',
      presetId: 'supply-chain-risk',
      label: 'Supply-Chain Risk',
      changed: true,
      monitor: 'full',
      map: {
        view: 'global',
        zoom: 2.3,
        timeRange: '7d',
        enabledLayers: [],
      },
      panels: { enabled: [] },
      message: 'Applied.',
    }),
    openMissionPicker: async () => ({
      ok: true,
      status: 'applied',
      destination: 'mission_picker',
      overlay: 'open',
      message: 'Opened mission presets.',
      context: {
        variant: 'full',
        map: {
          view: 'global',
          center: { lat: 0, lon: 0 },
          zoom: 2,
          timeRange: '7d',
          enabledLayers: [],
        },
        panels: { mounted: ['map'], enabled: ['map'] },
      },
    }),
    applyDashboardTabAction: async (action) => (
      action.type === 'list'
        ? {
            activeTabId: 'tab-main01-abc123',
            tabs: [{ id: 'tab-main01-abc123', name: 'Main', active: true, canDelete: false }],
            tabCount: 1,
            tabsTruncated: false,
            canCreate: true,
            cap: null,
          }
        : {
            ok: true,
            status: 'applied',
            actionType: action.type,
            message: 'Applied dashboard tab action.',
            tabId: typeof action.tabId === 'string' ? action.tabId : 'tab-main01-abc123',
            name: typeof action.name === 'string' ? action.name : 'Main',
            activeTabId: typeof action.tabId === 'string' ? action.tabId : 'tab-main01-abc123',
          }
    ),

    getPanelLayout: async () => ({
      regions: {
        sidebar: { available: true, panelCount: 1 },
        bottom: { available: false, panelCount: 0 },
      },
      panels: [{
        id: 'giving',
        region: 'sidebar',
        index: 0,
        collapsed: false,
        fullscreen: false,
        collapsible: false,
        fullscreenCapable: false,
        fixed: false,
      }],
      panelCount: 1,
    }),
    setPanelCollapsed: async () => ({
      ok: true,
      status: 'applied',
      actionType: 'set_collapsed',
      panelId: 'live-news',
      requestedCollapsed: true,
      effectiveCollapsed: true,
      changed: true,
      message: 'Panel collapsed.',
      persisted: true,
    }),
    movePanel: async () => ({
      ok: true,
      status: 'applied',
      actionType: 'move',
      panelId: 'giving',
      region: 'sidebar',
      index: 0,
      changed: true,
      message: 'Moved panel.',
      persisted: true,
    }),
    setPanelFullscreen: async () => ({
      ok: true,
      status: 'applied',
      actionType: 'set_fullscreen',
      panelId: 'live-news',
      requestedFullscreen: true,
      effectiveFullscreen: true,
      changed: true,
      message: 'Panel entered fullscreen.',
    }),
    getAccessContext: async () => ({
      accountState: 'signed_out',
      clerk: 'unavailable',
      productTier: 'anonymous',
      capabilities: {
        premiumAccess: false,
        apiAccess: false,
        mcpAccess: false,
        dataExport: false,
      },
      limits: {
        enabledPanels: { used: 1, cap: 40 },
        dashboardTabs: { used: 1, cap: 3, canCreate: true },
      },
    }),
    openSignIn: async () => ({ ok: false, status: 'denied', reason: 'clerk_unavailable' }),
    ...overrides,
  };
}

function trackedRuntime(provider) {
  const events = [];
  const harness = createFakeWebMcpRuntime(
    provider,
    (event, data) => events.push({ event, data }),
  );
  return { ...harness, events };
}

async function executeRegistered(provider, name, inputJson = '{}', options = {}) {
  const descriptor = (await provider.getTools()).find((tool) => tool.name === name);
  assert.ok(descriptor, `missing registered WebMCP tool ${name}`);
  return provider.executeTool(descriptor, inputJson, options);
}

describe('WebMCP registry behavioral contract', () => {
  it('keeps unsupported and obsolete providers silent', async () => {
    for (const provider of [undefined, { provideContext() {} }]) {
      const harness = trackedRuntime(provider);
      const controller = registerWebMcpTools(createBindings(), harness.runtime);
      assert.ok(controller);
      harness.dispatchDocument('DOMContentLoaded');
      harness.dispatchWindow('load');
      await settlePromises();
      assert.deepEqual(harness.events, []);
      controller.abort();
    }
  });

  it('registers synchronously, exposes sorted serialized schemas, and executes registered tools', async () => {
    const provider = new FakeWebMcpModelContext({ supportsTargetExecutionSignal: true });
    const harness = trackedRuntime(provider);
    const opened = [];
    const controller = registerWebMcpTools(createBindings({
      openCountryBriefByCode: async (code, country) => {
        opened.push({ code, country });
        return true;
      },
    }), harness.runtime);

    assert.deepEqual(
      provider.registrationCalls.map(({ tool }) => tool.name),
      WEBMCP_SPA_TOOL_NAMES,
      'registration calls must start before registerWebMcpTools returns',
    );
    assert.ok(provider.registrationCalls.every(({ signal }) => signal === controller.signal));
    await settlePromises();

    const registered = await provider.getTools();
    assert.deepEqual(
      registered.map(({ name }) => name),
      [...WEBMCP_SPA_TOOL_NAMES].sort((left, right) => left.localeCompare(right)),
    );
    for (const registeredTool of registered) {
      const original = provider.registrationCalls
        .find(({ tool }) => tool.name === registeredTool.name).tool;
      assert.deepEqual(JSON.parse(registeredTool.inputSchema), original.inputSchema);
      assert.equal('execute' in registeredTool, false);
    }

    const result = await executeRegistered(
      provider,
      'openCountryBrief',
      JSON.stringify({ iso2: 'de' }),
    );
    assert.equal(result, 'Opened intelligence brief for Country DE (DE).');
    assert.deepEqual(opened, [{ code: 'DE', country: 'Country DE' }]);
    assert.deepEqual(harness.events, [
      {
        event: 'webmcp-registered',
        data: { toolCount: WEBMCP_SPA_TOOL_NAMES.length, pageSurface: 'dashboard', api: 'document-current' },
      },
      {
        event: 'webmcp-tool-invoked',
        data: { tool: 'openCountryBrief', outcome: 'success', reason: 'completed' },
      },
    ]);
  });

  it('marks registration settlement so a probe can read the inventory in one call', async () => {
    // On Chrome's WebMCP origin-trial build, ANY access to
    // document.modelContext before the page finishes registering wedges the
    // registration itself — a bare property read is enough, and an empty
    // getTools() is a symptom rather than the cause. So a discovery probe must
    // touch nothing until this mark, which the page emits from its own
    // instrumentation, says "read now, once" — see e2e/webmcp.spec.ts.
    const previousWindow = Object.hasOwn(globalThis, 'window') ? globalThis.window : undefined;
    const hadWindow = Object.hasOwn(globalThis, 'window');
    const marks = [];
    globalThis.window = { __wmLcpDebug: { enabled: true, marks } };
    try {
      const provider = new FakeWebMcpModelContext({ supportsTargetExecutionSignal: true });
      const harness = trackedRuntime(provider);
      registerWebMcpTools(createBindings(), harness.runtime);
      assert.equal(
        marks.some(({ name }) => name === 'wm:webmcp:registered'),
        false,
        'the mark must not appear before registration settles',
      );
      await settlePromises();

      const registered = marks.filter(({ name }) => name === 'wm:webmcp:registered');
      assert.equal(registered.length, 1, 'registration settles exactly once');
      assert.deepEqual(registered[0].detail, { toolCount: WEBMCP_SPA_TOOL_NAMES.length });
      assert.deepEqual(
        (await provider.getTools()).map(({ name }) => name),
        [...WEBMCP_SPA_TOOL_NAMES].sort((left, right) => left.localeCompare(right)),
        'the mark must not fire before the inventory is actually readable',
      );
    } finally {
      if (hadWindow) globalThis.window = previousWindow;
      else delete globalThis.window;
    }
  });

  it('marks an empty registration pass without authorizing an inventory read', async () => {
    const previousWindow = Object.hasOwn(globalThis, 'window') ? globalThis.window : undefined;
    const hadWindow = Object.hasOwn(globalThis, 'window');
    const marks = [];
    globalThis.window = { __wmLcpDebug: { enabled: true, marks } };
    try {
      const failures = new Map(WEBMCP_SPA_TOOL_NAMES.map((name) => [
        name,
        new DOMException(`${name} rejected`, 'NotAllowedError'),
      ]));
      const provider = new FakeWebMcpModelContext({ registrationFailure: failures });
      const harness = trackedRuntime(provider);
      registerWebMcpTools(createBindings(), harness.runtime);

      assert.equal(marks.length, 0, 'no settlement mark appears before registration finishes');
      await settlePromises();

      const empty = marks.filter(({ name }) => name === 'wm:webmcp:registration-empty');
      assert.equal(empty.length, 1, 'the all-rejected pass settles exactly once');
      assert.deepEqual(empty[0].detail, { toolCount: 0 });
      assert.equal(
        marks.some(({ name }) => name === 'wm:webmcp:registered'),
        false,
        'an empty pass must not authorize the probe to read the provider inventory',
      );
      assert.deepEqual(await provider.getTools(), []);
      assert.equal(
        harness.events.filter(({ event }) => event === 'webmcp-registration-failed').length,
        WEBMCP_SPA_TOOL_NAMES.length,
      );
      assert.equal(
        harness.events.some(({ event }) => event === 'webmcp-registered'),
        false,
      );
    } finally {
      if (hadWindow) globalThis.window = previousWindow;
      else delete globalThis.window;
    }
  });

  it('does not enter a registered callback for a pre-aborted invocation', async () => {
    let mutationCalls = 0;
    const provider = new FakeWebMcpModelContext({ supportsTargetExecutionSignal: true });
    const harness = trackedRuntime(provider);
    registerWebMcpTools(createBindings({
      applyDashboardAction: async () => {
        mutationCalls += 1;
        return {
          ok: true,
          status: 'applied',
          actionType: 'set_view',
          message: 'Applied dashboard action.',
          targets: [],
        };
      },
    }), harness.runtime);
    await settlePromises();

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      executeRegistered(
        provider,
        'set_map_view',
        JSON.stringify({ view: 'eu' }),
        { signal: controller.signal },
      ),
      (error) => error.name === 'AbortError',
    );
    assert.equal(mutationCalls, 0);
    assert.equal(provider.executionCalls.length, 0);
    assert.equal(
      harness.events.some(({ event }) => event === 'webmcp-tool-invoked'),
      false,
    );
  });

  it('classifies every SPA tool in the cancellation policy record', () => {
    // The gate is derived from this record, so an unclassified tool would fall
    // out of the gate silently. TypeScript catches a missing key only while the
    // record keeps its Record<WebMcpSpaToolName, ...> annotation; this asserts
    // the same exhaustiveness at runtime, from the shipped tool inventory, so
    // growing WEBMCP_SPA_TOOL_NAMES past the policy fails loudly here.
    assert.deepEqual(
      Object.keys(WEBMCP_TOOL_CANCELLATION_POLICY).sort(),
      [...WEBMCP_SPA_TOOL_NAMES].sort(),
      'every SPA tool needs an explicit cancellation policy',
    );
    assert.deepEqual(
      Object.values(WEBMCP_TOOL_CANCELLATION_POLICY)
        .filter((policy) => !['read-only', 'view-state', 'cancellation-required', 'result-dependent'].includes(policy)),
      [],
      'policy values are limited to the documented classifications',
    );
  });

  it('preserves regional panel index 0 in get_panel_layout', async () => {
    // Bottom-region index 0 is a valid ordinal. Coercing with `||` would replace
    // it with the flatten fallback (1 when a sidebar panel precedes it).
    const provider = new FakeWebMcpModelContext();
    const harness = trackedRuntime(provider);
    registerWebMcpTools(createBindings({
      getPanelLayout: async () => ({
        regions: {
          sidebar: { available: true, panelCount: 1 },
          bottom: { available: true, panelCount: 1 },
        },
        panels: [
          {
            id: 'giving',
            region: 'sidebar',
            index: 0,
            collapsed: false,
            fullscreen: false,
            collapsible: false,
            fullscreenCapable: false,
            fixed: false,
          },
          {
            id: 'live-news',
            region: 'bottom',
            index: 0,
            collapsed: false,
            fullscreen: false,
            collapsible: true,
            fullscreenCapable: true,
            fixed: false,
          },
        ],
        panelCount: 2,
      }),
    }), harness.runtime);
    await settlePromises();

    const layout = await executeRegistered(provider, 'get_panel_layout');
    assert.equal(layout.regions.bottom.panelCount, 1);
    assert.equal(layout.panels[1].id, 'live-news');
    assert.equal(layout.panels[1].index, 0, 'bottom panel must keep regional index 0');
  });

  it('denies tools whose effects can outlive cancellation when the host omits the target signal', async () => {
    // Layer, panel, map-mode, tab, and monitor changes can persist or leave
    // the current origin. An uncancellable invocation can outlive the session,
    // so these tools stay fail-closed while the browser cannot deliver a signal.
    // open_search_result is result-dependent and must reach its binding so the
    // issued effect class can decide.
    assert.deepEqual(
      [...CANCELLATION_REQUIRED_WEBMCP_TOOLS].sort(),
      [
        'apply_mission_preset',
        'create_dashboard_tab',
        'delete_dashboard_tab',
        'move_panel',
        'openCountryBrief',
        'rename_dashboard_tab',
        'select_dashboard_tab',
        'set_map_layers',
        'set_map_mode',
        'set_panel_collapsed',
        'set_panel_enabled',
        'switch_monitor',
      ],
      'the gated set includes navigation, persistent writes, and metered country generation',
    );
    let mutationCalls = 0;
    let openCalls = 0;
    let tabCalls = 0;
    let panelCalls = 0;
    let missionCalls = 0;
    const provider = new FakeWebMcpModelContext();
    const harness = trackedRuntime(provider);
    registerWebMcpTools(createBindings({
      applyDashboardAction: async () => {
        mutationCalls += 1;
        return { ok: true, status: 'applied', actionType: 'set_layers', message: 'Applied.', targets: [] };
      },
      openSearchResult: async () => {
        openCalls += 1;
        return { ok: true, status: 'opened' };
      },
      applyDashboardTabAction: async () => {
        tabCalls += 1;
        return {
          ok: true,
          status: 'applied',
          actionType: 'create',
          message: 'Applied dashboard tab action.',
          tabId: 'tab-main01-abc123',
          name: 'Main',
          activeTabId: 'tab-main01-abc123',
        };
      },
      setPanelEnabled: async () => {
        panelCalls += 1;
        return {
          ok: true,
          status: 'applied',
          panelId: 'giving',
          requestedEnabled: true,
          effectiveEnabled: true,
          changed: true,
          message: 'Panel enabled.',
        };
      },
      applyMissionPreset: async () => {
        missionCalls += 1;
        return {
          ok: true,
          status: 'applied',
          presetId: 'supply-chain-risk',
          label: 'Supply-Chain Risk',
          changed: true,
          monitor: 'full',
          map: {
            view: 'global',
            zoom: 2.3,
            timeRange: '7d',
            enabledLayers: [],
          },
          panels: { enabled: [] },
          message: 'Applied.',
        };
      },
    }), harness.runtime);
    await settlePromises();

    const denial = {
      ok: false,
      status: 'denied',
      reason: 'target_cancellation_unsupported',
      message: 'This browser cannot cancel work already running in the page, so World Monitor '
        + 'will not run tools whose effects can outlive cancellation. Read-only and '
        + 'reversible view-state dashboard tools still work.',
    };
    assert.deepEqual(
      await executeRegistered(provider, 'openCountryBrief', JSON.stringify({ iso2: 'DE' })),
      denial,
    );
    assert.deepEqual(
      await executeRegistered(provider, 'set_map_layers', JSON.stringify({ layers: { conflicts: true } })),
      denial,
    );
    assert.deepEqual(
      await executeRegistered(provider, 'set_map_mode', JSON.stringify({ mode: '3d' })),
      denial,
    );
    assert.deepEqual(
      await executeRegistered(
        provider,
        'set_panel_enabled',
        JSON.stringify({ panelId: 'giving', enabled: true }),
      ),
      denial,
    );
    assert.deepEqual(
      await executeRegistered(
        provider,
        'apply_mission_preset',
        JSON.stringify({ presetId: 'supply-chain-risk' }),
      ),
      denial,
    );
    assert.deepEqual(
      await executeRegistered(
        provider,
        'set_panel_collapsed',
        JSON.stringify({ panelId: 'live-news', collapsed: true }),
      ),
      denial,
    );
    assert.deepEqual(
      await executeRegistered(
        provider,
        'move_panel',
        JSON.stringify({ panelId: 'giving', region: 'sidebar', index: 0 }),
      ),
      denial,
    );
    for (const [tool, input] of [
      ['select_dashboard_tab', { tabId: 'tab-main01-abc123' }],
      ['create_dashboard_tab', { name: 'Markets' }],
      ['rename_dashboard_tab', { tabId: 'tab-main01-abc123', name: 'Workspace' }],
      ['delete_dashboard_tab', { tabId: 'tab-main01-abc123', confirm: true }],
    ]) {
      assert.deepEqual(await executeRegistered(provider, tool, JSON.stringify(input)), denial);
    }
    assert.deepEqual(
      await executeRegistered(provider, 'switch_monitor', JSON.stringify({ monitor: 'tech' })),
      denial,
    );
    assert.deepEqual(
      await executeRegistered(
        provider,
        'open_search_result',
        JSON.stringify({ resultKey: `sr_${'a'.repeat(32)}` }),
      ),
      { ok: true, status: 'opened' },
    );
    assert.equal(mutationCalls, 0, 'a gated tool must not reach its binding');
    assert.equal(openCalls, 1, 'result-dependent open_search_result must reach its binding');
    assert.equal(tabCalls, 0, 'persistent dashboard tab tools must not reach their binding');
    assert.equal(panelCalls, 0, 'persistent panel changes must not reach their binding');
    assert.equal(missionCalls, 0, 'persistent mission preset changes must not reach their binding');
  });

  it('runs a dashboard-changing tool when the host omits the target execution signal', async () => {
    let mutationCalls = 0;
    let contextCalls = 0;
    const provider = new FakeWebMcpModelContext();
    const harness = trackedRuntime(provider);
    registerWebMcpTools(createBindings({
      getDashboardContext: async () => {
        contextCalls += 1;
        return createBindings().getDashboardContext();
      },
      applyDashboardAction: async () => {
        mutationCalls += 1;
        return {
          ok: true,
          status: 'applied',
          actionType: 'set_view',
          message: 'Applied dashboard action.',
          targets: [],
        };
      },
    }), harness.runtime);
    await settlePromises();

    const context = await executeRegistered(provider, 'get_dashboard_context');
    assert.equal(context.variant, 'full');
    assert.equal(contextCalls, 1);

    // Chrome through 151 passes no target-side signal. These tools only move
    // visible, reversible dashboard view state, so they run anyway rather than
    // costing 7 of 10 tools on every browser that exists.
    assert.deepEqual(
      await executeRegistered(provider, 'set_map_view', JSON.stringify({ view: 'eu' })),
      {
        ok: true,
        status: 'applied',
        actionType: 'set_view',
        message: 'Applied dashboard action.',
        targets: [],
        targetCount: 0,
        targetsTruncated: false,
      },
    );
    assert.equal(mutationCalls, 1, 'the binding must actually run without a target signal');
    assert.equal(provider.executionCalls.at(-1).targetSignal, undefined);
    assert.deepEqual(harness.events.at(-1), {
      event: 'webmcp-tool-invoked',
      data: { tool: 'set_map_view', outcome: 'success', reason: 'completed' },
    });
  });

  it('runs time-range and country-focus tools without a target execution signal', async () => {
    const actions = [];
    const provider = new FakeWebMcpModelContext();
    const harness = trackedRuntime(provider);
    registerWebMcpTools(createBindings({
      applyDashboardAction: async (action) => {
        actions.push(action.type);
        return {
          ok: true,
          status: 'applied',
          actionType: action.type,
          message: 'Applied dashboard action.',
          targets: [],
        };
      },
    }), harness.runtime);
    await settlePromises();

    assert.deepEqual(
      await executeRegistered(provider, 'set_time_range', JSON.stringify({ timeRange: '6h' })),
      {
        ok: true,
        status: 'applied',
        actionType: 'set_time_range',
        message: 'Applied dashboard action.',
        targets: [],
        targetCount: 0,
        targetsTruncated: false,
      },
    );
    assert.deepEqual(
      await executeRegistered(provider, 'focus_country', JSON.stringify({ iso2: 'DE' })),
      {
        ok: true,
        status: 'applied',
        actionType: 'focus_country',
        message: 'Applied dashboard action.',
        targets: [],
        targetCount: 0,
        targetsTruncated: false,
      },
    );
    assert.deepEqual(actions, ['set_time_range', 'focus_country']);
    assert.equal(provider.executionCalls.at(-1).targetSignal, undefined);
  });

  it('rejects the caller before the default target cancellation hop is delivered', async () => {
    const callbackEntered = deferred();
    const targetAbortObserved = deferred();
    let targetSignal;
    const provider = new FakeWebMcpModelContext({ supportsTargetExecutionSignal: true });
    await provider.registerTool({
      name: 'ordering_probe',
      description: 'Test callback cancellation transport ordering.',
      inputSchema: { type: 'object', additionalProperties: false },
      execute: async (_args, execution) => {
        targetSignal = execution.signal;
        targetSignal.addEventListener('abort', () => targetAbortObserved.resolve(), { once: true });
        callbackEntered.resolve();
        await targetAbortObserved.promise;
        targetSignal.throwIfAborted();
      },
    });
    const descriptor = (await provider.getTools())[0];
    const controller = new AbortController();
    const invocation = provider.executeTool(descriptor, '{}', { signal: controller.signal });
    await callbackEntered.promise;

    controller.abort();
    await assert.rejects(invocation, (error) => error.name === 'AbortError');
    assert.equal(targetSignal.aborted, false);

    await targetAbortObserved.promise;
    assert.equal(targetSignal.aborted, true);
  });

  it('reports duplicate, disallowed, rejected, and host-aborted registrations by closed reason', async () => {
    const failures = new Map([
      ['openCountryBrief', new DOMException('duplicate detail', 'InvalidStateError')],
      ['openSearch', new DOMException('policy detail', 'NotAllowedError')],
      ['get_dashboard_context', new DOMException('origin detail', 'SecurityError')],
      ['open_dashboard_panel', new TypeError('schema detail')],
      ['set_map_view', new DOMException('host cancellation detail', 'AbortError')],
    ]);
    const provider = new FakeWebMcpModelContext({ registrationFailure: failures });
    const harness = trackedRuntime(provider);
    registerWebMcpTools(createBindings(), harness.runtime);
    await settlePromises();

    assert.deepEqual(harness.events.slice(0, 5), [
      { event: 'webmcp-registration-failed', data: { tool: 'openCountryBrief', reason: 'invalid-state' } },
      { event: 'webmcp-registration-failed', data: { tool: 'openSearch', reason: 'not-allowed' } },
      { event: 'webmcp-registration-failed', data: { tool: 'get_dashboard_context', reason: 'security' } },
      { event: 'webmcp-registration-failed', data: { tool: 'open_dashboard_panel', reason: 'invalid-tool' } },
      { event: 'webmcp-registration-failed', data: { tool: 'set_map_view', reason: 'aborted' } },
    ]);
    assert.deepEqual(harness.events.at(-1), {
      event: 'webmcp-registered',
      data: { toolCount: WEBMCP_SPA_TOOL_NAMES.length - failures.size, pageSurface: 'dashboard', api: 'document-current' },
    });
    assert.equal(JSON.stringify(harness.events).includes('detail'), false);
  });

  it('passes catalog layer IDs into set_map_layers', async () => {
    const applied = [];
    const provider = new FakeWebMcpModelContext({ supportsTargetExecutionSignal: true });
    const harness = trackedRuntime(provider);
    registerWebMcpTools(createBindings({
      listMapLayerCatalog: async () => ({
        variant: 'full',
        rendererKind: 'deck',
        enabledLayers: [],
        liveLayerKeys: ['conflicts', 'weather', 'hotspots'],
        hasPremium: true,
        deckGlActive: true,
      }),
      applyDashboardAction: async (action) => {
        applied.push(action);
        return {
          ok: true,
          status: 'applied',
          actionType: action.type,
          message: 'Applied dashboard action.',
          targets: Object.keys(action.layers ?? {}).map((id) => ({
            id,
            status: 'applied',
          })),
        };
      },
    }), harness.runtime);
    await settlePromises();

    const listed = await executeRegistered(provider, 'list_map_layers', '{}');
    assert.equal(listed.ok, true);
    const layerId = listed.layers.find((layer) => layer.available)?.id
      ?? listed.layers[0].id;
    assert.equal(typeof layerId, 'string');

    const controller = new AbortController();
    const result = await executeRegistered(
      provider,
      'set_map_layers',
      JSON.stringify({ layers: { [layerId]: true } }),
      { signal: controller.signal },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(applied, [{
      type: 'set_layers',
      layers: { [layerId]: true },
    }]);
  });
  it('aborts before a late provider can register', async () => {
    const harness = trackedRuntime(undefined);
    const controller = registerWebMcpTools(createBindings(), harness.runtime);
    controller.abort();
    const provider = new FakeWebMcpModelContext();
    harness.document.modelContext = provider;

    assert.equal(harness.dispatchDocument('DOMContentLoaded'), false);
    assert.equal(harness.dispatchWindow('load'), false);
    await settlePromises();
    assert.equal(provider.registrationCalls.length, 0);
    assert.deepEqual(harness.events, []);
  });

  it('aborts registrations while the provider still has them pending', async () => {
    const provider = new FakeWebMcpModelContext({ deferAllRegistrations: true });
    const harness = trackedRuntime(provider);
    const controller = registerWebMcpTools(createBindings(), harness.runtime);

    assert.deepEqual(provider.pendingRegistrationNames, [...WEBMCP_SPA_TOOL_NAMES].sort());
    controller.abort();
    await settlePromises();
    assert.deepEqual(provider.pendingRegistrationNames, []);
    assert.deepEqual(await provider.getTools(), []);
    assert.deepEqual(harness.events, []);
  });

  it('unregisters after acceptance and permits same-document re-initialization', async () => {
    const provider = new FakeWebMcpModelContext();
    const first = trackedRuntime(provider);
    const firstController = registerWebMcpTools(createBindings(), first.runtime);
    await settlePromises();
    const firstTools = await provider.getTools();
    assert.equal(firstTools.length, WEBMCP_SPA_TOOL_NAMES.length);

    firstController.abort();
    assert.deepEqual(await provider.getTools(), []);
    await assert.rejects(
      provider.executeTool(firstTools[0], '{}'),
      (error) => error.name === 'InvalidStateError',
    );

    const second = trackedRuntime(provider);
    const secondController = registerWebMcpTools(createBindings(), second.runtime);
    await settlePromises();
    assert.equal((await provider.getTools()).length, WEBMCP_SPA_TOOL_NAMES.length);
    assert.equal(
      second.events.some(({ event }) => event === 'webmcp-registration-failed'),
      false,
    );
    secondController.abort();
  });
});

describe('registered WebMCP readiness behavior', () => {
  it('delivers target cancellation asynchronously and prevents later deferred mutation', async () => {
    const entered = deferred();
    const release = deferred();
    const targetAbortScheduled = deferred();
    const targetAbortObserved = deferred();
    let deliverTargetAbort;
    let effects = 0;
    let receivedSignal;
    const provider = new FakeWebMcpModelContext({
      supportsTargetExecutionSignal: true,
      scheduleTargetExecutionAbort: (deliver) => {
        deliverTargetAbort = deliver;
        targetAbortScheduled.resolve();
      },
    });
    const harness = trackedRuntime(provider);
    registerWebMcpTools(createBindings({
      applyDashboardAction: async (action, execution) => {
        receivedSignal = execution?.signal;
        execution?.signal?.addEventListener(
          'abort',
          () => targetAbortObserved.resolve(),
          { once: true },
        );
        entered.resolve();
        await release.promise;
        execution?.signal?.throwIfAborted();
        effects += 1;
        return {
          ok: true,
          status: 'applied',
          actionType: action.type,
          message: 'Applied dashboard action.',
          targets: [],
        };
      },
    }), harness.runtime);
    await settlePromises();

    const controller = new AbortController();
    const invocation = executeRegistered(
      provider,
      'set_map_view',
      JSON.stringify({ view: 'eu', zoom: 4 }),
      { signal: controller.signal },
    );
    await entered.promise;
    assert.ok(receivedSignal);
    assert.notEqual(receivedSignal, controller.signal);
    assert.equal(provider.executionCalls.at(-1).targetSignal, receivedSignal);
    controller.abort();
    await assert.rejects(invocation, (error) => error.name === 'AbortError');
    await targetAbortScheduled.promise;
    assert.equal(receivedSignal.aborted, false);
    assert.equal(effects, 0);

    deliverTargetAbort();
    await targetAbortObserved.promise;
    assert.equal(receivedSignal.aborted, true);
    release.resolve();
    await settlePromises();
    assert.equal(effects, 0);
    assert.deepEqual(harness.events.at(-1), {
      event: 'webmcp-tool-invoked',
      data: { tool: 'set_map_view', outcome: 'failure', reason: 'cancelled' },
    });
    assert.equal(
      harness.events.some(({ data }) => (
        data.tool === 'set_map_view' && data.outcome === 'success'
      )),
      false,
    );
  });

  it('keeps a pre-ready invocation pending and resumes through the registered definition', async () => {
    const ready = deferred();
    const destroyed = new Promise(() => {});
    let opened = false;
    const provider = new FakeWebMcpModelContext({ supportsTargetExecutionSignal: true });
    const harness = trackedRuntime(provider);
    registerWebMcpTools(createBindings({
      openSearch: async () => {
        await waitForWebMcpUiReady(ready.promise, destroyed, 1_000);
        opened = true;
        return true;
      },
    }), harness.runtime);
    await settlePromises();

    let settled = false;
    const invocation = executeRegistered(provider, 'openSearch').then((result) => {
      settled = true;
      return result;
    });
    await settlePromises();
    assert.equal(settled, false);
    assert.equal(opened, false);

    ready.resolve();
    assert.equal(await invocation, 'Opened search palette.');
    assert.equal(opened, true);
  });

  it('turns readiness timeout into a bounded, privacy-safe tool failure', async () => {
    const never = new Promise(() => {});
    const provider = new FakeWebMcpModelContext({ supportsTargetExecutionSignal: true });
    const harness = trackedRuntime(provider);
    registerWebMcpTools(createBindings({
      openSearch: () => waitForWebMcpUiReady(never, never, 5),
    }), harness.runtime);
    await settlePromises();

    await assert.rejects(
      executeRegistered(provider, 'openSearch'),
      (error) => error.name === 'WebMcpToolError'
        && error.message === 'World Monitor could not open search.'
        && !error.message.includes('5ms'),
    );
    assert.deepEqual(harness.events.at(-1), {
      event: 'webmcp-tool-invoked',
      data: { tool: 'openSearch', outcome: 'failure', reason: 'internal' },
    });
  });

  it('wakes a pre-ready invocation on teardown and removes its registered definition', async () => {
    const ready = new Promise(() => {});
    const destroyed = deferred();
    const provider = new FakeWebMcpModelContext({ supportsTargetExecutionSignal: true });
    const harness = trackedRuntime(provider);
    const controller = registerWebMcpTools(createBindings({
      openSearch: () => waitForWebMcpUiReady(ready, destroyed.promise, 1_000),
    }), harness.runtime);
    await settlePromises();

    const invocation = executeRegistered(provider, 'openSearch');
    destroyed.resolve();
    await assert.rejects(invocation, /World Monitor could not open search/);
    controller.abort();
    assert.deepEqual(await provider.getTools(), []);
  });
});
