/**
 * Datacenter growth scrub points — derived from Epoch-cited
 * `firstOperationalMs` on AI_DATA_CENTERS (missing ≠ early).
 *
 * Origin is the earliest joined First Operational Date (not a fixed 2015 floor).
 * One scrub per calendar year at that year’s first cited opening, so China’s
 * 2010 Epoch cohort and later named clusters (e.g. TSUBAME 2014) appear.
 *
 * Seeking paints only clusters with firstOperationalMs <= focus.
 * Regenerate Epoch dates: `node scripts/join-epoch-operational-dates.mjs`
 *
 * Epoch GPU clusters: https://epoch.ai/data/gpu_clusters.csv
 * (dataset spans ~2010–present; First Operational Date is often conservative)
 */

import { AI_DATA_CENTERS } from '@/config/ai-datacenters';

const EPOCH_SOURCE = 'https://epoch.ai/data/gpu_clusters.csv';

export type AiDcGrowthLandmark = {
  id: string;
  ms: number;
  headline: string;
  kind: 'infra';
  sourceUrl: string;
  note: string;
};

function isDatedOperational(d: (typeof AI_DATA_CENTERS)[number]): boolean {
  if (d.status === 'decommissioned' || d.status === 'planned') return false;
  return d.firstOperationalMs != null && Number.isFinite(d.firstOperationalMs);
}

function datedOperationalCountBy(focusMs: number): number {
  let n = 0;
  for (const d of AI_DATA_CENTERS) {
    if (!isDatedOperational(d)) continue;
    if ((d.firstOperationalMs as number) <= focusMs) n += 1;
  }
  return n;
}

/**
 * Earliest Epoch-joined operational instant in the catalog.
 * Today: 2010-11-15 — batch of anonymized Chinese systems in Epoch’s join.
 */
export function earliestDcOperationalMs(): number | null {
  let min: number | null = null;
  for (const d of AI_DATA_CENTERS) {
    if (!isDatedOperational(d)) continue;
    const ms = d.firstOperationalMs as number;
    if (min == null || ms < min) min = ms;
  }
  return min;
}

/**
 * One scrub ms per calendar year: the first cited opening that year.
 * Skips years with no Epoch-dated openings in the joined catalog.
 */
function buildDcGrowthScrubMs(): number[] {
  const firstByYear = new Map<number, number>();
  for (const d of AI_DATA_CENTERS) {
    if (!isDatedOperational(d)) continue;
    const ms = d.firstOperationalMs as number;
    const y = new Date(ms).getUTCFullYear();
    const prev = firstByYear.get(y);
    if (prev == null || ms < prev) firstByYear.set(y, ms);
  }
  return [...firstByYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, ms]) => ms);
}

function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function yearLabel(ms: number): string {
  return String(new Date(ms).getUTCFullYear());
}

const DC_GROWTH_SCRUB_MS = buildDcGrowthScrubMs();

/**
 * TimeNav scrub points for GPU/AI datacenter density growth.
 * First point = earliest Epoch First Operational Date in the joined catalog.
 */
export const AI_DC_GROWTH_LANDMARKS: readonly AiDcGrowthLandmark[] =
  DC_GROWTH_SCRUB_MS.map((ms, i) => {
    const y = yearLabel(ms);
    const day = formatDay(ms);
    const count = datedOperationalCountBy(ms);
    const prevMs = i > 0 ? DC_GROWTH_SCRUB_MS[i - 1]! : null;
    const prevCount = prevMs != null ? datedOperationalCountBy(prevMs) : 0;
    const added = count - prevCount;
    const isFirst = i === 0;
    const deltaNote = isFirst
      ? `Earliest Epoch First Operational Date in joined catalog (${day}): ${count} clusters`
      : `${count} operational by ${day} (+${added} since ${formatDay(prevMs!)}); Epoch join`;
    return {
      id: `dc-growth-${y}`,
      ms,
      headline: isFirst ? `DC · first · ${y}` : `DC · ${y}`,
      kind: 'infra' as const,
      sourceUrl: EPOCH_SOURCE,
      note:
        count > 0
          ? deltaNote
          : `No Epoch-dated clusters by ${day} in joined catalog`,
    };
  });

/** Time · all window origin when Datacenters growth scrub is active. */
export const AI_DC_GROWTH_START_MS =
  AI_DC_GROWTH_LANDMARKS[0]?.ms ?? Date.UTC(2010, 10, 15);

export function dcGrowthLandmarkForMs(ms: number): AiDcGrowthLandmark | undefined {
  return AI_DC_GROWTH_LANDMARKS.find((l) => l.ms === ms);
}
