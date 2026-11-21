import type { No2ActivityExclusion, No2ActivityRegionView, No2ActivityState } from '@/services/economic/no2-activity';

// Green and red carry the reading; slate is a reading inside the dead band.
// Pending and excluded are both "no reading" and must read as such: a muted
// violet for a baseline still being fetched, a dark grey for a window the
// method refused, neither on the green-red axis.
export const NO2_ACTIVITY_COLORS: Record<No2ActivityState, [number, number, number]> = {
  strengthening: [34, 197, 94],
  weakening: [239, 68, 68],
  unchanged: [148, 163, 184],
  pending: [139, 92, 246],
  excluded: [71, 85, 105],
};

export const NO2_ACTIVITY_STATE_LABELS: Record<No2ActivityState, string> = {
  strengthening: 'Strengthening',
  weakening: 'Weakening',
  unchanged: 'Unchanged',
  pending: 'Baseline pending',
  excluded: 'No reading',
};

export const NO2_ACTIVITY_EXCLUSION_LABELS: Record<No2ActivityExclusion, string> = {
  request_failed: 'Source request failed',
  baseline_backfill_pending: 'Baseline backfill pending',
  insufficient_valid_days: 'Insufficient valid days',
  insufficient_baseline_years: 'Insufficient baseline years',
};

export const NO2_ACTIVITY_LEGEND: ReadonlyArray<{ state: No2ActivityState; label: string }> = (
  ['strengthening', 'weakening', 'unchanged', 'pending', 'excluded'] as const
).map((state) => ({ state, label: NO2_ACTIVITY_STATE_LABELS[state] }));

export function no2ActivityFill(state: No2ActivityState, alpha: number): [number, number, number, number] {
  const [r, g, b] = NO2_ACTIVITY_COLORS[state];
  return [r, g, b, alpha];
}

export function formatNo2Change(changePercent: number | null): string {
  if (changePercent === null) return '';
  const sign = changePercent > 0 ? '+' : '';
  return `${sign}${changePercent.toFixed(1)}%`;
}

/**
 * Hover card HTML. `text` must HTML-escape: the label and the credit are
 * upstream data.
 */
export function no2ActivityTooltip(region: No2ActivityRegionView, attribution: string, text: (value: unknown) => string): string {
  const [r, g, b] = NO2_ACTIVITY_COLORS[region.state];
  const reading = region.state === 'pending' || region.state === 'excluded'
    ? text(region.exclusion ? NO2_ACTIVITY_EXCLUSION_LABELS[region.exclusion] : NO2_ACTIVITY_STATE_LABELS.excluded)
    : `${text(NO2_ACTIVITY_STATE_LABELS[region.state])} ${text(formatNo2Change(region.changePercent))} vs prior years`;
  const kind = region.kind === 'cluster' ? 'Industrial cluster' : 'Country';
  return `<div class="deckgl-tooltip"><strong>${text(region.label)}</strong>`
    + `<br/><span style="opacity:.7">${kind} · NO2 activity</span>`
    + `<br/><span style="color:rgb(${r},${g},${b});font-weight:600">${reading}</span>`
    + `<br/>${text(region.windowStart)} to ${text(region.windowEnd)} · ${text(region.validDays)} valid days`
    + `<br/><span style="opacity:.6">${text(attribution)}</span></div>`;
}
