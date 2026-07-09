export const roundMs = (n: number | undefined): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : undefined;

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
