/**
 * `GET /api/conflict-archive/v5/list` — handler core for the
 * RSS-embedding conflict feed.
 *
 * Reads from TWO sources and merges them:
 *
 *   1. `conflict:archive:rse:v1` — items the v6 live-news pipeline
 *      flagged isConflict (RSS-clustered, no LLM summary; the
 *      `summary` field is the longest plaintext RSS description).
 *
 *   2. `conflict:archive:v1:gdelt` — legacy GDELT-fed conflict items,
 *      kept as-is per product spec. These DO carry LLM-generated
 *      summaries — they're already in the archive from prior runs
 *      and we don't strip them.
 *
 * iOS receives a single deduplicated array (by article link) sorted
 * newest-first. Both sources expose lat/lng so all items can pin on
 * the map.
 */

import { cachedFetchJson, getCachedJson } from '../../_shared/redis';
import type { ConflictArchiveItem } from '../v1/_store';

const DIGEST_KEY = 'conflict-archive:v5:digest';
const TOP_LEVEL_TTL_S = 30;

const RSE_KEY = 'conflict:archive:rse:v1';
const GDELT_KEY = 'conflict:archive:v1:gdelt';

export interface ListConflictArchiveV5Response {
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
    imageUrl?: string | null;
    isConflict: boolean;
    origin: ConflictArchiveItem['origin'];
  }>;
  generatedAt: string;
}

export async function listConflictArchiveV5(): Promise<ListConflictArchiveV5Response> {
  const cached = await cachedFetchJson<ListConflictArchiveV5Response>(
    DIGEST_KEY,
    TOP_LEVEL_TTL_S,
    async () => {
      const [rse, gdelt] = await Promise.all([
        getCachedJson(RSE_KEY) as Promise<ConflictArchiveItem[] | null>,
        getCachedJson(GDELT_KEY) as Promise<ConflictArchiveItem[] | null>,
      ]);

      const merged = new Map<string, ConflictArchiveItem>();

      // Insert GDELT first; RSE entries overwrite on link collision so
      // the RSS-clustered version (which has richer sources[]) wins.
      // Dedup key is the article link — the most stable identifier
      // across pipelines.
      const upsert = (it: ConflictArchiveItem) => {
        if (!it?.link) return;
        merged.set(it.link, it);
      };
      for (const it of gdelt ?? []) upsert(it);
      for (const it of rse ?? []) upsert(it);

      const items = Array.from(merged.values())
        .sort((a, b) => b.publishedAt - a.publishedAt)
        .map((it) => ({
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
          // imageUrl is RSE-only (GDELT items don't ship one) — pass
          // through whatever the bucket wrote, or null.
          imageUrl: (it as { imageUrl?: string | null }).imageUrl ?? null,
          isConflict: true,
          origin: it.origin,
        }));

      console.log(
        `[conflict-archive:v5] merged rse=${rse?.length ?? 0} gdelt=${gdelt?.length ?? 0} ` +
        `→ ${items.length} unique items`,
      );

      return { items, generatedAt: new Date().toISOString() };
    },
  );

  return cached ?? { items: [], generatedAt: new Date().toISOString() };
}
