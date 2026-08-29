import type { AppContext } from './app-context';
import type { AgentBusApplierOptions } from './agent-bus-applier';
import { applyWebMcpDashboardAction } from './webmcp-dashboard';
import { preloadCountryGeometry } from '@/services/country-geometry';
import { throwIfWebMcpAborted, type DashboardActionResult } from '@/services/webmcp';

const MAP_READY_ACTION_TYPES = new Set([
  'set_view',
  'set_layers',
  'set_time_range',
  'focus_country',
  'set_map_mode',
]);
const URL_SYNC_ACTION_TYPES = new Set([
  'set_view',
  'set_time_range',
  'focus_country',
]);
const VIEWPORT_AUTHORITY_ACTION_TYPES = new Set([
  'set_view',
  'focus_country',
]);

export function dashboardActionNeedsMapReady(type: string | undefined): boolean {
  return typeof type === 'string' && MAP_READY_ACTION_TYPES.has(type);
}

export function dashboardActionSyncsUrl(type: string | undefined): boolean {
  return typeof type === 'string' && URL_SYNC_ACTION_TYPES.has(type);
}

export function dashboardActionUsesViewportAuthority(
  type: string | undefined,
): type is 'set_view' | 'focus_country' {
  return typeof type === 'string' && VIEWPORT_AUTHORITY_ACTION_TYPES.has(type);
}

export interface DashboardActionBindingOptions {
  waitForUiReady: () => Promise<void>;
  waitForMapReady: () => Promise<void>;
  getMapAuthorityToken?: () => number;
  signal?: AbortSignal;
  applierOptions: AgentBusApplierOptions;
  syncUrlStateNow: () => void;
  preloadCountryGeometry?: () => Promise<void>;
}

/**
 * Execute one WebMCP dashboard action through the same narrow applier as the
 * in-app agent bus. Kept outside App so readiness and post-animation URL
 * ordering can be verified behaviorally without booting the whole dashboard.
 */
export async function runDashboardActionBinding(
  ctx: AppContext,
  action: unknown,
  options: DashboardActionBindingOptions,
): Promise<DashboardActionResult> {
  const mapAuthorityToken = options.getMapAuthorityToken?.();
  throwIfWebMcpAborted(options.signal);
  await options.waitForUiReady();
  throwIfWebMcpAborted(options.signal);

  // Parse through the shared Zod contract before deciding whether the concrete
  // renderer is needed. Keep this import dynamic so dashboard boot and simple
  // panel actions do not pull agent-bus/Zod into the eager entry. Invalid and
  // non-map actions still reach the applier for their structured result without
  // forcing a deferred map renderer to initialize.
  const { parseAgentBusAction } = await import('../../shared/agent-bus-actions');
  throwIfWebMcpAborted(options.signal);
  const parsed = parseAgentBusAction(action);
  if (parsed.ok && dashboardActionNeedsMapReady(parsed.action.type)) {
    await options.waitForMapReady();
    throwIfWebMcpAborted(options.signal);
    if (parsed.action.type === 'focus_country') {
      await (options.preloadCountryGeometry ?? preloadCountryGeometry)();
      throwIfWebMcpAborted(options.signal);
    }
    if (
      dashboardActionUsesViewportAuthority(parsed.action.type)
      && mapAuthorityToken !== undefined
      && options.getMapAuthorityToken?.() !== mapAuthorityToken
    ) {
      return {
        ok: false,
        status: 'denied',
        actionType: parsed.action.type,
        reason: 'viewport_superseded',
        message: 'Map movement was superseded by a newer viewport action.',
        targets: [],
      };
    }
  }

  const result = await applyWebMcpDashboardAction(
    ctx,
    parsed.ok ? parsed.action : action,
    options.applierOptions,
    options.signal,
  );
  throwIfWebMcpAborted(options.signal);
  if (result.ok && dashboardActionSyncsUrl(result.actionType)) {
    options.syncUrlStateNow();
  }
  return result;
}
