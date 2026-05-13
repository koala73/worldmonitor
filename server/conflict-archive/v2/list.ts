/**
 * `GET /api/conflict-archive/v2/list` — handler core.
 *
 * Reads the World News archive at `conflict:archive:wn:v1` (written by
 * the v2 refresh cron). Wire-compatible with v1's response shape so the
 * iOS NewsItem decoder works against both. Unlike v1, v2 ships real
 * `source` and `link` values — the upstream is a paid licensed feed.
 *
 * # Caching
 *
 *   Top-level digest:  conflict-archive:wn:v1:digest (30 s)
 *   Source store:      conflict:archive:wn:v1        (written by cron)
 */

import { cachedFetchJson, getCachedJson } from '../../_shared/redis';
import type { ConflictArchiveItemV2 } from './refresh';
import { ARCHIVE_WN_KEY } from './refresh';

const DIGEST_KEY = 'conflict-archive:wn:v1:digest';
const TOP_LEVEL_TTL_S = 30;

export interface ListConflictArchiveV2Response {
  items: Array<{
    source: string;
    title: string;
    link: string;
    publishedAt: number;
    isAlert: boolean;
    summary: string | null;
    locationName: string | null;
    country: string | null;
    region?: string | null;
    location: { latitude: number; longitude: number } | null;
    sources: Array<{
      source: string;
      title: string;
      link: string;
      publishedAt: number;
    }> | null;
    /** Always true on this endpoint — exposed so the iOS NewsItem decoder
     *  picks up the same field name it gets from live-news. */
    isConflict: boolean;
    /** Pipeline of origin — `worldnews` for everything from v2. */
    origin: 'worldnews' | 'live-news' | 'gdelt';
  }>;
  generatedAt: string;
}

export async function listConflictArchiveV2(): Promise<ListConflictArchiveV2Response> {
  const cached = await cachedFetchJson<ListConflictArchiveV2Response>(
    DIGEST_KEY,
    TOP_LEVEL_TTL_S,
    async () => {
      const archived = ((await getCachedJson(ARCHIVE_WN_KEY)) as ConflictArchiveItemV2[] | null) ?? [];

      const items = archived.map((it) => ({
        source: it.source,
        title: it.title,
        link: it.link,
        publishedAt: it.publishedAt,
        isAlert: it.isAlert,
        summary: it.summary,
        locationName: it.locationName,
        country: it.country,
        region: it.region ?? null,
        location: it.location,
        sources: it.sources,
        isConflict: true,
        origin: it.origin,
      }));

      console.log(`[conflict-archive:v2] returning ${items.length} archived items`);

      return {
        items,
        generatedAt: new Date().toISOString(),
      };
    },
  );

  return cached ?? { items: [], generatedAt: new Date().toISOString() };
}
