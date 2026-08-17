import type { AppContext } from './app-context';
import type { AgentBusApplierOptions } from './agent-bus-applier';
import { applyWebMcpDashboardAction } from './webmcp-dashboard';
import type { DashboardActionResult } from '@/services/webmcp';

export interface DashboardActionBindingOptions {
  waitForUiReady: () => Promise<void>;
  waitForMapReady: () => Promise<void>;
  applierOptions: AgentBusApplierOptions;
  syncUrlStateNow: () => void;
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
  await options.waitForUiReady();

  // Parse through the shared Zod contract before deciding whether the concrete
  // renderer is needed. Keep this import dynamic so dashboard boot and simple
  // panel actions do not pull agent-bus/Zod into the eager entry. Invalid and
  // non-map actions still reach the applier for their structured result without
  // forcing a deferred map renderer to initialize.
  const { parseAgentBusAction } = await import('../../shared/agent-bus-actions');
  const parsed = parseAgentBusAction(action);
  if (
    parsed.ok
    && (parsed.action.type === 'set_view' || parsed.action.type === 'set_layers')
  ) {
    await options.waitForMapReady();
  }

  const result = await applyWebMcpDashboardAction(
    ctx,
    parsed.ok ? parsed.action : action,
    options.applierOptions,
  );
  if (result.ok && result.actionType === 'set_view') {
    options.syncUrlStateNow();
  }
  return result;
}
