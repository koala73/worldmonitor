export const PHYSICAL_DIVERGENCE_STALE_AFTER_CALENDAR_DAYS = 12;
export const PHYSICAL_DIVERGENCE_PAPER_MAX_AGE_MS = 36 * 60 * 60 * 1000;
export const PHYSICAL_DIVERGENCE_FX_MAX_AGE_MS = 60 * 60 * 60 * 1000;

const SHANGHAI_DAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function shanghaiDayMs(nowMs) {
  const parts = Object.fromEntries(
    SHANGHAI_DAY_FORMATTER.formatToParts(new Date(nowMs))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

export function isPhysicalDivergenceDate(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

export function isPhysicalDivergenceInstant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function isPhysicalDivergencePrintFuture(value, nowMs) {
  const inputDay = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(inputDay)
    && Number.isFinite(nowMs)
    && inputDay > shanghaiDayMs(nowMs);
}

export function isPhysicalDivergencePrintStale(value, nowMs) {
  const inputDay = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(inputDay) || !Number.isFinite(nowMs)) return false;
  const currentDay = shanghaiDayMs(nowMs);
  const ageDays = Math.floor((currentDay - inputDay) / 86_400_000);
  return ageDays > PHYSICAL_DIVERGENCE_STALE_AFTER_CALENDAR_DAYS;
}

function isInstantStale(value, nowMs, maxAgeMs) {
  const inputMs = Date.parse(value);
  return Number.isFinite(inputMs) && nowMs - inputMs > maxAgeMs;
}

function isInstantFuture(value, nowMs) {
  const inputMs = Date.parse(value);
  return Number.isFinite(inputMs) && Number.isFinite(nowMs) && inputMs > nowMs;
}

export function physicalDivergenceStaleReason({ physicalAsOf, paperAsOf, fxAsOf }, nowMs) {
  if (!isPhysicalDivergenceDate(physicalAsOf)) return 'physical_print_invalid';
  if (!isPhysicalDivergenceInstant(paperAsOf)) return 'paper_snapshot_invalid';
  if (!isPhysicalDivergenceInstant(fxAsOf)) return 'fx_snapshot_invalid';
  if (isPhysicalDivergencePrintFuture(physicalAsOf, nowMs)) {
    return 'physical_print_in_future';
  }
  if (isPhysicalDivergencePrintStale(physicalAsOf, nowMs)) {
    return 'physical_print_older_than_12_calendar_days';
  }
  if (isInstantFuture(paperAsOf, nowMs)) {
    return 'paper_snapshot_in_future';
  }
  if (isInstantStale(paperAsOf, nowMs, PHYSICAL_DIVERGENCE_PAPER_MAX_AGE_MS)) {
    return 'paper_snapshot_older_than_36_hours';
  }
  if (isInstantFuture(fxAsOf, nowMs)) {
    return 'fx_snapshot_in_future';
  }
  if (isInstantStale(fxAsOf, nowMs, PHYSICAL_DIVERGENCE_FX_MAX_AGE_MS)) {
    return 'fx_snapshot_older_than_60_hours';
  }
  return null;
}
