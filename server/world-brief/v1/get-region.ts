/**
 * Read side of the regional briefs feature — serves a single per-region brief
 * to the iOS "My Briefs" feature.
 *
 * The dispatcher cron (`api/world-brief/v1/refresh-regions`) writes each
 * region's brief to `news:world-brief:region:<id>:v1`. This reader returns one
 * such payload on demand. The payload shape is the SAME `WorldBriefPayload`
 * the global brief uses (conflict + liveNews + per-category sections), so iOS
 * decodes it with the existing model and the app picks the requested category
 * section client-side (the region × category "cell").
 *
 * Three outcomes, kept distinct so the HTTP layer can honour the
 * never-cache-empty rule (read-fail → 503, empty → no-store, populated → long):
 *   • ok          — key present and decoded
 *   • empty       — genuine key miss (region not generated yet this cycle)
 *   • unavailable — Redis read failed (timeout / network / non-2xx)
 */

import { getCachedJson } from '../../_shared/redis';
import { REGION_IDS, type RegionId } from '../../_shared/geo-regions';
import {
  regionBriefKey,
  regionBriefIndexKey,
  regionBriefSnapshotKey,
  hourBucketToMs,
  type WorldBriefPayload,
} from './_generate';

/** Narrow an arbitrary string to a known region id (query-param validation). */
export function isRegionId(id: string | null | undefined): id is RegionId {
  return !!id && (REGION_IDS as readonly string[]).includes(id);
}

export type RegionBriefResult =
  | { status: 'ok'; payload: WorldBriefPayload }
  | { status: 'empty' }
  | { status: 'unavailable' };

/**
 * Read one region's brief. Uses the redis `strict` flag so an operational
 * failure is reported as `unavailable` rather than masquerading as an
 * empty/not-yet-generated brief — the latter must never be long-cached.
 */
export async function getRegionBrief(regionId: RegionId): Promise<RegionBriefResult> {
  try {
    const payload = (await getCachedJson(
      regionBriefKey(regionId),
      false,
      undefined, // default op timeout
      true, // strict — throw on operational failure, null only on genuine miss
    )) as WorldBriefPayload | null;

    if (!payload) return { status: 'empty' };
    return { status: 'ok', payload };
  } catch (err) {
    console.error(
      `[world-brief:get-region:${regionId}] read failed:`,
      err instanceof Error ? err.message : err,
    );
    return { status: 'unavailable' };
  }
}

/**
 * Read the region brief snapshot for a specific time (a user's delivery hour).
 * Resolution: the latest snapshot at/​before `atMs` (nearest-before); if none
 * exists at/before it, the closest available snapshot overall. Falls back to
 * the latest brief when there's no snapshot index yet or the chosen snapshot
 * has expired.
 */
export async function getRegionBriefAt(regionId: RegionId, atMs: number): Promise<RegionBriefResult> {
  try {
    const index = (await getCachedJson(
      regionBriefIndexKey(regionId),
      false,
      undefined,
      true,
    )) as string[] | null;
    const buckets = Array.isArray(index) ? index : [];
    if (buckets.length === 0) return getRegionBrief(regionId); // no snapshots yet → latest

    // Nearest-before: largest bucket with time ≤ atMs.
    let chosen: string | null = null;
    let bestBeforeMs = -Infinity;
    for (const b of buckets) {
      const t = hourBucketToMs(b);
      if (t <= atMs && t > bestBeforeMs) {
        bestBeforeMs = t;
        chosen = b;
      }
    }
    // Fallback: nothing at/before the delivery time → closest available overall.
    if (!chosen) {
      let bestDist = Infinity;
      for (const b of buckets) {
        const dist = Math.abs(hourBucketToMs(b) - atMs);
        if (dist < bestDist) {
          bestDist = dist;
          chosen = b;
        }
      }
    }
    if (!chosen) return getRegionBrief(regionId);

    const payload = (await getCachedJson(
      regionBriefSnapshotKey(regionId, chosen),
      false,
      undefined,
      true,
    )) as WorldBriefPayload | null;
    if (!payload) return getRegionBrief(regionId); // snapshot expired between index read and GET
    return { status: 'ok', payload };
  } catch (err) {
    console.error(
      `[world-brief:get-region:${regionId}:at=${atMs}] read failed:`,
      err instanceof Error ? err.message : err,
    );
    return { status: 'unavailable' };
  }
}
