export const DASHBOARD_MAP_VIEWS = [
  'global',
  'america',
  'mena',
  'eu',
  'asia',
  'latam',
  'africa',
  'oceania',
] as const;

export const DASHBOARD_TIME_RANGES = [
  '1h',
  '6h',
  '24h',
  '48h',
  '7d',
  'all',
] as const;

// Public WebMCP/agent-bus grammar. The visible dashboard buttons are labeled
// 2D/3D; storage still uses the internal flat/globe preference.
export const DASHBOARD_MAP_MODES = ['2d', '3d'] as const;

export type DashboardTimeRange = (typeof DASHBOARD_TIME_RANGES)[number];
export type DashboardMapMode = (typeof DASHBOARD_MAP_MODES)[number];

export const DASHBOARD_COUNTRY_CODE_PATTERN = '^[A-Z]{2}$';

// Keep coordinate actions portable across every dashboard renderer. The flat
// map uses Web Mercator, whose finite latitude extent ends at this value; the
// globe can render the same range without renderer-specific normalization.
export const DASHBOARD_MAP_MAX_LATITUDE = 85.051129;

// WebMCP action results must remain below Chrome's 1.5K-character guidance
// without dropping per-target outcomes. Ten 30-character layer IDs plus the
// closed status/reason vocabulary fit as one complete atomic result.
export const MAX_LAYER_ACTION_TARGETS = 10;
export const MAX_LAYER_ACTION_TARGET_ID_LENGTH = 30;

// Layer registry keys are lower-camel identifiers. Keep the public action
// grammar ASCII-only (while tolerating '-'/'_' in unknown IDs so the applier
// can return a structured unknown_layer denial) because JSON-escaped control
// characters can expand far beyond their source length and break the bounded
// WebMCP result contract.
export const DASHBOARD_LAYER_ACTION_TARGET_ID_PATTERN = '^[a-z][A-Za-z0-9_-]*$';

// Canonical ALL_PANELS keys are mostly kebab-case, but a few live IDs are
// mixed-case (`regionalStartups`, `gccNews`). Catalog output and open_panel
// must share this grammar so schema-validating hosts can consume catalog IDs.
export const DASHBOARD_PANEL_ACTION_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9@_-]*$';
