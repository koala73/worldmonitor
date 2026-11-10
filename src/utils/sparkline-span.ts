export interface SparklineSpan {
  sparkline?: number[];
  sparklineIntervalSeconds?: number;
  sparklineStartAt?: number;
}

export interface SparklineSpanOptions {
  now?: number;
  locale?: string;
  /** Wraps a formatted start time, e.g. "since {{date}}" from the locale. */
  since: (when: string) => string;
}

const DAY_MS = 86_400_000;
// 288 traded bars of a 23-hour contract cover 25 wall-clock hours, and 26 in
// the first hour after a reopen, when they reach back past two daily breaks.
// The rest is slack for a quote a few minutes old. A weekend is far longer.
const FULL_DAY_SLACK_MS = 3 * 3_600_000;

/**
 * Describe the time a sparkline covers. Every sparkline is drawn at the same
 * width, so without this a chart of the 30 minutes since a reopen looks like a
 * chart of a day. Returns "24h" for a full trading day that ends now, the start
 * time ("since Sun 23:00 UTC", or "since Oct 13" for daily closes) otherwise,
 * and "" when the series has no span labels or nothing is drawn.
 */
export function sparklineSpanLabel(quote: SparklineSpan, options: SparklineSpanOptions): string {
  const { sparkline, sparklineIntervalSeconds: interval, sparklineStartAt: startAt } = quote;
  if (!sparkline || sparkline.length < 2) return '';
  if (typeof interval !== 'number' || !(interval > 0)) return '';
  if (typeof startAt !== 'number' || !Number.isFinite(startAt)) return '';
  const { now = Date.now(), locale, since } = options;
  const start = new Date(startAt);

  if (interval >= DAY_MS / 1000) {
    return since(new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(start));
  }
  if (sparkline.length * interval * 1000 >= DAY_MS && now - startAt <= DAY_MS + FULL_DAY_SLACK_MS) {
    return new Intl.NumberFormat(locale, { style: 'unit', unit: 'hour', unitDisplay: 'narrow' }).format(24);
  }
  const when = new Intl.DateTimeFormat(locale, {
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC',
  }).format(start);
  return since(`${when} UTC`);
}
