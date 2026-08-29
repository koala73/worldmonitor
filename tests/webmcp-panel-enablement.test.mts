import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applySetPanelEnabled,
  isCatalogPanelLive,
  waitUntilPanelLive,
} from '../src/app/panel-enablement.ts';
import {
  ALL_PANELS,
  FREE_MAX_PANELS,
  countFreePanelCapUsage,
  getInitialPanelSettingsForVariant,
  isFreePanelCapCounted,
  isPanelNativeToVariant,
} from '../src/config/panels.ts';
import {
  evaluateSetPanelEnabled,
} from '../src/config/panel-enablement.ts';
import type { PanelConfig } from '../src/types/index.ts';
import {
  buildWebMcpTools as buildProductionWebMcpTools,
} from '../src/services/webmcp.ts';

function cloneSettings(variant: string): Record<string, PanelConfig> {
  return structuredClone(getInitialPanelSettingsForVariant(variant));
}

function settingsWithFreeSlots(
  variant: string,
  extras: Record<string, Partial<PanelConfig>> = {},
): Record<string, PanelConfig> {
  const settings = cloneSettings(variant);
  let counted = 0;
  for (const [key, config] of Object.entries(settings)) {
    if (!isFreePanelCapCounted(key)) continue;
    if (counted < 5 && config.enabled) {
      counted += 1;
      continue;
    }
    config.enabled = false;
  }
  for (const [key, patch] of Object.entries(extras)) {
    settings[key] = { ...settings[key]!, ...patch };
  }
  return settings;
}

function settingsAtFreeCap(
  variant: string,
  leaveDisabled: string,
): Record<string, PanelConfig> {
  const settings = cloneSettings(variant);
  let counted = 0;
  for (const [key, config] of Object.entries(settings)) {
    if (key === leaveDisabled) {
      config.enabled = false;
      continue;
    }
    if (!isFreePanelCapCounted(key)) continue;
    if (counted < FREE_MAX_PANELS) {
      config.enabled = true;
      counted += 1;
    } else {
      config.enabled = false;
    }
  }
  assert.equal(countFreePanelCapUsage(settings), FREE_MAX_PANELS);
  assert.equal(settings[leaveDisabled]?.enabled, false);
  return settings;
}

function evaluate(overrides: {
  panelId?: unknown;
  enabled?: unknown;
  panelSettings?: Record<string, PanelConfig>;
  variant?: string;
  isPro?: boolean;
  isPanelAllowed?: (panelId: string, config: PanelConfig) => boolean;
}) {
  const variant = overrides.variant ?? 'full';
  return evaluateSetPanelEnabled({
    panelId: overrides.panelId ?? 'windy-webcams',
    enabled: overrides.enabled ?? true,
    panelSettings: overrides.panelSettings ?? cloneSettings(variant),
    variant,
    isPro: overrides.isPro ?? false,
    isPanelAllowed: overrides.isPanelAllowed,
  });
}

describe('isPanelNativeToVariant', () => {
  it('treats catalog keys as native only to the monitors that define them', () => {
    assert.equal(isPanelNativeToVariant('markets', 'full'), true);
    assert.equal(isPanelNativeToVariant('markets', 'happy'), false);
    assert.equal(isPanelNativeToVariant('positive-feed', 'happy'), true);
    assert.equal(isPanelNativeToVariant('positive-feed', 'full'), false);
    assert.equal(isPanelNativeToVariant('giving', 'full'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(ALL_PANELS, 'positive-feed'), true);
  });
});

describe('evaluateSetPanelEnabled', () => {
  it('enables a native disabled panel', () => {
    const panelSettings = settingsWithFreeSlots('full');
    assert.equal(panelSettings['windy-webcams']?.enabled, false);
    const result = evaluate({ panelSettings, panelId: 'windy-webcams', enabled: true });
    assert.deepEqual(result, {
      ok: true,
      status: 'applied',
      panelId: 'windy-webcams',
      requestedEnabled: true,
      effectiveEnabled: true,
      changed: true,
      message: 'Panel enabled.',
    });
  });

  it('disables a native enabled panel', () => {
    const panelSettings = cloneSettings('full');
    assert.equal(panelSettings.markets?.enabled, true);
    const result = evaluate({ panelSettings, panelId: 'markets', enabled: false });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'applied');
    assert.equal(result.changed, true);
    assert.equal(result.effectiveEnabled, false);
    assert.equal(result.requestedEnabled, false);
    assert.equal(result.message, 'Panel disabled.');
  });

  it('treats repeats as success with no change', () => {
    const panelSettings = cloneSettings('full');
    const stillOff = evaluate({
      panelSettings,
      panelId: 'windy-webcams',
      enabled: false,
    });
    assert.equal(stillOff.ok, true);
    assert.equal(stillOff.changed, false);
    assert.equal(stillOff.effectiveEnabled, false);
    assert.equal(stillOff.message, 'Panel already disabled.');

    const stillOn = evaluate({
      panelSettings,
      panelId: 'markets',
      enabled: true,
    });
    assert.equal(stillOn.ok, true);
    assert.equal(stillOn.changed, false);
    assert.equal(stillOn.effectiveEnabled, true);
    assert.equal(stillOn.message, 'Panel already enabled.');
  });

  it('no-ops a cross-variant panel that is already in the requested state', () => {
    const panelSettings = cloneSettings('full');
    panelSettings['positive-feed'] = {
      ...panelSettings['positive-feed']!,
      enabled: true,
    };
    const result = evaluate({
      panelSettings,
      panelId: 'positive-feed',
      enabled: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(result.reason, undefined);
  });

  it('refuses to enable a panel that is not native to the current monitor', () => {
    const full = evaluate({
      variant: 'full',
      panelId: 'positive-feed',
      enabled: true,
    });
    assert.equal(full.ok, false);
    assert.equal(full.status, 'denied');
    assert.equal(full.reason, 'panel_incompatible');
    assert.equal(full.changed, false);
    assert.equal(full.effectiveEnabled, false);

    const happy = evaluate({
      variant: 'happy',
      panelId: 'markets',
      enabled: true,
    });
    assert.equal(happy.reason, 'panel_incompatible');
    assert.equal(happy.effectiveEnabled, false);
  });

  it('allows disabling a non-native panel that is currently enabled', () => {
    const panelSettings = cloneSettings('happy');
    panelSettings.markets = {
      name: 'Markets',
      enabled: true,
      priority: 1,
    };
    const result = evaluate({
      variant: 'happy',
      panelSettings,
      panelId: 'markets',
      enabled: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.effectiveEnabled, false);
  });

  it('refuses unentitled enable but still allows disable of a live panel', () => {
    const panelSettings = cloneSettings('full');
    panelSettings['stock-analysis'] = {
      ...panelSettings['stock-analysis']!,
      enabled: false,
    };
    const deniedEnable = evaluate({
      panelSettings,
      panelId: 'stock-analysis',
      enabled: true,
      isPanelAllowed: () => false,
    });
    assert.equal(deniedEnable.reason, 'panel_not_entitled');
    assert.equal(deniedEnable.ok, false);
    assert.equal(deniedEnable.effectiveEnabled, false);

    panelSettings['stock-analysis']!.enabled = true;
    const allowedDisable = evaluate({
      panelSettings,
      panelId: 'stock-analysis',
      enabled: false,
      isPanelAllowed: () => false,
    });
    assert.equal(allowedDisable.ok, true);
    assert.equal(allowedDisable.changed, true);
    assert.equal(allowedDisable.effectiveEnabled, false);
    assert.equal(allowedDisable.reason, undefined);
  });

  it('refuses a free-tier enable that would exceed the panel cap', () => {
    const panelSettings = settingsAtFreeCap('full', 'windy-webcams');
    const result = evaluate({
      panelSettings,
      panelId: 'windy-webcams',
      enabled: true,
      isPro: false,
    });
    assert.equal(result.reason, 'panel_cap_exceeded');
    assert.equal(result.ok, false);
    assert.equal(result.changed, false);
    assert.equal(result.effectiveEnabled, false);
  });

  it('does not count the map panel against the free-tier cap', () => {
    const panelSettings = settingsAtFreeCap('full', 'map');
    const result = evaluate({
      panelSettings,
      panelId: 'map',
      enabled: true,
      isPro: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.reason, undefined);
  });

  it('lets a Pro session enable past the free-tier cap', () => {
    const panelSettings = settingsAtFreeCap('full', 'windy-webcams');
    const result = evaluate({
      panelSettings,
      panelId: 'windy-webcams',
      enabled: true,
      isPro: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
  });

  it('rejects unknown, runtime, and malformed identifiers before mutation policy', () => {
    assert.equal(evaluate({ panelId: 'not-a-real-panel' }).reason, 'unknown_panel');
    assert.equal(evaluate({ panelId: 'cw-custom-1' }).reason, 'unknown_panel');
    assert.equal(evaluate({ panelId: 'mcp-remote-1' }).reason, 'unknown_panel');
    assert.equal(evaluate({ panelId: 'Markets' }).reason, 'malformed_arguments');
    assert.equal(evaluate({ panelId: '.markets' }).reason, 'malformed_arguments');
    assert.equal(evaluate({ panelId: 'a'.repeat(97) }).reason, 'malformed_arguments');
    assert.equal(evaluate({ panelId: 12 }).reason, 'malformed_arguments');
    assert.equal(evaluate({ enabled: 'true' }).reason, 'malformed_arguments');
    assert.equal(evaluate({ panelId: 'Markets' }).status, 'invalid');
  });

  it('treats a catalog panel missing from settings as currently disabled', () => {
    const panelSettings = settingsWithFreeSlots('full');
    delete panelSettings['windy-webcams'];
    const result = evaluate({ panelSettings, panelId: 'windy-webcams', enabled: true });
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.effectiveEnabled, true);
  });

  it('denies enable when stored premium metadata is stripped but the catalog marks the panel premium', () => {
    const panelSettings = settingsWithFreeSlots('full');
    const stored = { ...panelSettings['stock-analysis']!, enabled: false };
    delete stored.premium;
    panelSettings['stock-analysis'] = stored;
    assert.equal(stored.premium, undefined);

    const result = evaluate({
      panelSettings,
      panelId: 'stock-analysis',
      enabled: true,
      isPro: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'denied');
    assert.equal(result.reason, 'panel_not_entitled');
    assert.equal(result.changed, false);
    assert.equal(result.effectiveEnabled, false);
    assert.equal(panelSettings['stock-analysis']?.enabled, false);
    assert.equal(panelSettings['stock-analysis']?.premium, undefined);
  });

  it('passes catalog config to the entitlement callback, not the stored entry', () => {
    const panelSettings = settingsWithFreeSlots('full');
    const stored = { ...panelSettings['stock-analysis']!, enabled: false };
    delete stored.premium;
    panelSettings['stock-analysis'] = stored;
    let seenPremium: PanelConfig['premium'] | undefined;
    const result = evaluate({
      panelSettings,
      panelId: 'stock-analysis',
      enabled: true,
      isPro: false,
      isPanelAllowed: (_id, config) => {
        seenPremium = config.premium;
        return Boolean(config.premium) === false;
      },
    });
    assert.equal(seenPremium, 'locked');
    assert.equal(result.reason, 'panel_not_entitled');
    assert.equal(stored.premium, undefined);
  });
});

describe('applySetPanelEnabled', () => {
  it('persists an enable through the same user-set path and skips persist on no-op', () => {
    const panelSettings = settingsWithFreeSlots('full');
    const persistCalls: Record<string, PanelConfig>[] = [];
    let applyCount = 0;
    let toggleCount = 0;
    let fetchCount = 0;
    let toastCount = 0;
    let refreshCount = 0;
    const deps = {
      variant: 'full',
      isPro: false,
      persist: (settings: Record<string, PanelConfig>) => {
        persistCalls.push(structuredClone(settings));
      },
      applyPanelSettings: () => {
        applyCount += 1;
      },
      trackToggle: () => {
        toggleCount += 1;
      },
      showCapToast: () => {
        toastCount += 1;
      },
    };
    const panels = {
      'windy-webcams': { fetchData: () => { fetchCount += 1; } },
    };
    const unifiedSettings = {
      refreshPanelToggles: () => {
        refreshCount += 1;
      },
    };

    const first = applySetPanelEnabled(
      { panelSettings, panels, unifiedSettings },
      'windy-webcams',
      true,
      deps,
    );
    assert.equal(first.changed, true);
    assert.equal(panelSettings['windy-webcams']?.enabled, true);
    assert.equal(panelSettings['windy-webcams']?.proGated, undefined);
    assert.equal(persistCalls.length, 1);
    assert.equal(persistCalls[0]?.['windy-webcams']?.enabled, true);
    assert.equal(applyCount, 1);
    assert.equal(toggleCount, 1);
    assert.equal(fetchCount, 1);
    assert.equal(refreshCount, 1);
    assert.equal(toastCount, 0);

    const repeat = applySetPanelEnabled(
      { panelSettings, panels, unifiedSettings },
      'windy-webcams',
      true,
      deps,
    );
    assert.equal(repeat.changed, false);
    assert.equal(persistCalls.length, 1);
    assert.equal(applyCount, 1);
    assert.equal(toggleCount, 1);
    assert.equal(fetchCount, 1);
    assert.equal(refreshCount, 1);
  });

  it('still returns applied when fetchData throws or rejects after persist', async () => {
    const panelSettings = settingsWithFreeSlots('full');
    let persistCount = 0;
    const deps = {
      variant: 'full',
      isPro: false,
      persist: () => {
        persistCount += 1;
      },
      applyPanelSettings: () => {},
      trackToggle: () => {},
    };
    const thrown = applySetPanelEnabled(
      {
        panelSettings,
        panels: {
          'windy-webcams': {
            fetchData: () => {
              throw new Error('fetch failed');
            },
          },
        },
      },
      'windy-webcams',
      true,
      deps,
    );
    assert.equal(thrown.ok, true);
    assert.equal(thrown.changed, true);
    assert.equal(persistCount, 1);

    panelSettings['windy-webcams']!.enabled = false;
    const rejected = applySetPanelEnabled(
      {
        panelSettings,
        panels: {
          'windy-webcams': {
            fetchData: () => Promise.reject(new Error('async fetch failed')),
          },
        },
      },
      'windy-webcams',
      true,
      deps,
    );
    assert.equal(rejected.ok, true);
    assert.equal(rejected.changed, true);
    await Promise.resolve();
    await Promise.resolve();
  });

  it('persists a disable without deleting the catalog entry', () => {
    const panelSettings = cloneSettings('full');
    const persistCalls: Record<string, PanelConfig>[] = [];
    const result = applySetPanelEnabled(
      { panelSettings },
      'markets',
      false,
      {
        variant: 'full',
        isPro: false,
        persist: (settings) => persistCalls.push(structuredClone(settings)),
        applyPanelSettings: () => {},
        trackToggle: () => {},
      },
    );
    assert.equal(result.changed, true);
    assert.equal(panelSettings.markets?.enabled, false);
    assert.ok(Object.prototype.hasOwnProperty.call(panelSettings, 'markets'));
    assert.equal(persistCalls.length, 1);
  });

  it('fails closed before changing live state when persistence fails', () => {
    const panelSettings = settingsWithFreeSlots('full');
    let applyCount = 0;
    let toggleCount = 0;
    const result = applySetPanelEnabled(
      { panelSettings },
      'windy-webcams',
      true,
      {
        variant: 'full',
        isPro: false,
        persist: () => false,
        applyPanelSettings: () => { applyCount += 1; },
        trackToggle: () => { toggleCount += 1; },
      },
    );

    assert.deepEqual(result, {
      ok: false,
      status: 'denied',
      panelId: 'windy-webcams',
      requestedEnabled: true,
      effectiveEnabled: false,
      changed: false,
      reason: 'persist_failed',
      message: 'Dashboard panel change could not be saved.',
    });
    assert.equal(panelSettings['windy-webcams']?.enabled, false);
    assert.equal(applyCount, 0);
    assert.equal(toggleCount, 0);
  });

  it('does not persist entitlement, cap, or unknown refusals', () => {
    const panelSettings = settingsAtFreeCap('full', 'windy-webcams');
    let persistCount = 0;
    const deps = {
      variant: 'full',
      isPro: false,
      persist: () => {
        persistCount += 1;
      },
      applyPanelSettings: () => {},
      trackToggle: () => {},
      showCapToast: () => {},
      isPanelAllowed: () => true,
    };

    const cap = applySetPanelEnabled(
      { panelSettings },
      'windy-webcams',
      true,
      deps,
    );
    assert.equal(cap.reason, 'panel_cap_exceeded');
    assert.equal(panelSettings['windy-webcams']?.enabled, false);

    const unknown = applySetPanelEnabled(
      { panelSettings },
      'not-a-real-panel',
      true,
      deps,
    );
    assert.equal(unknown.reason, 'unknown_panel');
    assert.equal(persistCount, 0);

    const unentitledSettings = settingsWithFreeSlots('full');
    unentitledSettings['stock-analysis'] = {
      ...unentitledSettings['stock-analysis']!,
      enabled: false,
    };
    const unentitled = applySetPanelEnabled(
      { panelSettings: unentitledSettings },
      'stock-analysis',
      true,
      {
        ...deps,
        isPanelAllowed: () => false,
      },
    );
    assert.equal(unentitled.reason, 'panel_not_entitled');
    assert.equal(unentitledSettings['stock-analysis']?.enabled, false);
    assert.equal(persistCount, 0);

    const stalePremiumSettings = settingsWithFreeSlots('full');
    const staleStored = { ...stalePremiumSettings['stock-analysis']!, enabled: false };
    delete staleStored.premium;
    stalePremiumSettings['stock-analysis'] = staleStored;
    const stale = applySetPanelEnabled(
      { panelSettings: stalePremiumSettings },
      'stock-analysis',
      true,
      {
        variant: 'full',
        isPro: false,
        persist: () => {
          persistCount += 1;
        },
        applyPanelSettings: () => {},
        trackToggle: () => {},
      },
    );
    assert.equal(stale.reason, 'panel_not_entitled');
    assert.equal(stalePremiumSettings['stock-analysis']?.enabled, false);
    assert.equal(persistCount, 0);
  });

  it('shows the free-tier cap toast only when the cap blocks an enable', () => {
    const panelSettings = settingsAtFreeCap('full', 'windy-webcams');
    let toastCount = 0;
    applySetPanelEnabled(
      { panelSettings },
      'windy-webcams',
      true,
      {
        variant: 'full',
        isPro: false,
        persist: () => {},
        applyPanelSettings: () => {},
        trackToggle: () => {},
        showCapToast: () => {
          toastCount += 1;
        },
      },
    );
    assert.equal(toastCount, 1);
  });
});

describe('set_panel_enabled WebMCP adapter', () => {
  it('rejects extra keys and missing cancellation before the binding', async () => {
    let calls = 0;
    const tools = buildProductionWebMcpTools({
      openCountryBriefByCode: async () => true,
      resolveCountryName: (code: string) => `Country ${code}`,
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
      applyDashboardAction: async (action: { type: string }) => ({
        ok: true,
        status: 'applied' as const,
        actionType: action.type as 'open_panel',
        message: 'Applied.',
        targets: [],
      }),
      searchDashboard: async (query: string) => ({
        queryLength: query.length,
        results: [],
        resultCount: 0,
        truncated: false,
      }),
      openSearchResult: async () => ({ ok: true, status: 'opened' as const }),
      setPanelEnabled: async () => {
        calls += 1;
        return {
          ok: true,
          status: 'applied' as const,
          panelId: 'giving',
          requestedEnabled: true,
          effectiveEnabled: true,
          changed: true,
          message: 'Panel enabled.',
        };
      },
    }, () => {});
    const tool = tools.find((candidate) => candidate.name === 'set_panel_enabled');
    assert.ok(tool);

    const extraKeys = await tool.execute(
      { panelId: 'giving', enabled: true, selector: '#giving' },
      { signal: new AbortController().signal },
    );
    assert.equal((extraKeys as { reason?: string }).reason, 'malformed_arguments');
    assert.equal((extraKeys as { status?: string }).status, 'invalid');
    assert.equal(calls, 0);

    const noSignal = await tool.execute({ panelId: 'giving', enabled: true });
    assert.equal((noSignal as { reason?: string }).reason, 'target_cancellation_unsupported');
    assert.equal(calls, 0);

    const applied = await tool.execute(
      { panelId: 'giving', enabled: true },
      { signal: new AbortController().signal },
    );
    assert.equal((applied as { ok?: boolean }).ok, true);
    assert.equal(calls, 1);
  });

  it('preserves denial reasons and maps entitlement vs validation analytics', async () => {
    const events: Array<{ event: string; data?: { outcome?: string; reason?: string; tool?: string } }> = [];
    const tools = buildProductionWebMcpTools({
      openCountryBriefByCode: async () => true,
      resolveCountryName: (code: string) => `Country ${code}`,
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
      applyDashboardAction: async (action: { type: string }) => ({
        ok: true,
        status: 'applied' as const,
        actionType: action.type as 'open_panel',
        message: 'Applied.',
        targets: [],
      }),
      searchDashboard: async (query: string) => ({
        queryLength: query.length,
        results: [],
        resultCount: 0,
        truncated: false,
      }),
      openSearchResult: async () => ({ ok: true, status: 'opened' as const }),
      setPanelEnabled: async (panelId) => {
        if (panelId === 'stock-analysis') {
          return {
            ok: false,
            status: 'denied' as const,
            panelId: 'stock-analysis',
            requestedEnabled: true,
            effectiveEnabled: false,
            changed: false,
            reason: 'panel_not_entitled' as const,
            message: 'Panel is not available on this plan.',
          };
        }
        if (panelId === 'not-a-real-panel') {
          return {
            ok: false,
            status: 'denied' as const,
            panelId: 'not-a-real-panel',
            requestedEnabled: true,
            effectiveEnabled: false,
            changed: false,
            reason: 'unknown_panel' as const,
            message: 'Unknown panel.',
          };
        }
        return {
          ok: false,
          status: 'denied' as const,
          panelId: String(panelId),
          requestedEnabled: true,
          effectiveEnabled: false,
          changed: false,
          reason: 'panel_incompatible' as const,
          message: 'Panel is not available on this monitor.',
        };
      },
    }, (event, data) => events.push({ event, data }));
    const tool = tools.find((candidate) => candidate.name === 'set_panel_enabled');
    assert.ok(tool);
    const signal = { signal: new AbortController().signal };

    const unentitled = await tool.execute({ panelId: 'stock-analysis', enabled: true }, signal);
    assert.equal((unentitled as { status?: string }).status, 'denied');
    assert.equal((unentitled as { reason?: string }).reason, 'panel_not_entitled');
    assert.equal(events.at(-1)?.data?.outcome, 'denied');
    assert.equal(events.at(-1)?.data?.reason, 'entitlement');

    const unknown = await tool.execute({ panelId: 'not-a-real-panel', enabled: true }, signal);
    assert.equal((unknown as { reason?: string }).reason, 'unknown_panel');
    assert.equal(events.at(-1)?.data?.reason, 'validation');

    const incompatible = await tool.execute({ panelId: 'positive-feed', enabled: true }, signal);
    assert.equal((incompatible as { reason?: string }).reason, 'panel_incompatible');
    assert.equal(events.at(-1)?.data?.reason, 'unavailable');
  });
});

describe('waitUntilPanelLive', () => {
  it('does not treat a registered but disconnected instance as live', () => {
    assert.equal(isCatalogPanelLive('giving', { giving: {} }), false);
    assert.equal(
      isCatalogPanelLive('giving', { giving: { getElement: () => ({ isConnected: false }) } }),
      false,
    );
    assert.equal(isCatalogPanelLive('giving', {}), false);
  });

  it('treats a connected panel instance as live', () => {
    assert.equal(
      isCatalogPanelLive('giving', { giving: { getElement: () => ({ isConnected: true }) } }),
      true,
    );
  });

  it('treats a connected non-deferred data-panel node as live', () => {
    const previousDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = {
      querySelector: (selector: string) => {
        if (selector.includes('[data-panel="giving"]') && selector.includes(':not([data-deferred-panel])')) {
          return { isConnected: true };
        }
        return null;
      },
    };
    try {
      assert.equal(isCatalogPanelLive('giving', {}), true);
      assert.equal(
        isCatalogPanelLive('giving', { giving: { getElement: () => ({ isConnected: false }) } }),
        true,
      );
    } finally {
      if (previousDocument === undefined) {
        Reflect.deleteProperty(globalThis, 'document');
      } else {
        (globalThis as { document?: unknown }).document = previousDocument;
      }
    }
  });

  it('resolves immediately when the panel is already live', async () => {
    const outcome = await waitUntilPanelLive({
      isLive: () => true,
      timeoutMs: 50,
      observe: () => () => {},
    });
    assert.equal(outcome, 'live');
  });

  it('resolves live when the panel appears before timeout', async () => {
    let live = false;
    let notify = (): void => {};
    const pending = waitUntilPanelLive({
      isLive: () => live,
      timeoutMs: 500,
      observe: (onChange) => {
        notify = onChange;
        return () => {};
      },
    });
    await Promise.resolve();
    live = true;
    notify();
    assert.equal(await pending, 'live');
  });

  it('times out without throwing when the panel never appears', async () => {
    const outcome = await waitUntilPanelLive({
      isLive: () => false,
      timeoutMs: 20,
      observe: () => () => {},
    });
    assert.equal(outcome, 'timeout');
  });

  it('rejects when the invocation is aborted during the wait', async () => {
    const controller = new AbortController();
    const pending = waitUntilPanelLive({
      isLive: () => false,
      signal: controller.signal,
      timeoutMs: 1_000,
      observe: () => () => {},
    });
    controller.abort();
    await assert.rejects(pending, (error: Error) => error.name === 'AbortError');
  });

  it('enable-then-destroy disconnects the observer and clears the timeout immediately', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const armed = new Set<ReturnType<typeof setTimeout>>();
    let stopCount = 0;
    let live = false;
    let notify = (): void => {};

    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const id = realSetTimeout(handler, timeout, ...args);
      armed.add(id);
      return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
      armed.delete(id as ReturnType<typeof setTimeout>);
      realClearTimeout(id);
    }) as typeof clearTimeout;

    const lifecycle = new AbortController();
    try {
      const pending = waitUntilPanelLive({
        isLive: () => live,
        signal: lifecycle.signal,
        timeoutMs: 30_000,
        observe: (onChange) => {
          notify = onChange;
          return () => {
            stopCount += 1;
          };
        },
      });
      await Promise.resolve();
      assert.equal(armed.size, 1, 'live wait must arm the timeout before destroy');
      assert.equal(stopCount, 0);

      // App.destroy() aborts the lifecycle signal; the waiter must settle and
      // drop both the MutationObserver and the 30s timer before replacement
      // DOM can look live.
      lifecycle.abort();
      await assert.rejects(pending, (error: Error) => error.name === 'AbortError');
      assert.equal(stopCount, 1, 'observer must disconnect on destroy');
      assert.equal(armed.size, 0, 'timeout must clear on destroy');

      live = true;
      notify();
      await Promise.resolve();
      assert.equal(stopCount, 1, 'late mutations must not re-arm or re-stop the observer');
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });
});
