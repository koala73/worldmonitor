import { ConvexError, v, type Infer } from "convex/values";
import { normalizeScope } from "../../shared/tab-scope";
import { isValidIso2 } from "./iso2";

/**
 * The stored shape of a team dashboard (convex/teamDashboards.ts). Shared by
 * the schema and the publish mutation so the two cannot drift.
 */
export const teamDashboardLayoutValidator = v.object({
  // Grid order. `bottom` marks the panels docked in the bottom grid on wide
  // screens; `rows` / `cols` are the panel's resized spans.
  panels: v.array(v.object({
    key: v.string(),
    on: v.boolean(),
    bottom: v.optional(v.boolean()),
    rows: v.optional(v.number()),
    cols: v.optional(v.number()),
  })),
  map: v.optional(v.object({
    view: v.string(),
    zoom: v.number(),
    lat: v.number(),
    lon: v.number(),
    timeRange: v.string(),
    layers: v.array(v.string()),
  })),
  // Focus (#10453): the chosen countries and the neighbours switch, never an
  // expanded list, so a correction to shared/country-adjacency.ts reaches
  // stored dashboards. Optional: rows stored before focus have neither field.
  scope: v.optional(v.object({
    countries: v.array(v.string()),
    neighbours: v.optional(v.boolean()),
    start: v.optional(v.string()),
    end: v.optional(v.string()),
  })),
  // Per-panel filter choices that travel with a focused dashboard.
  panelFilters: v.optional(v.array(v.object({ key: v.string(), value: v.string() }))),
});

export type TeamDashboardLayout = Infer<typeof teamDashboardLayoutValidator>;

const MAX_PANELS = 400;
const MAX_LAYERS = 200;
// Mirror src/utils/panel-grid.ts (MAX_PANEL_ROW_SPAN, MAX_PANEL_COL_SPAN).
const MAX_ROW_SPAN = 4;
const MAX_COL_SPAN = 3;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/;
const MAX_PANEL_FILTERS = 40;
const MAX_PANEL_FILTER_VALUE_LENGTH = 200;

function invalid(field: string): never {
  throw new ConvexError({ kind: "INVALID_LAYOUT", field });
}

function isSpan(value: number | undefined, max: number): boolean {
  return value === undefined || (Number.isInteger(value) && value >= 1 && value <= max);
}

/** Bounds the validator cannot express: sizes, key shape, numeric ranges. */
export function checkTeamDashboardLayout(layout: TeamDashboardLayout): void {
  if (layout.panels.length === 0 || layout.panels.length > MAX_PANELS) invalid("panels");
  const seen = new Set<string>();
  for (const panel of layout.panels) {
    if (!KEY_RE.test(panel.key) || seen.has(panel.key)) invalid("panels.key");
    if (!isSpan(panel.rows, MAX_ROW_SPAN) || !isSpan(panel.cols, MAX_COL_SPAN)) invalid("panels.span");
    seen.add(panel.key);
  }
  if (layout.scope) checkScope(layout.scope);
  if (layout.panelFilters) checkPanelFilters(layout.panelFilters);
  const map = layout.map;
  if (!map) return;
  if (!KEY_RE.test(map.view) || !KEY_RE.test(map.timeRange)) invalid("map.view");
  if (!Number.isFinite(map.zoom) || map.zoom < 0 || map.zoom > 24) invalid("map.zoom");
  if (!Number.isFinite(map.lat) || Math.abs(map.lat) > 90) invalid("map.lat");
  if (!Number.isFinite(map.lon) || Math.abs(map.lon) > 180) invalid("map.lon");
  if (map.layers.length > MAX_LAYERS || map.layers.some((layer) => !KEY_RE.test(layer))) invalid("map.layers");
}

/**
 * A stored scope must already be what `normalizeScope` would produce from it:
 * 1..SCOPE_MAX_COUNTRIES unique uppercase ISO2 codes, real calendar dates and
 * start <= end. normalizeScope cleans untrusted input by dropping bad entries;
 * here anything it would drop or change is refused, since layouts are stored
 * verbatim.
 */
function checkScope(scope: NonNullable<TeamDashboardLayout["scope"]>): void {
  const normalized = normalizeScope(scope);
  if (
    !normalized ||
    normalized.countries.length !== scope.countries.length ||
    normalized.countries.some((code, i) => code !== scope.countries[i] || !isValidIso2(code)) ||
    normalized.start !== scope.start ||
    normalized.end !== scope.end
  ) {
    invalid("scope");
  }
}

function checkPanelFilters(filters: NonNullable<TeamDashboardLayout["panelFilters"]>): void {
  if (filters.length > MAX_PANEL_FILTERS) invalid("panelFilters");
  const seen = new Set<string>();
  for (const filter of filters) {
    if (!KEY_RE.test(filter.key) || seen.has(filter.key) || filter.value.length > MAX_PANEL_FILTER_VALUE_LENGTH) {
      invalid("panelFilters");
    }
    seen.add(filter.key);
  }
}
