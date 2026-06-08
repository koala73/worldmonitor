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
import { feedMaxItemsForVersion } from '../../_shared/feed-limits';

const DIGEST_KEY = 'conflict-archive:v5:digest';
const TOP_LEVEL_TTL_S = 30;

const RSE_KEY = 'conflict:archive:rse:v1';

/** Conflict visibility gate: a cluster is shown when it has ≥ MIN_RSS distinct
 *  RSS publishers AND ≥ MIN_TOTAL total sources (RSS + GDELT corroboration).
 *
 *  Default is ≥1 RSS, ≥1 total — i.e. a trusted RSS anchor is the only
 *  requirement; GDELT corroboration is no longer needed to surface a conflict
 *  story. Requiring ≥1 RSS still guarantees a trusted anchor (no GDELT-only
 *  stories). This is volume-first; the feed shows the RSS lede (never an AI
 *  summary) so a lone-RSS conflict story is safe to surface. Raise
 *  WM_CONFLICT_MIN_TOTAL_SOURCES (e.g. to 3) to re-require corroboration.
 *  Both env-tunable. */
const DEFAULT_MIN_RSS = 1;
const DEFAULT_MIN_TOTAL = 1;
function conflictGate(): { minRss: number; minTotal: number } {
  const r = Number(process.env.WM_CONFLICT_MIN_RSS_SOURCES);
  const t = Number(process.env.WM_CONFLICT_MIN_TOTAL_SOURCES);
  return {
    minRss: Number.isFinite(r) && r >= 0 ? Math.floor(r) : DEFAULT_MIN_RSS,
    minTotal: Number.isFinite(t) && t >= 1 ? Math.floor(t) : DEFAULT_MIN_TOTAL,
  };
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

export async function listConflictArchiveV5(av?: string | null): Promise<ListConflictArchiveV5Response> {
  const cached = await cachedFetchJson<ListConflictArchiveV5Response>(
    DIGEST_KEY,
    TOP_LEVEL_TTL_S,
    async () => {
      // 5 s read timeout (vs the 1.5 s user-facing default): the archive is a
      // multi-MB compressed blob (rich sources[] per item) and a timed-out
      // read here returns an empty feed to the user. This is a cache-miss
      // path behind a 30 s wrapper cache, so the longer wait only hits once
      // per cache window, not per request.
      //
      // strict=true: a read FAILURE throws rather than returning null. Without
      // this, a timeout would yield items:[] which cachedFetchJson then CACHES
      // in Redis for 30 s — poisoning the feed for every reader in the window.
      // On a throw, cachedFetchJson does not cache and the error propagates to
      // the handler, which returns 503 so stale-if-error serves the last good
      // feed. A genuine key-miss still returns null (handled as empty below).
      const rse = (await getCachedJson(RSE_KEY, false, 5_000, true)) as ConflictArchiveItem[] | null;

      const merged = new Map<string, ConflictArchiveItem>();
      // Dedup by article link — the stable cross-refresh identifier.
      for (const it of rse ?? []) {
        if (!it?.link) continue;
        merged.set(it.link, it);
      }

      // Visibility gate: ≥1 RSS anchor AND ≥3 total sources (GDELT counts
      // toward the total but not the RSS floor).
      // NOTE: the per-version cap is applied AFTER this cached builder, not
      // here — otherwise the first app version to warm this shared cache would
      // bake its cap into the blob for every other version. We cache the full
      // visible list and slice it per `av` on the way out.
      const { minRss, minTotal } = conflictGate();
      const items = Array.from(merged.values())
        .filter((it) => rssSourceCount(it) >= minRss && (it.sources?.length ?? 0) >= minTotal)
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
        `visible (min-rss=${minRss} min-total=${minTotal})`,
      );

      return { items, generatedAt: new Date().toISOString() };
    },
  );

  const full = cached ?? { items: [], generatedAt: new Date().toISOString() };
  // Per-app-version cap, applied after the shared cache read (see note above).
  const cap = feedMaxItemsForVersion(av);
  if (!Number.isFinite(cap)) return full;
  return { ...full, items: full.items.slice(0, cap) };
}
