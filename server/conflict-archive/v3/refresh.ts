/**
 * Conflict-archive v3 refresh — Webz.io conflict-tagged seed.
 *
 * # Why a separate v3 store
 *
 * Same pattern as v2 (worldnewsapi): the live-news cron writes broad
 * content, the enrichment cron tags conflict items via the LLM and
 * organically copies them into this archive. This file exists as the
 * one-shot manual bootstrap so the iOS map isn't empty on day one —
 * after that, the archive grows organically.
 *
 * # Pipeline
 *
 *   1. searchNews with a tight conflict query. ~10 posts per call
 *      (Webz Lite tier cap).
 *   2. Map each post → ConflictArchiveItemV3 with `origin: 'webz'`.
 *      Enrichment fields (location, lat/lng, locationName) start null —
 *      filled by the location-only LLM path in the enrichment cron.
 *   3. Merge into the existing archive idempotently by uuid; preserve
 *      enrichment from prior runs.
 *   4. Prune past the 30-day retention window. Cap.
 */

import { searchNews, deriveSource, parsePublishDate, deriveSummary, type WebzPost } from '../../_shared/webz-client';
import { getCachedJson, setCachedJson } from '../../_shared/redis';
import type { ConflictArchiveItem } from '../v1/_store';

/** Single key — v3 archive lives in its own namespace. */
export const ARCHIVE_WEBZ_KEY = 'conflict:archive:webz:v1';

const RETENTION_MS = 3 * 24 * 60 * 60 * 1000; // 3-day project max
const RETENTION_S = Math.floor(RETENTION_MS / 1000);
const MAX_ITEMS = 2000;

/** Lucene-style conflict query — same intent as the worldnews v2 seed,
 *  translated to Webz's syntax. */
const CONFLICT_QUERY =
  '(airstrike OR "missile strike" OR shelling OR "armed clash" OR ' +
  '"ground assault" OR "drone strike" OR "armed conflict" OR ' +
  'bombardment OR "rocket attack" OR "war crime" OR ' +
  '"military offensive" OR "shells fired" OR insurgents) ' +
  'language:english';

/**
 * Structurally identical to v1/v2 `ConflictArchiveItem` but with the
 * `origin` union widened to include `'webz'`.
 */
export type ConflictArchiveItemV3 = Omit<ConflictArchiveItem, 'origin'> & {
  origin: 'webz' | 'worldnews' | 'live-news' | 'gdelt';
};

export interface RefreshResult {
  status: 'ok' | 'skipped';
  fetched: number;
  totalAfter: number;
  dropped: number;
  generatedAt: string;
}

function postToItem(p: WebzPost): ConflictArchiveItemV3 | null {
  const source = deriveSource(p);
  const publishedAt = parsePublishDate(p.published);
  if (!source || !p.title || !p.url || publishedAt === null) return null;

  // Use first webz-supplied named location as the initial label so iOS
  // map rows have something useful even before LLM enrichment lands.
  const firstLoc = p.entities?.locations?.[0]?.name?.trim();
  const initialLocationName = firstLoc && firstLoc.length > 0 ? firstLoc : null;

  return {
    id: `webz-${p.uuid}`,
    source,
    title: p.title,
    link: p.url,
    publishedAt,
    isAlert: !!p.breaking,
    summary: deriveSummary(p),
    location: null,
    locationName: initialLocationName,
    country: null,
    region: null,
    sources: null,
    origin: 'webz',
  };
}

function mergeArchive(
  existing: ConflictArchiveItemV3[],
  fresh: ConflictArchiveItemV3[],
): ConflictArchiveItemV3[] {
  const byId = new Map<string, ConflictArchiveItemV3>();
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
      // `summary` always tracks the upstream — license terms only allow
      // re-publishing Webz's own content, never a prior LLM rewrite.
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

export async function refreshConflictArchiveV3(): Promise<RefreshResult> {
  const startedAt = Date.now();

  const resp = await searchNews({ q: CONFLICT_QUERY });
  if (!resp) {
    return {
      status: 'skipped',
      fetched: 0,
      totalAfter: 0,
      dropped: 0,
      generatedAt: new Date().toISOString(),
    };
  }

  const fresh: ConflictArchiveItemV3[] = [];
  let dropped = 0;
  for (const p of resp.posts ?? []) {
    const item = postToItem(p);
    if (item) fresh.push(item);
    else dropped++;
  }

  const existing = ((await getCachedJson(ARCHIVE_WEBZ_KEY)) as ConflictArchiveItemV3[] | null) ?? [];
  const merged = mergeArchive(existing, fresh);
  await setCachedJson(ARCHIVE_WEBZ_KEY, merged, RETENTION_S);

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[conflict-archive:v3:refresh] posts=${resp.posts?.length ?? 0} ` +
    `existed=${existing.length} after=${merged.length} dropped=${dropped} ` +
    `requestsLeft=${resp.requestsLeft} in ${elapsedMs}ms`,
  );

  return {
    status: 'ok',
    fetched: fresh.length,
    totalAfter: merged.length,
    dropped,
    generatedAt: new Date().toISOString(),
  };
}
