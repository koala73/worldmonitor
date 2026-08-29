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
import type { AgentBusApplierOptions } from './agent-bus-applier';

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
  const result = applyAgentBusAction(ctx, action, options);
  if (result.ok && result.actionType === 'set_view' && ctx.map) {
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

export function applyWebMcpOpenSettings(
  ctx: AppContext,
  currentVariant: string,
): WebMcpNavigationResult {
  const context = navigationContext(ctx, currentVariant);
  if (ctx.isDestroyed) return APP_DESTROYED_NAV_RESULT(context);
  if (!ctx.unifiedSettings) {
    return {
      ok: false,
      status: 'denied',
      destination: 'settings',
      reason: 'unavailable',
      message: 'Settings are not available on this dashboard.',
      context,
    };
  }
  ctx.unifiedSettings.open('settings');
  return {
    ok: true,
    status: 'applied',
    destination: 'settings',
    overlay: 'open',
    tab: 'settings',
    message: 'Opened settings.',
    context,
  };
}

export function applyWebMcpOpenAlerts(
  ctx: AppContext,
  currentVariant: string,
): WebMcpNavigationResult {
  const context = navigationContext(ctx, currentVariant);
  if (ctx.isDestroyed) return APP_DESTROYED_NAV_RESULT(context);
  if (ctx.isDesktopApp || !ctx.unifiedSettings) {
    return {
      ok: false,
      status: 'denied',
      destination: 'alerts',
      reason: 'unavailable',
      message: 'Alerts are not available on this dashboard.',
      context,
    };
  }
  ctx.unifiedSettings.open('notifications');
  return {
    ok: true,
    status: 'applied',
    destination: 'alerts',
    overlay: 'open',
    tab: 'notifications',
    message: 'Opened alerts.',
    context,
  };
}
