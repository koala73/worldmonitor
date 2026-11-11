import { ConvexError, v, type Infer } from "convex/values";

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
});

export type TeamDashboardLayout = Infer<typeof teamDashboardLayoutValidator>;

const MAX_PANELS = 400;
const MAX_LAYERS = 200;
// Mirror src/utils/panel-grid.ts (MAX_PANEL_ROW_SPAN, MAX_PANEL_COL_SPAN).
const MAX_ROW_SPAN = 4;
const MAX_COL_SPAN = 3;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/;

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
  const map = layout.map;
  if (!map) return;
  if (!KEY_RE.test(map.view) || !KEY_RE.test(map.timeRange)) invalid("map.view");
  if (!Number.isFinite(map.zoom) || map.zoom < 0 || map.zoom > 24) invalid("map.zoom");
  if (!Number.isFinite(map.lat) || Math.abs(map.lat) > 90) invalid("map.lat");
  if (!Number.isFinite(map.lon) || Math.abs(map.lon) > 180) invalid("map.lon");
  if (map.layers.length > MAX_LAYERS || map.layers.some((layer) => !KEY_RE.test(layer))) invalid("map.layers");
}
