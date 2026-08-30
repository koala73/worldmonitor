import type { AppContext } from './app-context';
import {
  DashboardBindingError,
  raceWebMcpAbort,
  throwIfWebMcpAborted,
  type DashboardActionResult,
  type DashboardContextSnapshot,
  type WebMcpMonitorKey,
  type WebMcpNavigationResult,
} from '@/services/webmcp';
import {
  normalizeCatalogVariant,
  type MapLayerCatalogSnapshot,
} from '@/services/webmcp-map-layer-catalog';
import type { MapLayerRuntimeAvailability } from '@/services/map-layer-runtime-availability';
import {
  listDashboardPanelCatalog,
  type DashboardPanelCatalogPage,
  type DashboardPanelCatalogQuery,
} from '@/services/webmcp-panel-catalog';
import {
  evaluateMissionPresetApply,
  listMissionPresetCatalog,
  type MissionPresetCatalogQuery,
  type MissionPresetCatalogResult,
} from '@/services/webmcp-mission-preset-catalog';
import {
  getMissionPreset,
  loadStoredMissionPreset,
  type MissionPresetId,
} from '@/services/mission-presets';
import type { ApplyMissionPresetResult } from '@/services/webmcp';
import { WEBMCP_MISSION_PICKER_REASON } from '@/config/webmcp';
import type { PanelConfig } from '@/types';
import type { AgentBusApplierOptions } from './agent-bus-applier';
import type { RendererKind } from '@/config/map-layer-definitions';
import { currentDashboardMapMode } from './map-dimension-control';

const APP_DESTROYED_RESULT: DashboardActionResult = {
  ok: false,
  status: 'denied',
  reason: 'app_destroyed',
  message: 'Dashboard is no longer available.',
  targets: [],
};

// Tools are intentionally discoverable before Phase 4 finishes. Production
// cold boots have exceeded the former 10-second bound, so keep this separate
// from shorter renderer/action waits and large enough for the supported
// pre-ready invocation contract while still failing a genuinely stuck boot.
export const WEBMCP_UI_READY_TIMEOUT_MS = 30_000;

function interruptedViewportResult(
  result: DashboardActionResult,
  reason: 'viewport_superseded' | 'renderer_changed' | 'viewport_interrupted',
): DashboardActionResult {
  return {
    ...result,
    ok: false,
    status: 'denied',
    reason,
    message: reason === 'viewport_superseded'
      ? 'Map movement was superseded by a newer viewport action.'
      : reason === 'renderer_changed'
        ? 'Map renderer changed before the movement completed.'
        : 'Map movement was interrupted before it completed.',
    targets: result.targets.map((target) => ({ ...target, status: 'denied', reason })),
  };
}

export function getWebMcpDashboardContext(
  ctx: AppContext,
  variant: string,
): DashboardContextSnapshot {
  if (ctx.isDestroyed) {
    throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
  }
  if (!ctx.map) {
    throw new DashboardBindingError('map_unavailable', 'Map is not available.');
  }

  const mapState = ctx.map.getState();
  const center = ctx.map.getCenter();

  return {
    variant,
    map: {
      view: mapState.view,
      center,
      zoom: mapState.zoom,
      mode: currentDashboardMapMode(ctx),
      timeRange: mapState.timeRange,
      enabledLayers: Object.entries(mapState.layers)
        .filter(([, enabled]) => enabled === true)
        .map(([layer]) => layer),
    },
    panels: {
      mounted: Object.keys(ctx.panels),
      enabled: Object.entries(ctx.panelSettings)
        .filter(([, config]) => config.enabled === true)
        .map(([panelId]) => panelId),
    },
  };
}

export function getWebMcpMapLayerCatalogSnapshot(
  ctx: AppContext,
  variant: string,
  hasPremium: boolean,
  tFn?: (key: string) => string,
  runtimeAvailability?: MapLayerRuntimeAvailability,
): MapLayerCatalogSnapshot {
  if (ctx.isDestroyed) {
    throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
  }
  if (!ctx.map) {
    throw new DashboardBindingError('map_unavailable', 'Map is not available.');
  }

  const mapState = ctx.map.getState();
  const rendererKind: RendererKind = ctx.map.isGlobeMode?.()
    ? 'globe'
    : ctx.map.isDeckGLActive?.() ? 'deck' : 'svg';
  return {
    variant: normalizeCatalogVariant(variant),
    rendererKind,
    enabledLayers: Object.entries(mapState.layers)
      .filter(([, enabled]) => enabled === true)
      .map(([layer]) => layer),
    liveLayerKeys: Object.keys(ctx.mapLayers),
    ...(runtimeAvailability ? { runtimeAvailability } : {}),
    hasPremium,
    deckGlActive: Boolean(ctx.map.isDeckGLActive?.()),
    ...(tFn ? { tFn } : {}),
  };
}

export function listWebMcpDashboardPanels(
  ctx: AppContext,
  variant: string,
  query: DashboardPanelCatalogQuery,
  options: { isPanelAllowed: (panelId: string, config: PanelConfig) => boolean },
): DashboardPanelCatalogPage {
  if (ctx.isDestroyed) {
    throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
  }
  return listDashboardPanelCatalog({
    currentVariant: variant,
    panelSettings: ctx.panelSettings,
    mountedIds: new Set(Object.keys(ctx.panels)),
    isPanelAllowed: options.isPanelAllowed,
  }, query);
}

export async function waitForWebMcpUiReady(
  uiReady: Promise<void>,
  appDestroyed: Promise<void>,
  timeoutMs: number,
  target = 'UI',
  signal?: AbortSignal,
): Promise<void> {
  throwIfWebMcpAborted(signal);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rejectAbort: ((error: unknown) => void) | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${target} did not initialise within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const handleAbort = (): void => {
    try {
      throwIfWebMcpAborted(signal);
    } catch (error) {
      rejectAbort?.(error);
    }
  };
  signal?.addEventListener('abort', handleAbort, { once: true });
  try {
    const outcome = await Promise.race([
      uiReady.then(() => 'ready' as const),
      appDestroyed.then(() => 'destroyed' as const),
      timeout,
      aborted,
    ]);
    if (outcome === 'destroyed') {
      throw new Error('Dashboard is no longer available.');
    }
  } finally {
    if (timer !== null) clearTimeout(timer);
    signal?.removeEventListener('abort', handleAbort);
  }
}

export async function applyWebMcpDashboardAction(
  ctx: AppContext,
  action: unknown,
  options: AgentBusApplierOptions,
  signal?: AbortSignal,
): Promise<DashboardActionResult> {
  throwIfWebMcpAborted(signal);
  if (ctx.isDestroyed) return APP_DESTROYED_RESULT;

  // Keep the zod-backed agent-bus contract out of the eager dashboard entry.
  const { applyAgentBusAction } = await import('./agent-bus-applier');
  throwIfWebMcpAborted(signal);
  if (ctx.isDestroyed) return APP_DESTROYED_RESULT;
  const result = await raceWebMcpAbort(applyAgentBusAction(ctx, action, options), signal);
  if (
    result.ok
    && (result.actionType === 'set_view' || result.actionType === 'focus_country')
    && ctx.map
  ) {
    try {
      await raceWebMcpAbort(
        ctx.map.whenViewportSettled(result.viewportActionToken),
        signal,
      );
      throwIfWebMcpAborted(signal);
    } catch (error) {
      if (ctx.isDestroyed) return APP_DESTROYED_RESULT;
      if (error instanceof Error && error.name === 'ViewportTransitionError') {
        const reason = (error as Error & { reason?: string }).reason;
        if (reason === 'viewport_superseded'
          || reason === 'renderer_changed'
          || reason === 'viewport_interrupted') {
          return interruptedViewportResult(result, reason);
        }
      }
      throw error;
    }
    if (ctx.isDestroyed) return APP_DESTROYED_RESULT;
  }
  throwIfWebMcpAborted(signal);
  return result;
}

const EMPTY_NAV_CONTEXT: DashboardContextSnapshot = {
  variant: '',
  map: {
    view: '',
    center: null,
    zoom: 0,
    timeRange: '',
    enabledLayers: [],
  },
  panels: {
    mounted: [],
    enabled: [],
  },
};

function navigationContext(ctx: AppContext, variant: string): DashboardContextSnapshot {
  try {
    return getWebMcpDashboardContext(ctx, variant);
  } catch {
    return { ...EMPTY_NAV_CONTEXT, variant };
  }
}

const APP_DESTROYED_NAV_RESULT = (
  context: DashboardContextSnapshot,
): WebMcpNavigationResult => ({
  ok: false,
  status: 'denied',
  reason: 'app_destroyed',
  message: 'Dashboard is no longer available.',
  context,
});

export type WebMcpVisibleMonitorNavigation = 'none' | 'reload' | 'assign' | 'blocked' | 'unavailable';

export async function applyWebMcpSwitchMonitor(
  ctx: AppContext,
  currentVariant: string,
  monitor: WebMcpMonitorKey,
  navigate: (variant: WebMcpMonitorKey) => Promise<WebMcpVisibleMonitorNavigation>,
): Promise<WebMcpNavigationResult> {
  const context = navigationContext(ctx, currentVariant);
  if (ctx.isDestroyed) return APP_DESTROYED_NAV_RESULT(context);

  const navigation = await navigate(monitor);
  if (navigation === 'unavailable' || navigation === 'blocked') {
    return {
      ok: false,
      status: 'denied',
      destination: monitor,
      reason: 'unavailable',
      message: navigation === 'unavailable'
        ? 'That monitor is not available on this dashboard.'
        : 'World Monitor could not switch monitors.',
      context,
    };
  }

  return {
    ok: true,
    status: 'applied',
    destination: monitor,
    navigation,
    message: navigation === 'none' ? 'Already on that monitor.' : 'Switched monitor.',
    context: { ...navigationContext(ctx, currentVariant), variant: monitor },
  };
}

async function openUnifiedSettingsOverlay(
  ctx: AppContext,
  currentVariant: string,
  destination: 'settings' | 'alerts',
  tab: 'settings' | 'notifications',
): Promise<WebMcpNavigationResult> {
  const context = navigationContext(ctx, currentVariant);
  if (ctx.isDestroyed) return APP_DESTROYED_NAV_RESULT(context);
  if (!ctx.unifiedSettings) {
    return {
      ok: false,
      status: 'denied',
      destination,
      reason: 'unavailable',
      message: destination === 'alerts'
        ? 'Alerts are not available on this dashboard.'
        : 'Settings are not available on this dashboard.',
      context,
    };
  }
  const opened = await Promise.resolve(ctx.unifiedSettings.open(tab));
  if (ctx.isDestroyed) return APP_DESTROYED_NAV_RESULT(navigationContext(ctx, currentVariant));
  if (opened === false) {
    return {
      ok: false,
      status: 'denied',
      destination,
      reason: 'unavailable',
      message: destination === 'alerts'
        ? 'Alerts are not available on this dashboard.'
        : 'Settings are not available on this dashboard.',
      context: navigationContext(ctx, currentVariant),
    };
  }
  return {
    ok: true,
    status: 'applied',
    destination,
    overlay: 'open',
    tab,
    message: destination === 'alerts' ? 'Opened alerts.' : 'Opened settings.',
    context: navigationContext(ctx, currentVariant),
  };
}

export async function applyWebMcpOpenSettings(
  ctx: AppContext,
  currentVariant: string,
): Promise<WebMcpNavigationResult> {
  return openUnifiedSettingsOverlay(ctx, currentVariant, 'settings', 'settings');
}

export async function applyWebMcpOpenAlerts(
  ctx: AppContext,
  currentVariant: string,
): Promise<WebMcpNavigationResult> {
  const context = navigationContext(ctx, currentVariant);
  if (ctx.isDestroyed) return APP_DESTROYED_NAV_RESULT(context);
  if (ctx.isDesktopApp) {
    return {
      ok: false,
      status: 'denied',
      destination: 'alerts',
      reason: 'unavailable',
      message: 'Alerts are not available on this dashboard.',
      context,
    };
  }
  return openUnifiedSettingsOverlay(ctx, currentVariant, 'alerts', 'notifications');
}

export function listWebMcpMissionPresets(
  ctx: AppContext,
  variant: string,
  query: MissionPresetCatalogQuery = {},
  options: {
    hasPremium: boolean;
    targetCancellationSupported?: boolean;
    isPanelEntitled?: (panelId: string) => boolean;
  },
): MissionPresetCatalogResult {
  if (ctx.isDestroyed) {
    throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
  }
  return listMissionPresetCatalog({
    variant,
    hasPremium: options.hasPremium,
    activePresetId: loadStoredMissionPreset()?.id ?? null,
    targetCancellationSupported: options.targetCancellationSupported,
    isPanelEntitled: options.isPanelEntitled,
  }, query);
}

export function applyWebMcpMissionPreset(
  ctx: AppContext,
  variant: string,
  presetId: unknown,
  options: {
    hasPremium: boolean;
    isPanelEntitled?: (panelId: string) => boolean;
    apply: (id: MissionPresetId) => { changed: boolean; priorPresetId: string | null };
  },
): ApplyMissionPresetResult {
  if (ctx.isDestroyed) {
    return {
      ok: false,
      status: 'denied',
      reason: 'app_destroyed',
      message: 'Dashboard is no longer available.',
    };
  }

  const decision = evaluateMissionPresetApply(presetId, {
    variant,
    hasPremium: options.hasPremium,
    activePresetId: loadStoredMissionPreset()?.id ?? null,
    isPanelEntitled: options.isPanelEntitled,
  });
  if (!decision.ok || !decision.presetId) {
    return {
      ok: false,
      status: decision.reason === 'malformed_arguments' || decision.reason === 'unknown_preset'
        ? 'invalid'
        : 'denied',
      ...(decision.presetId ? { presetId: decision.presetId } : {}),
      ...(decision.label ? { label: decision.label } : {}),
      reason: decision.reason,
      message: decision.message,
    };
  }

  const preset = getMissionPreset(decision.presetId);
  if (!preset) {
    return {
      ok: false,
      status: 'invalid',
      reason: 'unknown_preset',
      message: 'Unknown mission preset.',
    };
  }

  try {
    const { changed } = options.apply(decision.presetId);
    if (ctx.isDestroyed) {
      // Apply already committed through the mission path. Prefer reporting the
      // durable outcome over a post-commit deny that would mislead callers into
      // retrying a state that already landed.
      return {
        ok: true,
        status: changed ? 'applied' : 'unchanged',
        presetId: preset.id,
        label: preset.label,
        changed,
        monitor: variant,
        message: changed
          ? `Mission preset applied: ${preset.label}.`
          : `Mission preset already active: ${preset.label}.`,
      };
    }
    let context;
    try {
      context = getWebMcpDashboardContext(ctx, variant);
    } catch {
      return {
        ok: true,
        status: changed ? 'applied' : 'unchanged',
        presetId: preset.id,
        label: preset.label,
        changed,
        monitor: variant,
        message: changed
          ? `Mission preset applied: ${preset.label}.`
          : `Mission preset already active: ${preset.label}.`,
      };
    }
    return {
      ok: true,
      status: changed ? 'applied' : 'unchanged',
      presetId: preset.id,
      label: preset.label,
      changed,
      monitor: context.variant,
      map: {
        view: context.map.view,
        zoom: context.map.zoom,
        timeRange: context.map.timeRange,
        enabledLayers: context.map.enabledLayers,
      },
      panels: {
        enabled: context.panels.enabled,
      },
      message: changed
        ? `Mission preset applied: ${preset.label}.`
        : `Mission preset already active: ${preset.label}.`,
    };
  } catch {
    return {
      ok: false,
      status: 'denied',
      presetId: preset.id,
      label: preset.label,
      reason: 'apply_failed',
      message: 'Mission preset application failed and was rolled back.',
    };
  }
}

export function applyWebMcpOpenMissionPicker(
  ctx: AppContext,
  currentVariant: string,
  openPicker: () => boolean,
): WebMcpNavigationResult {
  const context = navigationContext(ctx, currentVariant);
  if (ctx.isDestroyed) return APP_DESTROYED_NAV_RESULT(context);
  const opened = openPicker();
  if (!opened) {
    return {
      ok: false,
      status: 'denied',
      destination: 'mission_picker',
      reason: WEBMCP_MISSION_PICKER_REASON.unavailable,
      message: 'Mission presets are not available on this dashboard.',
      context,
    };
  }
  return {
    ok: true,
    status: 'applied',
    destination: 'mission_picker',
    overlay: 'open',
    message: 'Opened mission presets.',
    context: navigationContext(ctx, currentVariant),
  };
}
