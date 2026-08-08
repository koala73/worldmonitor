/**
 * Dashboard-sized projection of the thermal-escalation watch (#5300).
 *
 * The canonical `thermal:escalation:v1` payload carries every cluster the
 * detector produced (~117, and every one of them rides in the bootstrap slow
 * tier that EVERY client downloads on EVERY boot). The dashboard renders 12:
 * `fetchThermalEscalations(maxItems = 12)` slices the array and recomputes its
 * summary from that slice, so clusters past the cap are downloaded and thrown
 * away — ~2.9 GB/day of Redis egress for bytes no UI ever shows.
 *
 * `computeThermalEscalationWatch` already ranks clusters (strategic relevance →
 * severity → total FRP → observation count), so the client's `slice(0, 12)` is a
 * top-12-by-rank. Capping the published array to the same ranked prefix is
 * therefore byte-for-byte behaviour-preserving for every current consumer.
 *
 * The cap sits above the client's render limit so a caller may raise `maxItems`
 * a little without silently losing clusters; `thermal-dashboard-cap.test.mjs`
 * pins the client default below it so the two can never drift into silent
 * truncation.
 *
 * `summary` is deliberately left as computed over the FULL cluster set: it
 * describes the world, not the page, and the hydrated client recomputes its own
 * summary from the slice anyway. `totalClusters` records the pre-cap count so no
 * consumer mistakes a capped array for the whole picture.
 *
 * NOTE: this file must not import anything outside `scripts/` — Railway builds
 * the seeders from a scripts-only Nixpacks root, and a `../api/` import crashes
 * the container at startup (#5268).
 */

export const THERMAL_DASHBOARD_CLUSTER_LIMIT = 24;

export function compactThermalDashboardPayload(value, limit = THERMAL_DASHBOARD_CLUSTER_LIMIT) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.clusters)) return value;
  if (value.clusters.length <= limit) return value;

  return {
    ...value,
    clusters: value.clusters.slice(0, limit),
    totalClusters: value.clusters.length,
  };
}
