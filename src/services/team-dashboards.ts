import type { PanelConfig } from '@/types';
import { SITE_VARIANT } from '@/config/variant';
import { overlayPanelChoices, type TabPanels } from '@/services/tab-store';
import { isDynamicPanel } from '@/services/mission-presets';
import { getConvexApi, getConvexClient, waitForConvexAuthForUser } from '@/services/convex-client';
import { settleAccountOperation } from '@/services/account-operation';
import { DASHBOARD_MAP_VIEWS, DASHBOARD_TIME_RANGES } from '../../shared/agent-bus-contract';
import type { TeamDashboardLayout } from '../../convex/lib/teamDashboardLayout';
import type { Id } from '../../convex/_generated/dataModel';

export type { TeamDashboardLayout };

/**
 * Team dashboards: tab layouts shared within an API Business or Enterprise
 * team (convex/teamDashboards.ts). The server decides who is on the team;
 * this module converts between a live tab and the stored layout and wraps the
 * three Convex calls.
 */
export interface TeamDashboard {
  id: string;
  name: string;
  version: number;
  updatedAt: number;
  layout: TeamDashboardLayout;
}

export interface TeamDashboards {
  team: { kind: 'business' | 'enterprise' };
  dashboards: TeamDashboard[];
}

/** Which team dashboard a tab was opened from, and the version it holds. */
export interface TeamDashboardLink {
  id: string;
  version: number;
}

export type DashboardMapView = (typeof DASHBOARD_MAP_VIEWS)[number];
export type DashboardTimeRange = (typeof DASHBOARD_TIME_RANGES)[number];

/** The map part of a layout, narrowed to values this build can apply. */
export interface TeamDashboardMap {
  view: DashboardMapView;
  zoom: number;
  lat: number;
  lon: number;
  timeRange: DashboardTimeRange;
  layers: string[];
}

export interface PanelSize {
  key: string;
  rows?: number;
  cols?: number;
}

// Mirrors the server's key rule (convex/lib/teamDashboardLayout.ts) so a
// capture never sends something publish would refuse.
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/;
const MAX_ROW_SPAN = 4;
const MAX_COL_SPAN = 3;

function span(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max ? value : undefined;
}

export interface TeamDashboardCaptureInput extends TabPanels {
  bottomSet: readonly string[];
  rowSpans: Readonly<Record<string, number>>;
  colSpans: Readonly<Record<string, number>>;
  map: {
    view: string;
    zoom: number;
    center: { lat: number; lon: number } | null;
    timeRange: string;
    layers: Readonly<Record<string, boolean | undefined>>;
  } | null;
}

/**
 * The layout of the tab on screen, as a teammate should get it: every panel
 * in grid order with its visibility, dock and size, plus the map view and the
 * layers that are on. Custom widgets and MCP panels are the publisher's own
 * and are left out.
 */
export function captureTeamDashboardLayout(input: TeamDashboardCaptureInput): TeamDashboardLayout {
  const bottom = new Set(input.bottomSet);
  const keys = new Set([...input.panelOrder, ...Object.keys(input.panelSettings)]);
  const panels: TeamDashboardLayout['panels'] = [];
  for (const key of keys) {
    const config = input.panelSettings[key];
    if (!config || !KEY_RE.test(key) || isDynamicPanel(key)) continue;
    const entry: TeamDashboardLayout['panels'][number] = { key, on: config.enabled };
    if (bottom.has(key)) entry.bottom = true;
    const rows = span(input.rowSpans[key], MAX_ROW_SPAN);
    const cols = span(input.colSpans[key], MAX_COL_SPAN);
    if (rows !== undefined) entry.rows = rows;
    if (cols !== undefined) entry.cols = cols;
    panels.push(entry);
  }

  const map = input.map;
  if (!map?.center || !Number.isFinite(map.zoom)) return { panels };
  return {
    panels,
    map: {
      view: map.view,
      zoom: map.zoom,
      lat: map.center.lat,
      lon: map.center.lon,
      timeRange: map.timeRange,
      layers: Object.entries(map.layers)
        .filter(([layer, on]) => on === true && KEY_RE.test(layer))
        .map(([layer]) => layer),
    },
  };
}

export interface TeamDashboardTab extends TabPanels {
  bottomSet: string[];
  sizes: PanelSize[];
  map: TeamDashboardMap | null;
}

function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

/**
 * Turn a stored layout into this browser's tab. Panels go through the same
 * overlay as saved new-tab panels, so a panel this build does not know (or a
 * teammate's custom widget) is skipped. A map view or time range this build
 * does not know drops the whole map part rather than half-applying it.
 */
export function toTeamDashboardTab(
  layout: TeamDashboardLayout,
  currentPanelSettings: Record<string, PanelConfig>,
): TeamDashboardTab {
  const { panelSettings, panelOrder } = overlayPanelChoices(currentPanelSettings, layout.panels);
  const known = new Set(panelOrder);
  const bottomSet: string[] = [];
  const sizes: PanelSize[] = [];
  for (const panel of layout.panels) {
    if (!known.has(panel.key)) continue;
    if (panel.bottom) bottomSet.push(panel.key);
    sizes.push({ key: panel.key, rows: span(panel.rows, MAX_ROW_SPAN), cols: span(panel.cols, MAX_COL_SPAN) });
  }

  const raw = layout.map;
  const map = raw
    && isOneOf(DASHBOARD_MAP_VIEWS, raw.view)
    && isOneOf(DASHBOARD_TIME_RANGES, raw.timeRange)
    && Number.isFinite(raw.zoom) && Number.isFinite(raw.lat) && Number.isFinite(raw.lon)
    ? { view: raw.view, zoom: raw.zoom, lat: raw.lat, lon: raw.lon, timeRange: raw.timeRange, layers: [...raw.layers] }
    : null;

  return { panelSettings, panelOrder, bottomSet, sizes, map };
}

/** The ConvexError `kind` of a failed call, when it has one. */
export function teamDashboardErrorKind(err: unknown): string | null {
  const data = (err as { data?: unknown } | null)?.data;
  if (data && typeof data === 'object' && typeof (data as { kind?: unknown }).kind === 'string') {
    return (data as { kind: string }).kind;
  }
  const match = /"kind":"([A-Z_]+)"/.exec(String((err as Error | null)?.message ?? ''));
  return match?.[1] ?? null;
}

async function convexForUser(userId: string, action: string) {
  const [client, api] = await Promise.all([getConvexClient(), getConvexApi()]);
  if (!client || !api) throw new Error('Convex unavailable');
  if (!await waitForConvexAuthForUser(userId)) {
    throw new Error(`Authentication unavailable while ${action}. Try again.`);
  }
  return { client, api };
}

/** The signed-in user's team and its dashboards for this variant; null without a team. */
export async function loadTeamDashboards(userId: string): Promise<TeamDashboards | null> {
  const action = 'loading team dashboards';
  const { client, api } = await convexForUser(userId, action);
  const result = await settleAccountOperation(userId, action,
    () => client.query(api.teamDashboards.listForVariant, { variant: SITE_VARIANT }));
  if (!result.team) return null;
  return {
    team: result.team,
    dashboards: result.dashboards.map((d) => ({ ...d, id: String(d.id) })),
  };
}

export async function publishTeamDashboard(
  userId: string,
  args: { name: string; layout: TeamDashboardLayout; dashboardId?: string; baseVersion?: number },
): Promise<TeamDashboardLink> {
  const action = 'sharing a dashboard with your team';
  const { client, api } = await convexForUser(userId, action);
  const result = await settleAccountOperation(userId, action, () => client.mutation(api.teamDashboards.publish, {
    variant: SITE_VARIANT,
    name: args.name,
    layout: args.layout,
    ...(args.dashboardId ? { dashboardId: args.dashboardId as Id<'teamDashboards'> } : {}),
    ...(args.dashboardId && args.baseVersion !== undefined ? { baseVersion: args.baseVersion } : {}),
  }));
  return { id: String(result.id), version: result.version };
}

export async function removeTeamDashboard(userId: string, dashboardId: string): Promise<void> {
  const action = 'removing a team dashboard';
  const { client, api } = await convexForUser(userId, action);
  await settleAccountOperation(userId, action,
    () => client.mutation(api.teamDashboards.remove, { dashboardId: dashboardId as Id<'teamDashboards'> }));
}
