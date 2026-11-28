/**
 * The watched site a looked-up point falls on, and that site's public record.
 *
 * The point is matched to the registry in the browser, on the same 0.01-degree
 * cell the registry merges its entries by (and shared links round to). Only the
 * site's registry id is then sent to WorldMonitor, never the point (KTD16).
 */
import type { GeoPoint } from '../../../shared/orbital/pass-geometry.js';
import type { WatchedSite } from '../../../shared/watched-sites';
import type { GetWatchedSiteImageryResponse } from '@/generated/client/worldmonitor/orbital/v1/service_client';
import { OrbitalServiceClient } from '@/services/generated-rpc-clients';
import { createLazyClient, getRpcBaseUrl } from '@/services/rpc-client';

const getOrbitalClient = createLazyClient(() => new OrbitalServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) }));

let sitesByCell: Promise<{ cells: Map<string, WatchedSite>; cellKey: (lat: number, lon: number) => string }> | null = null;

/** The watched site whose 0.01-degree cell holds the point, or null. */
export function watchedSiteAt(point: GeoPoint): Promise<WatchedSite | null> {
  sitesByCell ??= import('../../../shared/watched-sites').then(({ composeWatchedSites, watchedSiteCellKey }) => {
    const cells = new Map<string, WatchedSite>();
    for (const site of composeWatchedSites()) cells.set(watchedSiteCellKey(site.lat, site.lon), site);
    return { cells, cellKey: watchedSiteCellKey };
  });
  sitesByCell.catch(() => { sitesByCell = null; });
  return sitesByCell.then(({ cells, cellKey }) => cells.get(cellKey(point.lat, point.lon)) ?? null);
}

/** The site's seeded public record, read by its registry id. */
export function loadWatchedSiteRecord(siteId: string, signal?: AbortSignal): Promise<GetWatchedSiteImageryResponse> {
  return getOrbitalClient().getWatchedSiteImagery({ siteId }, { signal });
}
