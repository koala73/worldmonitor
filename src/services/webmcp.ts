// WebMCP — in-page agent tool surface.
//
// Registers a small set of tools via `document.modelContext.registerTool`
// so browsers implementing the current WebMCP API can drive the site the same
// way a human does. Tools MUST route through existing UI code paths so agents
// inherit every auth/entitlement gate a browser user is subject to — they are
// not a backdoor around the paywall.
//
// Current tools mirror the static Agent Skills set (#3310) and add bounded
// live-dashboard context/actions through the existing agent-bus seam (#6211):
//   1. openCountryBrief({ iso2 }) — opens the country deep-dive panel.
//   2. openSearch()               — opens the global command palette.
//   3. get_dashboard_context()    — reads bounded visible dashboard state.
//   4. list_map_layers()          — pages the canonical map-layer catalog.
//   5. list_dashboard_panels()    — pages the canonical panel catalog.
//   6. switch_monitor()           — switches World/Tech/Finance/Commodity/Energy/Good News.
//   7. open_settings()            — opens the settings overlay.
//   8. open_alerts()              — opens the alerts/notifications tab.
//   9. open_dashboard_panel()     — opens an already-live panel.
//  10. set_panel_enabled()        — enables or disables a catalog panel.
//  11. get_panel_layout()         — reads region order, collapse, fullscreen.
//  12. set_panel_collapsed()      — collapses or expands a collapsible panel.
//  13. move_panel()               — moves a panel by region and index.
//  14. set_panel_fullscreen()     — toggles panel fullscreen when supported.
//  15. set_map_view()             — moves the visible map.
//  16. set_map_layers()           — changes allowed visible map layers.
//  17. set_time_range()           — sets the visible map time range.
//  18. focus_country()            — focuses a country bbox without a briefing.
//  19. set_map_mode()             — switches the visible 2D/3D map renderer.
//  20. search_dashboard()         — searches the live dashboard index.
//  21. open_search_result()       — selects an opaque, revalidated result.
//  22. list_dashboard_tabs()      — enumerates persistent workspace tabs.
//  23. select_dashboard_tab()     — switches the active workspace tab.
//  24. create_dashboard_tab()     — creates a workspace, or returns one by name.
//  25. rename_dashboard_tab()     — renames a workspace tab by stable ID.
//  26. delete_dashboard_tab()     — deletes a workspace tab after confirm=true.
//  27. list_mission_presets()     — lists bundled mission presets for this monitor.
//  28. apply_mission_preset()     — applies a bundled preset atomically.
//  29. open_mission_picker()      — opens the mission preset picker.
//  30. get_access_context()       — reads signed-out / loading / signed-in access.
//  31. open_sign_in()             — opens the existing Clerk sign-in dialog.
//
// No tool is conditionally registered. Live controls re-check auth and
// entitlement through the agent-bus applier on every invocation, so a single
// registration remains correct across sign-in/sign-out.
//
// Scanner compatibility: WebMCP scanners probe for
// `document.modelContext.registerTool` invocations during initial page load.
// Register synchronously from App.ts (no dynamic import, no init-phase
// awaits) so the probe finds the tools before it gives up.

import { trackPrivacyRestricted, type UmamiEvent } from './analytics';
import { markLcpDebug } from '../utils/lcp-debug';
import {
  WEBMCP_SPA_TOOL,
  WEBMCP_SPA_TOOL_NAMES,
  WEBMCP_TOOL_BUDGETS,
  type WebMcpSpaToolName,
} from '../config/webmcp';
import { SITE_VARIANTS, isSiteVariant, type SiteVariant } from '../config/variant';
import {
  DASHBOARD_PANEL_CATALOG_CATEGORY_KEYS,
  DASHBOARD_PANEL_CATALOG_DEFAULT_LIMIT,
  DASHBOARD_PANEL_CATALOG_MAX_LIMIT,
  DASHBOARD_PANEL_CATALOG_OUTPUT_TARGET_CHARS,
  DASHBOARD_PANEL_CATEGORY_MAX_CHARS,
  DASHBOARD_PANEL_ID_MAX_CHARS,
  DASHBOARD_PANEL_ID_PATTERN,
  DASHBOARD_PANEL_LABEL_MAX_CHARS,
  DashboardPanelCatalogError,
  type DashboardPanelCatalogItem,
  type DashboardPanelCatalogPage,
  type DashboardPanelCatalogQuery,
  type DashboardPanelUnavailableReason,
} from './webmcp-panel-catalog';
import {
  DASHBOARD_MAP_MAX_LATITUDE,
  DASHBOARD_MAP_MODES,
  DASHBOARD_MAP_VIEWS,
  DASHBOARD_TIME_RANGES,
  DASHBOARD_COUNTRY_CODE_PATTERN,
  DASHBOARD_LAYER_ACTION_TARGET_ID_PATTERN,
  MAX_LAYER_ACTION_TARGET_ID_LENGTH,
  MAX_LAYER_ACTION_TARGETS,
} from '../../shared/agent-bus-contract';
import {
  DASHBOARD_TAB_ID_PATTERN,
  DASHBOARD_TAB_NAME_MAX_LENGTH,
  isDashboardTabId,
  isDashboardTabListSnapshot,
  mutationDenied,
  type DashboardTabAction,
  type DashboardTabActionResult,
  type DashboardTabListSnapshot,
  type DashboardTabMutationResult,
} from './dashboard-tab-actions';
import {
  DEFAULT_MAP_LAYER_PAGE_SIZE,
  MAX_MAP_LAYER_PAGE_SIZE,
  WEBMCP_MAP_LAYER_MONITORS,
  WEBMCP_MAP_LAYER_RENDERERS,
  WEBMCP_MAP_LAYER_STATES,
  listMapLayerCatalog,
  parseMapLayerCatalogArgs,
  type MapLayerCatalogSnapshot,
} from './webmcp-map-layer-catalog';
import type { SetPanelEnabledResult } from '../config/panel-enablement';
import {
  MISSION_PRESET_APPLY_DENY_REASONS,
  MissionPresetCatalogError,
  isMissionPresetId,
  type MissionPresetApplyDenyReason,
  type MissionPresetCatalogQuery,
  type MissionPresetCatalogResult,
} from './webmcp-mission-preset-catalog';
import type { MissionPresetId } from './mission-presets';
import type {
  PanelLayoutMutationResult,
  PanelLayoutSnapshot,
} from './panel-layout-actions';
import {
  PANEL_LAYOUT_DENIAL_REASONS,
  PANEL_LAYOUT_ID_MAX_CHARS,
  PANEL_LAYOUT_REGIONS,
} from './panel-layout-actions';

export interface WebMcpAppBindings {
  openCountryBriefByCode(
    code: string,
    country: string,
    options?: WebMcpExecutionOptions,
  ): boolean | Promise<boolean>;
  resolveCountryName(code: string): string;
  // Returns a Promise because implementations may await a readiness signal
  // (e.g. waiting for the search modal to exist during startup) before
  // dispatching. Tool executes must `await` it so rejections surface to
  // withInvocationLogging's catch path.
  openSearch(options?: WebMcpExecutionOptions): boolean | Promise<boolean>;
  getDashboardContext(
    options?: WebMcpExecutionOptions,
  ): DashboardContextSnapshot | Promise<DashboardContextSnapshot>;
  listMapLayerCatalog(
    options?: WebMcpExecutionOptions,
  ): MapLayerCatalogSnapshot | Promise<MapLayerCatalogSnapshot>;
  listDashboardPanels(
    query: DashboardPanelCatalogQuery,
    options?: WebMcpExecutionOptions,
  ): DashboardPanelCatalogPage | Promise<DashboardPanelCatalogPage>;
  switchMonitor(
    monitor: SiteVariant,
    options?: WebMcpExecutionOptions,
  ): WebMcpNavigationResult | Promise<WebMcpNavigationResult>;
  openSettings(
    options?: WebMcpExecutionOptions,
  ): WebMcpNavigationResult | Promise<WebMcpNavigationResult>;
  openAlerts(
    options?: WebMcpExecutionOptions,
  ): WebMcpNavigationResult | Promise<WebMcpNavigationResult>;
  applyDashboardAction(
    action: unknown,
    options?: WebMcpExecutionOptions,
  ): DashboardActionResult | Promise<DashboardActionResult>;
  searchDashboard(
    query: string,
    scope: DashboardSearchScope,
    limit: number,
    options?: WebMcpExecutionOptions,
  ): DashboardSearchResponse | Promise<DashboardSearchResponse>;
  openSearchResult(
    resultKey: string,
    options?: WebMcpExecutionOptions,
  ): DashboardSearchOpenResult | Promise<DashboardSearchOpenResult>;
  applyDashboardTabAction(
    action: DashboardTabAction,
    options?: WebMcpExecutionOptions,
  ): DashboardTabActionResult | Promise<DashboardTabActionResult>;
  setPanelEnabled(
    panelId: unknown,
    enabled: unknown,
    options?: WebMcpExecutionOptions,
  ): SetPanelEnabledResult | Promise<SetPanelEnabledResult>;
  listMissionPresets(
    query: MissionPresetCatalogQuery,
    options?: WebMcpExecutionOptions,
  ): MissionPresetCatalogResult | Promise<MissionPresetCatalogResult>;
  applyMissionPreset(
    presetId: unknown,
    options?: WebMcpExecutionOptions,
  ): ApplyMissionPresetResult | Promise<ApplyMissionPresetResult>;
  openMissionPicker(
    options?: WebMcpExecutionOptions,
  ): WebMcpNavigationResult | Promise<WebMcpNavigationResult>;
  getPanelLayout(
    options?: WebMcpExecutionOptions,
  ): PanelLayoutSnapshot | Promise<PanelLayoutSnapshot>;
  setPanelCollapsed(
    panelId: unknown,
    collapsed: unknown,
    options?: WebMcpExecutionOptions,
  ): PanelLayoutMutationResult | Promise<PanelLayoutMutationResult>;
  movePanel(
    panelId: unknown,
    region: unknown,
    index: unknown,
    options?: WebMcpExecutionOptions,
  ): PanelLayoutMutationResult | Promise<PanelLayoutMutationResult>;
  setPanelFullscreen(
    panelId: unknown,
    fullscreen: unknown,
    options?: WebMcpExecutionOptions,
  ): PanelLayoutMutationResult | Promise<PanelLayoutMutationResult>;
  getAccessContext(
    options?: WebMcpExecutionOptions,
  ): AccessContextSnapshot | Promise<AccessContextSnapshot>;
  openSignIn(
    options?: WebMcpExecutionOptions,
  ): OpenSignInResult | Promise<OpenSignInResult>;
}

export interface ApplyMissionPresetResult {
  ok: boolean;
  status: 'applied' | 'unchanged' | 'denied' | 'invalid';
  presetId?: string;
  label?: string;
  changed?: boolean;
  monitor?: string;
  map?: {
    view: string;
    zoom: number;
    timeRange: string;
    enabledLayers: string[];
  };
  panels?: {
    enabled: string[];
  };
  reason?: MissionPresetApplyDenyReason;
  message: string;
}

export interface WebMcpExecutionOptions {
  signal?: AbortSignal;
}

export type DashboardSearchScope = 'all' | 'signals' | 'map' | 'panels' | 'actions';

export interface DashboardSearchDescriptor {
  key: string;
  type: string;
  title: string;
  subtitle?: string;
  executable: boolean;
}

export interface DashboardSearchResponse {
  queryLength: number;
  results: DashboardSearchDescriptor[];
  resultCount: number;
  truncated: boolean;
}

export type DashboardSearchOpenReason =
  | 'malformed_arguments'
  | 'invalid_or_expired_key'
  | 'search_state_changed'
  | 'result_no_longer_available'
  | 'result_no_longer_executable'
  | 'target_cancellation_unsupported';

export interface DashboardSearchOpenResult {
  ok: boolean;
  status: 'opened' | 'denied';
  type?: string;
  reason?: DashboardSearchOpenReason;
  message?: string;
}

export interface DashboardContextSnapshot {
  variant: string;
  map: {
    view: string;
    center: { lat: number; lon: number } | null;
    zoom: number;
    mode?: '2d' | '3d';
    timeRange: string;
    enabledLayers: string[];
  };
  panels: {
    mounted: string[];
    enabled: string[];
  };
}

export const WEBMCP_MONITOR_KEYS = SITE_VARIANTS;

export type WebMcpMonitorKey = SiteVariant;
export type WebMcpNavDestination = WebMcpMonitorKey | 'settings' | 'alerts' | 'mission_picker';
export type WebMcpMonitorNavigation = 'none' | 'reload' | 'assign';

export interface WebMcpNavigationResult {
  ok: boolean;
  status: 'applied' | 'denied' | 'invalid';
  destination?: WebMcpNavDestination;
  navigation?: WebMcpMonitorNavigation;
  overlay?: 'open' | 'closed';
  tab?: string;
  reason?: string;
  message: string;
  context: DashboardContextSnapshot;
}

export type WebMcpAccountState = 'signed_out' | 'loading' | 'signed_in';
export type WebMcpClerkState = 'unavailable' | 'loading' | 'ready';
export type WebMcpProductTier = 'anonymous' | 'free' | 'pro' | 'unknown';

export interface AccessContextSnapshot {
  accountState: WebMcpAccountState;
  clerk: WebMcpClerkState;
  productTier: WebMcpProductTier;
  capabilities: {
    premiumAccess: boolean;
    apiAccess: boolean;
    mcpAccess: boolean;
    dataExport: boolean;
  };
  limits: {
    enabledPanels: { used: number; cap: number | null };
    dashboardTabs: { used: number; cap: number | null; canCreate: boolean };
  };
}

export type OpenSignInResult =
  | { ok: true; status: 'opened' }
  | { ok: true; status: 'already_open'; reason: 'already_open' }
  | { ok: false; status: 'denied'; reason: 'clerk_unavailable' };

export type DashboardActionStatus = 'applied' | 'denied' | 'invalid' | 'skipped';

export interface DashboardActionTargetResult {
  target: string;
  status: DashboardActionStatus;
  reason?: string;
}

export interface DashboardActionViewState {
  timeRange?: string;
  iso2?: string;
  mode?: string;
  renderer?: string;
  lat?: number;
  lon?: number;
  zoom?: number;
}

export interface DashboardActionCompatibility {
  adjusted: boolean;
  layers?: Array<{
    layer: string;
    from: boolean;
    to: boolean;
    reason: string;
  }>;
}

export interface DashboardActionResult {
  ok: boolean;
  status: DashboardActionStatus;
  actionType?: 'open_panel' | 'set_view' | 'set_layers' | 'set_time_range' | 'focus_country' | 'set_map_mode';
  reason?: string;
  message: string;
  targets: DashboardActionTargetResult[];
  requested?: DashboardActionViewState;
  effective?: DashboardActionViewState;
  compatibility?: DashboardActionCompatibility;
}

export type DashboardBindingFailureReason = 'app_destroyed' | 'map_unavailable';

export class DashboardBindingError extends Error {
  public constructor(
    public readonly reason: DashboardBindingFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'DashboardBindingError';
  }
}

type WebMcpAnalytics = (event: UmamiEvent, data?: Record<string, unknown>) => void;
type WebMcpInvocationOutcome = 'success' | 'denied' | 'failure';
type WebMcpInvocationReason =
  | 'completed'
  | 'validation'
  | 'entitlement'
  | 'unavailable'
  | 'stale'
  | 'cancelled'
  | 'internal';
type RegistrationFailureReason =
  | 'invalid-state'
  | 'security'
  | 'not-allowed'
  | 'invalid-tool'
  | 'unknown';

interface WebMcpToolExecutionContext {
  signal?: AbortSignal;
}

type DashboardWebMcpTool = Omit<WebMCP.ModelContextTool, 'execute'> & {
  name: WebMcpSpaToolName;
  execute: (
    input: Record<string, unknown>,
    context?: WebMcpToolExecutionContext,
  ) => Promise<unknown> | unknown;
};

interface WebMcpRegistrationRuntime {
  document?: Pick<Document, 'modelContext' | 'addEventListener'>;
  window?: Pick<Window, 'addEventListener'>;
  track?: WebMcpAnalytics;
}

const ISO2 = /^[A-Z]{2}$/;
const SEARCH_RESULT_KEY = /^sr_[a-f0-9]{32}$/;
const DASHBOARD_SEARCH_SCOPES = new Set<DashboardSearchScope>([
  'all', 'signals', 'map', 'panels', 'actions',
]);
const DASHBOARD_SEARCH_OPEN_REASONS = new Set<DashboardSearchOpenReason>([
  'malformed_arguments',
  'invalid_or_expired_key',
  'search_state_changed',
  'result_no_longer_available',
  'result_no_longer_executable',
  'target_cancellation_unsupported',
]);
// Cancellation policy per tool. Chrome documents the callback as
// `execute(input, { signal })`, but shipped builds through 151 invoke it with
// the input alone — true even when the caller passes `{ signal }` to
// `executeTool()`. A cancelled invocation rejects on the agent side while the
// page work runs on: a phantom completion.
//
// Gate a tool when its effect can outlive caller cancellation. The policy name
// describes the runtime requirement instead of one particular reason for it.
//   - 'cancellation-required' (gated): set_map_layers writes
//     STORAGE_KEYS.mapLayers to local storage (and for `ais` opens a network
//     stream). Putting the map back by hand restores neither. openCountryBrief
//     can start server-side LLM generation that consumes the caller's daily
//     allowance. The gateway cannot refund a request merely because
//     browser-side execution was cancelled.
//   - 'result-dependent': open_search_result is a selector. Cancellation is
//     evaluated for the issued result's bound effect class, not the tool as a
//     whole. View-state results (opening an already-enabled panel with no tab
//     deep-link, moving the map) run without a target-side signal; persistent,
//     quota-consuming, and external-navigation results stay blocked.
//   - 'cancellation-required': switch_monitor can persist a desktop variant
//     selection and reload, or navigate the tab to another origin. Neither
//     effect is a reversible dashboard-only view change.
//   - 'view-state': set_map_view also writes share-URL state via
//     history.replaceState — visible in the address bar and overwritten by the
//     next human map move.
//   - 'read-only': nothing to undo.
//
// Keyed by WebMcpSpaToolName, so adding a tool without a policy entry is
// a TypeScript error. That is the forcing function: nothing ships unclassified.
export const WEBMCP_TOOL_CANCELLATION_POLICY: Readonly<
  Record<
    WebMcpSpaToolName,
    'read-only' | 'view-state' | 'cancellation-required' | 'result-dependent'
  >
> = Object.freeze({
  [WEBMCP_SPA_TOOL.getDashboardContext]: 'read-only',
  [WEBMCP_SPA_TOOL.getAccessContext]: 'read-only',
  [WEBMCP_SPA_TOOL.listMapLayers]: 'read-only',
  [WEBMCP_SPA_TOOL.listDashboardPanels]: 'read-only',
  [WEBMCP_SPA_TOOL.searchDashboard]: 'read-only',
  [WEBMCP_SPA_TOOL.getPanelLayout]: 'read-only',
  [WEBMCP_SPA_TOOL.openSearch]: 'view-state',
  [WEBMCP_SPA_TOOL.switchMonitor]: 'cancellation-required',
  [WEBMCP_SPA_TOOL.openSettings]: 'view-state',
  [WEBMCP_SPA_TOOL.openAlerts]: 'view-state',
  [WEBMCP_SPA_TOOL.openSignIn]: 'view-state',
  [WEBMCP_SPA_TOOL.openDashboardPanel]: 'view-state',
  [WEBMCP_SPA_TOOL.setPanelEnabled]: 'cancellation-required',
  [WEBMCP_SPA_TOOL.setPanelCollapsed]: 'cancellation-required',
  [WEBMCP_SPA_TOOL.movePanel]: 'cancellation-required',
  [WEBMCP_SPA_TOOL.setPanelFullscreen]: 'view-state',
  [WEBMCP_SPA_TOOL.setMapView]: 'view-state',
  [WEBMCP_SPA_TOOL.setTimeRange]: 'view-state',
  [WEBMCP_SPA_TOOL.focusCountry]: 'view-state',
  [WEBMCP_SPA_TOOL.openCountryBrief]: 'cancellation-required',
  [WEBMCP_SPA_TOOL.setMapLayers]: 'cancellation-required',
  [WEBMCP_SPA_TOOL.setMapMode]: 'cancellation-required',
  [WEBMCP_SPA_TOOL.openSearchResult]: 'result-dependent',
  [WEBMCP_SPA_TOOL.listDashboardTabs]: 'read-only',
  [WEBMCP_SPA_TOOL.selectDashboardTab]: 'cancellation-required',
  [WEBMCP_SPA_TOOL.createDashboardTab]: 'cancellation-required',
  [WEBMCP_SPA_TOOL.renameDashboardTab]: 'cancellation-required',
  [WEBMCP_SPA_TOOL.deleteDashboardTab]: 'cancellation-required',
  [WEBMCP_SPA_TOOL.listMissionPresets]: 'read-only',
  [WEBMCP_SPA_TOOL.applyMissionPreset]: 'cancellation-required',
  [WEBMCP_SPA_TOOL.openMissionPicker]: 'view-state',
});

/** Tools the page refuses to run without a target-side AbortSignal. */
export const CANCELLATION_REQUIRED_WEBMCP_TOOLS: ReadonlySet<WebMcpSpaToolName> = new Set(
  Object.entries(WEBMCP_TOOL_CANCELLATION_POLICY)
    .filter(([, policy]) => policy === 'cancellation-required')
    .map(([name]) => name as WebMcpSpaToolName),
);
const MAX_SEARCH_QUERY_CHARS = 160;
const MAX_SEARCH_RESULTS = 10;
const DEFAULT_SEARCH_RESULTS = 8;
const MAX_OUTPUT_CHARS = WEBMCP_TOOL_BUDGETS.outputJsonChars;
const TARGET_OUTPUT_CHARS = 1_400;
export const DASHBOARD_SEARCH_OUTPUT_TARGET_CHARS = 1_400;
export const DASHBOARD_SEARCH_TYPE_MAX_CHARS = 32;
export const DASHBOARD_SEARCH_TITLE_MAX_CHARS = 160;
export const DASHBOARD_SEARCH_SUBTITLE_MAX_CHARS = 180;
const SEARCH_RESULT_TYPE_BUCKETS = new Set([
  'command',
  'country',
  'news',
  'hotspot',
  'market',
  'prediction',
  'conflict',
  'base',
  'pipeline',
  'cable',
  'datacenter',
  'earthquake',
  'outage',
  'nuclear',
  'irradiator',
  'techcompany',
  'ailab',
  'startup',
  'techevent',
  'techhq',
  'accelerator',
  'exchange',
  'financialcenter',
  'centralbank',
  'commodityhub',
  'flight',
]);
const TOOL_FAILURE_MESSAGES: Record<WebMcpSpaToolName, string> = {
  openCountryBrief: 'World Monitor could not open that country brief.',
  openSearch: 'World Monitor could not open search.',
  get_dashboard_context: 'World Monitor could not read dashboard context.',
  list_map_layers: 'World Monitor could not list map layers.',
  list_dashboard_panels: 'World Monitor could not list dashboard panels.',
  switch_monitor: 'World Monitor could not switch monitors.',
  open_settings: 'World Monitor could not open settings.',
  open_alerts: 'World Monitor could not open alerts.',
  open_dashboard_panel: 'World Monitor could not open that dashboard panel.',
  set_panel_enabled: 'World Monitor could not update that dashboard panel.',
  get_panel_layout: 'World Monitor could not read the panel layout.',
  set_panel_collapsed: 'World Monitor could not update that panel collapse state.',
  move_panel: 'World Monitor could not move that panel.',
  set_panel_fullscreen: 'World Monitor could not update that panel fullscreen state.',
  set_map_view: 'World Monitor could not move the map.',
  set_map_layers: 'World Monitor could not update map layers.',
  set_time_range: 'World Monitor could not set the map time range.',
  focus_country: 'World Monitor could not focus that country.',
  set_map_mode: 'World Monitor could not switch the map mode.',
  search_dashboard: 'World Monitor could not search the dashboard.',
  open_search_result: 'World Monitor could not open that search result.',
  list_dashboard_tabs: 'World Monitor could not list dashboard tabs.',
  select_dashboard_tab: 'World Monitor could not select that dashboard tab.',
  create_dashboard_tab: 'World Monitor could not create that dashboard tab.',
  rename_dashboard_tab: 'World Monitor could not rename that dashboard tab.',
  delete_dashboard_tab: 'World Monitor could not delete that dashboard tab.',
  list_mission_presets: 'World Monitor could not list mission presets.',
  apply_mission_preset: 'World Monitor could not apply that mission preset.',
  open_mission_picker: 'World Monitor could not open the mission picker.',
  get_access_context: 'World Monitor could not read access context.',
  open_sign_in: 'World Monitor could not open sign-in.',
};
export const WEBMCP_UNSUPPORTED_CANCELLATION_MESSAGE =
  'This browser cannot cancel work already running in the page, so World Monitor '
  + 'will not run tools whose effects can outlive cancellation. Read-only and '
  + 'reversible view-state dashboard tools still work.';

function unsupportedCancellationResult(): Record<string, unknown> {
  return {
    ok: false,
    status: 'denied',
    reason: 'target_cancellation_unsupported',
    message: WEBMCP_UNSUPPORTED_CANCELLATION_MESSAGE,
  };
}

class SafeWebMcpError extends Error {
  public constructor(
    message: string,
    public readonly analyticsReason: WebMcpInvocationReason = 'internal',
  ) {
    super(message.slice(0, WEBMCP_TOOL_BUDGETS.errorMessageChars));
    this.name = 'WebMcpToolError';
  }
}

function reportWebMcpEvent(
  trackEvent: WebMcpAnalytics,
  event: UmamiEvent,
  data: Record<string, unknown>,
): void {
  try {
    trackEvent(event, data);
  } catch {
    // Optional telemetry must never affect registration or tool execution.
  }
}

function errorName(error: unknown): string {
  try {
    return error && typeof error === 'object' && 'name' in error
      ? String((error as { name?: unknown }).name ?? '')
      : '';
  } catch {
    return '';
  }
}

export function isWebMcpAbortError(error: unknown): boolean {
  return errorName(error) === 'AbortError';
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (!value || typeof value !== 'object') return false;
  try {
    const signal = value as Partial<AbortSignal>;
    return typeof signal.aborted === 'boolean'
      && typeof signal.addEventListener === 'function'
      && typeof signal.removeEventListener === 'function'
      && typeof signal.throwIfAborted === 'function';
  } catch {
    return false;
  }
}

export function throwIfWebMcpAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  signal.throwIfAborted();
  throw new DOMException('Tool execution was aborted.', 'AbortError');
}

export async function raceWebMcpAbort<T>(
  source: PromiseLike<T> | T,
  signal?: AbortSignal,
): Promise<T> {
  throwIfWebMcpAborted(signal);
  if (!signal) return await source;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener('abort', handleAbort);
    const finish = (callback: (value: T) => void, value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const handleAbort = (): void => {
      try {
        throwIfWebMcpAborted(signal);
      } catch (error) {
        fail(error);
      }
    };

    signal.addEventListener('abort', handleAbort, { once: true });
    Promise.resolve(source).then(
      (value) => finish(resolve, value),
      fail,
    );
    // Close the race between the entry check and listener installation.
    if (signal.aborted) handleAbort();
  });
}

interface WebMcpInvocationHooks {
  preflight?: (
    args: Record<string, unknown>,
    extra?: WebMcpToolExecutionContext,
  ) => Promise<unknown | undefined> | unknown | undefined;
  successMetadata?: (
    args: Record<string, unknown>,
    result: unknown,
  ) => Record<string, unknown>;
}

function withInvocationLogging(
  name: WebMcpSpaToolName,
  fn: (
    input: Record<string, unknown>,
    extra?: { signal?: AbortSignal },
  ) => Promise<unknown> | unknown,
  trackEvent: WebMcpAnalytics,
  hooks: WebMcpInvocationHooks = {},
): DashboardWebMcpTool['execute'] {
  return async (args, extra?: WebMcpToolExecutionContext) => {
    const signal = isAbortSignal(extra?.signal) ? extra.signal : undefined;
    const execution = signal ? { signal } : undefined;
    markLcpDebug('wm:webmcp:tool-start', {
      tool: name,
      targetCancellationSupported: Boolean(signal),
    });
    try {
      throwIfWebMcpAborted(signal);
      const preflightResult = await hooks.preflight?.(args, execution);
      throwIfWebMcpAborted(signal);
      let result: unknown;
      if (preflightResult !== undefined) {
        result = preflightResult;
      } else if (CANCELLATION_REQUIRED_WEBMCP_TOOLS.has(name) && !signal) {
        // This tool declared that a phantom completion would be unsafe, and
        // the host cannot deliver the target-side signal. Return a structured
        // denial because some hosts erase the name and message of errors
        // raised by the page callback.
        result = unsupportedCancellationResult();
      } else {
        result = await fn(args, execution);
        // Browser cancellation rejects executeTool independently of this
        // callback. Re-check here so late work cannot publish success telemetry
        // after the host has already cancelled the invocation.
        throwIfWebMcpAborted(signal);
      }
      enforceOutputBudget(result);
      const invocation = classifyInvocationResult(result);
      reportWebMcpEvent(trackEvent, 'webmcp-tool-invoked', {
        tool: name,
        ...invocation,
        ...(hooks.successMetadata?.(args, result) ?? {}),
      });
      return result;
    } catch (error) {
      const reason = signal?.aborted
        ? 'cancelled'
        : classifyInvocationError(error);
      reportWebMcpEvent(trackEvent, 'webmcp-tool-invoked', {
        tool: name,
        outcome: 'failure',
        reason,
      });
      if (signal?.aborted) throwIfWebMcpAborted(signal);
      if (error instanceof SafeWebMcpError) throw error;
      if (isWebMcpAbortError(error)) throw error;
      if (error instanceof DashboardBindingError) {
        throw new SafeWebMcpError(
          `Dashboard unavailable: ${boundedText(error.message, 160)} Reason: ${error.reason}.`,
          'unavailable',
        );
      }
      if (error instanceof DashboardPanelCatalogError) {
        throw new SafeWebMcpError(error.message, 'validation');
      }
      if (error instanceof MissionPresetCatalogError) {
        throw new SafeWebMcpError(error.message, 'validation');
      }
      throw new SafeWebMcpError(TOOL_FAILURE_MESSAGES[name]);
    }
  };
}

function enforceOutputBudget(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string' || serialized.length > MAX_OUTPUT_CHARS) {
    throw new SafeWebMcpError('Tool output exceeded the safe output limit.');
  }
}

function structuredResultReasons(result: Record<string, unknown>): string[] {
  const reasons = typeof result.reason === 'string' ? [result.reason] : [];
  if (!Array.isArray(result.targets)) return reasons;
  for (const target of result.targets) {
    if (target && typeof target === 'object' && 'reason' in target) {
      const reason = (target as { reason?: unknown }).reason;
      if (typeof reason === 'string') reasons.push(reason);
    }
  }
  return reasons;
}

const VALIDATION_DENIAL_REASONS = new Set([
  'malformed_arguments',
  'invalid_action',
  'not_dashboard_control',
  'invalid_name',
  'confirmation_required',
  'last_tab',
  'invalid_monitor',
  'invalid_renderer',
  'invalid_state',
  'invalid_limit',
  'invalid_cursor',
  'unknown_monitor',
  'unknown_panel',
  'unknown_country',
]);
const ENTITLEMENT_DENIAL_REASONS = new Set([
  'panel_not_entitled',
  'panel_cap_exceeded',
  'layer_not_entitled',
  'tab_cap',
  'preset_not_entitled',
]);
const STALE_DENIAL_REASONS = new Set([
  'invalid_or_expired_key',
  'search_state_changed',
  'result_no_longer_available',
  'result_no_longer_executable',
  'tab_not_found',
]);

function classifyStructuredDenial(result: Record<string, unknown>): WebMcpInvocationReason {
  if (result.status === 'invalid') return 'validation';
  const reasons = structuredResultReasons(result);
  if (reasons.some((reason) => VALIDATION_DENIAL_REASONS.has(reason))) return 'validation';
  if (reasons.some((reason) => ENTITLEMENT_DENIAL_REASONS.has(reason))) return 'entitlement';
  if (reasons.some((reason) => STALE_DENIAL_REASONS.has(reason))) return 'stale';
  return 'unavailable';
}

function classifyInvocationResult(result: unknown): {
  outcome: WebMcpInvocationOutcome;
  reason: WebMcpInvocationReason;
} {
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (record.ok === false || ['denied', 'invalid', 'skipped'].includes(String(record.status))) {
      return { outcome: 'denied', reason: classifyStructuredDenial(record) };
    }
  }
  return { outcome: 'success', reason: 'completed' };
}

function classifyInvocationError(error: unknown): WebMcpInvocationReason {
  if (error instanceof SafeWebMcpError) return error.analyticsReason;
  if (error instanceof DashboardBindingError) return 'unavailable';
  if (error instanceof DashboardPanelCatalogError) return 'validation';
  if (error instanceof MissionPresetCatalogError) return 'validation';
  if (isWebMcpAbortError(error)) return 'cancelled';
  return 'internal';
}

function searchResultTypeBucket(value: unknown): string {
  return typeof value === 'string' && SEARCH_RESULT_TYPE_BUCKETS.has(value)
    ? value
    : 'other';
}

function boundedText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function boundedNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeIdentifiers(values: unknown, maxLength: number): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.slice(0, maxLength))
    .filter(Boolean))]
    .sort();
}

function boundDashboardContext(
  snapshot: DashboardContextSnapshot,
  maxChars = TARGET_OUTPUT_CHARS,
): Record<string, unknown> {
  const enabledLayers = normalizeIdentifiers(snapshot.map?.enabledLayers, 80);
  const mounted = normalizeIdentifiers(snapshot.panels?.mounted, 96);
  const enabled = normalizeIdentifiers(snapshot.panels?.enabled, 96);
  const result = {
    variant: boundedText(snapshot.variant, 32),
    map: {
      view: boundedText(snapshot.map?.view, 32),
      center: snapshot.map?.center
        ? {
            lat: boundedNumber(snapshot.map.center.lat),
            lon: boundedNumber(snapshot.map.center.lon),
          }
        : null,
      zoom: boundedNumber(snapshot.map?.zoom),
      ...(snapshot.map?.mode === '3d' || snapshot.map?.mode === '2d'
        ? { mode: snapshot.map.mode }
        : {}),
      timeRange: boundedText(snapshot.map?.timeRange, 32),
      enabledLayers,
      enabledLayerCount: enabledLayers.length,
      layersTruncated: false,
    },
    panels: {
      mounted,
      enabled,
      mountedCount: mounted.length,
      enabledCount: enabled.length,
      mountedTruncated: false,
      enabledTruncated: false,
    },
  };

  const collections = [enabled, mounted, enabledLayers];
  while (JSON.stringify(result).length > maxChars) {
    const candidate = collections
      .filter((collection) => collection.length > 0)
      .sort((left, right) => (
        right.reduce((sum, item) => sum + item.length, 0)
        - left.reduce((sum, item) => sum + item.length, 0)
      ))[0];
    if (!candidate) break;
    candidate.pop();
  }

  result.map.layersTruncated = enabledLayers.length < result.map.enabledLayerCount;
  result.panels.mountedTruncated = mounted.length < result.panels.mountedCount;
  result.panels.enabledTruncated = enabled.length < result.panels.enabledCount;
  return result;
}

function boundUnavailableReason(value: unknown): DashboardPanelUnavailableReason | undefined {
  if (value === 'panel_not_entitled' || value === 'panel_disabled' || value === 'panel_not_live') {
    return value;
  }
  return undefined;
}

function boundDashboardPanelCatalog(result: DashboardPanelCatalogPage): DashboardPanelCatalogPage {
  const panels = (Array.isArray(result.panels) ? result.panels : []).map((panel) => {
    const available = panel?.available === true;
    const unavailableReason = available ? undefined : boundUnavailableReason(panel?.unavailableReason);
    const bounded: DashboardPanelCatalogItem = {
      id: boundedText(panel?.id, DASHBOARD_PANEL_ID_MAX_CHARS),
      label: boundedText(panel?.label, DASHBOARD_PANEL_LABEL_MAX_CHARS),
      category: boundedText(panel?.category, DASHBOARD_PANEL_CATEGORY_MAX_CHARS),
      variants: Array.isArray(panel?.variants)
        ? panel.variants
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.slice(0, 32))
        : [],
      enabled: panel?.enabled === true,
      mounted: panel?.mounted === true,
      entitled: panel?.entitled === true,
      available,
      ...(unavailableReason ? { unavailableReason } : {}),
    };
    return bounded;
  });
  const bounded: DashboardPanelCatalogPage = {
    variant: boundedText(result.variant, 32),
    total: Math.max(0, Math.floor(boundedNumber(result.total))),
    hasMore: result.hasMore === true,
    nextCursor: result.nextCursor ? boundedText(result.nextCursor, DASHBOARD_PANEL_ID_MAX_CHARS) : null,
    panels,
  };
  while (
    JSON.stringify(bounded).length > DASHBOARD_PANEL_CATALOG_OUTPUT_TARGET_CHARS
    && bounded.panels.length > 1
  ) {
    bounded.panels.pop();
    bounded.hasMore = true;
    bounded.nextCursor = bounded.panels[bounded.panels.length - 1]?.id ?? null;
  }
  if (JSON.stringify(bounded).length > MAX_OUTPUT_CHARS) {
    throw new SafeWebMcpError('Dashboard panel catalog exceeded the safe output limit.');
  }
  return bounded;
}

function boundDashboardViewState(
  value: DashboardActionViewState | undefined,
): DashboardActionViewState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const bounded: DashboardActionViewState = {};
  if (typeof value.timeRange === 'string' && value.timeRange) {
    bounded.timeRange = boundedText(value.timeRange, 32);
  }
  if (typeof value.iso2 === 'string' && value.iso2) {
    bounded.iso2 = boundedText(value.iso2, 2);
  }
  if (typeof value.mode === 'string' && value.mode) {
    bounded.mode = boundedText(value.mode, 8);
  }
  if (typeof value.renderer === 'string' && value.renderer) {
    bounded.renderer = boundedText(value.renderer, 16);
  }
  if (typeof value.lat === 'number' && Number.isFinite(value.lat)) bounded.lat = value.lat;
  if (typeof value.lon === 'number' && Number.isFinite(value.lon)) bounded.lon = value.lon;
  if (typeof value.zoom === 'number' && Number.isFinite(value.zoom)) bounded.zoom = value.zoom;
  return Object.keys(bounded).length > 0 ? bounded : undefined;
}

function boundDashboardCompatibility(
  value: DashboardActionCompatibility | undefined,
): DashboardActionCompatibility | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const layers = Array.isArray(value.layers)
    ? value.layers.slice(0, MAX_LAYER_ACTION_TARGETS).map((layer) => ({
      layer: boundedText(layer?.layer, 32),
      from: layer?.from === true,
      to: layer?.to === true,
      reason: boundedText(layer?.reason, 64),
    }))
    : [];
  return {
    adjusted: value.adjusted === true,
    ...(layers.length > 0 ? { layers } : {}),
  };
}

const ACCOUNT_STATES = new Set<WebMcpAccountState>(['signed_out', 'loading', 'signed_in']);
const CLERK_STATES = new Set<WebMcpClerkState>(['unavailable', 'loading', 'ready']);
const PRODUCT_TIERS = new Set<WebMcpProductTier>(['anonymous', 'free', 'pro', 'unknown']);

function oneOf<T extends string>(value: unknown, allowed: ReadonlySet<T>, fallback: T): T {
  return typeof value === 'string' && allowed.has(value as T) ? value as T : fallback;
}

function optionalCap(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

export function boundWebMcpAccessContext(
  snapshot: AccessContextSnapshot,
  targetCancellationSupported: boolean,
): Record<string, unknown> {
  const enabledPanels = snapshot.limits?.enabledPanels;
  const dashboardTabs = snapshot.limits?.dashboardTabs;
  return {
    accountState: oneOf(snapshot.accountState, ACCOUNT_STATES, 'loading'),
    clerk: oneOf(snapshot.clerk, CLERK_STATES, 'unavailable'),
    productTier: oneOf(snapshot.productTier, PRODUCT_TIERS, 'unknown'),
    capabilities: {
      premiumAccess: snapshot.capabilities?.premiumAccess === true,
      apiAccess: snapshot.capabilities?.apiAccess === true,
      mcpAccess: snapshot.capabilities?.mcpAccess === true,
      dataExport: snapshot.capabilities?.dataExport === true,
    },
    limits: {
      enabledPanels: {
        used: Math.max(0, Math.floor(boundedNumber(enabledPanels?.used))),
        cap: optionalCap(enabledPanels?.cap),
      },
      dashboardTabs: {
        used: Math.max(0, Math.floor(boundedNumber(dashboardTabs?.used))),
        cap: optionalCap(dashboardTabs?.cap),
        canCreate: dashboardTabs?.canCreate === true,
      },
    },
    targetCancellationSupported: targetCancellationSupported === true,
  };
}

function boundDashboardActionResult(result: DashboardActionResult): Record<string, unknown> & {
  ok: boolean;
  status: DashboardActionStatus;
} {
  const targets = (Array.isArray(result.targets) ? result.targets : []).map((target) => ({
    target: boundedText(target?.target, 96),
    status: target?.status,
    ...(target?.reason ? { reason: boundedText(target.reason, 64) } : {}),
  }));
  const requested = boundDashboardViewState(result.requested);
  const effective = boundDashboardViewState(result.effective);
  const compatibility = boundDashboardCompatibility(result.compatibility);
  const bounded = {
    ok: result.ok === true,
    status: result.status,
    ...(result.actionType ? { actionType: result.actionType } : {}),
    ...(result.reason ? { reason: boundedText(result.reason, 64) } : {}),
    message: boundedText(result.message, 240),
    targets,
    targetCount: targets.length,
    targetsTruncated: false,
    ...(requested ? { requested } : {}),
    ...(effective ? { effective } : {}),
    ...(compatibility ? { compatibility } : {}),
  };

  if (JSON.stringify(bounded).length > MAX_OUTPUT_CHARS) {
    throw new SafeWebMcpError('Dashboard action result exceeded the safe output limit.');
  }
  return bounded;
}

function boundDashboardSearchResult(result: DashboardSearchResponse): DashboardSearchResponse {
  const sourceResults = Array.isArray(result.results) ? result.results : [];
  const results = sourceResults
    .filter((match) => typeof match?.key === 'string' && SEARCH_RESULT_KEY.test(match.key))
    .slice(0, MAX_SEARCH_RESULTS)
    .map((match) => ({
      key: match.key,
      type: boundedText(match?.type, DASHBOARD_SEARCH_TYPE_MAX_CHARS),
      title: boundedText(match?.title, DASHBOARD_SEARCH_TITLE_MAX_CHARS),
      ...(match?.subtitle ? {
        subtitle: boundedText(match.subtitle, DASHBOARD_SEARCH_SUBTITLE_MAX_CHARS),
      } : {}),
      executable: match?.executable === true,
    }));
  let truncated = result.truncated === true || results.length < sourceResults.length;
  const bounded: DashboardSearchResponse = {
    queryLength: Math.max(0, Math.floor(boundedNumber(result.queryLength))),
    results,
    resultCount: results.length,
    truncated,
  };

  while (
    JSON.stringify(bounded).length > DASHBOARD_SEARCH_OUTPUT_TARGET_CHARS
    && results.length > 0
  ) {
    results.pop();
    truncated = true;
    bounded.resultCount = results.length;
    bounded.truncated = truncated;
  }
  if (JSON.stringify(bounded).length > MAX_OUTPUT_CHARS) {
    throw new SafeWebMcpError('Dashboard search result exceeded the safe output limit.');
  }
  return bounded;
}

function boundOpenSignInResult(result: OpenSignInResult): OpenSignInResult {
  if (result?.ok === true && result.status === 'already_open') {
    return { ok: true, status: 'already_open', reason: 'already_open' };
  }
  if (result?.ok === true && result.status === 'opened') {
    return { ok: true, status: 'opened' };
  }
  return { ok: false, status: 'denied', reason: 'clerk_unavailable' };
}

function boundSearchOpenResult(result: DashboardSearchOpenResult): DashboardSearchOpenResult {
  const opened = result.ok === true && result.status === 'opened';
  const reason = result.reason && DASHBOARD_SEARCH_OPEN_REASONS.has(result.reason)
    ? result.reason
    : 'invalid_or_expired_key';
  const message = !opened && typeof result.message === 'string' && result.message.trim()
    ? boundedText(result.message, WEBMCP_TOOL_BUDGETS.errorMessageChars)
    : '';
  return {
    ok: opened,
    status: opened ? 'opened' : 'denied',
    ...(result.type ? { type: boundedText(result.type, 32) } : {}),
    ...(!opened ? { reason } : {}),
    ...(message ? { message } : {}),
  };
}

const SET_PANEL_ENABLED_REASONS = new Set([
  'malformed_arguments',
  'unknown_panel',
  'panel_incompatible',
  'panel_not_entitled',
  'panel_cap_exceeded',
  'panel_required',
  'persist_failed',
]);

function boundSetPanelEnabledResult(result: SetPanelEnabledResult): SetPanelEnabledResult {
  const status = result.status === 'applied' || result.status === 'denied' || result.status === 'invalid'
    ? result.status
    : 'denied';
  const ok = result.ok === true && status === 'applied';
  const reason = result.reason && SET_PANEL_ENABLED_REASONS.has(result.reason)
    ? result.reason
    : undefined;
  return {
    ok,
    status: ok ? 'applied' : status === 'invalid' ? 'invalid' : 'denied',
    panelId: boundedText(result.panelId, 96),
    requestedEnabled: result.requestedEnabled === true,
    effectiveEnabled: result.effectiveEnabled === true,
    changed: ok && result.changed === true,
    ...(!ok && reason ? { reason } : {}),
    message: boundedText(result.message, 160) || (ok ? 'Panel updated.' : 'Panel change denied.'),
  };
}

const MISSION_PRESET_APPLY_REASON_SET: ReadonlySet<string> = new Set(
  MISSION_PRESET_APPLY_DENY_REASONS,
);

function boundMissionPresetCatalog(result: MissionPresetCatalogResult): MissionPresetCatalogResult {
  const presets = (Array.isArray(result.presets) ? result.presets : []).map((preset) => {
    const available = preset.available === true;
    return {
      id: boundedText(preset.id, 48) as MissionPresetId,
      label: boundedText(preset.label, 48),
      ...(available && preset.view
        ? { view: boundedText(preset.view, 24) as NonNullable<MissionPresetCatalogResult['presets'][number]['view']> }
        : {}),
      ...(available && preset.timeRange
        ? {
          timeRange: boundedText(preset.timeRange, 8) as NonNullable<
            MissionPresetCatalogResult['presets'][number]['timeRange']
          >,
        }
        : {}),
      panelCount: Math.max(0, Math.floor(boundedNumber(preset.panelCount))),
      layerCount: Math.max(0, Math.floor(boundedNumber(preset.layerCount))),
      active: preset.active === true,
      monitorCompatible: preset.monitorCompatible === true,
      entitled: preset.entitled === true,
      available,
      ...(preset.unavailableReason
        ? { unavailableReason: preset.unavailableReason }
        : {}),
    };
  });
  return {
    ok: true,
    variant: boundedText(result.variant, 24),
    activePresetId: result.activePresetId && isMissionPresetId(result.activePresetId)
      ? result.activePresetId
      : null,
    presets,
    count: presets.length,
  };
}

function boundApplyMissionPresetResult(result: ApplyMissionPresetResult): ApplyMissionPresetResult {
  const status = result.status === 'applied'
    || result.status === 'unchanged'
    || result.status === 'denied'
    || result.status === 'invalid'
    ? result.status
    : 'denied';
  const ok = result.ok === true && (status === 'applied' || status === 'unchanged');
  const reason = result.reason && MISSION_PRESET_APPLY_REASON_SET.has(result.reason)
    ? result.reason
    : undefined;
  const map = result.map && typeof result.map === 'object'
    ? {
      view: boundedText(result.map.view, 24),
      zoom: boundedNumber(result.map.zoom),
      timeRange: boundedText(result.map.timeRange, 8),
      enabledLayers: normalizeIdentifiers(result.map.enabledLayers, 64),
    }
    : undefined;
  const panels = result.panels && typeof result.panels === 'object'
    ? { enabled: normalizeIdentifiers(result.panels.enabled, 96) }
    : undefined;
  return {
    ok,
    status: ok ? status : status === 'invalid' ? 'invalid' : 'denied',
    ...(result.presetId ? { presetId: boundedText(result.presetId, 48) } : {}),
    ...(result.label ? { label: boundedText(result.label, 80) } : {}),
    ...(ok ? { changed: result.changed === true } : { changed: false }),
    ...(result.monitor ? { monitor: boundedText(result.monitor, 24) } : {}),
    ...(map ? { map } : {}),
    ...(panels ? { panels } : {}),
    ...(!ok && reason ? { reason } : {}),
    message: boundedText(result.message, 160)
      || (ok ? 'Mission preset applied.' : 'Mission preset change denied.'),
  };
}

const PANEL_LAYOUT_DENIAL_REASON_SET: ReadonlySet<string> = new Set(
  PANEL_LAYOUT_DENIAL_REASONS,
);

function boundPanelLayoutSnapshot(
  snapshot: PanelLayoutSnapshot,
  cursor?: string,
): PanelLayoutSnapshot | PanelLayoutMutationResult {
  const panels = (Array.isArray(snapshot.panels) ? snapshot.panels : []).map((panel, index) => {
    const rawIndex = panel?.index;
    const resolvedIndex = typeof rawIndex === 'number' && Number.isFinite(rawIndex)
      ? rawIndex
      : index;
    return {
      id: boundedText(panel?.id, PANEL_LAYOUT_ID_MAX_CHARS),
      region: panel?.region === 'bottom' ? 'bottom' as const : 'sidebar' as const,
      // Preserve regional index 0; `||` would coerce it to the flatten fallback.
      index: Math.max(0, Math.floor(resolvedIndex)),
      collapsed: panel?.collapsed === true,
      fullscreen: panel?.fullscreen === true,
      collapsible: panel?.collapsible === true,
      fullscreenCapable: panel?.fullscreenCapable === true,
      fixed: panel?.fixed === true,
    };
  }).filter((panel) => panel.id);

  let startIndex = 0;
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || !cursor) {
      return boundPanelLayoutMutationResult({
        ok: false,
        status: 'invalid',
        actionType: 'move',
        reason: 'malformed_arguments',
        message: 'cursor must be a stable panel ID from get_panel_layout.',
      });
    }
    startIndex = panels.findIndex((panel) => panel.id === cursor);
    if (startIndex < 0) {
      return boundPanelLayoutMutationResult({
        ok: false,
        status: 'denied',
        actionType: 'move',
        reason: 'panel_not_found',
        message: 'That panel layout cursor is no longer available.',
        panelId: cursor,
      });
    }
  }

  const remaining = panels.slice(startIndex);
  const page: typeof panels = [];
  let nextCursor: string | undefined;
  const resolvePanelCount = (raw: unknown, fallback: number): number => {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return Math.max(0, Math.floor(raw));
    }
    return Math.max(0, fallback);
  };
  const regionMeta = {
    sidebar: {
      available: snapshot.regions?.sidebar?.available !== false,
      panelCount: resolvePanelCount(
        snapshot.regions?.sidebar?.panelCount,
        panels.filter((panel) => panel.region === 'sidebar').length,
      ),
    },
    bottom: {
      available: snapshot.regions?.bottom?.available === true,
      panelCount: resolvePanelCount(
        snapshot.regions?.bottom?.panelCount,
        panels.filter((panel) => panel.region === 'bottom').length,
      ),
    },
  };
  const panelCount = Math.max(
    resolvePanelCount(snapshot.panelCount, panels.length),
    panels.length,
  );

  for (let index = 0; index < remaining.length; index += 1) {
    const panel = remaining[index];
    if (!panel) continue;
    const candidate = [...page, panel];
    const envelope = {
      regions: regionMeta,
      panels: candidate,
      panelCount,
      panelsTruncated: true,
      nextCursor: remaining[index + 1]?.id,
    };
    if (JSON.stringify(envelope).length > TARGET_OUTPUT_CHARS && page.length > 0) {
      nextCursor = panel.id;
      break;
    }
    page.push(panel);
  }

  return {
    regions: regionMeta,
    panels: page,
    panelCount,
    ...(nextCursor || snapshot.panelsTruncated
      ? {
        panelsTruncated: true,
        ...(nextCursor ? { nextCursor: boundedText(nextCursor, PANEL_LAYOUT_ID_MAX_CHARS) } : {}),
      }
      : {}),
  };
}

function boundPanelLayoutMutationResult(
  result: PanelLayoutMutationResult,
): PanelLayoutMutationResult {
  const actionType = result.actionType === 'set_collapsed'
    || result.actionType === 'move'
    || result.actionType === 'set_fullscreen'
    ? result.actionType
    : 'move';
  const status = result.status === 'applied' || result.status === 'denied' || result.status === 'invalid'
    ? result.status
    : 'denied';
  const ok = result.ok === true && status === 'applied';
  const reason = result.reason && PANEL_LAYOUT_DENIAL_REASON_SET.has(result.reason)
    ? result.reason
    : undefined;
  const region = result.region === 'sidebar' || result.region === 'bottom'
    ? result.region
    : undefined;
  return {
    ok,
    status: ok ? 'applied' : status === 'invalid' ? 'invalid' : 'denied',
    actionType,
    ...(result.panelId !== undefined
      ? { panelId: boundedText(result.panelId, PANEL_LAYOUT_ID_MAX_CHARS) }
      : {}),
    ...(region ? { region } : {}),
    ...(typeof result.index === 'number' ? { index: Math.max(0, Math.floor(result.index)) } : {}),
    ...(typeof result.requestedCollapsed === 'boolean'
      ? { requestedCollapsed: result.requestedCollapsed }
      : {}),
    ...(typeof result.effectiveCollapsed === 'boolean'
      ? { effectiveCollapsed: result.effectiveCollapsed }
      : {}),
    ...(typeof result.requestedFullscreen === 'boolean'
      ? { requestedFullscreen: result.requestedFullscreen }
      : {}),
    ...(typeof result.effectiveFullscreen === 'boolean'
      ? { effectiveFullscreen: result.effectiveFullscreen }
      : {}),
    ...(ok ? { changed: result.changed === true } : { changed: false }),
    ...(result.unchanged === true ? { unchanged: true } : {}),
    ...(typeof result.persisted === 'boolean' ? { persisted: result.persisted } : {}),
    ...(!ok && reason ? { reason } : {}),
    message: boundedText(result.message, 160) || (ok ? 'Panel layout updated.' : 'Panel layout change denied.'),
  };
}

function boundDashboardTabList(
  snapshot: DashboardTabListSnapshot,
  cursor?: string,
): DashboardTabActionResult {
  const sourceTabs = Array.isArray(snapshot.tabs) ? snapshot.tabs : [];
  const tabs = sourceTabs.map((tab) => ({
    id: boundedText(tab?.id, 64),
    name: boundedText(tab?.name, DASHBOARD_TAB_NAME_MAX_LENGTH),
    active: tab?.active === true,
    canDelete: tab?.canDelete === true,
  })).filter((tab) => tab.id);
  const tabCount = Math.max(
    Math.max(0, Math.floor(boundedNumber(snapshot.tabCount)) || tabs.length),
    tabs.length,
  );
  const activeTabId = boundedText(snapshot.activeTabId, 64);
  const canCreate = snapshot.canCreate === true;
  const cap = snapshot.cap === null || typeof snapshot.cap === 'number' ? snapshot.cap : null;
  const createBlockReason = snapshot.createBlockReason
    ? boundedText(snapshot.createBlockReason, 32) as DashboardTabListSnapshot['createBlockReason']
    : undefined;

  let startIndex = 0;
  if (cursor !== undefined) {
    if (!isDashboardTabId(cursor)) {
      return boundDashboardTabMutation(mutationDenied(
        'list',
        'malformed_arguments',
        'cursor must be a stable dashboard tab ID from list_dashboard_tabs.',
      ));
    }
    startIndex = tabs.findIndex((tab) => tab.id === cursor);
    if (startIndex < 0) {
      return boundDashboardTabMutation(mutationDenied(
        'list',
        'tab_not_found',
        'That dashboard tab cursor is no longer available.',
      ));
    }
  }

  const buildPage = (
    pageTabs: typeof tabs,
    nextCursor: string | undefined,
  ): DashboardTabListSnapshot => ({
    activeTabId,
    tabs: pageTabs,
    tabCount,
    tabsTruncated: nextCursor !== undefined || snapshot.tabsTruncated === true,
    canCreate,
    cap,
    ...(createBlockReason ? { createBlockReason } : {}),
    ...(nextCursor ? { nextCursor: boundedText(nextCursor, 64) } : {}),
  });

  const remaining = tabs.slice(startIndex);
  const page: typeof tabs = [];
  for (let index = 0; index < remaining.length; index += 1) {
    const tab = remaining[index];
    if (!tab) continue;
    const candidate = [...page, tab];
    const following = remaining[index + 1];
    if (JSON.stringify(buildPage(candidate, following?.id)).length > TARGET_OUTPUT_CHARS) {
      break;
    }
    page.push(tab);
  }
  if (page.length === 0 && remaining[0]) page.push(remaining[0]);

  const consumed = startIndex + page.length;
  const nextCursor = consumed < tabs.length ? tabs[consumed]?.id : undefined;
  const result = buildPage(page, nextCursor);
  if (JSON.stringify(result).length > MAX_OUTPUT_CHARS) {
    throw new SafeWebMcpError('Dashboard tab list exceeded the safe output limit.');
  }
  return result;
}

function boundDashboardTabMutation(result: DashboardTabMutationResult): DashboardTabMutationResult {
  const bounded: DashboardTabMutationResult = {
    ok: result.ok === true,
    status: result.status,
    actionType: result.actionType,
    message: boundedText(result.message, 240),
    ...(result.reason ? { reason: boundedText(result.reason, 64) as DashboardTabMutationResult['reason'] } : {}),
    ...(result.tabId ? { tabId: boundedText(result.tabId, 64) } : {}),
    ...(result.name ? { name: boundedText(result.name, DASHBOARD_TAB_NAME_MAX_LENGTH) } : {}),
    ...(result.activeTabId ? { activeTabId: boundedText(result.activeTabId, 64) } : {}),
    ...(result.unchanged === true ? { unchanged: true } : {}),
    ...(result.alreadyExisted === true ? { alreadyExisted: true } : {}),
    ...(typeof result.persisted === 'boolean' ? { persisted: result.persisted } : {}),
    ...(typeof result.tabCount === 'number' ? { tabCount: Math.max(0, Math.floor(result.tabCount)) } : {}),
    ...(typeof result.canCreate === 'boolean' ? { canCreate: result.canCreate } : {}),
    ...(result.cap === null || typeof result.cap === 'number' ? { cap: result.cap } : {}),
    ...(result.lockReason ? { lockReason: boundedText(result.lockReason, 32) as DashboardTabMutationResult['lockReason'] } : {}),
  };
  if (JSON.stringify(bounded).length > MAX_OUTPUT_CHARS) {
    throw new SafeWebMcpError('Dashboard tab result exceeded the safe output limit.');
  }
  return bounded;
}

const EMPTY_NAV_CONTEXT: DashboardContextSnapshot = {
  variant: '',
  map: {
    view: '',
    center: null,
    zoom: 0,
    timeRange: '',
    enabledLayers: [],
  },
  panels: {
    mounted: [],
    enabled: [],
  },
};

async function currentNavigationContext(
  app: WebMcpAppBindings,
  options?: WebMcpExecutionOptions,
): Promise<DashboardContextSnapshot> {
  try {
    return await app.getDashboardContext(options);
  } catch {
    return EMPTY_NAV_CONTEXT;
  }
}

function boundDashboardNavigationResult(result: WebMcpNavigationResult): Record<string, unknown> {
  const envelope = {
    ok: result.ok === true,
    status: result.status,
    ...(result.destination ? { destination: boundedText(result.destination, 32) } : {}),
    ...(result.navigation ? { navigation: boundedText(result.navigation, 16) } : {}),
    ...(result.overlay ? { overlay: boundedText(result.overlay, 16) } : {}),
    ...(result.tab ? { tab: boundedText(result.tab, 32) } : {}),
    ...(result.reason ? { reason: boundedText(result.reason, 64) } : {}),
    message: boundedText(result.message, 240),
    context: {},
  };
  const envelopeChars = JSON.stringify(envelope).length;
  // `"context":{}` is already in the envelope; the empty object is 2 chars.
  const contextBudget = Math.max(0, MAX_OUTPUT_CHARS - envelopeChars + 2);
  const bounded = {
    ...envelope,
    context: boundDashboardContext(result.context ?? EMPTY_NAV_CONTEXT, contextBudget),
  };
  if (JSON.stringify(bounded).length > MAX_OUTPUT_CHARS) {
    throw new SafeWebMcpError('Dashboard navigation result exceeded the safe output limit.');
  }
  return bounded;
}

async function applyDashboardTabAction(
  action: DashboardTabAction,
  app: WebMcpAppBindings,
  options?: WebMcpExecutionOptions,
): Promise<DashboardTabActionResult> {
  const result = await app.applyDashboardTabAction(action, options);
  return isDashboardTabListSnapshot(result)
    ? boundDashboardTabList(result, action.type === 'list' ? action.cursor : undefined)
    : boundDashboardTabMutation(result);
}

function hasOnlyOwnKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

type SwitchMonitorInput =
  | { ok: true; monitor: SiteVariant }
  | {
    ok: false;
    reason: 'malformed_arguments' | 'unknown_monitor';
    message: string;
  };

function validateSwitchMonitorInput(args: Record<string, unknown>): SwitchMonitorInput {
  if (!hasOnlyOwnKeys(args, ['monitor'])) {
    return {
      ok: false,
      reason: 'malformed_arguments',
      message: 'switch_monitor accepts only a monitor key.',
    };
  }
  const monitor = typeof args.monitor === 'string' ? args.monitor : '';
  if (!isSiteVariant(monitor)) {
    return {
      ok: false,
      reason: 'unknown_monitor',
      message: 'Unknown monitor.',
    };
  }
  return { ok: true, monitor };
}

async function applyDashboardAction(
  action: unknown,
  app: WebMcpAppBindings,
  options?: WebMcpExecutionOptions,
): Promise<Record<string, unknown>> {
  // Denied and invalid actions are expected, structured control outcomes—not
  // transport failures. Preserve the narrow applier result so agents can branch
  // on stable reasons and per-target statuses. Runtime/binding faults still
  // reject through withInvocationLogging's safe error boundary.
  return boundDashboardActionResult(await app.applyDashboardAction(action, options));
}

export function buildWebMcpTools(
  app: WebMcpAppBindings,
  trackEvent: WebMcpAnalytics = trackPrivacyRestricted,
): DashboardWebMcpTool[] {
  const tools: DashboardWebMcpTool[] = [
    {
      name: WEBMCP_SPA_TOOL.openCountryBrief,
      title: 'Open Country Brief',
      description:
        'Open the intelligence brief panel for a country by ISO 3166-1 alpha-2 code (e.g. "DE", "IR"). Routes the user to the country deep-dive view; the brief itself is fetched by the same path a click would take. This can consume daily briefing quota. To only pan the map, use focus_country.',
      inputSchema: {
        type: 'object',
        properties: {
          iso2: {
            type: 'string',
            description: 'ISO 3166-1 alpha-2 country code, uppercase.',
            pattern: '^[A-Z]{2}$',
          },
        },
        required: ['iso2'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.openCountryBrief, async (args, extra) => {
        const iso2 = typeof args.iso2 === 'string' ? args.iso2.toUpperCase() : '';
        if (!ISO2.test(iso2)) {
          throw new SafeWebMcpError(
            'iso2 must be an ISO 3166-1 alpha-2 code, such as "DE" or "IR".',
            'validation',
          );
        }
        const name = boundedText(app.resolveCountryName(iso2), 160) || iso2;
        const opened = await app.openCountryBriefByCode(iso2, name, extra);
        if (opened !== true) {
          throw new SafeWebMcpError(
            'The requested country brief did not become visible.',
            'unavailable',
          );
        }
        return `Opened intelligence brief for ${name} (${iso2}).`;
      }, trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.openSearch,
      title: 'Open Search',
      description:
        'Open the global search command palette so the user can find countries, signals, alerts, and other entities tracked by World Monitor.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.openSearch, async (_args, extra) => {
        const opened = await app.openSearch(extra);
        if (opened !== true) {
          throw new SafeWebMcpError(
            'The search palette did not become visible.',
            'unavailable',
          );
        }
        return 'Opened search palette.';
      }, trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.getDashboardContext,
      title: 'Get Dashboard Context',
      description:
        'Read a bounded snapshot of the visible dashboard: active variant, map view, center, zoom, map mode (2d or 3d), time range, enabled layers, and mounted or enabled panel IDs.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.getDashboardContext, async (_args, extra) => (
        boundDashboardContext(await app.getDashboardContext(extra))
      ), trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.listMapLayers,
      title: 'List Map Layers',
      description:
        'Page the canonical map-layer catalog, including disabled layers. Omit monitor for every registered layer; world lists only that variant. Each result has the stable ID, label, enabled state, monitor availability, renderer compatibility, entitlement, and a reason when the current page cannot enable it with set_map_layers. Does not load map datasets.',
      inputSchema: {
        type: 'object',
        properties: {
          monitor: {
            type: 'string',
            description: 'Omit for every non-sunset registered layer; world lists only that variant.',
            enum: [...WEBMCP_MAP_LAYER_MONITORS],
          },
          renderer: {
            type: 'string',
            description: 'Optional 2d or 3d renderer compatibility filter.',
            enum: [...WEBMCP_MAP_LAYER_RENDERERS],
          },
          state: {
            type: 'string',
            description: 'Filter to enabled layers, or layers the current page can enable.',
            enum: [...WEBMCP_MAP_LAYER_STATES],
          },
          cursor: {
            type: 'string',
            description: 'Previous page last layer ID; reuse only with the same filters.',
            minLength: 1,
            maxLength: MAX_LAYER_ACTION_TARGET_ID_LENGTH,
            pattern: DASHBOARD_LAYER_ACTION_TARGET_ID_PATTERN,
          },
          limit: {
            type: 'integer',
            description: `Page size from 1 to ${MAX_MAP_LAYER_PAGE_SIZE}.`,
            minimum: 1,
            maximum: MAX_MAP_LAYER_PAGE_SIZE,
            default: DEFAULT_MAP_LAYER_PAGE_SIZE,
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.listMapLayers, async (args, extra) => {
        const parsed = parseMapLayerCatalogArgs(args);
        if (!parsed.ok) return parsed;
        return listMapLayerCatalog(
          {
            ...await app.listMapLayerCatalog(extra),
            targetCancellationSupported: Boolean(extra?.signal),
          },
          parsed.query,
          { targetOutputChars: TARGET_OUTPUT_CHARS },
        );
      }, trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.listDashboardPanels,
      title: 'List Dashboard Panels',
      description:
        'Page the canonical dashboard panel catalog for this tab, including disabled and unmounted panels. Optional variant, category, enabled, and available filters. Follow nextCursor until hasMore is false. Does not return panel data or enable panels. Gated panels include a stable unavailableReason.',
      inputSchema: {
        type: 'object',
        properties: {
          variant: {
            type: 'string',
            description: 'Monitor variant to list. Omit to include every canonical panel ID.',
            enum: [...SITE_VARIANTS],
          },
          category: {
            type: 'string',
            description: 'Settings category key, such as core or marketsFinance.',
            enum: [...DASHBOARD_PANEL_CATALOG_CATEGORY_KEYS],
          },
          enabled: {
            type: 'boolean',
            description: 'If set, keep panels whose enabled state matches.',
          },
          available: {
            type: 'boolean',
            description: 'If set, keep panels the current session can open.',
          },
          cursor: {
            type: 'string',
            description: 'Catalog cursor from the previous page nextCursor.',
            minLength: 1,
            maxLength: DASHBOARD_PANEL_ID_MAX_CHARS,
            pattern: DASHBOARD_PANEL_ID_PATTERN,
          },
          limit: {
            type: 'integer',
            description: 'Maximum panels in this page, from 1 to 8.',
            minimum: 1,
            maximum: DASHBOARD_PANEL_CATALOG_MAX_LIMIT,
            default: DASHBOARD_PANEL_CATALOG_DEFAULT_LIMIT,
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.listDashboardPanels, async (args, extra) => {
        if (!hasOnlyOwnKeys(args, ['variant', 'category', 'enabled', 'available', 'cursor', 'limit'])) {
          throw new SafeWebMcpError(
            'list_dashboard_panels accepts only variant, category, enabled, available, cursor, and limit.',
            'validation',
          );
        }
        const query: DashboardPanelCatalogQuery = {};
        if (args.variant !== undefined) query.variant = args.variant as string;
        if (args.category !== undefined) query.category = args.category as string;
        if (args.enabled !== undefined) query.enabled = args.enabled as boolean;
        if (args.available !== undefined) query.available = args.available as boolean;
        if (args.cursor !== undefined) query.cursor = args.cursor as string;
        if (args.limit !== undefined) query.limit = args.limit as number;
        return boundDashboardPanelCatalog(await app.listDashboardPanels(query, extra));
      }, trackEvent, {
        successMetadata: (_args, value) => {
          const result = value as DashboardPanelCatalogPage;
          return {
            resultCount: result.panels.length,
            hasMore: result.hasMore === true,
          };
        },
      }),
    },
    {
      name: WEBMCP_SPA_TOOL.switchMonitor,
      title: 'Switch Monitor',
      description:
        'Switch the visible dashboard to World (full), Tech (tech), Finance (finance), Commodity (commodity), Energy (energy), or Good News (happy) through the header variant switcher. Use those stable keys, not display labels. Returns the selected destination and effective dashboard state.',
      inputSchema: {
        type: 'object',
        properties: {
          monitor: {
            type: 'string',
            description: 'Stable monitor key: full, tech, finance, commodity, energy, or happy.',
            enum: [...SITE_VARIANTS],
          },
        },
        required: ['monitor'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.switchMonitor, async (args, extra) => {
        const input = validateSwitchMonitorInput(args);
        if (!input.ok) {
          throw new SafeWebMcpError('switch_monitor input preflight did not run.');
        }
        return boundDashboardNavigationResult(await app.switchMonitor(input.monitor, extra));
      }, trackEvent, {
        preflight: async (args, extra) => {
          const input = validateSwitchMonitorInput(args);
          if (input.ok) return undefined;
          return boundDashboardNavigationResult({
            ok: false,
            status: 'invalid',
            reason: input.reason,
            message: input.message,
            context: await currentNavigationContext(app, extra),
          });
        },
      }),
    },
    {
      name: WEBMCP_SPA_TOOL.openSettings,
      title: 'Open Settings',
      description:
        'Open the dashboard settings overlay through the same header gear path a person uses. Opening settings does not change its contents. Returns the selected destination and effective dashboard state.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.openSettings, async (args, extra) => {
        if (!hasOnlyOwnKeys(args, [])) {
          return boundDashboardNavigationResult({
            ok: false,
            status: 'invalid',
            reason: 'malformed_arguments',
            message: 'open_settings does not accept arguments.',
            context: await currentNavigationContext(app, extra),
          });
        }
        return boundDashboardNavigationResult(await app.openSettings(extra));
      }, trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.openAlerts,
      title: 'Open Alerts',
      description:
        'Open the alerts notifications tab through the same settings path the visible UI uses. Opening alerts does not change their contents. Unavailable dashboards return a stable reason without account details.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.openAlerts, async (args, extra) => {
        if (!hasOnlyOwnKeys(args, [])) {
          return boundDashboardNavigationResult({
            ok: false,
            status: 'invalid',
            reason: 'malformed_arguments',
            message: 'open_alerts does not accept arguments.',
            context: await currentNavigationContext(app, extra),
          });
        }
        return boundDashboardNavigationResult(await app.openAlerts(extra));
      }, trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.openDashboardPanel,
      title: 'Open Dashboard Panel',
      description:
        'Open and scroll to an already-live, currently enabled dashboard panel through the same entitlement-aware control path used by World Monitor. Disabled panels return panel_disabled. Use set_panel_enabled to change whether a catalog panel is enabled; this tool does not enable panels itself.',
      inputSchema: {
        type: 'object',
        properties: {
          panelId: {
            type: 'string',
            description: 'Dashboard panel ID, such as "markets" or "strategic-risk".',
            minLength: 1,
            maxLength: 96,
            pattern: DASHBOARD_PANEL_ID_PATTERN,
          },
        },
        required: ['panelId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.openDashboardPanel, async (args, extra) => (
        applyDashboardAction({
          type: 'open_panel',
          panelId: args.panelId,
        }, app, extra)
      ), trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.setPanelEnabled,
      title: 'Set Panel Enabled',
      description:
        'Enable or disable a dashboard panel by its stable ID through the same settings path a person uses. Returns the requested state, effective state, and whether anything changed. Enabling unknown, incompatible, unentitled, or free-tier-capped panels is denied; disabling a live catalog panel still succeeds. Requires target-side cancellation because it persists dashboard settings.',
      inputSchema: {
        type: 'object',
        properties: {
          panelId: {
            type: 'string',
            description: 'Dashboard panel ID, such as "markets" or "giving".',
            minLength: 1,
            maxLength: 96,
            pattern: '^[a-z0-9][a-z0-9@_-]*$',
          },
          enabled: {
            type: 'boolean',
            description: 'True to enable the panel, false to disable it.',
          },
        },
        required: ['panelId', 'enabled'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.setPanelEnabled, async (args, extra) => {
        if (!hasOnlyOwnKeys(args, ['panelId', 'enabled'])) {
          return boundSetPanelEnabledResult({
            ok: false,
            status: 'invalid',
            panelId: typeof args.panelId === 'string' ? args.panelId : '',
            requestedEnabled: args.enabled === true,
            effectiveEnabled: false,
            changed: false,
            reason: 'malformed_arguments',
            message: 'panelId must be a stable dashboard panel ID and enabled must be a boolean.',
          });
        }
        return boundSetPanelEnabledResult(
          await app.setPanelEnabled(args.panelId, args.enabled, extra),
        );
      }, trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.getPanelLayout,
      title: 'Get Panel Layout',
      description:
        'Read the effective dashboard panel layout: stable panel IDs, named regions (sidebar or bottom), order index, collapsed state, and fullscreen state. When panelsTruncated is true, pass nextCursor to continue. Use before collapse, move, or fullscreen tools.',
      inputSchema: {
        type: 'object',
        properties: {
          cursor: {
            type: 'string',
            description: 'Optional panel ID cursor from a previous truncated get_panel_layout page.',
            minLength: 1,
            maxLength: PANEL_LAYOUT_ID_MAX_CHARS,
            pattern: DASHBOARD_PANEL_ID_PATTERN,
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.getPanelLayout, async (args, extra) => {
        if (!hasOnlyOwnKeys(args, ['cursor'])) {
          return boundPanelLayoutMutationResult({
            ok: false,
            status: 'invalid',
            actionType: 'move',
            reason: 'malformed_arguments',
            message: 'get_panel_layout accepts only an optional cursor.',
          });
        }
        if (args.cursor !== undefined && typeof args.cursor !== 'string') {
          return boundPanelLayoutMutationResult({
            ok: false,
            status: 'invalid',
            actionType: 'move',
            reason: 'malformed_arguments',
            message: 'cursor must be a stable panel ID from get_panel_layout.',
          });
        }
        const cursor = typeof args.cursor === 'string' ? args.cursor : undefined;
        return boundPanelLayoutSnapshot(await app.getPanelLayout(extra), cursor);
      }, trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.setPanelCollapsed,
      title: 'Set Panel Collapsed',
      description:
        'Collapse or expand a mounted panel by stable ID through the same control and persistence path as the visible collapse button. Idempotent when the state already matches. Requires target-side cancellation because collapsed state persists.',
      inputSchema: {
        type: 'object',
        properties: {
          panelId: {
            type: 'string',
            description: 'Dashboard panel ID from get_panel_layout.',
            minLength: 1,
            maxLength: PANEL_LAYOUT_ID_MAX_CHARS,
            pattern: DASHBOARD_PANEL_ID_PATTERN,
          },
          collapsed: {
            type: 'boolean',
            description: 'True to collapse the panel, false to expand it.',
          },
        },
        required: ['panelId', 'collapsed'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.setPanelCollapsed, async (args, extra) => {
        if (!hasOnlyOwnKeys(args, ['panelId', 'collapsed'])) {
          return boundPanelLayoutMutationResult({
            ok: false,
            status: 'invalid',
            actionType: 'set_collapsed',
            reason: 'malformed_arguments',
            message: 'panelId must be a stable dashboard panel ID and collapsed must be a boolean.',
            panelId: typeof args.panelId === 'string' ? args.panelId : '',
            requestedCollapsed: args.collapsed === true,
            effectiveCollapsed: false,
            changed: false,
          });
        }
        return boundPanelLayoutMutationResult(
          await app.setPanelCollapsed(args.panelId, args.collapsed, extra),
        );
      }, trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.movePanel,
      title: 'Move Panel',
      description:
        'Move a mounted panel to a named layout region (sidebar or bottom) at a 0-based index through the same persistence path as keyboard reorder. Do not use pointer coordinates. Requires target-side cancellation because order persists.',
      inputSchema: {
        type: 'object',
        properties: {
          panelId: {
            type: 'string',
            description: 'Dashboard panel ID from get_panel_layout.',
            minLength: 1,
            maxLength: PANEL_LAYOUT_ID_MAX_CHARS,
            pattern: DASHBOARD_PANEL_ID_PATTERN,
          },
          region: {
            type: 'string',
            description: 'Target layout region.',
            enum: [...PANEL_LAYOUT_REGIONS],
          },
          index: {
            type: 'integer',
            description: '0-based destination index in the target region after the move.',
            minimum: 0,
            maximum: 200,
          },
        },
        required: ['panelId', 'region', 'index'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.movePanel, async (args, extra) => {
        if (!hasOnlyOwnKeys(args, ['panelId', 'region', 'index'])) {
          return boundPanelLayoutMutationResult({
            ok: false,
            status: 'invalid',
            actionType: 'move',
            reason: 'malformed_arguments',
            message: 'move_panel requires panelId, region, and index.',
            panelId: typeof args.panelId === 'string' ? args.panelId : '',
            changed: false,
          });
        }
        return boundPanelLayoutMutationResult(
          await app.movePanel(args.panelId, args.region, args.index, extra),
        );
      }, trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.setPanelFullscreen,
      title: 'Set Panel Fullscreen',
      description:
        'Enter or exit panel fullscreen by stable ID through the same visible fullscreen control as Live News and Live Webcams. Idempotent when the state already matches. Session view-state only; it does not persist across reload.',
      inputSchema: {
        type: 'object',
        properties: {
          panelId: {
            type: 'string',
            description: 'Dashboard panel ID from get_panel_layout.',
            minLength: 1,
            maxLength: PANEL_LAYOUT_ID_MAX_CHARS,
            pattern: DASHBOARD_PANEL_ID_PATTERN,
          },
          fullscreen: {
            type: 'boolean',
            description: 'True to enter fullscreen, false to exit.',
          },
        },
        required: ['panelId', 'fullscreen'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.setPanelFullscreen, async (args, extra) => {
        if (!hasOnlyOwnKeys(args, ['panelId', 'fullscreen'])) {
          return boundPanelLayoutMutationResult({
            ok: false,
            status: 'invalid',
            actionType: 'set_fullscreen',
            reason: 'malformed_arguments',
            message: 'panelId must be a stable dashboard panel ID and fullscreen must be a boolean.',
            panelId: typeof args.panelId === 'string' ? args.panelId : '',
            requestedFullscreen: args.fullscreen === true,
            effectiveFullscreen: false,
            changed: false,
          });
        }
        return boundPanelLayoutMutationResult(
          await app.setPanelFullscreen(args.panelId, args.fullscreen, extra),
        );
      }, trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.setMapView,
      title: 'Set Map View',
      description:
        'Move the visible map to a named world region or a bounded latitude/longitude pair, with an optional zoom level.',
      inputSchema: {
        type: 'object',
        properties: {
          view: {
            type: 'string',
            description: 'Named map region.',
            enum: [...DASHBOARD_MAP_VIEWS],
          },
          lat: {
            type: 'number',
            description: 'Web Mercator latitude; provide with lon.',
            minimum: -DASHBOARD_MAP_MAX_LATITUDE,
            maximum: DASHBOARD_MAP_MAX_LATITUDE,
          },
          lon: {
            type: 'number',
            description: 'Longitude from -180 to 180; provide with lat.',
            minimum: -180,
            maximum: 180,
          },
          zoom: {
            type: 'number',
            description: 'Optional map zoom from 1 to 10.',
            minimum: 1,
            maximum: 10,
          },
        },
        oneOf: [
          {
            properties: { view: {} },
            required: ['view'],
            not: {
              anyOf: [
                { properties: { lat: {} }, required: ['lat'] },
                { properties: { lon: {} }, required: ['lon'] },
              ],
            },
          },
          {
            properties: { lat: {}, lon: {} },
            required: ['lat', 'lon'],
            not: { properties: { view: {} }, required: ['view'] },
          },
        ],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.setMapView, async (args, extra) => (
        applyDashboardAction({
          type: 'set_view',
          view: args.view,
          lat: args.lat,
          lon: args.lon,
          zoom: args.zoom,
        }, app, extra)
      ), trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.setMapLayers,
      title: 'Set Map Layers',
      description:
        'Enable or disable explicit visible map layers through World Monitor’s variant, renderer, and entitlement-aware control path.',
      inputSchema: {
        type: 'object',
        properties: {
          layers: {
            type: 'object',
            description: 'Map layer IDs mapped to true (enable) or false (disable).',
            minProperties: 1,
            maxProperties: MAX_LAYER_ACTION_TARGETS,
            propertyNames: {
              type: 'string',
              minLength: 1,
              maxLength: MAX_LAYER_ACTION_TARGET_ID_LENGTH,
              pattern: DASHBOARD_LAYER_ACTION_TARGET_ID_PATTERN,
            },
            additionalProperties: { type: 'boolean' },
          },
        },
        required: ['layers'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.setMapLayers, async (args, extra) => (
        applyDashboardAction({
          type: 'set_layers',
          layers: args.layers,
        }, app, extra)
      ), trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.setTimeRange,
      title: 'Set Map Time Range',
      description:
        'Set the visible map time range through the same 1h, 6h, 24h, 48h, 7d, or all control used by the dashboard. Returns the requested and effective range.',
      inputSchema: {
        type: 'object',
        properties: {
          timeRange: {
            type: 'string',
            description: 'Dashboard time-range control value.',
            enum: [...DASHBOARD_TIME_RANGES],
          },
        },
        required: ['timeRange'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.setTimeRange, async (args, extra) => (
        applyDashboardAction({
          type: 'set_time_range',
          timeRange: args.timeRange,
        }, app, extra)
      ), trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.focusCountry,
      title: 'Focus Country On Map',
      description:
        'Focus the visible map on a country bounding box by ISO 3166-1 alpha-2 code without opening a country brief or consuming briefing quota.',
      inputSchema: {
        type: 'object',
        properties: {
          iso2: {
            type: 'string',
            description: 'ISO 3166-1 alpha-2 country code, uppercase.',
            pattern: DASHBOARD_COUNTRY_CODE_PATTERN,
          },
        },
        required: ['iso2'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.focusCountry, async (args, extra) => {
        const iso2 = typeof args.iso2 === 'string' ? args.iso2.toUpperCase() : '';
        if (!ISO2.test(iso2)) {
          throw new SafeWebMcpError(
            'iso2 must be an ISO 3166-1 alpha-2 code, such as "DE" or "IR".',
            'validation',
          );
        }
        return applyDashboardAction({
          type: 'focus_country',
          iso2,
        }, app, extra);
      }, trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.setMapMode,
      title: 'Set Map Mode',
      description:
        'Switch the visible map between 2d (flat) and 3d (globe) through the same dashboard control, including renderer layer compatibility.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            description: 'Visible map mode: 2d or 3d.',
            enum: [...DASHBOARD_MAP_MODES],
          },
        },
        required: ['mode'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.setMapMode, async (args, extra) => (
        applyDashboardAction({
          type: 'set_map_mode',
          mode: args.mode,
        }, app, extra)
      ), trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.searchDashboard,
      title: 'Search Dashboard',
      description:
        'Search the current World Monitor country, signal, map, panel, finance, and action indexes without opening the command palette or changing the dashboard. executable is true only when live dashboard state and this host’s cancellation support both allow the bound effect.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search text. It is never included in analytics.',
            minLength: 1,
            maxLength: MAX_SEARCH_QUERY_CHARS,
          },
          scope: {
            type: 'string',
            description: 'Optional dashboard surface to search.',
            enum: [...DASHBOARD_SEARCH_SCOPES],
            default: 'all',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of concise results to return.',
            minimum: 1,
            maximum: MAX_SEARCH_RESULTS,
            default: DEFAULT_SEARCH_RESULTS,
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.searchDashboard, async (args, extra) => {
        if (!hasOnlyOwnKeys(args, ['query', 'scope', 'limit'])) {
          throw new SafeWebMcpError(
            'search_dashboard accepts only query, scope, and limit.',
            'validation',
          );
        }
        if (typeof args.query !== 'string') {
          throw new SafeWebMcpError('query must be a string.', 'validation');
        }
        if (args.query.length > MAX_SEARCH_QUERY_CHARS) {
          throw new SafeWebMcpError(
            `query must be at most ${MAX_SEARCH_QUERY_CHARS} characters.`,
            'validation',
          );
        }
        const query = args.query.trim();
        if (!query) throw new SafeWebMcpError('query must not be empty.', 'validation');

        const scope = args.scope === undefined ? 'all' : args.scope;
        if (typeof scope !== 'string' || !DASHBOARD_SEARCH_SCOPES.has(scope as DashboardSearchScope)) {
          throw new SafeWebMcpError(
            'scope must be one of: all, signals, map, panels, actions.',
            'validation',
          );
        }
        const limit = args.limit === undefined ? DEFAULT_SEARCH_RESULTS : args.limit;
        if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > MAX_SEARCH_RESULTS) {
          throw new SafeWebMcpError(
            `limit must be an integer from 1 to ${MAX_SEARCH_RESULTS}.`,
            'validation',
          );
        }

        return boundDashboardSearchResult(await app.searchDashboard(
          query,
          scope as DashboardSearchScope,
          Number(limit),
          extra,
        ));
      }, trackEvent, {
        successMetadata: (args, value) => {
          const result = value as DashboardSearchResponse;
          return {
            queryLength: typeof args.query === 'string' ? args.query.trim().length : 0,
            resultCount: result.resultCount,
            resultTypes: [...new Set(
              result.results.map((match) => searchResultTypeBucket(match.type)),
            )].sort(),
          };
        },
      }),
    },
    {
      name: WEBMCP_SPA_TOOL.openSearchResult,
      title: 'Open Search Result',
      description:
        'Open one result previously issued by search_dashboard after rechecking that it is still live, allowed, compatible, and entitled. Cancellation uses the bound effect class, which callers cannot supply or downgrade. View-state results run without a target-side AbortSignal; persistent, quota-consuming, and external-navigation results require one and may return target_cancellation_unsupported.',
      inputSchema: {
        type: 'object',
        properties: {
          resultKey: {
            type: 'string',
            description: 'Opaque key returned by search_dashboard on this page.',
            pattern: '^sr_[a-f0-9]{32}$',
          },
        },
        required: ['resultKey'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.openSearchResult, async (args, extra) => {
        if (!hasOnlyOwnKeys(args, ['resultKey'])) {
          return boundSearchOpenResult({
            ok: false,
            status: 'denied',
            reason: 'malformed_arguments',
          });
        }
        const resultKey = typeof args.resultKey === 'string' ? args.resultKey : '';
        if (!SEARCH_RESULT_KEY.test(resultKey)) {
          return boundSearchOpenResult({
            ok: false,
            status: 'denied',
            reason: 'malformed_arguments',
          });
        }
        return boundSearchOpenResult(await app.openSearchResult(resultKey, extra));
      }, trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.listDashboardTabs,
      title: 'List Dashboard Tabs',
      description:
        'List dashboard tabs as named persistent panel workspaces. Returns each tab id, name, active flag, plus whether another tab can be created and why add is locked. Use tab ids, not display names, for select, rename, and delete. When tabsTruncated is true, tabCount is the total persisted workspace count and this page omitted later tabs; pass nextCursor to list the rest. Call list_dashboard_tabs again after mutations.',
      inputSchema: {
        type: 'object',
        properties: {
          cursor: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            pattern: DASHBOARD_TAB_ID_PATTERN,
            description: 'Inclusive start tab id from a previous nextCursor. Omit to start at the first workspace.',
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.listDashboardTabs, async (args, extra) => {
        if (!hasOnlyOwnKeys(args, ['cursor'])) {
          return boundDashboardTabMutation(mutationDenied(
            'list',
            'malformed_arguments',
            'list_dashboard_tabs accepts only an optional cursor.',
          ));
        }
        if (args.cursor !== undefined && typeof args.cursor !== 'string') {
          return boundDashboardTabMutation(mutationDenied(
            'list',
            'malformed_arguments',
            'cursor must be a stable dashboard tab ID from list_dashboard_tabs.',
          ));
        }
        const cursor = typeof args.cursor === 'string' ? args.cursor : undefined;
        return applyDashboardTabAction(
          cursor ? { type: 'list', cursor } : { type: 'list' },
          app,
          extra,
        );
      }, trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.selectDashboardTab,
      title: 'Select Dashboard Tab',
      description:
        'Activate a dashboard tab by stable tab id from list_dashboard_tabs. Selecting the already-active tab is a successful no-op. Unavailable without target-side cancellation because tab changes persist to worldmonitor-tabs-v1 and the live panel workspace (same class as openCountryBrief/set_map_layers).',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            pattern: DASHBOARD_TAB_ID_PATTERN,
            description: 'Stable dashboard tab id from list_dashboard_tabs.',
          },
        },
        required: ['tabId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.selectDashboardTab, async (args, extra) => {
        if (!hasOnlyOwnKeys(args, ['tabId'])) {
          return boundDashboardTabMutation(mutationDenied(
            'select',
            'malformed_arguments',
            'select_dashboard_tab accepts only tabId.',
          ));
        }
        return applyDashboardTabAction(
          { type: 'select', tabId: typeof args.tabId === 'string' ? args.tabId : '' },
          app,
          extra,
        );
      }, trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.createDashboardTab,
      title: 'Create Dashboard Tab',
      description:
        'Create a dashboard tab as a named persistent panel workspace, then activate it. Omit name to use the dashboard default. Creating a tab whose trimmed name already exists returns that tab without duplicating it. Honors the same tab cap and entitlement lock as the dashboard tab bar. Unavailable without target-side cancellation because tab changes persist to worldmonitor-tabs-v1 and the live panel workspace (same class as openCountryBrief/set_map_layers).',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: DASHBOARD_TAB_NAME_MAX_LENGTH,
            description: 'Optional display name. Omit to use the dashboard default.',
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.createDashboardTab, async (args, extra) => {
        if (!hasOnlyOwnKeys(args, ['name'])) {
          return boundDashboardTabMutation(mutationDenied(
            'create',
            'malformed_arguments',
            'create_dashboard_tab accepts only an optional name.',
          ));
        }
        const name = args.name;
        if (name !== undefined && typeof name !== 'string') {
          return boundDashboardTabMutation(mutationDenied(
            'create',
            'invalid_name',
            `Tab names must be 1–${DASHBOARD_TAB_NAME_MAX_LENGTH} visible characters.`,
          ));
        }
        return applyDashboardTabAction({ type: 'create', name }, app, extra);
      }, trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.renameDashboardTab,
      title: 'Rename Dashboard Tab',
      description:
        'Rename a dashboard tab by stable tab id. Names are trimmed and capped at 40 characters, matching the dashboard tab bar. Renaming to the current name is a successful no-op. Unavailable without target-side cancellation because tab changes persist to worldmonitor-tabs-v1 and the live panel workspace (same class as openCountryBrief/set_map_layers).',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            pattern: DASHBOARD_TAB_ID_PATTERN,
            description: 'Stable dashboard tab id from list_dashboard_tabs.',
          },
          name: {
            type: 'string',
            minLength: 1,
            maxLength: DASHBOARD_TAB_NAME_MAX_LENGTH,
            description: 'New display name for the tab.',
          },
        },
        required: ['tabId', 'name'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.renameDashboardTab, async (args, extra) => {
        if (!hasOnlyOwnKeys(args, ['tabId', 'name'])) {
          return boundDashboardTabMutation(mutationDenied(
            'rename',
            'malformed_arguments',
            'rename_dashboard_tab accepts only tabId and name.',
          ));
        }
        return applyDashboardTabAction(
          {
            type: 'rename',
            tabId: typeof args.tabId === 'string' ? args.tabId : '',
            name: typeof args.name === 'string' ? args.name : '',
          },
          app,
          extra,
        );
      }, trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.deleteDashboardTab,
      title: 'Delete Dashboard Tab',
      description:
        'Delete a dashboard tab by stable tab id. Requires confirm=true. Refuses to delete the last remaining tab. Unavailable without target-side cancellation because tab changes persist to worldmonitor-tabs-v1 and the live panel workspace (same class as openCountryBrief/set_map_layers).',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            pattern: DASHBOARD_TAB_ID_PATTERN,
            description: 'Stable dashboard tab id from list_dashboard_tabs.',
          },
          confirm: {
            type: 'boolean',
            description: 'Must be true. Delete is a destructive persistent mutation.',
          },
        },
        required: ['tabId', 'confirm'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.deleteDashboardTab, async (args, extra) => {
        if (!hasOnlyOwnKeys(args, ['tabId', 'confirm'])) {
          return boundDashboardTabMutation(mutationDenied(
            'delete',
            'malformed_arguments',
            'delete_dashboard_tab accepts only tabId and confirm.',
          ));
        }
        return applyDashboardTabAction(
          {
            type: 'delete',
            tabId: typeof args.tabId === 'string' ? args.tabId : '',
            confirm: args.confirm === true,
          },
          app,
          extra,
        );
      }, trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.listMissionPresets,
      title: 'List Mission Presets',
      description:
        'List every bundled mission preset for the current monitor. Each item uses a stable preset ID and panel/layer counts without premium payloads. Available rows include intended view and time range. Includes active, monitorCompatible, entitled, and available flags with a stable unavailableReason when gated.',
      inputSchema: {
        type: 'object',
        properties: {
          available: {
            type: 'boolean',
            description: 'If set, keep only presets the current session can apply.',
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.listMissionPresets, async (args, extra) => {
        if (!hasOnlyOwnKeys(args, ['available'])) {
          throw new SafeWebMcpError(
            'list_mission_presets accepts only available.',
            'validation',
          );
        }
        const query: MissionPresetCatalogQuery = {};
        if (args.available !== undefined) query.available = args.available as boolean;
        return boundMissionPresetCatalog(await app.listMissionPresets(query, extra));
      }, trackEvent, {
        successMetadata: (_args, value) => {
          const result = value as MissionPresetCatalogResult;
          return { resultCount: result.presets.length };
        },
      }),
    },
    {
      name: WEBMCP_SPA_TOOL.applyMissionPreset,
      title: 'Apply Mission Preset',
      description:
        'Apply a bundled mission preset by stable ID through the same mission-control path a person uses. Reports entitlement and monitor compatibility before writing. Requires target-side cancellation because it persists panels, layers, map view, and time range. On failure, restores the prior dashboard state.',
      inputSchema: {
        type: 'object',
        properties: {
          presetId: {
            type: 'string',
            description: 'Bundled mission preset ID from list_mission_presets.',
            minLength: 1,
            maxLength: 48,
            pattern: '^[a-z][a-z0-9-]*$',
          },
        },
        required: ['presetId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.applyMissionPreset, async (args, extra) => {
        if (!hasOnlyOwnKeys(args, ['presetId'])) {
          return boundApplyMissionPresetResult({
            ok: false,
            status: 'invalid',
            reason: 'malformed_arguments',
            message: 'presetId must be a stable bundled mission preset ID.',
          });
        }
        return boundApplyMissionPresetResult(
          await app.applyMissionPreset(args.presetId, extra),
        );
      }, trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.openMissionPicker,
      title: 'Open Mission Picker',
      description:
        'Open the mission preset picker through the same mission-control path a person uses. Opening the picker does not apply a preset. Returns the destination and effective dashboard state.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.openMissionPicker, async (args, extra) => {
        if (!hasOnlyOwnKeys(args, [])) {
          return boundDashboardNavigationResult({
            ok: false,
            status: 'invalid',
            reason: 'malformed_arguments',
            message: 'open_mission_picker does not accept arguments.',
            context: await currentNavigationContext(app, extra),
          });
        }
        return boundDashboardNavigationResult(await app.openMissionPicker(extra));
      }, trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.getAccessContext,
      title: 'Get Access Context',
      description:
        'Read whether this tab is signed out, still loading account state, or signed in. Returns product tier, capability flags, panel and dashboard-tab limits, and whether the host can cancel tools. Contains no names, emails, account IDs, tokens, or session details.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.getAccessContext, async (_args, extra) => (
        boundWebMcpAccessContext(await app.getAccessContext(extra), Boolean(extra?.signal))
      ), trackEvent),
    },
    {
      name: WEBMCP_SPA_TOOL.openSignIn,
      title: 'Open Sign In',
      description:
        'Open the existing Clerk sign-in dialog on this page. Does not accept credentials, one-time codes, or provider choices. Returns a stable reason when Clerk is unavailable or the dialog is already open.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging(WEBMCP_SPA_TOOL.openSignIn, async (args, extra) => {
        if (!hasOnlyOwnKeys(args, [])) {
          throw new SafeWebMcpError(
            'open_sign_in does not accept credentials or other arguments.',
            'validation',
          );
        }
        return boundOpenSignInResult(await app.openSignIn(extra));
      }, trackEvent),
    },
  ];
  const registered = new Set(tools.map((tool) => tool.name));
  for (const name of WEBMCP_SPA_TOOL_NAMES) {
    if (!registered.has(name)) {
      throw new Error(`WebMCP SPA inventory is missing ${name}.`);
    }
  }
  return tools;
}

function registrationFailureReason(error: unknown): RegistrationFailureReason | 'aborted' {
  let name = '';
  try {
    name = error && typeof error === 'object' && 'name' in error
      ? String((error as { name?: unknown }).name ?? '')
      : '';
  } catch {
    return 'unknown';
  }
  switch (name) {
    case 'AbortError':
      return 'aborted';
    case 'InvalidStateError':
      return 'invalid-state';
    case 'SecurityError':
      return 'security';
    case 'NotAllowedError':
      return 'not-allowed';
    case 'TypeError':
      return 'invalid-tool';
    default:
      return 'unknown';
  }
}

function observeRegistration(
  provider: WebMCP.ModelContext,
  tool: DashboardWebMcpTool,
  controller: AbortController,
  trackEvent: WebMcpAnalytics,
): Promise<boolean> {
  let registration: Promise<void>;
  try {
    registration = provider.registerTool(tool, { signal: controller.signal });
  } catch (error) {
    registration = Promise.reject(error);
  }

  return Promise.resolve(registration).then(
    () => !controller.signal.aborted,
    (error: unknown) => {
      const reason = registrationFailureReason(error);
      if (!controller.signal.aborted) {
        reportWebMcpEvent(trackEvent, 'webmcp-registration-failed', {
          tool: tool.name,
          reason,
        });
      }
      return false;
    },
  );
}

function startRegistration(
  provider: WebMCP.ModelContext,
  tools: DashboardWebMcpTool[],
  controller: AbortController,
  trackEvent: WebMcpAnalytics,
): void {
  const registrations = tools.map((tool) => (
    observeRegistration(provider, tool, controller, trackEvent)
  ));

  void Promise.all(registrations).then((accepted) => {
    if (controller.signal.aborted) return;
    const toolCount = accepted.filter(Boolean).length;
    // EVERY settled registration pass emits a mark, so a probe waiting on one
    // never hangs: a probe that polls getTools() before this point observes an
    // empty inventory, and on the Chrome origin-trial path that empty read
    // wedges every later getTools() call for the lifetime of the page.
    // The zero-tool pass gets its OWN mark, though — 'wm:webmcp:registered'
    // means "the inventory is there to read", and firing it with nothing
    // registered would authorize the probe to read the empty inventory this
    // mark exists to keep it away from.
    if (toolCount === 0) {
      markLcpDebug('wm:webmcp:registration-empty', { toolCount: 0 });
      return;
    }
    markLcpDebug('wm:webmcp:registered', { toolCount });
    reportWebMcpEvent(trackEvent, 'webmcp-registered', {
      toolCount,
      pageSurface: 'dashboard',
      api: 'document-current',
    });
  });
}

// Registers tools with the browser's current WebMCP provider, if present.
// Registration calls begin synchronously so discovery probes can observe them.
// A provider installed after head parsing gets one DOM-ready/load retry. The
// returned AbortController tears down accepted tools, pending registrations,
// and retry listeners. Unsupported runtimes remain a no-op.
export function registerWebMcpTools(
  app: WebMcpAppBindings,
  runtime: WebMcpRegistrationRuntime = {},
): AbortController | null {
  const runtimeDocument = runtime.document
    ?? (typeof document === 'undefined' ? null : document);
  if (!runtimeDocument) return null;

  const runtimeWindow = runtime.window
    ?? (typeof window === 'undefined' ? null : window);
  const trackEvent = runtime.track ?? trackPrivacyRestricted;
  const tools = buildWebMcpTools(app, trackEvent);
  const controller = new AbortController();
  let registrationStarted = false;

  const registerAvailableProvider = (): boolean => {
    if (registrationStarted || controller.signal.aborted) return registrationStarted;
    let provider: WebMCP.ModelContext | undefined;
    try {
      provider = runtimeDocument.modelContext;
    } catch {
      return false;
    }
    if (!provider || typeof provider.registerTool !== 'function') return false;
    registrationStarted = true;
    startRegistration(provider, tools, controller, trackEvent);
    return true;
  };

  if (!registerAvailableProvider()) {
    const retry = (): void => { registerAvailableProvider(); };
    try {
      runtimeDocument.addEventListener('DOMContentLoaded', retry, {
        once: true,
        signal: controller.signal,
      });
    } catch {
      // Unsupported listener options must not break page initialization.
    }
    try {
      runtimeWindow?.addEventListener('load', retry, {
        once: true,
        signal: controller.signal,
      });
    } catch {
      // Unsupported listener options must not break page initialization.
    }
  }

  return controller;
}
