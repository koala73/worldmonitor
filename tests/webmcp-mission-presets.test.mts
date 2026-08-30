import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyWebMcpMissionPreset } from '../src/app/webmcp-dashboard.ts';
import type { AppContext } from '../src/app/app-context.ts';
import { SITE_VARIANTS } from '../src/config/variant.ts';
import { MISSION_PRESETS } from '../src/services/mission-presets.ts';
import {
  WEBMCP_SPA_TOOL,
} from '../src/config/webmcp.ts';
import {
  buildWebMcpTools,
  CANCELLATION_REQUIRED_WEBMCP_TOOLS,
  WEBMCP_TOOL_CANCELLATION_POLICY,
} from '../src/services/webmcp.ts';
import {
  evaluateMissionPresetApply,
  isMissionPresetMonitorCompatible,
  listMissionPresetCatalog,
  MISSION_PRESET_MIN_PANEL_MATCHES,
} from '../src/services/webmcp-mission-preset-catalog.ts';
import type { MapLayers } from '../src/types/index.ts';

function makeApplyContext(overrides: Partial<AppContext> = {}): AppContext {
  const mapLayers = {
    conflicts: true,
    weather: false,
  } as unknown as MapLayers;
  return {
    isDestroyed: false,
    panels: {},
    panelSettings: {},
    mapLayers,
    map: {
      getState: () => ({
        view: 'global',
        zoom: 2,
        pan: { x: 0, y: 0 },
        timeRange: '7d',
        layers: mapLayers,
      }),
      getCenter: () => ({ lat: 0, lon: 0 }),
      setCenter: () => 1,
      setView: () => {},
      setLayers: () => {},
      setTimeRange: () => {},
      getTimeRange: () => '7d',
      switchToGlobe: () => {},
      switchToFlat: () => {},
      whenRendererReady: () => Promise.resolve(),
      whenViewportSettled: () => Promise.resolve(),
      isDeckGLActive: () => false,
      isGlobeMode: () => false,
    },
    ...overrides,
  } as AppContext;
}

function live(overrides: {
  variant?: string;
  hasPremium?: boolean;
  activePresetId?: string | null;
  targetCancellationSupported?: boolean;
  isPanelEntitled?: (panelId: string) => boolean;
} = {}) {
  return {
    variant: overrides.variant ?? 'full',
    hasPremium: overrides.hasPremium ?? false,
    activePresetId: overrides.activePresetId ?? null,
    targetCancellationSupported: overrides.targetCancellationSupported,
    isPanelEntitled: overrides.isPanelEntitled,
  };
}

describe('webmcp mission preset catalog', () => {
  it('lists every bundled preset from the canonical registry', () => {
    const result = listMissionPresetCatalog(live());
    assert.equal(result.ok, true);
    assert.equal(result.count, MISSION_PRESETS.length);
    assert.deepEqual(
      result.presets.map((preset) => preset.id),
      MISSION_PRESETS.map((preset) => preset.id),
    );
    for (const preset of result.presets) {
      assert.equal(typeof preset.label, 'string');
      assert.ok(preset.label.length > 0);
      assert.equal(typeof preset.panelCount, 'number');
      assert.equal(typeof preset.layerCount, 'number');
      assert.ok(preset.panelCount >= 0);
      assert.ok(preset.layerCount >= 0);
      assert.equal('description' in preset, false);
    }
    assert.ok(JSON.stringify(result).length <= 1_500);
  });

  it('marks monitor-incompatible presets with a stable reason', () => {
    const result = listMissionPresetCatalog(live({ variant: 'happy' }));
    const crisis = result.presets.find((preset) => preset.id === 'crisis-desk');
    assert.ok(crisis);
    assert.equal(crisis.monitorCompatible, false);
    assert.equal(crisis.available, false);
    assert.equal(crisis.unavailableReason, 'preset_incompatible');
    assert.equal(crisis.panelCount, 0);
    assert.equal(crisis.layerCount, 0);
    assert.equal('view' in crisis, false);
    assert.equal('timeRange' in crisis, false);

    const goodNews = result.presets.find((preset) => preset.id === 'good-news-explorer');
    assert.ok(goodNews);
    assert.equal(goodNews.monitorCompatible, true);
    assert.equal(goodNews.available, true);
    assert.equal(goodNews.unavailableReason, undefined);
    assert.equal(goodNews.view, 'global');
    assert.equal(goodNews.timeRange, '7d');
  });

  it('reports entitlement denials without leaking premium payloads', () => {
    const result = listMissionPresetCatalog(live({
      variant: 'full',
      isPanelEntitled: () => false,
    }));
    const supply = result.presets.find((preset) => preset.id === 'supply-chain-risk');
    assert.ok(supply);
    assert.equal(supply.entitled, false);
    assert.equal(supply.available, false);
    assert.equal(supply.unavailableReason, 'preset_not_entitled');
    assert.equal(Object.keys(supply).includes('description'), false);
  });

  it('marks presets unavailable when the host cannot cancel mutations', () => {
    const result = listMissionPresetCatalog(live({
      targetCancellationSupported: false,
    }));
    const supply = result.presets.find((preset) => preset.id === 'supply-chain-risk');
    assert.ok(supply);
    assert.equal(supply.monitorCompatible, true);
    assert.equal(supply.entitled, true);
    assert.equal(supply.available, false);
    assert.equal(supply.unavailableReason, 'target_cancellation_unsupported');
  });

  it('keeps list output under budget for every monitor without a cancellation flag', () => {
    for (const variant of SITE_VARIANTS) {
      const result = listMissionPresetCatalog(live({ variant }));
      const serialized = JSON.stringify(result);
      assert.ok(
        serialized.length <= 1_500,
        `${variant} catalog is ${serialized.length} chars`,
      );
      assert.ok(result.presets.some((preset) => preset.available));
    }
  });

  it('filters available=true to eligible presets only', () => {
    const result = listMissionPresetCatalog(live({ variant: 'happy' }), { available: true });
    assert.ok(result.presets.every((preset) => preset.available));
    assert.ok(result.presets.some((preset) => preset.id === 'good-news-explorer'));
    assert.ok(!result.presets.some((preset) => preset.id === 'crisis-desk'));
  });

  it('evaluates compatibility for every bundled preset on every monitor', () => {
    for (const variant of SITE_VARIANTS) {
      for (const preset of MISSION_PRESETS) {
        const compatible = isMissionPresetMonitorCompatible(preset.id, variant);
        const decision = evaluateMissionPresetApply(preset.id, live({ variant }));
        if (compatible) {
          assert.equal(decision.ok, true, `${variant}/${preset.id}`);
        } else {
          assert.equal(decision.ok, false, `${variant}/${preset.id}`);
          assert.equal(decision.reason, 'preset_incompatible', `${variant}/${preset.id}`);
        }
      }
    }
    assert.ok(MISSION_PRESET_MIN_PANEL_MATCHES >= 2);
  });

  it('rejects unknown and malformed preset ids before application', () => {
    assert.deepEqual(evaluateMissionPresetApply('', live()).reason, 'malformed_arguments');
    assert.deepEqual(evaluateMissionPresetApply(null, live()).reason, 'malformed_arguments');
    assert.deepEqual(evaluateMissionPresetApply('custom-user-preset', live()).reason, 'unknown_preset');
  });
});

describe('webmcp mission preset apply outcomes', () => {
  it('reports success when the app is destroyed after the apply commits', () => {
    const ctx = makeApplyContext();
    let applyCalls = 0;
    const result = applyWebMcpMissionPreset(ctx, 'full', 'supply-chain-risk', {
      hasPremium: true,
      apply: (id) => {
        applyCalls += 1;
        assert.equal(id, 'supply-chain-risk');
        ctx.isDestroyed = true;
        return { changed: true, priorPresetId: null };
      },
    });
    assert.equal(applyCalls, 1);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'applied');
    assert.equal(result.presetId, 'supply-chain-risk');
    assert.equal(result.changed, true);
    assert.equal(result.map, undefined);
  });

  it('reports success when post-commit context snapshot fails', () => {
    const ctx = makeApplyContext({ map: null });
    let applyCalls = 0;
    const result = applyWebMcpMissionPreset(ctx, 'full', 'supply-chain-risk', {
      hasPremium: true,
      apply: (id) => {
        applyCalls += 1;
        assert.equal(id, 'supply-chain-risk');
        return { changed: true, priorPresetId: null };
      },
    });
    assert.equal(applyCalls, 1);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'applied');
    assert.equal(result.presetId, 'supply-chain-risk');
    assert.equal(result.map, undefined);
    assert.equal(result.panels, undefined);
  });

  it('denies apply_failed with the stable rollback message and hides private exception text', () => {
    const ctx = makeApplyContext();
    const privateDetail = 'localStorage.getItem("mission-preset") failed at querySelector(#mission-root) callback';
    const result = applyWebMcpMissionPreset(ctx, 'full', 'supply-chain-risk', {
      hasPremium: true,
      apply: () => {
        throw new Error(privateDetail);
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'denied');
    assert.equal(result.reason, 'apply_failed');
    assert.equal(result.message, 'Mission preset application failed and was rolled back.');
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(privateDetail), false);
    assert.equal(serialized.includes('localStorage'), false);
    assert.equal(serialized.includes('querySelector'), false);
  });
});

describe('webmcp mission preset tools', () => {
  it('classifies list/open/apply cancellation policies', () => {
    assert.equal(WEBMCP_TOOL_CANCELLATION_POLICY[WEBMCP_SPA_TOOL.listMissionPresets], 'read-only');
    assert.equal(WEBMCP_TOOL_CANCELLATION_POLICY[WEBMCP_SPA_TOOL.openMissionPicker], 'view-state');
    assert.equal(
      WEBMCP_TOOL_CANCELLATION_POLICY[WEBMCP_SPA_TOOL.applyMissionPreset],
      'cancellation-required',
    );
    assert.equal(CANCELLATION_REQUIRED_WEBMCP_TOOLS.has(WEBMCP_SPA_TOOL.applyMissionPreset), true);
  });

  it('denies apply_mission_preset without a target-side AbortSignal', async () => {
    let applyCalls = 0;
    const tools = buildWebMcpTools({
      openCountryBriefByCode: async () => true,
      resolveCountryName: () => 'Germany',
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
        panels: { mounted: [], enabled: [] },
      }),
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
      switchMonitor: async () => ({
        ok: true,
        status: 'applied',
        destination: 'full',
        navigation: 'none',
        message: 'Already on that monitor.',
        context: {
          variant: 'full',
          map: {
            view: 'global',
            center: null,
            zoom: 2,
            timeRange: '7d',
            enabledLayers: [],
          },
          panels: { mounted: [], enabled: [] },
        },
      }),
      openSettings: async () => ({
        ok: true,
        status: 'applied',
        destination: 'settings',
        overlay: 'open',
        message: 'Opened settings.',
        context: {
          variant: 'full',
          map: {
            view: 'global',
            center: null,
            zoom: 2,
            timeRange: '7d',
            enabledLayers: [],
          },
          panels: { mounted: [], enabled: [] },
        },
      }),
      openAlerts: async () => ({
        ok: true,
        status: 'applied',
        destination: 'alerts',
        overlay: 'open',
        message: 'Opened alerts.',
        context: {
          variant: 'full',
          map: {
            view: 'global',
            center: null,
            zoom: 2,
            timeRange: '7d',
            enabledLayers: [],
          },
          panels: { mounted: [], enabled: [] },
        },
      }),
      applyDashboardAction: async () => ({
        ok: true,
        status: 'applied',
        actionType: 'set_view',
        message: 'Applied.',
        targets: [],
      }),
      searchDashboard: async () => ({
        queryLength: 0,
        results: [],
        resultCount: 0,
        truncated: false,
      }),
      openSearchResult: async () => ({ ok: true, status: 'opened' }),
      applyDashboardTabAction: async () => ({
        activeTabId: 'tab-main01-abc123',
        tabs: [],
        tabCount: 0,
        tabsTruncated: false,
        canCreate: true,
        cap: null,
      }),
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
      applyMissionPreset: async () => {
        applyCalls += 1;
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
            center: null,
            zoom: 2,
            timeRange: '7d',
            enabledLayers: [],
          },
          panels: { mounted: [], enabled: [] },
        },
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
          enabledPanels: { used: 0, cap: 40 },
          dashboardTabs: { used: 1, cap: 3, canCreate: true },
        },
      }),
      openSignIn: async () => ({ ok: false, status: 'denied', reason: 'clerk_unavailable' }),
    });

    const applyTool = tools.find((tool) => tool.name === WEBMCP_SPA_TOOL.applyMissionPreset);
    assert.ok(applyTool);
    const denied = await applyTool.execute({ presetId: 'supply-chain-risk' });
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'target_cancellation_unsupported');
    assert.equal(applyCalls, 0);

    const applied = await applyTool.execute(
      { presetId: 'supply-chain-risk' },
      { signal: new AbortController().signal },
    );
    assert.equal(applied.ok, true);
    assert.equal(applied.presetId, 'supply-chain-risk');
    assert.equal(applyCalls, 1);

    const listTool = tools.find((tool) => tool.name === WEBMCP_SPA_TOOL.listMissionPresets);
    assert.ok(listTool);
    const listed = await listTool.execute({});
    assert.equal(listed.ok, true);
  });
});
