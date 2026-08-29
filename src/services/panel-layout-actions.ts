/**
 * Decision layer for panel-layout WebMCP tools.
 *
 * PanelLayoutManager owns live DOM order, collapse persistence, and fullscreen
 * toggles. This module answers whether a read or mutation is allowed and what
 * the caller should apply, so agents share the same region names, index rules,
 * and stable denial reasons as the keyboard and visible controls.
 */

export const PANEL_LAYOUT_REGIONS = ['sidebar', 'bottom'] as const;
export type PanelLayoutRegion = (typeof PANEL_LAYOUT_REGIONS)[number];

export const PANEL_LAYOUT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@_-]*$/;
export const PANEL_LAYOUT_ID_MAX_CHARS = 96;

export type PanelLayoutDenialReason =
  | 'malformed_arguments'
  | 'panel_not_found'
  | 'panel_not_mounted'
  | 'region_unavailable'
  | 'invalid_region'
  | 'invalid_index'
  | 'collapse_unsupported'
  | 'fullscreen_unsupported'
  | 'panel_fixed'
  | 'persist_failed'
  | 'layout_unavailable'
  | 'app_destroyed';

export interface PanelLayoutEntry {
  id: string;
  region: PanelLayoutRegion;
  index: number;
  collapsed: boolean;
  fullscreen: boolean;
  collapsible: boolean;
  fullscreenCapable: boolean;
  /** When true, agents may not move this panel between regions or indices. */
  fixed: boolean;
}

export interface PanelLayoutRegionInfo {
  available: boolean;
  panelCount: number;
}

export interface PanelLayoutSnapshot {
  regions: {
    sidebar: PanelLayoutRegionInfo;
    bottom: PanelLayoutRegionInfo;
  };
  panels: PanelLayoutEntry[];
  panelCount: number;
  panelsTruncated?: boolean;
  nextCursor?: string;
}

export type PanelLayoutMutationStatus = 'applied' | 'denied' | 'invalid';

export interface PanelLayoutMutationResult {
  ok: boolean;
  status: PanelLayoutMutationStatus;
  actionType: 'set_collapsed' | 'move' | 'set_fullscreen';
  reason?: PanelLayoutDenialReason;
  message: string;
  panelId?: string;
  region?: PanelLayoutRegion;
  index?: number;
  requestedCollapsed?: boolean;
  effectiveCollapsed?: boolean;
  requestedFullscreen?: boolean;
  effectiveFullscreen?: boolean;
  changed?: boolean;
  unchanged?: boolean;
  persisted?: boolean;
}

export const PANEL_LAYOUT_UNAVAILABLE_RESULT: PanelLayoutMutationResult = {
  ok: false,
  status: 'denied',
  actionType: 'move',
  reason: 'layout_unavailable',
  message: 'Dashboard panel layout is not available.',
};

function isStablePanelId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= PANEL_LAYOUT_ID_MAX_CHARS
    && PANEL_LAYOUT_ID_PATTERN.test(value);
}

export function isPanelLayoutRegion(value: unknown): value is PanelLayoutRegion {
  return value === 'sidebar' || value === 'bottom';
}

export function describePanelLayout(
  panels: PanelLayoutEntry[],
  bottomAvailable: boolean,
): PanelLayoutSnapshot {
  const sidebarCount = panels.filter((panel) => panel.region === 'sidebar').length;
  const bottomCount = panels.filter((panel) => panel.region === 'bottom').length;
  return {
    regions: {
      sidebar: { available: true, panelCount: sidebarCount },
      bottom: { available: bottomAvailable, panelCount: bottomCount },
    },
    panels: panels.map((panel, index) => ({
      ...panel,
      index: panel.index >= 0 ? panel.index : index,
    })),
    panelCount: panels.length,
  };
}

function findPanel(
  panels: PanelLayoutEntry[],
  panelId: string,
): PanelLayoutEntry | undefined {
  return panels.find((panel) => panel.id === panelId);
}

export function resolveSetPanelCollapsed(
  panels: PanelLayoutEntry[],
  panelId: unknown,
  collapsed: unknown,
):
  | {
    ok: true;
    unchanged: boolean;
    panelId: string;
    requestedCollapsed: boolean;
    effectiveCollapsed: boolean;
  }
  | { ok: false; status: PanelLayoutMutationStatus; reason: PanelLayoutDenialReason; message: string; panelId?: string } {
  const requestedCollapsed = collapsed === true;
  if (!isStablePanelId(panelId) || typeof collapsed !== 'boolean') {
    return {
      ok: false,
      status: 'invalid',
      reason: 'malformed_arguments',
      message: 'panelId must be a stable dashboard panel ID and collapsed must be a boolean.',
      panelId: typeof panelId === 'string' ? panelId.slice(0, PANEL_LAYOUT_ID_MAX_CHARS) : '',
    };
  }

  const panel = findPanel(panels, panelId);
  if (!panel) {
    return {
      ok: false,
      status: 'denied',
      reason: 'panel_not_mounted',
      message: 'That panel is not mounted in the current layout.',
      panelId,
    };
  }
  if (!panel.collapsible) {
    return {
      ok: false,
      status: 'denied',
      reason: 'collapse_unsupported',
      message: 'That panel does not expose a collapse control.',
      panelId,
    };
  }
  if (panel.collapsed === requestedCollapsed) {
    return {
      ok: true,
      unchanged: true,
      panelId,
      requestedCollapsed,
      effectiveCollapsed: panel.collapsed,
    };
  }
  return {
    ok: true,
    unchanged: false,
    panelId,
    requestedCollapsed,
    effectiveCollapsed: requestedCollapsed,
  };
}

export function resolveSetPanelFullscreen(
  panels: PanelLayoutEntry[],
  panelId: unknown,
  fullscreen: unknown,
):
  | {
    ok: true;
    unchanged: boolean;
    panelId: string;
    requestedFullscreen: boolean;
    effectiveFullscreen: boolean;
  }
  | { ok: false; status: PanelLayoutMutationStatus; reason: PanelLayoutDenialReason; message: string; panelId?: string } {
  const requestedFullscreen = fullscreen === true;
  if (!isStablePanelId(panelId) || typeof fullscreen !== 'boolean') {
    return {
      ok: false,
      status: 'invalid',
      reason: 'malformed_arguments',
      message: 'panelId must be a stable dashboard panel ID and fullscreen must be a boolean.',
      panelId: typeof panelId === 'string' ? panelId.slice(0, PANEL_LAYOUT_ID_MAX_CHARS) : '',
    };
  }

  const panel = findPanel(panels, panelId);
  if (!panel) {
    return {
      ok: false,
      status: 'denied',
      reason: 'panel_not_mounted',
      message: 'That panel is not mounted in the current layout.',
      panelId,
    };
  }
  if (!panel.fullscreenCapable) {
    return {
      ok: false,
      status: 'denied',
      reason: 'fullscreen_unsupported',
      message: 'That panel does not expose a fullscreen control.',
      panelId,
    };
  }
  if (panel.fullscreen === requestedFullscreen) {
    return {
      ok: true,
      unchanged: true,
      panelId,
      requestedFullscreen,
      effectiveFullscreen: panel.fullscreen,
    };
  }
  return {
    ok: true,
    unchanged: false,
    panelId,
    requestedFullscreen,
    effectiveFullscreen: requestedFullscreen,
  };
}

/**
 * Resolve a coordinate-free move. `index` is the desired final 0-based position
 * in the target region after the panel is removed from its current home.
 * Append with `index === targetRegionCount` (after removal when moving within
 * the same region).
 */
export function resolveMovePanel(input: {
  panels: PanelLayoutEntry[];
  panelId: unknown;
  region: unknown;
  index: unknown;
  bottomAvailable: boolean;
}):
  | {
    ok: true;
    unchanged: boolean;
    panelId: string;
    region: PanelLayoutRegion;
    index: number;
  }
  | {
    ok: false;
    status: PanelLayoutMutationStatus;
    reason: PanelLayoutDenialReason;
    message: string;
    panelId?: string;
    region?: PanelLayoutRegion;
    index?: number;
  } {
  const { panels, panelId, region, index, bottomAvailable } = input;

  if (!isStablePanelId(panelId)) {
    return {
      ok: false,
      status: 'invalid',
      reason: 'malformed_arguments',
      message: 'panelId must be a stable dashboard panel ID.',
      panelId: typeof panelId === 'string' ? panelId.slice(0, PANEL_LAYOUT_ID_MAX_CHARS) : '',
    };
  }
  if (!isPanelLayoutRegion(region)) {
    return {
      ok: false,
      status: 'invalid',
      reason: 'invalid_region',
      message: 'region must be "sidebar" or "bottom".',
      panelId,
    };
  }
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    return {
      ok: false,
      status: 'invalid',
      reason: 'invalid_index',
      message: 'index must be a non-negative integer position in the target region.',
      panelId,
      region,
    };
  }

  const panel = findPanel(panels, panelId);
  if (!panel) {
    return {
      ok: false,
      status: 'denied',
      reason: 'panel_not_mounted',
      message: 'That panel is not mounted in the current layout.',
      panelId,
    };
  }

  // Idempotent same-slot requests succeed before restriction checks so agents
  // can safely re-assert the current layout.
  if (panel.region === region && panel.index === index) {
    return {
      ok: true,
      unchanged: true,
      panelId,
      region,
      index,
    };
  }

  if (panel.fixed) {
    return {
      ok: false,
      status: 'denied',
      reason: 'panel_fixed',
      message: 'That panel cannot be moved in the current layout.',
      panelId,
      region,
      index,
    };
  }
  if (region === 'bottom' && !bottomAvailable) {
    return {
      ok: false,
      status: 'denied',
      reason: 'region_unavailable',
      message: 'The bottom layout region is not available at the current viewport.',
      panelId,
      region,
      index,
    };
  }

  const targetPeers = panels.filter(
    (candidate) => candidate.region === region && candidate.id !== panelId,
  );
  const maxIndex = targetPeers.length;
  if (index > maxIndex) {
    return {
      ok: false,
      status: 'denied',
      reason: 'invalid_index',
      message: `index must be between 0 and ${maxIndex} for the ${region} region.`,
      panelId,
      region,
      index,
    };
  }

  return {
    ok: true,
    unchanged: false,
    panelId,
    region,
    index,
  };
}

export function mutationApplied(
  actionType: PanelLayoutMutationResult['actionType'],
  fields: Omit<PanelLayoutMutationResult, 'ok' | 'status' | 'actionType'>,
): PanelLayoutMutationResult {
  return {
    ok: true,
    status: 'applied',
    actionType,
    ...fields,
  };
}

export function mutationDenied(
  actionType: PanelLayoutMutationResult['actionType'],
  reason: PanelLayoutDenialReason,
  message: string,
  fields: Partial<Omit<PanelLayoutMutationResult, 'ok' | 'status' | 'actionType' | 'reason' | 'message'>> = {},
): PanelLayoutMutationResult {
  const status: PanelLayoutMutationStatus = reason === 'malformed_arguments'
    || reason === 'invalid_region'
    || reason === 'invalid_index'
    ? 'invalid'
    : 'denied';
  return {
    ok: false,
    status,
    actionType,
    reason,
    message,
    ...fields,
  };
}
