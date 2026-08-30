/**
 * Per-result cancellation for open_search_result (#7320).
 *
 * Chrome 149–151 omits the target-side AbortSignal. The selector tool used to
 * refuse every result for that reason. Safe view-state results (an already
 * enabled panel) must run; persistent, quota-consuming, and external-navigation
 * results stay blocked. The effect class is bound to the opaque token at
 * issuance so a caller cannot downgrade it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SearchSelectionDispatcher } from '@/app/search-selection-dispatcher';
import { WebMcpSearchController } from '@/app/webmcp-search-controller';
import type { SearchMatch } from '@/components/search-types';
import { STORAGE_KEYS } from '@/config';
import { COMMANDS } from '@/config/commands';
import { saveToStorage } from '@/utils';
import {
  buildWebMcpTools,
  type DashboardContextSnapshot,
  type WebMcpAppBindings,
  type WebMcpNavigationResult,
  WEBMCP_UNSUPPORTED_CANCELLATION_MESSAGE,
} from '@/services/webmcp';

const unusedDashboardContext: DashboardContextSnapshot = {
  variant: 'full',
  map: {
    view: 'global',
    center: null,
    zoom: 2,
    timeRange: '7d',
    enabledLayers: [],
  },
  panels: { mounted: [], enabled: [] },
};

function unusedNavigationResult(
  destination: WebMcpNavigationResult['destination'],
  extras: Partial<WebMcpNavigationResult> = {},
): WebMcpNavigationResult {
  return {
    ok: true,
    status: 'applied',
    destination,
    message: 'Unused in this test.',
    context: unusedDashboardContext,
    ...extras,
  };
}

const unusedNavigationBindings: Pick<
  WebMcpAppBindings,
  'switchMonitor' | 'openSettings' | 'openAlerts' | 'listMissionPresets' | 'applyMissionPreset' | 'openMissionPicker'
> = {
  switchMonitor: async () => unusedNavigationResult('full', { navigation: 'none' }),
  openSettings: async () => unusedNavigationResult('settings', {
    overlay: 'open',
    tab: 'settings',
  }),
  openAlerts: async () => unusedNavigationResult('alerts', {
    overlay: 'open',
    tab: 'notifications',
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
    changed: false,
    monitor: 'full',
    message: 'Unused mission preset binding.',
  }),
  openMissionPicker: async () => unusedNavigationResult('mission_picker', {
    overlay: 'open',
  }),
};

const unusedPanelLayoutBindings: Pick<
  WebMcpAppBindings,
  'getPanelLayout' | 'setPanelCollapsed' | 'movePanel' | 'setPanelFullscreen'
> = {
  getPanelLayout: async () => {
    throw new Error('Unexpected panel layout read.');
  },
  setPanelCollapsed: async () => {
    throw new Error('Unexpected panel layout mutation.');
  },
  movePanel: async () => {
    throw new Error('Unexpected panel layout mutation.');
  },
  setPanelFullscreen: async () => {
    throw new Error('Unexpected panel layout mutation.');
  },
};

function commandMatch(id: string): SearchMatch {
  const command = COMMANDS.find((entry) => entry.id === id);
  if (!command) throw new Error(`Expected command ${id}`);
  return {
    kind: 'command',
    command,
    score: 1,
    title: command.label,
    subtitle: command.category,
  };
}

function mountPanel(panelId: string): HTMLElement {
  const panel = document.createElement('div');
  panel.setAttribute('data-panel', panelId);
  document.body.append(panel);
  return panel;
}

function countryMatch(): SearchMatch {
  return {
    kind: 'result',
    score: 1,
    result: {
      type: 'country',
      id: 'DE',
      title: 'Germany',
      data: { code: 'DE', name: 'Germany' },
    },
  };
}

function createHarness(matches: SearchMatch[], enabledPanels: Record<string, boolean> = {}) {
  const mapLayers = { conflicts: false };
  const enableLayer = vi.fn();
  const closeForProgrammaticSelection = vi.fn();
  const openCountryBriefByCode = vi.fn(() => true);
  const openSettings = vi.fn();
  const panelSettings = Object.fromEntries(
    Object.entries(enabledPanels).map(([panelId, enabled]) => [panelId, { enabled }]),
  );
  const enablePanel = vi.fn((panelId: string) => {
    const settings = panelSettings[panelId] ?? { enabled: false };
    settings.enabled = true;
    panelSettings[panelId] = settings;
    saveToStorage(STORAGE_KEYS.panels, panelSettings);
    return true;
  });
  const modal = {
    search: vi.fn(() => ({ orderedMatches: matches })),
    resolveMatchByIdentity: vi.fn((identity: string) => (
      matches.find((match) => JSON.stringify(
        match.kind === 'command'
          ? ['command', match.command.id]
          : ['result', match.result.type, match.result.id, match.result.title, ''],
      ) === identity)
    )),
    closeForProgrammaticSelection,
  };
  const dispatcher = new SearchSelectionDispatcher({
    ctx: {
      mapLayers,
      map: {
        isGlobeMode: () => false,
        isDeckGLActive: () => false,
        enableLayer,
        setView: vi.fn(),
        setLayers: vi.fn(),
      },
      panelSettings,
      newsPanels: {},
      unifiedSettings: { open: openSettings },
    } as never,
    getVariant: () => 'full',
    hasPremiumAccess: () => false,
    openCountryBriefByCode,
    enablePanel,
    trackSearchResultSelected: vi.fn(),
    trackCountrySelected: vi.fn(),
    runWithAgentAnalyticsSuppressed: (callback) => callback(),
    suppressNextAgentPanelView: vi.fn(),
    resolveExecutableNewsPanel: vi.fn(() => null),
    saveToStorage,
    setTheme: vi.fn(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
  });
  const controller = new WebMcpSearchController({
    waitForIndexReady: async () => {},
    isDestroyed: () => false,
    refreshIndex: vi.fn(),
    getModal: () => modal as never,
    hasPremiumAccess: () => false,
    fetchLiveFlight: vi.fn(async () => {}),
    getAuthContext: () => 'anonymous:settled:free',
    getVariant: () => 'full',
    isMatchExecutable: () => true,
    isPanelCurrentlyEnabled: (panelId) => enabledPanels[panelId] === true,
    selectMatch: (candidate, signal) => dispatcher.selectProgrammaticMatch(
      candidate,
      () => candidate,
      signal,
    ),
    subscribeAuth: () => () => {},
    subscribeEntitlement: () => () => {},
    subscribeRuntimeConfig: () => () => {},
    subscribeWidgetAccess: () => () => {},
    onPremiumAccessChanged: vi.fn(),
    cancelPendingSelection: () => dispatcher.cancelPendingProgrammaticSelection(),
  });
  return {
    closeForProgrammaticSelection,
    controller,
    dispatcher,
    enableLayer,
    enablePanel,
    mapLayers,
    modal,
    openCountryBriefByCode,
    openSettings,
    panelSettings,
  };
}

const cancellationDenial = {
  ok: false,
  status: 'denied',
  reason: 'target_cancellation_unsupported',
  message: WEBMCP_UNSUPPORTED_CANCELLATION_MESSAGE,
} as const;

describe('open_search_result evaluates cancellation per issued effect', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });

  it('opens an enabled panel without a target-side signal', async () => {
    const { controller, closeForProgrammaticSelection, dispatcher } = createHarness(
      [commandMatch('panel:live-webcams')],
      { 'live-webcams': true },
    );
    mountPanel('live-webcams');

    const response = await controller.search('webcam', 'panels', 10);
    const issued = response.results[0];
    expect(issued).toMatchObject({
      type: 'command',
      executable: true,
    });
    expect(issued).not.toHaveProperty('effectClass');

    await expect(controller.open(issued!.key, async () => {})).resolves.toStrictEqual({
      ok: true,
      status: 'opened',
      type: 'command',
    });
    expect(closeForProgrammaticSelection).toHaveBeenCalledOnce();
    expect(localStorage.getItem(STORAGE_KEYS.mapLayers)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.panels)).toBeNull();

    controller.destroy();
    dispatcher.destroy();
  });

  it('does not advertise or run a persistent layer result without a target-side signal', async () => {
    const { controller, dispatcher, enableLayer } = createHarness(
      [commandMatch('layer:conflicts')],
    );

    const response = await controller.search('conflicts', 'map', 10);
    const issued = response.results[0];
    expect(issued?.executable).toBe(false);

    await expect(controller.open(issued!.key, async () => {})).resolves.toStrictEqual(
      cancellationDenial,
    );
    expect(enableLayer).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEYS.mapLayers)).toBeNull();

    const host = new AbortController();
    await expect(
      controller.open(issued!.key, async () => {}, host.signal),
    ).resolves.toStrictEqual({
      ok: true,
      status: 'opened',
      type: 'command',
    });
    expect(enableLayer).toHaveBeenCalledWith('conflicts');

    controller.destroy();
    dispatcher.destroy();
  });

  it('persists a layer result only when the host supplies a target-side signal', async () => {
    const { controller, dispatcher, enableLayer } = createHarness(
      [commandMatch('layer:conflicts')],
    );
    const host = new AbortController();

    const response = await controller.search('conflicts', 'map', 10, host.signal);
    const issued = response.results[0];
    expect(issued?.executable).toBe(true);

    await expect(
      controller.open(issued!.key, async () => {}, host.signal),
    ).resolves.toStrictEqual({
      ok: true,
      status: 'opened',
      type: 'command',
    });
    expect(enableLayer).toHaveBeenCalledWith('conflicts');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.mapLayers)!))
      .toStrictEqual({ conflicts: true });

    controller.destroy();
    dispatcher.destroy();
  });

  it('does not run a persistent result advertised under a capable host when open omits the signal', async () => {
    const { controller, dispatcher, enableLayer } = createHarness(
      [commandMatch('layer:conflicts')],
    );
    const host = new AbortController();

    const response = await controller.search('conflicts', 'map', 10, host.signal);
    expect(response.results[0]?.executable).toBe(true);

    await expect(controller.open(response.results[0]!.key, async () => {})).resolves.toStrictEqual(
      cancellationDenial,
    );
    expect(enableLayer).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEYS.mapLayers)).toBeNull();

    controller.destroy();
    dispatcher.destroy();
  });

  it('does not advertise or run an enabled panel tab deep-link without a target-side signal', async () => {
    const { controller, closeForProgrammaticSelection, dispatcher } = createHarness(
      [commandMatch('panel:consumer-prices@world')],
      { 'consumer-prices': true },
    );
    mountPanel('consumer-prices');
    const openedTabs: string[] = [];
    const onOpenTab = (event: Event): void => {
      const tab = (event as CustomEvent<{ tab?: string }>).detail?.tab;
      if (tab) openedTabs.push(tab);
    };
    window.addEventListener('wm-consumer-prices-open-tab', onOpenTab);

    const response = await controller.search('inflation', 'panels', 10);
    expect(response.results[0]?.executable).toBe(false);
    await expect(controller.open(response.results[0]!.key, async () => {})).resolves.toStrictEqual(
      cancellationDenial,
    );
    expect(closeForProgrammaticSelection).not.toHaveBeenCalled();
    expect(openedTabs).toEqual([]);
    expect(localStorage.getItem('wm-consumer-prices-v1')).toBeNull();

    window.removeEventListener('wm-consumer-prices-open-tab', onOpenTab);
    controller.destroy();
    dispatcher.destroy();
  });

  it('blocks an external-navigation settings result without a target-side signal', async () => {
    const { controller, closeForProgrammaticSelection, dispatcher, openSettings } = createHarness(
      [commandMatch('view:settings')],
    );

    const response = await controller.search('settings', 'actions', 10);
    expect(response.results[0]?.executable).toBe(false);
    await expect(controller.open(response.results[0]!.key, async () => {})).resolves.toStrictEqual(
      cancellationDenial,
    );
    expect(openSettings).not.toHaveBeenCalled();
    expect(closeForProgrammaticSelection).not.toHaveBeenCalled();

    controller.destroy();
    dispatcher.destroy();
  });

  it('blocks a quota-consuming country result without a target-side signal', async () => {
    const { controller, dispatcher, openCountryBriefByCode } = createHarness([countryMatch()]);

    const response = await controller.search('germany', 'all', 10);
    expect(response.results[0]?.executable).toBe(false);

    await expect(controller.open(response.results[0]!.key, async () => {})).resolves.toStrictEqual(
      cancellationDenial,
    );
    expect(openCountryBriefByCode).not.toHaveBeenCalled();

    controller.destroy();
    dispatcher.destroy();
  });

  it('blocks enabling a disabled panel without a target-side signal', async () => {
    const { controller, closeForProgrammaticSelection, dispatcher, enablePanel } = createHarness(
      [commandMatch('panel:windy-webcams')],
      { 'windy-webcams': false },
    );

    const response = await controller.search('webcam', 'panels', 10);
    expect(response.results[0]?.executable).toBe(false);
    await expect(controller.open(response.results[0]!.key, async () => {})).resolves.toStrictEqual(
      cancellationDenial,
    );
    expect(enablePanel).not.toHaveBeenCalled();
    expect(closeForProgrammaticSelection).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEYS.panels)).toBeNull();

    controller.destroy();
    dispatcher.destroy();
  });

  it('denies an issued enabled panel after it is disabled without a target-side signal', async () => {
    const enabledPanels = { 'live-webcams': true };
    const { controller, closeForProgrammaticSelection, dispatcher, enablePanel, panelSettings } =
      createHarness([commandMatch('panel:live-webcams')], enabledPanels);

    const response = await controller.search('webcam', 'panels', 10);
    expect(response.results[0]?.executable).toBe(true);

    enabledPanels['live-webcams'] = false;
    panelSettings['live-webcams']!.enabled = false;

    await expect(controller.open(response.results[0]!.key, async () => {})).resolves.toStrictEqual(
      cancellationDenial,
    );
    expect(enablePanel).not.toHaveBeenCalled();
    expect(closeForProgrammaticSelection).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEYS.panels)).toBeNull();

    controller.destroy();
    dispatcher.destroy();
  });

  it('keeps the bound persistent class when a disabled panel is later enabled', async () => {
    const enabledPanels = { 'windy-webcams': false };
    const { controller, closeForProgrammaticSelection, dispatcher, enablePanel } = createHarness(
      [commandMatch('panel:windy-webcams')],
      enabledPanels,
    );

    const response = await controller.search('webcam', 'panels', 10);
    expect(response.results[0]?.executable).toBe(false);

    enabledPanels['windy-webcams'] = true;

    await expect(controller.open(response.results[0]!.key, async () => {})).resolves.toStrictEqual(
      cancellationDenial,
    );
    expect(enablePanel).not.toHaveBeenCalled();
    expect(closeForProgrammaticSelection).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEYS.panels)).toBeNull();

    controller.destroy();
    dispatcher.destroy();
  });

  it('keeps the bound effect class when the advertised executable flag is ignored', async () => {
    const { controller, dispatcher, enableLayer } = createHarness(
      [commandMatch('layer:conflicts')],
    );
    const response = await controller.search('conflicts', 'map', 10);
    const issued = { ...response.results[0]!, executable: true };

    await expect(controller.open(issued.key, async () => {})).resolves.toStrictEqual(
      cancellationDenial,
    );
    expect(enableLayer).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEYS.mapLayers)).toBeNull();

    controller.destroy();
    dispatcher.destroy();
  });
});

describe('open_search_result rejects a caller-supplied effect class', () => {
  it('treats an extra effect property as malformed arguments', async () => {
    const tools = buildWebMcpTools({
      openCountryBriefByCode: async () => true,
      resolveCountryName: (code) => code,
      openSearch: async () => true,
      getDashboardContext: async () => unusedDashboardContext,
      listMapLayerCatalog: async () => ({
        variant: 'full',
        rendererKind: 'deck',
        enabledLayers: [],
        liveLayerKeys: [],
        hasPremium: false,
        deckGlActive: true,
      }),
      ...unusedNavigationBindings,
      applyDashboardAction: async () => ({
        ok: true,
        status: 'applied',
        message: 'Applied.',
        targets: [],
      }),
      searchDashboard: async () => ({
        queryLength: 1,
        results: [],
        resultCount: 0,
        truncated: false,
      }),
      openSearchResult: async () => ({ ok: true, status: 'opened' }),
      setPanelEnabled: async () => {
        throw new Error('Unexpected dashboard panel mutation.');
      },
      ...unusedPanelLayoutBindings,
      applyDashboardTabAction: async () => {
        throw new Error('Unexpected dashboard tab action.');
      },
      listDashboardPanels: async () => {
        throw new Error('Unexpected dashboard panel catalog read.');
      },
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
    }, () => {});
    const open = tools.find((tool) => tool.name === 'open_search_result');
    await expect(open!.execute({
      resultKey: `sr_${'a'.repeat(32)}`,
      effect: 'view-state',
    })).resolves.toMatchObject({
      ok: false,
      status: 'denied',
      reason: 'malformed_arguments',
    });
  });
});
