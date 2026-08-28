import type { SiteVariant } from './variant';

/**
 * Canonical names for every WebMCP page surface.
 *
 * Homepage tools are registered by the zero-import static welcome page. SPA
 * tools are imperative and are present in every dashboard variant. The
 * procurement tool is declarative: the panel adds its form attributes only
 * while the entitled, visible panel has settled data.
 */
export const WEBMCP_HOMEPAGE_TOOL_NAMES = [
  'launchWorldMonitor',
  'getWorldMonitorMcpEndpoint',
] as const;

export const WEBMCP_SPA_TOOL = Object.freeze({
  openCountryBrief: 'openCountryBrief',
  openSearch: 'openSearch',
  getDashboardContext: 'get_dashboard_context',
  openDashboardPanel: 'open_dashboard_panel',
  setMapView: 'set_map_view',
  setMapLayers: 'set_map_layers',
  searchDashboard: 'search_dashboard',
  openSearchResult: 'open_search_result',
} as const);

export const WEBMCP_SPA_TOOL_NAMES = [
  WEBMCP_SPA_TOOL.openCountryBrief,
  WEBMCP_SPA_TOOL.openSearch,
  WEBMCP_SPA_TOOL.getDashboardContext,
  WEBMCP_SPA_TOOL.openDashboardPanel,
  WEBMCP_SPA_TOOL.setMapView,
  WEBMCP_SPA_TOOL.setMapLayers,
  WEBMCP_SPA_TOOL.searchDashboard,
  WEBMCP_SPA_TOOL.openSearchResult,
] as const;

export const WEBMCP_DECLARATIVE_TOOL_NAMES = [
  'search_procurement',
] as const;

export const WEBMCP_PROCUREMENT_TOOL_NAME = WEBMCP_DECLARATIVE_TOOL_NAMES[0];

/** Shared limits for the declarative procurement form and its offline schema. */
export const WEBMCP_PROCUREMENT_TEXT_MAX_CHARS = 160;
export const WEBMCP_PROCUREMENT_COUNTRY_CODE_CHARS = 2;
export const WEBMCP_PROCUREMENT_COUNTRY_CODE_PATTERN = '^[A-Za-z]{2}$';

export type WebMcpHomepageToolName = (typeof WEBMCP_HOMEPAGE_TOOL_NAMES)[number];
export type WebMcpSpaToolName = (typeof WEBMCP_SPA_TOOL_NAMES)[number];
export type WebMcpDeclarativeToolName = (typeof WEBMCP_DECLARATIVE_TOOL_NAMES)[number];

export interface WebMcpVariantInventory {
  /** Always registered by the dashboard SPA. */
  spa: readonly WebMcpSpaToolName[];
  /**
   * Declarative tools whose panel is enabled in this variant's fresh defaults.
   * Registration still depends on entitlement, visibility, data, and idle
   * state, so these names are never part of the unconditional SPA inventory.
   */
  conditionalDeclarative: readonly WebMcpDeclarativeToolName[];
}

function variantInventory(hasDefaultProcurement: boolean): WebMcpVariantInventory {
  return Object.freeze({
    spa: WEBMCP_SPA_TOOL_NAMES,
    conditionalDeclarative: hasDefaultProcurement
      ? WEBMCP_DECLARATIVE_TOOL_NAMES
      : [],
  });
}

export const WEBMCP_VARIANT_INVENTORIES = Object.freeze({
  full: variantInventory(true),
  tech: variantInventory(true),
  finance: variantInventory(true),
  happy: variantInventory(false),
  commodity: variantInventory(false),
  energy: variantInventory(false),
}) satisfies Readonly<Record<SiteVariant, WebMcpVariantInventory>>;

/** Shared contract budgets applied uniformly to every imperative SPA tool. */
export const WEBMCP_TOOL_BUDGETS = Object.freeze({
  nameChars: 30,
  titleChars: 80,
  descriptionChars: 500,
  propertyDescriptionChars: 150,
  inputSchemaJsonChars: 2_048,
  outputJsonChars: 1_500,
  errorMessageChars: 320,
});
