import { SITE_VARIANT } from '@/config/variant';
import { normalizeExclusiveChoropleths } from '@/components/resilience-choropleth-utils';
import { getAllowedLayerKeys, isLayerExecutable, LAYER_REGISTRY, type MapRenderer, type MapVariant } from '@/config/map-layer-definitions';
import type { AppContext } from './app-context';
import type { MapLayers, PanelConfig } from '@/types';
import {
  isDashboardControlAction,
  parseAgentBusAction,
  type AgentBusAction,
  type DashboardControlAction,
  type DashboardControlActionType,
} from '../../shared/agent-bus-actions';

export type AgentBusApplyStatus = 'applied' | 'denied' | 'invalid' | 'skipped';

export interface AgentBusApplyTargetResult {
  target: string;
  status: AgentBusApplyStatus;
  reason?: string;
}

export interface AgentBusApplyResult {
  ok: boolean;
  status: AgentBusApplyStatus;
  actionType?: DashboardControlActionType;
  label?: string;
  reason?: string;
  message: string;
  targets: AgentBusApplyTargetResult[];
}

export interface AgentBusApplierOptions {
  getPanelConfig?: (panelId: string) => PanelConfig;
  isPanelAllowed?: (panelId: string, config: PanelConfig) => boolean;
  hasPremiumAccess?: () => boolean;
  getRenderer?: (ctx: AppContext) => MapRenderer;
  applyLayerChange?: (layer: keyof MapLayers, enabled: boolean, source: 'programmatic') => void;
}

const DEFAULT_LAYER_RESULT: AgentBusApplyTargetResult[] = [];
const MAP_VARIANTS = new Set<MapVariant>(['full', 'tech', 'finance', 'happy', 'commodity', 'energy']);

function denied(message: string, reason: string, targets = DEFAULT_LAYER_RESULT, action?: DashboardControlAction): AgentBusApplyResult {
  return {
    ok: false,
    status: 'denied',
    actionType: action?.type,
    label: action?.label,
    reason,
    message,
    targets,
  };
}

function invalid(issues: string[]): AgentBusApplyResult {
  return {
    ok: false,
    status: 'invalid',
    reason: 'invalid_action',
    message: issues.join('; ') || 'Invalid dashboard action.',
    targets: [],
  };
}

function applied(action: DashboardControlAction, message: string, targets: AgentBusApplyTargetResult[]): AgentBusApplyResult {
  return {
    ok: true,
    status: 'applied',
    actionType: action.type,
    label: action.label,
    message,
    targets,
  };
}

function defaultPanelAllowed(panelId: string, config: PanelConfig): boolean {
  void panelId;
  return !config.premium;
}

function getPanelConfig(panelId: string, options: AgentBusApplierOptions): PanelConfig {
  return options.getPanelConfig?.(panelId) ?? { name: panelId, enabled: true };
}

function isPanelAllowed(panelId: string, config: PanelConfig, options: AgentBusApplierOptions): boolean {
  return options.isPanelAllowed?.(panelId, config) ?? defaultPanelAllowed(panelId, config);
}

function premiumAccess(options: AgentBusApplierOptions): boolean {
  return options.hasPremiumAccess?.() ?? false;
}

function currentRenderer(ctx: AppContext, options: AgentBusApplierOptions): MapRenderer {
  if (options.getRenderer) return options.getRenderer(ctx);
  return ctx.map?.isGlobeMode?.() ? 'globe' : 'flat';
}

function currentMapVariant(): MapVariant {
  return MAP_VARIANTS.has(SITE_VARIANT as MapVariant) ? SITE_VARIANT as MapVariant : 'full';
}

function isMapLayerKey(key: string): key is keyof MapLayers {
  return Object.prototype.hasOwnProperty.call(LAYER_REGISTRY, key);
}

function applyOpenPanel(ctx: AppContext, action: Extract<AgentBusAction, { type: 'open_panel' }>, options: AgentBusApplierOptions): AgentBusApplyResult {
  const panel = ctx.panels[action.panelId];
  if (!panel) {
    return denied(`Panel is not available: ${action.panelId}.`, 'panel_not_live', [], action);
  }

  const config = ctx.panelSettings[action.panelId] ?? getPanelConfig(action.panelId, options);
  if (!isPanelAllowed(action.panelId, config, options)) {
    return denied(`Panel is not available on this plan: ${config.name || action.panelId}.`, 'panel_not_entitled', [
      { target: action.panelId, status: 'denied', reason: 'panel_not_entitled' },
    ], action);
  }

  panel.show();
  const element = panel.getElement();
  if (typeof element.scrollIntoView === 'function') {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  return applied(action, `Opened ${config.name || action.panelId}.`, [
    { target: action.panelId, status: 'applied' },
  ]);
}

function applySetView(ctx: AppContext, action: Extract<AgentBusAction, { type: 'set_view' }>): AgentBusApplyResult {
  if (!ctx.map) {
    return denied('Map is not available.', 'map_unavailable', [], action);
  }

  if (action.lat != null && action.lon != null) {
    ctx.map.setCenter(action.lat, action.lon, action.zoom);
    return applied(action, 'Moved the map.', [
      { target: `${action.lat},${action.lon}`, status: 'applied' },
    ]);
  }

  if (action.view) {
    ctx.map.setView(action.view, action.zoom);
    return applied(action, `Moved the map to ${action.view}.`, [
      { target: action.view, status: 'applied' },
    ]);
  }

  return invalid(['set_view requires either a named view or a lat/lon pair']);
}

function applySetLayers(ctx: AppContext, action: Extract<AgentBusAction, { type: 'set_layers' }>, options: AgentBusApplierOptions): AgentBusApplyResult {
  if (!ctx.map) {
    return denied('Map is not available.', 'map_unavailable', [], action);
  }

  const allowed = getAllowedLayerKeys(currentMapVariant());
  const renderer = currentRenderer(ctx, options);
  const isDeckGLActive = Boolean(ctx.map.isDeckGLActive?.());
  const isPremium = premiumAccess(options);
  const nextLayers = { ...ctx.mapLayers };
  const targets: AgentBusApplyTargetResult[] = [];
  let changed = false;

  for (const [rawKey, enabled] of Object.entries(action.layers)) {
    if (!isMapLayerKey(rawKey)) {
      targets.push({ target: rawKey, status: 'denied', reason: 'unknown_layer' });
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(ctx.mapLayers, rawKey)) {
      targets.push({ target: rawKey, status: 'denied', reason: 'layer_not_live' });
      continue;
    }
    if (!allowed.has(rawKey)) {
      targets.push({ target: rawKey, status: 'denied', reason: 'variant_disallowed' });
      continue;
    }

    const definition = LAYER_REGISTRY[rawKey];
    if (definition.premium && !isPremium) {
      targets.push({ target: rawKey, status: 'denied', reason: 'layer_not_entitled' });
      continue;
    }
    if (rawKey === 'resilienceScore' && !isDeckGLActive) {
      targets.push({ target: rawKey, status: 'denied', reason: 'layer_not_executable' });
      continue;
    }
    if (!isLayerExecutable(rawKey, renderer, isDeckGLActive)) {
      targets.push({ target: rawKey, status: 'denied', reason: 'layer_not_executable' });
      continue;
    }

    nextLayers[rawKey] = enabled;
    targets.push({ target: rawKey, status: 'applied' });
    changed = true;
  }

  if (!changed) {
    return denied('No requested layers can be applied.', 'no_allowed_layers', targets, action);
  }

  const normalized = normalizeExclusiveChoropleths(nextLayers, ctx.mapLayers);
  const changedLayers = (Object.keys(normalized) as Array<keyof MapLayers>)
    .filter((layer) => (normalized[layer] === true) !== (ctx.mapLayers[layer] === true));
  if (changedLayers.length === 0) {
    return applied(action, 'Map layers already match.', targets);
  }
  if (!options.applyLayerChange) {
    return denied(
      'Layer controls are unavailable.',
      'layer_change_unavailable',
      targets.map((target) => target.status === 'applied'
        ? { ...target, status: 'denied', reason: 'layer_change_unavailable' }
        : target),
      action,
    );
  }

  ctx.mapLayers = normalized;
  ctx.map.setLayers(normalized);
  for (const layer of changedLayers) {
    options.applyLayerChange(layer, normalized[layer] === true, 'programmatic');
  }
  return applied(action, 'Updated map layers.', targets);
}

export function applyAgentBusAction(
  ctx: AppContext,
  input: unknown,
  options: AgentBusApplierOptions = {},
): AgentBusApplyResult {
  const parsed = parseAgentBusAction(input);
  if (!parsed.ok) return invalid(parsed.issues);
  if (!isDashboardControlAction(parsed.action)) {
    return {
      ok: false,
      status: 'skipped',
      actionType: undefined,
      label: parsed.action.label,
      reason: 'not_dashboard_control',
      message: 'Action is handled outside the dashboard control applier.',
      targets: [],
    };
  }

  switch (parsed.action.type) {
    case 'open_panel':
      return applyOpenPanel(ctx, parsed.action, options);
    case 'set_view':
      return applySetView(ctx, parsed.action);
    case 'set_layers':
      return applySetLayers(ctx, parsed.action, options);
  }
}
