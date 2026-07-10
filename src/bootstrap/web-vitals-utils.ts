export const roundMs = (n: number | undefined): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : undefined;

/**
 * Fraction of (already good-trimmed) field Web-Vital events forwarded to Sentry.
 *
 * The good-trim (#4565) drops the `good` bucket, but the surviving
 * needs-improvement/poor tail still runs ~12k events/day — ~92% of ALL Sentry
 * volume — which is pure telemetry, not errors. This uniformly samples that tail
 * to cut that volume ~80%. Uniform (not rating-aware) sampling is deliberate: it
 * leaves the rating split, formFactor split, attribution-target distribution, and
 * p75 unbiased — only the sample size shrinks. Captured events carry a
 * `sampleRate` tag so absolute field volume is reconstructable (× 1/sampleRate).
 * At current traffic 20% still yields ~2.4k events/day — ample for weekly
 * page-level CrUX cross-checks and per-target histograms.
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
