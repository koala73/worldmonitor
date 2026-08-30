import { describe, expect, it } from 'vitest';

import { App } from '@/App';
import type { AppContext } from '@/app/app-context';
import { CountryIntelManager } from '@/app/country-intel';
import {
  buildWebMcpTools,
  type DashboardContextSnapshot,
  type WebMcpAppBindings,
  type WebMcpExecutionOptions,
  type WebMcpNavigationResult,
} from '@/services/webmcp';

const unusedDashboardContext: DashboardContextSnapshot = {
  variant: 'full',
  map: {
    view: 'global',
    center: { lat: 0, lon: 0 },
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

function unusedNavigationBindings(): Pick<
  WebMcpAppBindings,
  'switchMonitor' | 'openSettings' | 'openAlerts' | 'listMissionPresets' | 'applyMissionPreset' | 'openMissionPicker'
> {
  return {
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
}

function unusedPanelLayoutBindings(): Pick<
  WebMcpAppBindings,
  'getPanelLayout' | 'setPanelCollapsed' | 'movePanel' | 'setPanelFullscreen'
> {
  return {
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
}

describe('App WebMCP country binding cold start', () => {
  it('rejects a no-signal country open before the App binding starts', async () => {
    let bindingCalls = 0;
    const tools = buildWebMcpTools({
      openCountryBriefByCode: async () => {
        bindingCalls += 1;
        return true;
      },
      resolveCountryName: () => 'France',
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
      listDashboardPanels: async () => ({
        variant: 'full',
        total: 0,
        hasMore: false,
        nextCursor: null,
        panels: [],
      }),
      ...unusedNavigationBindings(),
      applyDashboardAction: async () => ({
        ok: true,
        status: 'applied',
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
      setPanelEnabled: async () => {
        throw new Error('Unexpected dashboard panel mutation.');
      },
      ...unusedPanelLayoutBindings(),
      applyDashboardTabAction: async () => {
        throw new Error('Unexpected dashboard tab action.');
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

    await expect(tools.find((tool) => tool.name === 'openCountryBrief')!.execute({ iso2: 'FR' }))
      .resolves.toMatchObject({
        ok: false,
        status: 'denied',
        reason: 'target_cancellation_unsupported',
      });
    expect(bindingCalls).toBe(0);
  });

  it('lazy-creates a null country page and acknowledges the visible tool result', async () => {
    let visible = false;
    let activeCode = '';
    let readinessCalls = 0;
    let loadingCalls = 0;
    let lazyCreateCalls = 0;
    const shownCodes: string[] = [];
    const renderPaused: boolean[] = [];
    const page = {
      getCode: () => activeCode,
      isVisible: () => visible,
      show: (_country: string, code: string) => {
        shownCodes.push(code);
        visible = true;
        activeCode = code;
        state.isDestroyed = true;
      },
      showLoading: () => {
        loadingCalls += 1;
        visible = true;
        activeCode = '__loading__';
      },
    };
    const state = {
      countryBriefPage: null,
      isDestroyed: false,
      map: {
        setRenderPaused: (paused: boolean) => renderPaused.push(paused),
      },
    } as unknown as AppContext;
    const countryIntel = new CountryIntelManager(state);
    Reflect.set(countryIntel, 'ensureCountryBriefPage', async () => {
      lazyCreateCalls += 1;
      expect(state.countryBriefPage).toBeNull();
      state.countryBriefPage = page as unknown as AppContext['countryBriefPage'];
      return true;
    });
    Reflect.set(countryIntel, 'getCountrySignals', async () => ({}));

    const app = Object.create(App.prototype) as App;
    Reflect.set(app, 'state', state);
    Reflect.set(app, 'countryIntel', countryIntel);
    Reflect.set(app, 'waitForUiReady', async () => { readinessCalls += 1; });
    const openWebMcpCountryBrief = Reflect.get(app, 'openWebMcpCountryBrief') as (
      code: string,
      country: string,
      execution?: WebMcpExecutionOptions,
    ) => Promise<boolean>;

    const bindings: WebMcpAppBindings = {
      openCountryBriefByCode: (code, country, execution) => (
        openWebMcpCountryBrief.call(app, code, country, execution)
      ),
      resolveCountryName: () => 'France',
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
      listDashboardPanels: async () => ({
        variant: 'full',
        total: 0,
        hasMore: false,
        nextCursor: null,
        panels: [],
      }),
      ...unusedNavigationBindings(),
      applyDashboardAction: async () => ({
        ok: true,
        status: 'applied',
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
      setPanelEnabled: async () => {
        throw new Error('Unexpected dashboard panel mutation.');
      },
      ...unusedPanelLayoutBindings(),
      applyDashboardTabAction: async () => {
        throw new Error('Unexpected dashboard tab action.');
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
    };
    const countryTool = buildWebMcpTools(bindings, () => {})
      .find((tool) => tool.name === 'openCountryBrief');
    expect(countryTool).toBeDefined();

    const controller = new AbortController();
    const result = await countryTool!.execute({ iso2: 'FR' }, { signal: controller.signal });

    expect(result).toBe('Opened intelligence brief for France (FR).');
    expect(readinessCalls).toBe(1);
    expect(lazyCreateCalls).toBe(1);
    expect(loadingCalls).toBe(1);
    expect(shownCodes).toEqual(['FR']);
    expect(state.countryBriefPage).toBe(page);
    expect(page.isVisible()).toBe(true);
    expect(page.getCode()).toBe('FR');
    expect(renderPaused).toEqual([true]);
  });
});
