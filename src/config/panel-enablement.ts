import type { PanelConfig } from '@/types';
import {
  ALL_PANELS,
  FREE_MAX_PANELS,
  countFreePanelCapUsage,
  getEffectivePanelConfig,
  isFreePanelCapCounted,
  isPanelEntitled,
  isPanelNativeToVariant,
} from './panels';

export const SET_PANEL_ENABLED_ID_PATTERN = /^[a-z0-9][a-z0-9@_-]*$/;
export const SET_PANEL_ENABLED_ID_MAX_CHARS = 96;

export type SetPanelEnabledStatus = 'applied' | 'denied' | 'invalid';

export type SetPanelEnabledReason =
  | 'malformed_arguments'
  | 'unknown_panel'
  | 'panel_incompatible'
  | 'panel_not_entitled'
  | 'panel_cap_exceeded'
  | 'panel_required'
  | 'persist_failed';

export interface SetPanelEnabledResult {
  ok: boolean;
  status: SetPanelEnabledStatus;
  panelId: string;
  requestedEnabled: boolean;
  effectiveEnabled: boolean;
  changed: boolean;
  reason?: SetPanelEnabledReason;
  message: string;
}

export interface EvaluateSetPanelEnabledInput {
  panelId: unknown;
  enabled: unknown;
  panelSettings: Record<string, PanelConfig>;
  variant: string;
  isPro: boolean;
  isPanelAllowed?: (panelId: string, config: PanelConfig) => boolean;
}

function result(fields: SetPanelEnabledResult): SetPanelEnabledResult {
  return fields;
}

function isStablePanelId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= SET_PANEL_ENABLED_ID_MAX_CHARS
    && SET_PANEL_ENABLED_ID_PATTERN.test(value);
}

function isCatalogPanelId(panelId: string): boolean {
  if (panelId.startsWith('cw-') || panelId.startsWith('mcp-')) return false;
  return Object.prototype.hasOwnProperty.call(ALL_PANELS, panelId);
}

export function evaluateSetPanelEnabled(
  input: EvaluateSetPanelEnabledInput,
): SetPanelEnabledResult {
  const requestedEnabled = input.enabled === true;
  if (!isStablePanelId(input.panelId) || typeof input.enabled !== 'boolean') {
    return result({
      ok: false,
      status: 'invalid',
      panelId: typeof input.panelId === 'string' ? input.panelId.slice(0, SET_PANEL_ENABLED_ID_MAX_CHARS) : '',
      requestedEnabled,
      effectiveEnabled: false,
      changed: false,
      reason: 'malformed_arguments',
      message: 'panelId must be a stable dashboard panel ID and enabled must be a boolean.',
    });
  }

  const panelId = input.panelId;
  if (!isCatalogPanelId(panelId)) {
    return result({
      ok: false,
      status: 'denied',
      panelId,
      requestedEnabled,
      effectiveEnabled: false,
      changed: false,
      reason: 'unknown_panel',
      message: 'Unknown dashboard panel.',
    });
  }

  const existing = input.panelSettings[panelId];
  const currentlyEnabled = existing?.enabled === true;
  // Entitlement uses catalog metadata. Stored entries can predate a premium
  // flag or have `premium` stripped; UnifiedSettings uses the same split.
  const catalogConfig = getEffectivePanelConfig(panelId, input.variant);

  if (currentlyEnabled === input.enabled) {
    return result({
      ok: true,
      status: 'applied',
      panelId,
      requestedEnabled,
      effectiveEnabled: currentlyEnabled,
      changed: false,
      message: currentlyEnabled ? 'Panel already enabled.' : 'Panel already disabled.',
    });
  }

  if (input.enabled && !isPanelNativeToVariant(panelId, input.variant)) {
    return result({
      ok: false,
      status: 'denied',
      panelId,
      requestedEnabled,
      effectiveEnabled: currentlyEnabled,
      changed: false,
      reason: 'panel_incompatible',
      message: 'That panel is not available on this monitor.',
    });
  }

  // Settings and the panel X-button still let a person disable a panel that is
  // already live, including a premium panel from a previous entitled session.
  // Entitlement only gates turning a panel on.
  if (input.enabled) {
    const allowed = input.isPanelAllowed
      ? input.isPanelAllowed(panelId, catalogConfig)
      : isPanelEntitled(panelId, catalogConfig, input.isPro);
    if (!allowed) {
      return result({
        ok: false,
        status: 'denied',
        panelId,
        requestedEnabled,
        effectiveEnabled: currentlyEnabled,
        changed: false,
        reason: 'panel_not_entitled',
        message: 'That panel is not available on the current plan.',
      });
    }
  }

  if (
    input.enabled
    && !input.isPro
    && isFreePanelCapCounted(panelId)
    && countFreePanelCapUsage(input.panelSettings) >= FREE_MAX_PANELS
  ) {
    return result({
      ok: false,
      status: 'denied',
      panelId,
      requestedEnabled,
      effectiveEnabled: currentlyEnabled,
      changed: false,
      reason: 'panel_cap_exceeded',
      message: 'The free-tier panel limit has been reached.',
    });
  }

  return result({
    ok: true,
    status: 'applied',
    panelId,
    requestedEnabled,
    effectiveEnabled: input.enabled,
    changed: true,
    message: input.enabled ? 'Panel enabled.' : 'Panel disabled.',
  });
}
