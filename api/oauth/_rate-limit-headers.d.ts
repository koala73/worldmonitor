/** Window every OAuth limiter here uses (`Ratelimit.slidingWindow(n, '60 s')`). */
export const OAUTH_RATE_LIMIT_WINDOW_SEC: number;

/**
 * Standard 429 denial headers (IETF RateLimit fields, legacy X-RateLimit-*,
 * and Retry-After) for an `@upstash/ratelimit` result whose `reset` is a Unix
 * epoch in milliseconds.
 *
 * The index signature is deliberate: callers hand over whatever their limiter
 * returned, including a narrowed result that carries neither field, and that
 * case falls back to one whole window rather than omitting Retry-After.
 */
export function oauthRateLimitHeaders(
  result:
    | { readonly limit?: number; readonly reset?: number; readonly [key: string]: unknown }
    | null
    | undefined,
  windowSec?: number,
): Record<string, string>;
