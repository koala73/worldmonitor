/**
 * `GET /api/conflict-archive/v1/list` — handler core.
 *
 * Returns the merged conflict-flagged item set from both pipelines:
 *   • live-news items the LLM enrichment classified isConflict=true
 *   • GDELT 'conflict' topic articles
 *
 * Items are retained for 30 days regardless of whether they're still
 * in the upstream RSS / GDELT windows. Sorted newest-first.
 *
 * # Response shape
 *
 * Mirrors the live-news digest response so iOS can decode it with the
 * existing `NewsItem` model — minimal new model code on the client side.
 */

import { readArchive } from './_store';
import { cachedFetchJson } from '../../_shared/redis';

const TOP_LEVEL_TTL_S = 30; // 30 s — same urgency tier as live-news / intel-news

export interface ListConflictArchiveResponse {
  items: Array<{
    source: string;
    title: string;
    link: string;
    publishedAt: number;
    isAlert: boolean;
    summary: string | null;
    locationName: string | null;
    country: string | null;
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
    /** Pipeline of origin — clients can colour pins differently if useful. */
    origin: 'live-news' | 'gdelt';
  }>;
  generatedAt: string;
}

export async function listConflictArchive(): Promise<ListConflictArchiveResponse> {
  const cacheKey = 'conflict-archive:digest:v1';

  // Tiny top-level cache so concurrent client polls don't redundantly
  // hit Redis even though the underlying read is already cheap.
  const cached = await cachedFetchJson<ListConflictArchiveResponse>(
    cacheKey,
    TOP_LEVEL_TTL_S,
    async () => {
      const archived = await readArchive(500);

      const items = archived.map((it) => ({
        source: it.source,
        title: it.title,
        link: it.link,
        publishedAt: it.publishedAt,
        isAlert: it.isAlert,
        summary: it.summary,
        locationName: it.locationName,
        country: it.country,
        location: it.location,
        sources: it.sources,
        isConflict: true,
        origin: it.origin,
      }));

      console.log(`[conflict-archive] returning ${items.length} archived items`);

      return {
        items,
        generatedAt: new Date().toISOString(),
      };
    },
  );

  if (!cached) return { items: [], generatedAt: new Date().toISOString() };

  // Scrub outlet identity from the wire response. Archive store and digest
  // cache retain the real `source` for internal use.
  return {
    ...cached,
    items: cached.items.map((item) => ({
      ...item,
      source: '',
      sources: item.sources ? item.sources.map((s) => ({ ...s, source: '' })) : item.sources,
    })),
  };
}
