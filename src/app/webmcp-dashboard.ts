import type { AppContext } from './app-context';
import {
  DashboardBindingError,
  type DashboardActionResult,
  type DashboardContextSnapshot,
} from '@/services/webmcp';
import type { AgentBusApplierOptions } from './agent-bus-applier';

const APP_DESTROYED_RESULT: DashboardActionResult = {
  ok: false,
  status: 'denied',
  reason: 'app_destroyed',
  message: 'Dashboard is no longer available.',
  targets: [],
};

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
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${target} did not initialise within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    const outcome = await Promise.race([
      uiReady.then(() => 'ready' as const),
      appDestroyed.then(() => 'destroyed' as const),
      timeout,
    ]);
    if (outcome === 'destroyed') {
      throw new Error('Dashboard is no longer available.');
    }
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export async function applyWebMcpDashboardAction(
  ctx: AppContext,
  action: unknown,
  options: AgentBusApplierOptions,
): Promise<DashboardActionResult> {
  if (ctx.isDestroyed) return APP_DESTROYED_RESULT;

  // Keep the zod-backed agent-bus contract out of the eager dashboard entry.
  const { applyAgentBusAction } = await import('./agent-bus-applier');
  if (ctx.isDestroyed) return APP_DESTROYED_RESULT;
  const result = applyAgentBusAction(ctx, action, options);
  if (result.ok && result.actionType === 'set_view' && ctx.map) {
    try {
      await ctx.map.whenViewportSettled(result.viewportActionToken);
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
  return result;
}
