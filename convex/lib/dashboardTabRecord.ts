import { ConvexError, v, type Infer } from "convex/values";
import {
  DASHBOARD_KEY_RE,
  DASHBOARD_TAB_ID_PATTERN,
  DASHBOARD_TAB_NAME_MAX_LENGTH,
  MAX_DASHBOARD_PANELS,
  type DashboardTabRecord,
} from "../../shared/dashboard-tab-sync";
import { checkPanelFilters, checkScope } from "./teamDashboardLayout";

/**
 * The stored shape of one synced dashboard tab (convex/userPreferences.ts,
 * `syncDashboardTabs`). Shared by the schema and the mutation so the two
 * cannot drift. Panel display names, font scale and priority stay on the
 * device; map view and spans are global, not per tab.
 */
export const dashboardTabRecordValidator = v.object({
  name: v.string(),
  // Grid order. `bottom` marks panels docked in the bottom grid.
  panels: v.array(v.object({
    key: v.string(),
    on: v.boolean(),
    bottom: v.optional(v.boolean()),
  })),
  scope: v.optional(v.object({
    countries: v.array(v.string()),
    neighbours: v.optional(v.boolean()),
    start: v.optional(v.string()),
    end: v.optional(v.string()),
  })),
  panelFilters: v.optional(v.array(v.object({ key: v.string(), value: v.string() }))),
  // The team dashboard this tab was opened from or shared as.
  team: v.optional(v.object({ id: v.string(), version: v.number() })),
});

// Compile-time check that the validator and the shared contract agree.
type StoredRecord = Infer<typeof dashboardTabRecordValidator>;
const _contractMatches: DashboardTabRecord extends StoredRecord
  ? (StoredRecord extends DashboardTabRecord ? true : never)
  : never = true;
void _contractMatches;

const TAB_ID_RE = new RegExp(DASHBOARD_TAB_ID_PATTERN);
const MAX_TAB_ID_LENGTH = 64;
const MAX_TEAM_ID_LENGTH = 64;

function invalidTab(field: string): never {
  throw new ConvexError({ kind: "INVALID_TAB", field });
}

export function checkDashboardTabId(tabId: string): void {
  if (tabId.length > MAX_TAB_ID_LENGTH || !TAB_ID_RE.test(tabId)) invalidTab("tabId");
}

/** Bounds the validator cannot express. A record is stored verbatim, so anything out of bounds is refused. */
export function checkDashboardTabRecord(record: StoredRecord): void {
  const name = record.name.trim();
  if (name.length === 0 || name.length > DASHBOARD_TAB_NAME_MAX_LENGTH || name !== record.name) {
    invalidTab("name");
  }
  if (record.panels.length > MAX_DASHBOARD_PANELS) invalidTab("panels");
  const seen = new Set<string>();
  for (const panel of record.panels) {
    if (!DASHBOARD_KEY_RE.test(panel.key) || seen.has(panel.key)) invalidTab("panels.key");
    seen.add(panel.key);
  }
  if (record.scope) checkScope(record.scope);
  if (record.panelFilters) checkPanelFilters(record.panelFilters);
  if (record.team) {
    const { id, version } = record.team;
    if (id.length === 0 || id.length > MAX_TEAM_ID_LENGTH || !Number.isInteger(version) || version < 1) {
      invalidTab("team");
    }
  }
}
