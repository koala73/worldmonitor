/**
 * `GET /api/conflict-archive/v4/list` — handler core.
 *
 * Reads the Newscatcher conflict archive at `conflict:archive:nc:v1`.
 * Wire-compatible with v2 / v3; real source + link (licensed feed).
 */

import { cachedFetchJson, getCachedJson } from '../../_shared/redis';
import type { ConflictArchiveItemV4 } from './refresh';
import { ARCHIVE_NC_KEY } from './refresh';

const DIGEST_KEY = 'conflict-archive:nc:v1:digest';
const TOP_LEVEL_TTL_S = 30;

export interface ListConflictArchiveV4Response {
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
    isConflict: boolean;
    origin: 'newscatcher' | 'webz' | 'worldnews' | 'live-news' | 'gdelt';
  }>;
  generatedAt: string;
}

export async function listConflictArchiveV4(): Promise<ListConflictArchiveV4Response> {
  const cached = await cachedFetchJson<ListConflictArchiveV4Response>(
    DIGEST_KEY,
    TOP_LEVEL_TTL_S,
    async () => {
      const archived = ((await getCachedJson(ARCHIVE_NC_KEY)) as ConflictArchiveItemV4[] | null) ?? [];

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

      console.log(`[conflict-archive:v4] returning ${items.length} archived items`);

      return {
        items,
        generatedAt: new Date().toISOString(),
      };
    },
  );

  return cached ?? { items: [], generatedAt: new Date().toISOString() };
}
