/**
 * Region-major brief dispatcher. One hourly cron hits the route, which calls
 * `refreshDueRegions(currentUtcHour)` — (re)generating the briefs for whichever
 * regions are scheduled for that hour. Each region's brief is written to its
 * own Redis key (see `regionBriefKey`).
 */

import { REGION_IDS, type RegionId } from '../../_shared/geo-regions';
import { refreshRegionalBrief, type RefreshWorldBriefResult } from './_generate';

/**
 * Per-region dispatch schedule — the UTC hours at which each region's brief is
 * (re)generated. Two slots each, ≈ 9AM and 6PM the region's local time,
 * de-clustered so no single hour dispatches more than 3 regions (~60s each →
 * well under the route's 300s budget). Tweak freely; the dispatcher just reads
 * this table.
 */
export const REGION_SCHEDULE: Record<RegionId, number[]> = {
  east_asia: [1, 10],
  southeast_asia: [2, 11],
  south_asia: [3, 12],
  central_asia: [4, 13],
  iran: [5, 14],
  ukraine_russia: [6, 15],
  levant: [6, 15],
  arabian_peninsula: [7, 16],
  africa: [7, 16],
  europe: [8, 17],
  oceania: [8, 23],
  latin_america: [12, 22],
  us: [14, 0],
  canada: [16, 1],
};

/**
 * Hourly-all dispatch: every region regenerates every hour, so each delivery
 * hour maps to a fresh snapshot (see the hourly-snapshot system in _generate).
 * The per-region `REGION_SCHEDULE` above is retained for reference but no
 * longer gates dispatch.
 */
export function regionsDueAt(_utcHour: number): RegionId[] {
  return [...REGION_IDS];
}

/** Max regions generated concurrently. 14 regions × ~11 Gemini section calls
 *  each must finish inside the route's 300s budget; a small pool keeps us well
 *  under it (≈3 waves × ~60s) while staying clear of Gemini rate limits. */
const REGION_CONCURRENCY = 5;

export interface DispatchResult {
  utcHour: number;
  due: RegionId[];
  results: Record<string, RefreshWorldBriefResult | { error: string }>;
}

/**
 * Generate every region's brief for this hour, with bounded concurrency. A
 * region that throws is logged and skipped; the others still run.
 */
export async function refreshDueRegions(utcHour: number): Promise<DispatchResult> {
  const due = regionsDueAt(utcHour);
  console.log(`[world-brief:dispatch] utcHour=${utcHour} regions=${due.length} (hourly-all, conc=${REGION_CONCURRENCY})`);
  const results: DispatchResult['results'] = {};

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < due.length) {
      const region = due[cursor++];
      try {
        results[region] = await refreshRegionalBrief(region);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results[region] = { error: msg };
        console.error(`[world-brief:dispatch] region=${region} FAILED: ${msg}`);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(REGION_CONCURRENCY, due.length) }, () => worker()),
  );

  return { utcHour, due, results };
}
