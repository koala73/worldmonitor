/**
 * `GET /api/conflict-archive/v5/list` — handler core for the
 * RSS-embedding conflict feed.
 *
 * Reads `conflict:archive:rse:v1` — conflict clusters from the v6
 * RSS-embedding pipeline (the enrich cron copies isConflict clusters
 * here). GDELT corroboration is already baked INTO these clusters'
 * `sources[]` — GDELT is a clustering signal now, not a standalone
 * archive, so we no longer merge `conflict:archive:v1:gdelt` (that key
 * still exists for the legacy v1-v4 conflict readers).
 *
 * Visibility gate: a cluster is shown only when it has ≥ `WM_V6_MIN_SOURCES`
 * distinct **RSS** publishers. GDELT sources never count toward the
 * gate — same rule as the live-news feed. Conflict events therefore
 * never surface on GDELT corroboration alone.
 */

import { cachedFetchJson, getCachedJson } from '../../_shared/redis';
import type { ConflictArchiveItem } from '../v1/_store';

const DIGEST_KEY = 'conflict-archive:v5:digest';
const TOP_LEVEL_TTL_S = 30;

const RSE_KEY = 'conflict:archive:rse:v1';

/** Minimum distinct RSS publishers for a conflict cluster to be shown.
 *  Mirrors the live-news gate; override via `WM_V6_MIN_SOURCES`. */
const DEFAULT_MIN_SOURCES = 3;
function minSources(): number {
  const raw = process.env.WM_V6_MIN_SOURCES;
  if (!raw) return DEFAULT_MIN_SOURCES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MIN_SOURCES;
}

/** Distinct RSS publishers in a cluster's sources[]. A source counts as
 *  RSS unless explicitly tagged `origin: 'gdelt'` — so legacy items
 *  (sources without an `origin` field) are treated as RSS, which is
 *  correct since they predate the GDELT corroboration layer. */
function rssSourceCount(item: ConflictArchiveItem): number {
  return (item.sources ?? []).filter((s) => s.origin !== 'gdelt').length;
}

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
      // 5 s read timeout (vs the 1.5 s user-facing default): the archive is a
      // multi-MB compressed blob (rich sources[] per item) and a timed-out
      // read here returns an empty feed to the user. This is a cache-miss
      // path behind a 30 s wrapper cache, so the longer wait only hits once
      // per cache window, not per request.
      const rse = (await getCachedJson(RSE_KEY, false, 5_000)) as ConflictArchiveItem[] | null;

      const merged = new Map<string, ConflictArchiveItem>();
      // Dedup by article link — the stable cross-refresh identifier.
      for (const it of rse ?? []) {
        if (!it?.link) continue;
        merged.set(it.link, it);
      }

      // Visibility gate: ≥ minSources distinct RSS publishers. GDELT
      // corroboration in sources[] never counts toward this.
      const min = minSources();
      const items = Array.from(merged.values())
        .filter((it) => min <= 1 || rssSourceCount(it) >= min)
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
        `[conflict-archive:v5] rse=${rse?.length ?? 0} → ${items.length} ` +
        `visible (min-rss-sources=${min})`,
      );

      return { items, generatedAt: new Date().toISOString() };
    },
  );

  return cached ?? { items: [], generatedAt: new Date().toISOString() };
}
