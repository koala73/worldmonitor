import type { PanelConfig } from '@/types';
import { getEffectivePanelConfig, userSetPanelEnabled } from '@/config/panels';
import {
  evaluateSetPanelEnabled,
  type SetPanelEnabledResult,
} from '@/config/panel-enablement';

export interface SetPanelEnabledContext {
  panelSettings: Record<string, PanelConfig>;
  panels?: Record<string, unknown>;
  unifiedSettings?: { refreshPanelToggles?: () => void } | null;
}

export interface SetPanelEnabledDeps {
  variant: string;
  isPro: boolean;
  persist: (settings: Record<string, PanelConfig>) => void;
  applyPanelSettings: () => void;
  trackToggle: (panelId: string, enabled: boolean) => void;
  showCapToast?: () => void;
  isPanelAllowed?: (panelId: string, config: PanelConfig) => boolean;
}

/**
 * Apply a user-equivalent panel enable/disable. Policy stays in
 * `evaluateSetPanelEnabled`; this helper only persists when that decision
 * says the visible settings store must change.
 */
export function applySetPanelEnabled(
  ctx: SetPanelEnabledContext,
  panelId: unknown,
  enabled: unknown,
  deps: SetPanelEnabledDeps,
): SetPanelEnabledResult {
  const decision = evaluateSetPanelEnabled({
    panelId,
    enabled,
    panelSettings: ctx.panelSettings,
    variant: deps.variant,
    isPro: deps.isPro,
    isPanelAllowed: deps.isPanelAllowed,
  });

  if (!decision.ok) {
    if (decision.reason === 'panel_cap_exceeded') deps.showCapToast?.();
    return decision;
  }
  if (!decision.changed || typeof panelId !== 'string' || typeof enabled !== 'boolean') {
    return decision;
  }

  let config = ctx.panelSettings[panelId];
  if (!config) {
    config = { ...getEffectivePanelConfig(panelId, deps.variant), enabled: false };
    ctx.panelSettings[panelId] = config;
  }
  userSetPanelEnabled(config, enabled);
  deps.trackToggle(panelId, enabled);
  deps.persist(ctx.panelSettings);
  deps.applyPanelSettings();
  ctx.unifiedSettings?.refreshPanelToggles?.();
  if (enabled) {
    const panel = ctx.panels?.[panelId];
    if (
      panel
      && typeof panel === 'object'
      && 'fetchData' in panel
      && typeof (panel as { fetchData: unknown }).fetchData === 'function'
    ) {
      (panel as { fetchData: () => void }).fetchData();
    }
  }
  return decision;
}
