export const roundMs = (n: number | undefined): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : undefined;

/**
 * Fraction of (already good-trimmed) field Web-Vital events forwarded to Sentry.
 *
 * The good-trim (#4565) drops the `good` bucket, but the surviving
 * needs-improvement/poor tail still runs ~12k events/day — ~92% of ALL Sentry
 * volume — which is pure telemetry, not errors. This uniformly samples that tail
 * to cut that volume ~80%. Captured events carry a `sampleRate` tag so absolute
 * field volume is reconstructable (× 1/sampleRate).
 *
 * WHAT THIS SAMPLING DOES AND DOES NOT PRESERVE — read before computing anything.
 *
 * Uniform (not rating-aware) sampling is deliberate, and *within the tail it is
 * handed* it preserves shape: the rating split, formFactor split and
 * attribution-target distribution over CAPTURED events are unbiased estimates of
 * those same distributions over BAD events. Only the sample size shrinks.
 *
 * It does NOT make any percentile of captured events an estimate of that
 * percentile of the field, because the good-trim upstream has already removed
 * ~70% of the distribution. Captured p75 is p75 of `metric | metric >= bad
 * threshold`, and that conditional statistic moves the WRONG WAY as the field
 * improves: a fix pushes moderate interactions across the threshold into `good`,
 * which DELETES them from the sample and leaves the surviving tail worse on
 * average. A real win can read as a flat or rising number. Worked example in
 * docs/perf/reading-field-web-vitals.md.
 *
 * The honest Sentry-side series is a RATE, not a percentile: count events with
 * the rating tag `poor`, scale by 1/sampleRate, and divide by a traffic
 * denominator Sentry does not hold (Umami pageviews) — see the doc. For an
 * actual page-level p75, use CrUX `queryHistoryRecord`, which observes the whole
 * distribution and none of this applies to it.
 */
export const WEB_VITAL_SAMPLE_RATE = 0.2;

/**
 * Uniform sampling gate for field Web-Vital reporting; returns true when the
 * event should be forwarded. `rate` in [0,1]; `rng` is injectable for tests.
 * `rate >= 1` (or NaN) always keeps — a misconfigured rate over-reports rather
 * than silently losing data; `rate <= 0` always drops.
 */
export function shouldSampleWebVital(
  rate: number = WEB_VITAL_SAMPLE_RATE,
  rng: () => number = Math.random,
): boolean {
  if (!(rate < 1)) return true;
  if (rate <= 0) return false;
  return rng() < rate;
}

export type WebVitalsFormFactor = 'mobile' | 'desktop';

function mediaQueryMatches(query: string): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

/**
 * Low-cardinality surface tag for field Web Vitals.
 *
 * This intentionally folds tablet/touch and <=1024px responsive layouts into
 * `mobile`, leaving only `mobile|desktop` as Sentry facets.
 */
export function getWebVitalsFormFactor(): WebVitalsFormFactor {
  if (typeof window === 'undefined') return 'desktop';
  const navigatorWithUaData = window.navigator as Navigator & {
    userAgentData?: { mobile?: boolean };
  };
  if (navigatorWithUaData.userAgentData?.mobile === true) return 'mobile';
  if (
    mediaQueryMatches('(pointer: coarse)')
    || mediaQueryMatches('(hover: none)')
    || mediaQueryMatches('(max-width: 1024px)')
  ) {
    return 'mobile';
  }
  return window.innerWidth > 0 && window.innerWidth <= 1024 ? 'mobile' : 'desktop';
}

export function sanitizeWebVitalUrl(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const url = new URL(raw, typeof window !== 'undefined' ? window.location.href : 'https://worldmonitor.app/');
    const query = url.search ? '?[redacted]' : '';
    return `${url.origin}${url.pathname}${query}`;
  } catch {
    const [withoutQuery = raw] = raw.split('?');
    return withoutQuery.slice(0, 200);
  }
}
