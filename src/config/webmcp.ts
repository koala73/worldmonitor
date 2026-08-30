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
  listMapLayers: 'list_map_layers',
  listDashboardPanels: 'list_dashboard_panels',
  switchMonitor: 'switch_monitor',
  openSettings: 'open_settings',
  openAlerts: 'open_alerts',
  openDashboardPanel: 'open_dashboard_panel',
  setPanelEnabled: 'set_panel_enabled',
  getPanelLayout: 'get_panel_layout',
  setPanelCollapsed: 'set_panel_collapsed',
  movePanel: 'move_panel',
  setPanelFullscreen: 'set_panel_fullscreen',
  setMapView: 'set_map_view',
  setMapLayers: 'set_map_layers',
  setTimeRange: 'set_time_range',
  focusCountry: 'focus_country',
  setMapMode: 'set_map_mode',
  searchDashboard: 'search_dashboard',
  openSearchResult: 'open_search_result',
  listDashboardTabs: 'list_dashboard_tabs',
  selectDashboardTab: 'select_dashboard_tab',
  createDashboardTab: 'create_dashboard_tab',
  renameDashboardTab: 'rename_dashboard_tab',
  deleteDashboardTab: 'delete_dashboard_tab',
  listMissionPresets: 'list_mission_presets',
  applyMissionPreset: 'apply_mission_preset',
  openMissionPicker: 'open_mission_picker',
  getAccessContext: 'get_access_context',
  openSignIn: 'open_sign_in',
} as const);

export const WEBMCP_SPA_TOOL_NAMES = [
  WEBMCP_SPA_TOOL.openCountryBrief,
  WEBMCP_SPA_TOOL.openSearch,
  WEBMCP_SPA_TOOL.getDashboardContext,
  WEBMCP_SPA_TOOL.listMapLayers,
  WEBMCP_SPA_TOOL.listDashboardPanels,
  WEBMCP_SPA_TOOL.switchMonitor,
  WEBMCP_SPA_TOOL.openSettings,
  WEBMCP_SPA_TOOL.openAlerts,
  WEBMCP_SPA_TOOL.openDashboardPanel,
  WEBMCP_SPA_TOOL.setPanelEnabled,
  WEBMCP_SPA_TOOL.getPanelLayout,
  WEBMCP_SPA_TOOL.setPanelCollapsed,
  WEBMCP_SPA_TOOL.movePanel,
  WEBMCP_SPA_TOOL.setPanelFullscreen,
  WEBMCP_SPA_TOOL.setMapView,
  WEBMCP_SPA_TOOL.setMapLayers,
  WEBMCP_SPA_TOOL.setTimeRange,
  WEBMCP_SPA_TOOL.focusCountry,
  WEBMCP_SPA_TOOL.setMapMode,
  WEBMCP_SPA_TOOL.searchDashboard,
  WEBMCP_SPA_TOOL.openSearchResult,
  WEBMCP_SPA_TOOL.listDashboardTabs,
  WEBMCP_SPA_TOOL.selectDashboardTab,
  WEBMCP_SPA_TOOL.createDashboardTab,
  WEBMCP_SPA_TOOL.renameDashboardTab,
  WEBMCP_SPA_TOOL.deleteDashboardTab,
  WEBMCP_SPA_TOOL.listMissionPresets,
  WEBMCP_SPA_TOOL.applyMissionPreset,
  WEBMCP_SPA_TOOL.openMissionPicker,
  WEBMCP_SPA_TOOL.getAccessContext,
  WEBMCP_SPA_TOOL.openSignIn,
] as const;

/**
 * Every stable reason `open_mission_picker` reports as a bounded navigation
 * result. Unlike the other mission tools, its App binding does not prethrow on
 * a destroyed dashboard, so `app_destroyed` reaches callers as a result here
 * rather than as a rejection.
 *
 * `unavailable` is picker-specific and is emitted from the mission-picker path.
 * `malformedArguments` and `appDestroyed` arrive from the shared argument and
 * navigation paths, which keep their own literals because every navigation tool
 * shares them.
 */
export const WEBMCP_MISSION_PICKER_REASON = Object.freeze({
  malformedArguments: 'malformed_arguments',
  unavailable: 'unavailable',
  appDestroyed: 'app_destroyed',
} as const);

export const WEBMCP_MISSION_PICKER_REASONS = [
  WEBMCP_MISSION_PICKER_REASON.malformedArguments,
  WEBMCP_MISSION_PICKER_REASON.unavailable,
  WEBMCP_MISSION_PICKER_REASON.appDestroyed,
] as const;

export type WebMcpMissionPickerReason = (typeof WEBMCP_MISSION_PICKER_REASONS)[number];

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
