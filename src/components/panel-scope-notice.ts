// Type-only: a value import would pull the lazily loaded Panel class into the App chunk.
import type { Panel } from './Panel';
import type { PanelScopeBehaviour } from '@/config/panel-scope';
import type { ResolvedScope } from '@/services/tab-focus';

/**
 * Which "Not filtered" chip a panel shows under the active focus (#10453).
 * None without a focus. A panel declared as filtering only earns no chip once
 * it actually overrides `Panel.applyScope`; until then it is labelled like
 * any unsupported panel, so the registry can never claim more than the code
 * does.
 */
export function scopeNoticeFor(
  behaviour: PanelScopeBehaviour,
  panel: Panel,
  scope: ResolvedScope | null,
): 'global' | 'unsupported' | null {
  if (!scope) return null;
  if (behaviour !== 'filters') return behaviour;
  return panel.filtersByScope() ? null : 'unsupported';
}
