import { rateLimitHeaders } from '../_api-key-rate-limit.js';

/**
 * Denial headers for the OAuth endpoints' per-IP limiters.
 *
 * RFC 9110 §15.5.30 and RFC 6585 both say a 429 SHOULD carry `Retry-After`;
 * without it a client that is refused has nothing to pace itself by, which is
 * exactly backwards for the endpoints an unattended agent retries hardest
 * (registration, token exchange, authorization). The rest of the API already
 * answers this way through `checkRateLimit` and `rateLimitHeaders`, so this
 * reuses that renderer rather than inventing a second contract.
 *
 * `reset` from @upstash/ratelimit is a Unix epoch in MILLISECONDS; Retry-After
 * and the IETF reset are delta-seconds, which `rateLimitHeaders` derives. A
 * reset already in the past floors at one second rather than inviting an
 * immediate retry.
 */

/** Every OAuth limiter here is `Ratelimit.slidingWindow(n, '60 s')`. */
export const OAUTH_RATE_LIMIT_WINDOW_SEC = 60;

/**
 * @param {{ limit?: number, reset?: number } | null | undefined} result
 * @param {number} [windowSec]
 * @returns {Record<string, string>}
 */
export function oauthRateLimitHeaders(result, windowSec = OAUTH_RATE_LIMIT_WINDOW_SEC) {
  const limit = Number.isFinite(result?.limit) ? Number(result.limit) : 0;
  const now = Date.now();
  // A limiter that answered without a usable reset still owes the caller a
  // pace: fall back to one whole window rather than omitting the header.
  const limiterResetMs = Number.isFinite(result?.reset) && Number(result.reset) > 0
    ? Number(result.reset)
    : now + windowSec * 1000;
  const retryAfterSec = Math.max(1, Math.ceil((limiterResetMs - now) / 1000));
  // Hand rateLimitHeaders a reset on a whole second from this one clock read.
  // It reads the clock again for RateLimit-Reset, and ceil() of the same
  // whole-second delta stays put under sub-second drift, so Retry-After and
  // RateLimit-Reset agree, including the one-second floor.
  return rateLimitHeaders({
    limit,
    remaining: 0,
    resetMs: now + retryAfterSec * 1000,
    retryAfterSec,
    windowSec,
  });
}
