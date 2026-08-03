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
  /** The caller knows clustering has completed, even when it produced zero results. */
  allowEmpty?: boolean;
}

/**
 * Paint retained clusters into a geo-hubs panel that mounted after the news
 * load. An empty cluster set is intentionally a no-op: the normal clustering
 * pass will populate the panel when it completes.
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
  if (clusters.length === 0) {
    panel.setActivities([]);
    return;
  }
  const { getTopActiveHubs } = await import('@/services/tech-activity');
  panel.setActivities(getTopActiveHubs(clusters));
}
