import { VARIANT_DEFAULTS } from '@/config/panels';
import { isSiteVariant, type SiteVariant } from '@/config/variant';
import {
  MISSION_PRESETS,
  getMissionPreset,
  type MissionMapView,
  type MissionPresetId,
  type MissionTimeRange,
} from '@/services/mission-presets';

/** Same threshold as `applyMissionPresetToState` soft-fallback. */
export const MISSION_PRESET_MIN_PANEL_MATCHES = 2;

/**
 * Stable reasons a catalog row can be unavailable, and stable reasons an apply
 * can be denied. Both types derive from these lists so the runtime sets, the
 * unions, and the documented reason catalog in `docs/webmcp.mdx` stay aligned.
 */
export const MISSION_PRESET_UNAVAILABLE_REASONS = [
  'preset_incompatible',
  'preset_not_entitled',
  'target_cancellation_unsupported',
] as const;

export const MISSION_PRESET_APPLY_DENY_REASONS = [
  'malformed_arguments',
  'unknown_preset',
  'preset_incompatible',
  'preset_not_entitled',
  'app_destroyed',
  'apply_failed',
] as const;

export type MissionPresetUnavailableReason =
  (typeof MISSION_PRESET_UNAVAILABLE_REASONS)[number];

export type MissionPresetApplyDenyReason =
  (typeof MISSION_PRESET_APPLY_DENY_REASONS)[number];

export interface MissionPresetCatalogItem {
  id: MissionPresetId;
  label: string;
  /** Present for available presets; omitted on gated rows to keep list budgets tight. */
  view?: MissionMapView;
  /** Present for available presets; omitted on gated rows to keep list budgets tight. */
  timeRange?: MissionTimeRange;
  panelCount: number;
  layerCount: number;
  active: boolean;
  monitorCompatible: boolean;
  entitled: boolean;
  available: boolean;
  unavailableReason?: MissionPresetUnavailableReason;
}

export interface MissionPresetCatalogLiveState {
  variant: string;
  hasPremium: boolean;
  activePresetId: string | null;
  /**
   * When false, presets that would otherwise be available stay listed but are
   * marked unavailable for apply with `target_cancellation_unsupported`.
   * Omit for read-only discovery that does not care about mutation hosts.
   */
  targetCancellationSupported?: boolean;
  /**
   * Optional panel entitlement probe. When omitted, bundled presets stay
   * entitled (matching visible mission control, which has no Pro gate).
   */
  isPanelEntitled?: (panelId: string) => boolean;
}

export interface MissionPresetCatalogResult {
  ok: true;
  variant: string;
  activePresetId: string | null;
  presets: MissionPresetCatalogItem[];
  count: number;
}

export interface MissionPresetCatalogQuery {
  available?: boolean;
}

export class MissionPresetCatalogError extends Error {
  public constructor(
    public readonly reason: 'malformed_arguments' | 'invalid_variant',
    message: string,
  ) {
    super(message);
    this.name = 'MissionPresetCatalogError';
  }
}

export interface MissionPresetApplyDecision {
  ok: boolean;
  reason?: MissionPresetApplyDenyReason;
  message: string;
  presetId?: MissionPresetId;
  label?: string;
  monitorCompatible?: boolean;
  entitled?: boolean;
}

const PRESET_ID_SET = new Set<string>(MISSION_PRESETS.map((preset) => preset.id));

function variantPanelSet(variant: string): Set<string> {
  const panels = VARIANT_DEFAULTS[variant] ?? VARIANT_DEFAULTS.full ?? [];
  return new Set(panels);
}

export function getMissionPresetPanelMatches(
  presetId: MissionPresetId,
  variant: string,
): string[] {
  const preset = getMissionPreset(presetId);
  if (!preset) return [];
  const allowed = variantPanelSet(variant);
  return preset.panels.filter((panelId) => panelId !== 'map' && allowed.has(panelId));
}

export function isMissionPresetMonitorCompatible(
  presetId: MissionPresetId,
  variant: string,
): boolean {
  return getMissionPresetPanelMatches(presetId, variant).length >= MISSION_PRESET_MIN_PANEL_MATCHES;
}

export function isMissionPresetId(value: unknown): value is MissionPresetId {
  return typeof value === 'string' && PRESET_ID_SET.has(value);
}

function resolveEntitled(
  panelIds: string[],
  live: MissionPresetCatalogLiveState,
): boolean {
  if (live.hasPremium) return true;
  if (!live.isPanelEntitled) return true;
  // A free session stays entitled when every intended panel is individually
  // entitled. Bundled presets avoid locked-only workspaces on web, so this
  // normally stays true and mirrors the visible mission control.
  return panelIds.every((panelId) => live.isPanelEntitled!(panelId));
}

function unavailableReason(item: {
  monitorCompatible: boolean;
  entitled: boolean;
  targetCancellationSupported?: boolean;
}): MissionPresetUnavailableReason | undefined {
  if (!item.monitorCompatible) return 'preset_incompatible';
  if (!item.entitled) return 'preset_not_entitled';
  if (item.targetCancellationSupported === false) return 'target_cancellation_unsupported';
  return undefined;
}

export function buildMissionPresetCatalogItem(
  presetId: MissionPresetId,
  live: MissionPresetCatalogLiveState,
): MissionPresetCatalogItem {
  const preset = getMissionPreset(presetId);
  if (!preset) {
    throw new MissionPresetCatalogError('malformed_arguments', `Unknown mission preset: ${presetId}`);
  }

  const matchingPanels = getMissionPresetPanelMatches(presetId, live.variant);
  const monitorCompatible = matchingPanels.length >= MISSION_PRESET_MIN_PANEL_MATCHES;
  const panelIds = monitorCompatible
    ? preset.panels.filter((panelId) => panelId === 'map' || matchingPanels.includes(panelId))
    : [];
  const entitled = resolveEntitled(matchingPanels, live);
  const reason = unavailableReason({
    monitorCompatible,
    entitled,
    targetCancellationSupported: live.targetCancellationSupported,
  });
  const available = reason === undefined;

  return {
    id: preset.id,
    label: preset.label,
    ...(available
      ? {
        view: preset.view,
        timeRange: preset.timeRange,
        panelCount: panelIds.length,
        layerCount: preset.layers.length,
      }
      : {
        panelCount: 0,
        layerCount: 0,
      }),
    active: live.activePresetId === preset.id,
    monitorCompatible,
    entitled,
    available,
    ...(reason ? { unavailableReason: reason } : {}),
  };
}

export function listMissionPresetCatalog(
  live: MissionPresetCatalogLiveState,
  query: MissionPresetCatalogQuery = {},
): MissionPresetCatalogResult {
  if (!isSiteVariant(live.variant)) {
    throw new MissionPresetCatalogError(
      'invalid_variant',
      'variant must be one of: full, tech, finance, commodity, energy, happy.',
    );
  }
  if (query.available !== undefined && typeof query.available !== 'boolean') {
    throw new MissionPresetCatalogError(
      'malformed_arguments',
      'available must be a boolean.',
    );
  }

  const presets = MISSION_PRESETS
    .map((preset) => buildMissionPresetCatalogItem(preset.id, {
      ...live,
      variant: live.variant as SiteVariant,
    }))
    .filter((item) => (query.available === undefined ? true : item.available === query.available));

  return {
    ok: true,
    variant: live.variant,
    activePresetId: live.activePresetId && isMissionPresetId(live.activePresetId)
      ? live.activePresetId
      : null,
    presets,
    count: presets.length,
  };
}

export function evaluateMissionPresetApply(
  presetId: unknown,
  live: MissionPresetCatalogLiveState,
): MissionPresetApplyDecision {
  if (typeof presetId !== 'string' || !presetId.trim()) {
    return {
      ok: false,
      reason: 'malformed_arguments',
      message: 'presetId must be a stable bundled mission preset ID.',
    };
  }
  if (!isMissionPresetId(presetId)) {
    return {
      ok: false,
      reason: 'unknown_preset',
      message: 'Unknown mission preset.',
    };
  }

  const item = buildMissionPresetCatalogItem(presetId, {
    ...live,
    // Apply path is already gated by withInvocationLogging; do not double-count
    // cancellation here so evaluate can run after the signal check.
    targetCancellationSupported: true,
  });

  if (!item.monitorCompatible) {
    return {
      ok: false,
      reason: 'preset_incompatible',
      message: 'That mission preset is not compatible with this monitor.',
      presetId: item.id,
      label: item.label,
      monitorCompatible: false,
      entitled: item.entitled,
    };
  }
  if (!item.entitled) {
    return {
      ok: false,
      reason: 'preset_not_entitled',
      message: 'That mission preset requires a higher plan.',
      presetId: item.id,
      label: item.label,
      monitorCompatible: true,
      entitled: false,
    };
  }

  return {
    ok: true,
    message: `Mission preset ready: ${item.label}.`,
    presetId: item.id,
    label: item.label,
    monitorCompatible: true,
    entitled: true,
  };
}
