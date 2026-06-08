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

/** Regions whose schedule includes this UTC hour (0–23). */
export function regionsDueAt(utcHour: number): RegionId[] {
  return REGION_IDS.filter((r) => REGION_SCHEDULE[r].includes(utcHour));
}

export interface DispatchResult {
  utcHour: number;
  due: RegionId[];
  results: Record<string, RefreshWorldBriefResult | { error: string }>;
}

/**
 * Generate the briefs for whichever regions are due at `utcHour`. Processed
 * SEQUENTIALLY — the schedule guarantees ≤3 regions per hour, and each region
 * runs ~11 Gemini section calls, so sequential keeps us clear of both the
 * Gemini rate limit and the 300s function budget (3 × ~60s = ~180s). A region
 * that throws is logged and skipped; the others still run.
 */
export async function refreshDueRegions(utcHour: number): Promise<DispatchResult> {
  const due = regionsDueAt(utcHour);
  console.log(`[world-brief:dispatch] utcHour=${utcHour} due=[${due.join(',')}]`);
  const results: DispatchResult['results'] = {};
  for (const region of due) {
    try {
      results[region] = await refreshRegionalBrief(region);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results[region] = { error: msg };
      console.error(`[world-brief:dispatch] region=${region} FAILED: ${msg}`);
    }
  }
  return { utcHour, due, results };
}
