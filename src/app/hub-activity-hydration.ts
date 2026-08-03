import type { ClusteredEvent } from '@/types';
import { getTopActiveGeoHubs, type GeoHubActivity } from '@/services/geo-activity';
import type { TechHubActivity } from '@/services/tech-activity';

export interface GeoHubActivityPanel {
  setActivities(activities: GeoHubActivity[]): void;
}

export interface TechHubActivityPanel {
  setActivities(activities: TechHubActivity[]): void;
}

export interface HubActivityHydrationOptions {
  /**
   * A clustering pass has settled, so an empty cluster set is a real "no hubs"
   * answer rather than "not computed yet". Callers must derive this from
   * `AppContext.clustersSettled` (or pass `true` from inside a completed
   * clustering block) — NOT from `initialLoadComplete`, which flips before the
   * clustering pass starts and would paint an empty state mid-flight.
   */
  allowEmpty?: boolean;
}

/**
 * Monotonic ticket for tech-hub paints. Both callers (the lazy-mount backfill
 * and a clustering-completion repaint) cross the same `await import(...)`, so
 * without an explicit ticket the older call can resolve last and overwrite newer
 * activities. Last hydration issued wins.
 */
let techHydrationSeq = 0;

/**
 * Paint retained clusters into a geo-hubs panel that mounted after the news
 * load. Without `allowEmpty`, an empty cluster set is intentionally a no-op —
 * the panel keeps its loading skeleton and the clustering pass populates it on
 * completion. With `allowEmpty`, an empty set is painted as a real "no hubs".
 */
export function hydrateGeoHubPanelFromClusters(
  panel: GeoHubActivityPanel | undefined,
  clusters: ClusteredEvent[],
  options: HubActivityHydrationOptions = {},
): void {
  if (!panel || (clusters.length === 0 && !options.allowEmpty)) return;
  panel.setActivities(clusters.length === 0 ? [] : getTopActiveGeoHubs(clusters));
}

/**
 * Paint retained clusters into a tech-hubs panel without turning the tech-geo
 * lookup table into an eager dashboard dependency.
 */
export async function hydrateTechHubPanelFromClusters(
  panel: TechHubActivityPanel | undefined,
  clusters: ClusteredEvent[],
  options: HubActivityHydrationOptions = {},
): Promise<void> {
  if (!panel || (clusters.length === 0 && !options.allowEmpty)) return;
  const seq = ++techHydrationSeq;
  // Import on every path, empty included, so both outcomes reach setActivities()
  // through the same await and a newer paint can never be undone by an older one.
  const { getTopActiveHubs } = await import('@/services/tech-activity');
  if (seq !== techHydrationSeq) return;
  panel.setActivities(clusters.length === 0 ? [] : getTopActiveHubs(clusters));
}
