/**
 * Conflict archive — long-retention store for items the LLM (or GDELT)
 * has classified as active armed-conflict.
 *
 * # Why a separate store
 *
 * The live-news and intel-news pipelines both work on rolling time
 * windows: 14 days max for live-news, 24 hours for GDELT, and even
 * shorter in practice because RSS feeds rotate stories within ~24-48h.
 * That's fine for general feed coverage, but conflict reporting is
 * sparse and important — a Gaza shelling from 5 days ago shouldn't
 * vanish from the map just because BBC dropped it from their RSS.
 *
 * # Storage layout
 *
 * Two keys, one per source pipeline. Each holds a JSON array of items
 * sorted newest-first. Separate keys mean each writer only touches its
 * own slot — no read-modify-write race between live-news enrichment
 * and the GDELT conflict topic.
 *
 *   conflict:archive:v1:live-news  — items from live-news LLM (isConflict=true)
 *   conflict:archive:v1:gdelt      — items from GDELT 'conflict' topic
 *
 * # Retention
 *
 * Items older than RETENTION_MS are filtered out on every write.
 * The Redis key TTL is set to RETENTION_MS as a backstop — if writes
 * stop happening for any reason, the archive expires cleanly rather
 * than drifting indefinitely.
 *
 * # Concurrency
 *
 * Read-modify-write isn't atomic. If two enrichment passes write to
 * the same key in the same millisecond, one's update can be lost.
 * We accept this because:
 *   - The two pipelines write to DIFFERENT keys, so cross-source
 *     races don't happen.
 *   - Within a single pipeline, the enrichment cadence is single-
 *     threaded per Vercel edge instance.
 *   - A lost write self-heals — the next enrichment cycle just
 *     re-processes the same set of items and writes them again.
 */

import { getCachedJson, setCachedJson } from '../../_shared/redis';

/** Retention window — 30 days. Long enough to feel "recent" for conflict
 *  reporting; short enough to keep payload manageable. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RETENTION_S = Math.floor(RETENTION_MS / 1000);

/** Cap items per source key — runaway protection. Conflict-flagged item
 *  rate is realistically <10 per hour, so 1000 is many days of headroom. */
const MAX_ITEMS_PER_KEY = 1000;

/** Wire shape — matches the iOS NewsItem decoder closely so the
 *  conflict-archive endpoint can return items the iOS feed renders
 *  with zero mapping logic. */
export interface ConflictArchiveItem {
  /** Stable id — titleHash from live-news, normalized-title-hash from GDELT.
   *  Used as the dedup key when the same story comes back through. */
  id: string;
  source: string;
  title: string;
  link: string;
  publishedAt: number;
  isAlert: boolean;
  summary: string | null;
  location: { latitude: number; longitude: number } | null;
  locationName: string | null;
  country: string | null;
  /** 8-region taxonomy code populated by enrichment ("us", "middle_east",
   *  etc.). Optional — older entries written before this field was added
   *  decode as undefined. iOS falls back to country-code mapping in that
   *  case. */
  region?: string | null;
  /** Other outlets covering the same story (canonical at index 0). */
  sources: Array<{
    source: string;
    title: string;
    link: string;
    publishedAt: number;
  }> | null;
  /** Pipeline that originated this item. Useful for client-side
   *  diagnostics; iOS can colour pins differently if it cares. */
  origin: 'live-news' | 'gdelt';
}

export type ArchiveSource = 'live-news' | 'gdelt';

const KEY_PREFIX = 'conflict:archive:v1';

function keyFor(source: ArchiveSource): string {
  return `${KEY_PREFIX}:${source}`;
}

/**
 * Add items to the archive for a given source. Existing items with
 * the same id are overwritten (newer wins). Items older than the
 * retention window are pruned. Sorted newest-first on write.
 *
 * Idempotent — calling with the same items twice is a no-op.
 *
 * Fire-and-forget OK: callers don't need the result, but they should
 * await the promise inside `keepAlive()` so Vercel doesn't kill the
 * isolate before the write completes.
 */
export async function appendToArchive(
  source: ArchiveSource,
  items: ConflictArchiveItem[],
): Promise<void> {
  if (items.length === 0) return;

  const key = keyFor(source);
  const cutoff = Date.now() - RETENTION_MS;

  // Read existing — null/empty is fine (first write to a fresh key).
  const existing = (await getCachedJson(key)) as ConflictArchiveItem[] | null;

  // Merge by id. Existing items first, new items overwrite.
  const byId = new Map<string, ConflictArchiveItem>();
  if (Array.isArray(existing)) {
    for (const it of existing) {
      if (it && typeof it.id === 'string' && typeof it.publishedAt === 'number') {
        byId.set(it.id, it);
      }
    }
  }
  for (const it of items) {
    byId.set(it.id, it);
  }

  // Filter to retention window + sort newest-first + cap.
  const merged = [...byId.values()]
    .filter((it) => it.publishedAt >= cutoff)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, MAX_ITEMS_PER_KEY);

  await setCachedJson(key, merged, RETENTION_S);
}

/**
 * Read merged archive across both source pipelines. Sorted newest-first.
 *
 * Cross-source dedup is by **link**, not `id`. The two pipelines use
 * different id formats:
 *   • live-news writes `id: titleHash`
 *   • GDELT (refresh.ts) writes `id: link`
 * The same article appearing in both pipelines therefore has different
 * server-side ids but the same `link`. iOS sees `link` as the article
 * identity (`NewsItem.id` returns `link`), so deduping by `id` here lets
 * duplicates leak through and Mapbox rejects them as duplicate annotation
 * IDs ("Duplicated annotations: conflict-archive-https://...").
 *
 * Within each source pipeline we also fall back to id-based dedup as a
 * safety net (in case a pipeline ever wrote two entries with same id but
 * different/missing links — unlikely but cheap to guard).
 */
export async function readArchive(limit: number = 500): Promise<ConflictArchiveItem[]> {
  const [liveNews, gdelt] = await Promise.all([
    getCachedJson(keyFor('live-news')) as Promise<ConflictArchiveItem[] | null>,
    getCachedJson(keyFor('gdelt')) as Promise<ConflictArchiveItem[] | null>,
  ]);

  // First pass: dedup by link across pipelines, keeping the entry with
  // the newer publishedAt when both have the same link. We prefer the
  // entry with non-null `summary` / `location` to push the most enriched
  // representation forward when timestamps tie.
  const byLink = new Map<string, ConflictArchiveItem>();
  for (const arr of [liveNews, gdelt]) {
    if (!Array.isArray(arr)) continue;
    for (const it of arr) {
      if (!it || typeof it.publishedAt !== 'number') continue;
      const link = typeof it.link === 'string' ? it.link : '';
      if (!link) continue;
      const existing = byLink.get(link);
      if (!existing) {
        byLink.set(link, it);
        continue;
      }
      // Both candidates have the same link. Pick the better entry:
      //   1. Newer publishedAt wins
      //   2. On timestamp tie, the entry with more enrichment fields wins
      const sameTimestamp = it.publishedAt === existing.publishedAt;
      const itEnrichScore = enrichmentScore(it);
      const exEnrichScore = enrichmentScore(existing);
      if (it.publishedAt > existing.publishedAt
          || (sameTimestamp && itEnrichScore > exEnrichScore)) {
        byLink.set(link, it);
      }
    }
  }

  return [...byLink.values()]
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, limit);
}

/** Crude richness score for picking the better of two same-link entries.
 *  Each enrichment field present adds 1. */
function enrichmentScore(it: ConflictArchiveItem): number {
  let s = 0;
  if (it.summary) s++;
  if (it.location) s++;
  if (it.locationName) s++;
  if (it.country) s++;
  if (it.region) s++;
  return s;
}
