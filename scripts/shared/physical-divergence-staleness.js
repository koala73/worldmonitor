export const PHYSICAL_DIVERGENCE_STALE_AFTER_CALENDAR_DAYS = 12;
export const PHYSICAL_DIVERGENCE_PAPER_MAX_AGE_MS = 36 * 60 * 60 * 1000;
export const PHYSICAL_DIVERGENCE_FX_MAX_AGE_MS = 60 * 60 * 60 * 1000;

export function isPhysicalDivergencePrintStale(value, nowMs) {
  const inputDay = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(inputDay)) return false;
  const now = new Date(nowMs);
  const currentDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const ageDays = Math.floor((currentDay - inputDay) / 86_400_000);
  return ageDays > PHYSICAL_DIVERGENCE_STALE_AFTER_CALENDAR_DAYS;
}

function isInstantStale(value, nowMs, maxAgeMs) {
  const inputMs = Date.parse(value);
  return Number.isFinite(inputMs) && nowMs - inputMs > maxAgeMs;
}

export function physicalDivergenceStaleReason({ physicalAsOf, paperAsOf, fxAsOf }, nowMs) {
  if (isPhysicalDivergencePrintStale(physicalAsOf, nowMs)) {
    return 'physical_print_older_than_12_calendar_days';
  }
  if (isInstantStale(paperAsOf, nowMs, PHYSICAL_DIVERGENCE_PAPER_MAX_AGE_MS)) {
    return 'paper_snapshot_older_than_36_hours';
  }
  if (isInstantStale(fxAsOf, nowMs, PHYSICAL_DIVERGENCE_FX_MAX_AGE_MS)) {
    return 'fx_snapshot_older_than_60_hours';
  }
  return null;
}
