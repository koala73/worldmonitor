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
//   4. open_dashboard_panel()     — opens an already-live panel.
//   5. set_map_view()             — moves the visible map.
//   6. set_map_layers()           — changes allowed visible map layers.
//   7. search_dashboard()         — searches the live dashboard index.
//   8. open_search_result()       — selects an opaque, revalidated result.
//
// No tool is conditionally registered. Live controls re-check auth and
// entitlement through the agent-bus applier on every invocation, so a single
// registration remains correct across sign-in/sign-out.
//
// Scanner compatibility: WebMCP scanners probe for
// `document.modelContext.registerTool` invocations during initial page load.
// Register synchronously from App.ts (no dynamic import, no init-phase
// awaits) so the probe finds the tools before it gives up.

import { track, trackPrivacyRestricted, type UmamiEvent } from './analytics';
import {
  DASHBOARD_MAP_MAX_LATITUDE,
  DASHBOARD_MAP_VIEWS,
  DASHBOARD_LAYER_ACTION_TARGET_ID_PATTERN,
  MAX_LAYER_ACTION_TARGET_ID_LENGTH,
  MAX_LAYER_ACTION_TARGETS,
} from '../../shared/agent-bus-contract';

export interface WebMcpAppBindings {
  openCountryBriefByCode(code: string, country: string): Promise<void>;
  resolveCountryName(code: string): string;
  // Returns a Promise because implementations may await a readiness signal
  // (e.g. waiting for the search modal to exist during startup) before
  // dispatching. Tool executes must `await` it so rejections surface to
  // withInvocationLogging's catch path.
  openSearch(): void | Promise<void>;
  getDashboardContext(): DashboardContextSnapshot | Promise<DashboardContextSnapshot>;
  applyDashboardAction(action: unknown): DashboardActionResult | Promise<DashboardActionResult>;
  searchDashboard(
    query: string,
    scope: DashboardSearchScope,
    limit: number,
  ): DashboardSearchResponse | Promise<DashboardSearchResponse>;
  openSearchResult(resultKey: string): DashboardSearchOpenResult | Promise<DashboardSearchOpenResult>;
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
  | 'result_no_longer_executable';

export interface DashboardSearchOpenResult {
  ok: boolean;
  status: 'opened' | 'denied';
  type?: string;
  reason?: DashboardSearchOpenReason;
}

export interface DashboardContextSnapshot {
  variant: string;
  map: {
    view: string;
    center: { lat: number; lon: number } | null;
    zoom: number;
    timeRange: string;
    enabledLayers: string[];
  };
  panels: {
    mounted: string[];
    enabled: string[];
  };
}

export type DashboardActionStatus = 'applied' | 'denied' | 'invalid' | 'skipped';

export interface DashboardActionTargetResult {
  target: string;
  status: DashboardActionStatus;
  reason?: string;
}

export interface DashboardActionResult {
  ok: boolean;
  status: DashboardActionStatus;
  actionType?: 'open_panel' | 'set_view' | 'set_layers';
  reason?: string;
  message: string;
  targets: DashboardActionTargetResult[];
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

type DashboardWebMcpToolName =
  | 'openCountryBrief'
  | 'openSearch'
  | 'get_dashboard_context'
  | 'open_dashboard_panel'
  | 'set_map_view'
  | 'set_map_layers'
  | 'search_dashboard'
  | 'open_search_result';
type WebMcpAnalytics = (event: UmamiEvent, data?: Record<string, unknown>) => void;
type RegistrationFailureReason =
  | 'invalid-state'
  | 'security'
  | 'not-allowed'
  | 'invalid-tool'
  | 'unknown';

type DashboardWebMcpTool = WebMCP.ModelContextTool & {
  name: DashboardWebMcpToolName;
  execute: WebMCP.ToolExecuteCallback<Record<string, unknown>>;
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
]);
const MAX_SEARCH_QUERY_CHARS = 160;
const MAX_SEARCH_RESULTS = 10;
const DEFAULT_SEARCH_RESULTS = 8;
const MAX_OUTPUT_CHARS = 1_500;
const TARGET_OUTPUT_CHARS = 1_400;
export const DASHBOARD_SEARCH_OUTPUT_TARGET_CHARS = 1_400;
export const DASHBOARD_SEARCH_TYPE_MAX_CHARS = 32;
export const DASHBOARD_SEARCH_TITLE_MAX_CHARS = 160;
export const DASHBOARD_SEARCH_SUBTITLE_MAX_CHARS = 180;
const TOOL_FAILURE_MESSAGES: Record<DashboardWebMcpToolName, string> = {
  openCountryBrief: 'World Monitor could not open that country brief.',
  openSearch: 'World Monitor could not open search.',
  get_dashboard_context: 'World Monitor could not read dashboard context.',
  open_dashboard_panel: 'World Monitor could not open that dashboard panel.',
  set_map_view: 'World Monitor could not move the map.',
  set_map_layers: 'World Monitor could not update map layers.',
  search_dashboard: 'World Monitor could not search the dashboard.',
  open_search_result: 'World Monitor could not open that search result.',
};

class SafeWebMcpError extends Error {
  public constructor(message: string) {
    super(message);
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

function withInvocationLogging(
  name: DashboardWebMcpToolName,
  fn: WebMCP.ToolExecuteCallback<Record<string, unknown>>,
  trackEvent: WebMcpAnalytics,
  successMetadata?: (
    args: Record<string, unknown>,
    result: unknown,
  ) => Record<string, unknown>,
): WebMCP.ToolExecuteCallback<Record<string, unknown>> {
  return async (args) => {
    try {
      const result = await fn(args);
      reportWebMcpEvent(trackEvent, 'webmcp-tool-invoked', {
        tool: name,
        outcome: 'success',
        ...(successMetadata?.(args, result) ?? {}),
      });
      return result;
    } catch (error) {
      reportWebMcpEvent(trackEvent, 'webmcp-tool-invoked', {
        tool: name,
        outcome: 'failure',
      });
      if (error instanceof SafeWebMcpError) throw error;
      if (error instanceof DashboardBindingError) {
        throw new SafeWebMcpError(
          `Dashboard unavailable: ${boundedText(error.message, 160)} Reason: ${error.reason}.`,
        );
      }
      throw new SafeWebMcpError(TOOL_FAILURE_MESSAGES[name]);
    }
  };
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

function boundDashboardContext(snapshot: DashboardContextSnapshot): Record<string, unknown> {
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
  while (JSON.stringify(result).length > TARGET_OUTPUT_CHARS) {
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

function boundDashboardActionResult(result: DashboardActionResult): Record<string, unknown> & {
  ok: boolean;
  status: DashboardActionStatus;
} {
  const targets = (Array.isArray(result.targets) ? result.targets : []).map((target) => ({
    target: boundedText(target?.target, 96),
    status: target?.status,
    ...(target?.reason ? { reason: boundedText(target.reason, 64) } : {}),
  }));
  const bounded = {
    ok: result.ok === true,
    status: result.status,
    ...(result.actionType ? { actionType: result.actionType } : {}),
    ...(result.reason ? { reason: boundedText(result.reason, 64) } : {}),
    message: boundedText(result.message, 240),
    targets,
    targetCount: targets.length,
    targetsTruncated: false,
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

function boundSearchOpenResult(result: DashboardSearchOpenResult): DashboardSearchOpenResult {
  const opened = result.ok === true && result.status === 'opened';
  const reason = result.reason && DASHBOARD_SEARCH_OPEN_REASONS.has(result.reason)
    ? result.reason
    : 'invalid_or_expired_key';
  return {
    ok: opened,
    status: opened ? 'opened' : 'denied',
    ...(result.type ? { type: boundedText(result.type, 32) } : {}),
    ...(!opened ? { reason } : {}),
  };
}

function hasOnlyOwnKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

async function applyDashboardAction(
  action: unknown,
  app: WebMcpAppBindings,
): Promise<Record<string, unknown>> {
  // Denied and invalid actions are expected, structured control outcomes—not
  // transport failures. Preserve the narrow applier result so agents can branch
  // on stable reasons and per-target statuses. Runtime/binding faults still
  // reject through withInvocationLogging's safe error boundary.
  return boundDashboardActionResult(await app.applyDashboardAction(action));
}

export function buildWebMcpTools(
  app: WebMcpAppBindings,
  trackEvent: WebMcpAnalytics = track,
  searchTrackEvent: WebMcpAnalytics = trackEvent === track
    ? trackPrivacyRestricted
    : trackEvent,
): DashboardWebMcpTool[] {
  return [
    {
      name: 'openCountryBrief',
      title: 'Open Country Brief',
      description:
        'Open the intelligence brief panel for a country by ISO 3166-1 alpha-2 code (e.g. "DE", "IR"). Routes the user to the country deep-dive view; the brief itself is fetched by the same path a click would take.',
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
      execute: withInvocationLogging('openCountryBrief', async (args) => {
        const iso2 = typeof args.iso2 === 'string' ? args.iso2.toUpperCase() : '';
        if (!ISO2.test(iso2)) {
          throw new SafeWebMcpError(
            'iso2 must be an ISO 3166-1 alpha-2 code, such as "DE" or "IR".',
          );
        }
        const name = app.resolveCountryName(iso2);
        await app.openCountryBriefByCode(iso2, name);
        return `Opened intelligence brief for ${name} (${iso2}).`;
      }, trackEvent),
    },
    {
      name: 'openSearch',
      title: 'Open Search',
      description:
        'Open the global search command palette so the user can find countries, signals, alerts, and other entities tracked by World Monitor.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging('openSearch', async () => {
        await app.openSearch();
        return 'Opened search palette.';
      }, trackEvent),
    },
    {
      name: 'get_dashboard_context',
      title: 'Get Dashboard Context',
      description:
        'Read a bounded snapshot of the visible dashboard: active variant, map view, center, zoom, time range, enabled layers, and mounted or enabled panel IDs.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: withInvocationLogging('get_dashboard_context', async () => (
        boundDashboardContext(await app.getDashboardContext())
      ), trackEvent),
    },
    {
      name: 'open_dashboard_panel',
      title: 'Open Dashboard Panel',
      description:
        'Open and scroll to an already-live dashboard panel through the same entitlement-aware control path used by World Monitor.',
      inputSchema: {
        type: 'object',
        properties: {
          panelId: {
            type: 'string',
            description: 'Dashboard panel ID, such as "markets" or "strategic-risk".',
            minLength: 1,
            maxLength: 96,
            pattern: '^[a-z0-9][a-z0-9@_-]*$',
          },
        },
        required: ['panelId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging('open_dashboard_panel', async (args) => (
        applyDashboardAction({
          type: 'open_panel',
          panelId: args.panelId,
        }, app)
      ), trackEvent),
    },
    {
      name: 'set_map_view',
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
            required: ['view'],
            not: {
              anyOf: [
                { required: ['lat'] },
                { required: ['lon'] },
              ],
            },
          },
          {
            required: ['lat', 'lon'],
            not: { required: ['view'] },
          },
        ],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: withInvocationLogging('set_map_view', async (args) => (
        applyDashboardAction({
          type: 'set_view',
          view: args.view,
          lat: args.lat,
          lon: args.lon,
          zoom: args.zoom,
        }, app)
      ), trackEvent),
    },
    {
      name: 'set_map_layers',
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
      execute: withInvocationLogging('set_map_layers', async (args) => (
        applyDashboardAction({
          type: 'set_layers',
          layers: args.layers,
        }, app)
      ), trackEvent),
    },
    {
      name: 'search_dashboard',
      title: 'Search Dashboard',
      description:
        'Search the current World Monitor country, signal, map, panel, finance, and action indexes without opening the command palette or changing the dashboard.',
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
      execute: withInvocationLogging('search_dashboard', async (args) => {
        if (!hasOnlyOwnKeys(args, ['query', 'scope', 'limit'])) {
          throw new SafeWebMcpError('search_dashboard accepts only query, scope, and limit.');
        }
        if (typeof args.query !== 'string') {
          throw new SafeWebMcpError('query must be a string.');
        }
        if (args.query.length > MAX_SEARCH_QUERY_CHARS) {
          throw new SafeWebMcpError(`query must be at most ${MAX_SEARCH_QUERY_CHARS} characters.`);
        }
        const query = args.query.trim();
        if (!query) throw new SafeWebMcpError('query must not be empty.');

        const scope = args.scope === undefined ? 'all' : args.scope;
        if (typeof scope !== 'string' || !DASHBOARD_SEARCH_SCOPES.has(scope as DashboardSearchScope)) {
          throw new SafeWebMcpError('scope must be one of: all, signals, map, panels, actions.');
        }
        const limit = args.limit === undefined ? DEFAULT_SEARCH_RESULTS : args.limit;
        if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > MAX_SEARCH_RESULTS) {
          throw new SafeWebMcpError(`limit must be an integer from 1 to ${MAX_SEARCH_RESULTS}.`);
        }

        return boundDashboardSearchResult(await app.searchDashboard(
          query,
          scope as DashboardSearchScope,
          Number(limit),
        ));
      }, searchTrackEvent, (args, value) => {
        const result = value as DashboardSearchResponse;
        return {
          queryLength: typeof args.query === 'string' ? args.query.trim().length : 0,
          resultCount: result.resultCount,
          resultTypes: [...new Set(result.results.map((match) => match.type))].sort(),
        };
      }),
    },
    {
      name: 'open_search_result',
      title: 'Open Search Result',
      description:
        'Open one result previously issued by search_dashboard after rechecking that it is still live, allowed, compatible, and entitled.',
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
      execute: withInvocationLogging('open_search_result', async (args) => {
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
        return boundSearchOpenResult(await app.openSearchResult(resultKey));
      }, searchTrackEvent),
    },
  ];
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
      if (!controller.signal.aborted && reason !== 'aborted') {
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
    if (toolCount === 0) return;
    reportWebMcpEvent(trackEvent, 'webmcp-registered', {
      toolCount,
      api: 'registerTool',
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
  const trackEvent = runtime.track ?? track;
  const searchTrackEvent = runtime.track ?? trackPrivacyRestricted;
  const tools = buildWebMcpTools(app, trackEvent, searchTrackEvent);
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
