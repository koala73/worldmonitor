/**
 * Conflict-archive v2 refresh — pulls conflict-tagged stories from the
 * World News API and writes them into a dedicated archive Redis key.
 *
 * # Why a separate v2 store
 *
 * v1 has two keys (`conflict:archive:v1:live-news` and
 * `conflict:archive:v1:gdelt`) which the legacy v1 list endpoint merges.
 * v2 lives in its own key (`conflict:archive:wn:v1`) so the cron, the
 * read endpoint, and the iOS TestFlight build form one isolated slice
 * we can validate without contaminating legacy data.
 *
 * # Pipeline
 *
 *   1. search-news with a tight conflict text query. ~50 articles per
 *      call, sorted newest-first.
 *   2. Map each article → ConflictArchiveItem with `origin = 'worldnews'`.
 *      Enrichment fields (summary, location, lat, lng, country) start
 *      null — the existing intel-news enrichment cron fills them.
 *   3. Merge into the existing archive (idempotent by id) — preserve
 *      enrichment from previous runs.
 *   4. Prune past the 30-day retention window. Cap at MAX_ITEMS.
 *
 * The enrichment cron (`/api/intel-news/v1/enrich`) treats this new key
 * as another conflict bucket — see the bucket extension in enrich.ts.
 * That gives us lat/lng for the iOS map without writing a parallel
 * enrichment pipeline.
 */

import { searchNews, deriveSource, parsePublishDate, type WorldNewsArticle } from '../../_shared/worldnews-client';
import { getCachedJson, setCachedJson } from '../../_shared/redis';
import type { ConflictArchiveItem } from '../v1/_store';

/** Single key — the v2 store lives outside the v1 prefix on purpose. */
export const ARCHIVE_WN_KEY = 'conflict:archive:wn:v1';

const RETENTION_MS = 3 * 24 * 60 * 60 * 1000; // 3-day project max
const RETENTION_S = Math.floor(RETENTION_MS / 1000);
const MAX_ITEMS = 2000;
const QUERY_NUMBER = 100;         // 1 + 100 × 0.01 = 2.0 pts per call (max page size)

/** Conflict-detecting query — broad enough to cast a wide net, specific
 *  enough that the post-fetch LLM enrichment confirms the isConflict
 *  flag without too much wasted classification cost. Bare-word terms
 *  ("strike", "attack") are intentionally omitted — they drift into
 *  labor/financial/sports headlines. */
const CONFLICT_TEXT_QUERY =
  '"airstrike" OR "missile strike" OR shelling OR "armed clash" OR ' +
  '"ground assault" OR "drone strike" OR "armed conflict" OR ' +
  'bombardment OR "rocket attack" OR "ceasefire" OR "war crime" OR ' +
  '"military offensive" OR "shells fired" OR insurgents';

/**
 * The v2 item is structurally identical to v1's `ConflictArchiveItem`
 * but with an extended `origin` union so iOS / the enrichment cron can
 * tell it apart from the legacy live-news / gdelt entries.
 */
export type ConflictArchiveItemV2 = Omit<ConflictArchiveItem, 'origin'> & {
  origin: 'worldnews' | 'live-news' | 'gdelt';
};

export interface RefreshResult {
  status: 'ok' | 'skipped';
  fetched: number;
  totalAfter: number;
  dropped: number;
  generatedAt: string;
}

/**
 * Map one upstream article into a partial archive item. Enrichment
 * fields (summary, location, lat, lng, country, locationName, region)
 * are left null/undefined — the existing intel-news enrich cron fills
 * them on its next pass.
 *
 * Returns null when essential fields are missing — better to drop the
 * entry than ship a broken row to iOS.
 */
function articleToItem(a: WorldNewsArticle): ConflictArchiveItemV2 | null {
  const source = deriveSource(a.url);
  const publishedAt = parsePublishDate(a.publish_date);
  if (!source || !a.title || !a.url || publishedAt === null) return null;
  return {
    id: `wn-${a.id}`,
    source,
    title: a.title,
    link: a.url,
    publishedAt,
    isAlert: false,
    summary: a.summary?.trim() || null,
    location: null,
    locationName: null,
    country: null,
    region: null,
    sources: null,
    origin: 'worldnews',
  };
}

/**
 * Idempotent merge — preserve enrichment fields from any item already
 * present at the same id. Sort newest-first. Drop stale. Cap.
 */
function mergeArchive(
  existing: ConflictArchiveItemV2[],
  fresh: ConflictArchiveItemV2[],
): ConflictArchiveItemV2[] {
  const byId = new Map<string, ConflictArchiveItemV2>();
  for (const item of existing) {
    if (item?.id) byId.set(item.id, item);
  }
  for (const next of fresh) {
    const prev = byId.get(next.id);
    if (!prev) {
      byId.set(next.id, next);
      continue;
    }
    byId.set(next.id, {
      ...next,
      // Preserve everything the enrichment cron has written.
      // EXCEPT `summary` — license terms only let us re-publish the
      // upstream API's own summary, so we always take the latest
      // fetched value and never preserve a prior (potentially LLM-
      // generated) one.
      summary: next.summary,
      location: prev.location ?? next.location,
      locationName: prev.locationName ?? next.locationName,
      country: prev.country ?? next.country,
      region: prev.region ?? next.region,
      sources: prev.sources ?? next.sources,
    });
  }
  const cutoff = Date.now() - RETENTION_MS;
  return Array.from(byId.values())
    .filter((it) => typeof it.publishedAt === 'number' && it.publishedAt >= cutoff)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, MAX_ITEMS);
}

export async function refreshConflictArchiveV2(): Promise<RefreshResult> {
  const startedAt = Date.now();

  // Last 24 h cap — keeps the call cheap and limits the noise from
  // older republished pieces. The accumulator's 30-day retention is
  // what gives us the long-tail recall.
  const earliest = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19);

  const upstream = await searchNews({
    text: CONFLICT_TEXT_QUERY,
    language: 'en',
    earliestPublishDate: earliest,
    sort: 'publish-time',
    sortDirection: 'DESC',
    number: QUERY_NUMBER,
  });

  if (!upstream) {
    return {
      status: 'skipped',
      fetched: 0,
      totalAfter: 0,
      dropped: 0,
      generatedAt: new Date().toISOString(),
    };
  }

  const fresh: ConflictArchiveItemV2[] = [];
  let dropped = 0;
  for (const a of upstream.news ?? []) {
    const item = articleToItem(a);
    if (item) fresh.push(item);
    else dropped++;
  }

  const existing = ((await getCachedJson(ARCHIVE_WN_KEY)) as ConflictArchiveItemV2[] | null) ?? [];
  const merged = mergeArchive(existing, fresh);
  await setCachedJson(ARCHIVE_WN_KEY, merged, RETENTION_S);

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[conflict-archive:v2:refresh] fetched=${fresh.length} ` +
    `existed=${existing.length} after=${merged.length} ` +
    `dropped=${dropped} in ${elapsedMs}ms`,
  );

  return {
    status: 'ok',
    fetched: fresh.length,
    totalAfter: merged.length,
    dropped,
    generatedAt: new Date().toISOString(),
  };
}
