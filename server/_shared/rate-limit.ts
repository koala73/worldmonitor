import { Ratelimit, type Duration } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

let ratelimit: Ratelimit | null = null;

function getRatelimit(): Ratelimit | null {
  if (ratelimit) return ratelimit;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  ratelimit = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(600, '60 s'),
    prefix: 'rl',
    analytics: false,
  });
  return ratelimit;
}

// Sentinel returned when no trusted client-IP header is present. Routed
// through the Upstash limiter as a single shared bucket so the entire
// "no trusted identity" population is naturally rate-limited together —
// an attacker who strips cf-connecting-ip / x-real-ip can no longer rotate
// identities by toggling x-forwarded-for. See getClientIp / #3531.
export const UNKNOWN_CLIENT_IP = 'unknown';

// Structured one-line log so api/server log aggregation can grep for the
// "rate-limit available" gap independently of Sentry. Keep the prefix
// stable — operators and the api/_rate-limit.js mirror both emit it.
function logRateLimitDegraded(stage: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[rate-limit] redis-error stage=${stage} msg=${msg}`);
}

// Marker header set on every degraded (fail-closed) response so observability
// can correlate "rate-limit unavailable" windows with downstream behaviour
// without parsing the JSON body. Mirrored in api/_rate-limit.js.
export const RATE_LIMIT_DEGRADED_HEADERS = {
  'X-RateLimit-Mode': 'degraded',
  // Short Retry-After encourages clients to retry once the limiter is back,
  // rather than treating the 503 as a hard outage.
  'Retry-After': '5',
} as const;

export function getClientIp(request: Request): string {
  // With Cloudflare proxy → Vercel, x-real-ip is the CF edge IP (shared across
  // users). cf-connecting-ip is the actual client IP set by Cloudflare —
  // prefer it.
  //
  // x-forwarded-for is client-settable and MUST NOT be trusted for
  // rate limiting (#3531) — without that fallback removed, a caller bypassing
  // CF entirely (direct request) could rotate identities by toggling the
  // header and beat the per-IP window. When neither trusted header is
  // present we return the UNKNOWN_CLIENT_IP sentinel so Upstash treats the
  // whole untrusted-identity population as one shared bucket.
  //
  // Trim each header value before falling through — a whitespace-only
  // cf-connecting-ip would otherwise short-circuit past x-real-ip.
  const cf = (request.headers.get('cf-connecting-ip') ?? '').trim();
  const xr = (request.headers.get('x-real-ip') ?? '').trim();
  return cf || xr || UNKNOWN_CLIENT_IP;
}

function tooManyRequestsResponse(
  limit: number,
  reset: number,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ error: 'Too many requests' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'X-RateLimit-Limit': String(limit),
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': String(reset),
      'Retry-After': String(Math.ceil((reset - Date.now()) / 1000)),
      ...corsHeaders,
    },
  });
}

function rateLimitDegradedResponse(corsHeaders: Record<string, string>): Response {
  return new Response(
    JSON.stringify({ error: 'Rate-limit service temporarily unavailable' }),
    {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        ...RATE_LIMIT_DEGRADED_HEADERS,
        ...corsHeaders,
      },
    },
  );
}

export interface RateLimitOptions {
  /**
   * When true and Redis is unavailable, return a 503 (with the
   * `X-RateLimit-Mode: degraded` marker) instead of allowing the request
   * through. Pass `true` for endpoints where the rate-limit IS the abuse
   * defence (LLM, checkout, lead capture). Default `false` keeps the
   * availability-first posture for general traffic so a Redis blip doesn't
   * black-hole the whole site. (#3531)
   */
  failClosed?: boolean;
}

export async function checkRateLimit(
  request: Request,
  corsHeaders: Record<string, string>,
  opts: RateLimitOptions = {},
): Promise<Response | null> {
  const rl = getRatelimit();
  if (!rl) return null;

  const ip = getClientIp(request);

  try {
    const { success, limit, reset } = await rl.limit(ip);

    if (!success) {
      return tooManyRequestsResponse(limit, reset, corsHeaders);
    }

    return null;
  } catch (err) {
    logRateLimitDegraded('checkRateLimit', err);
    if (opts.failClosed) return rateLimitDegradedResponse(corsHeaders);
    return null;
  }
}

// --- Per-endpoint rate limiting ---

interface EndpointRatePolicy {
  limit: number;
  window: Duration;
}

// Exported so scripts/enforce-rate-limit-policies.mjs can import it directly
// (#3278) instead of regex-parsing this file. Internal callers should keep
// using checkEndpointRateLimit / hasEndpointRatePolicy below — the export is
// for tooling, not new runtime callers.
export const ENDPOINT_RATE_POLICIES: Record<string, EndpointRatePolicy> = {
  '/api/news/v1/summarize-article-cache': { limit: 3000, window: '60 s' },
  '/api/intelligence/v1/classify-event': { limit: 600, window: '60 s' },
  // Legacy /api/sanctions-entity-search rate limit was 30/min per IP. Preserve
  // that budget now that LookupSanctionEntity proxies OpenSanctions live.
  '/api/sanctions/v1/lookup-sanction-entity': { limit: 30, window: '60 s' },
  // Lead capture: preserve the 3/hr and 5/hr budgets from legacy api/contact.js
  // and api/register-interest.js. Lower limits than normal IP rate limit since
  // these hit Convex + Resend per request.
  '/api/leads/v1/submit-contact': { limit: 3, window: '1 h' },
  '/api/leads/v1/register-interest': { limit: 5, window: '1 h' },
  // Scenario engine: legacy /api/scenario/v1/run capped at 10 jobs/min/IP via
  // inline Upstash INCR. Gateway now enforces the same budget with per-IP
  // keying in checkEndpointRateLimit.
  '/api/scenario/v1/run-scenario': { limit: 10, window: '60 s' },
  // Live tanker map (Energy Atlas): one user with 6 chokepoints × 1 call/min
  // = 6 req/min/IP base load. 60/min headroom covers tab refreshes + zoom
  // pans within a single user without flagging legitimate traffic.
  '/api/maritime/v1/get-vessel-snapshot': { limit: 60, window: '60 s' },
};

const endpointLimiters = new Map<string, Ratelimit>();

function getEndpointRatelimit(pathname: string): Ratelimit | null {
  const policy = ENDPOINT_RATE_POLICIES[pathname];
  if (!policy) return null;

  const cached = endpointLimiters.get(pathname);
  if (cached) return cached;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const rl = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(policy.limit, policy.window),
    prefix: 'rl:ep',
    analytics: false,
  });
  endpointLimiters.set(pathname, rl);
  return rl;
}

export function hasEndpointRatePolicy(pathname: string): boolean {
  return pathname in ENDPOINT_RATE_POLICIES;
}

export async function checkEndpointRateLimit(
  request: Request,
  pathname: string,
  corsHeaders: Record<string, string>,
  opts: RateLimitOptions = {},
): Promise<Response | null> {
  const rl = getEndpointRatelimit(pathname);
  if (!rl) return null;

  const ip = getClientIp(request);

  try {
    const { success, limit, reset } = await rl.limit(`${pathname}:${ip}`);

    if (!success) {
      return tooManyRequestsResponse(limit, reset, corsHeaders);
    }

    return null;
  } catch (err) {
    logRateLimitDegraded(`checkEndpointRateLimit:${pathname}`, err);
    // Per-endpoint policies exist precisely because the limit IS the abuse
    // defence — an LLM endpoint or a 3/hr lead-capture endpoint is the
    // worst place to silently fall through during a Redis outage. Default
    // to fail-closed; callers can opt out via opts.failClosed = false.
    const failClosed = opts.failClosed ?? true;
    if (failClosed) return rateLimitDegradedResponse(corsHeaders);
    return null;
  }
}

// --- In-handler scoped rate limits ---
//
// Handlers that need a per-subscope cap *in addition to* the gateway-level
// endpoint policy (e.g. a tighter budget for one request variant) use this
// helper. Gateway's checkEndpointRateLimit still runs first — this is a
// second stage.

const scopedLimiters = new Map<string, Ratelimit>();

function getScopedRatelimit(scope: string, limit: number, window: Duration): Ratelimit | null {
  const cacheKey = `${scope}|${limit}|${window}`;
  const cached = scopedLimiters.get(cacheKey);
  if (cached) return cached;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const rl = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(limit, window),
    prefix: 'rl:scope',
    analytics: false,
  });
  scopedLimiters.set(cacheKey, rl);
  return rl;
}

export interface ScopedRateLimitResult {
  allowed: boolean;
  limit: number;
  reset: number;
  /**
   * True when Redis was unreachable and the helper fell back to the
   * fail-open default. Callers that need fail-closed semantics should
   * gate on this — e.g. lead-capture handlers can refuse the write to
   * preserve the 3/hr budget across a Redis blip. (#3531)
   */
  degraded: boolean;
}

/**
 * Returns whether the request is under the scoped budget. `scope` is an
 * opaque namespace (e.g. `${pathname}#desktop`); `identifier` is usually the
 * client IP but can be any stable caller identifier. Fail-open on Redis errors
 * to stay consistent with checkRateLimit / checkEndpointRateLimit semantics,
 * but the `degraded` flag lets callers escalate to fail-closed locally
 * (#3531). The Redis error itself is logged once per call so silent bypass
 * windows are visible in logs / Sentry.
 */
export async function checkScopedRateLimit(
  scope: string,
  limit: number,
  window: Duration,
  identifier: string,
): Promise<ScopedRateLimitResult> {
  const rl = getScopedRatelimit(scope, limit, window);
  if (!rl) return { allowed: true, limit, reset: 0, degraded: false };
  try {
    const result = await rl.limit(`${scope}:${identifier}`);
    return {
      allowed: result.success,
      limit: result.limit,
      reset: result.reset,
      degraded: false,
    };
  } catch (err) {
    logRateLimitDegraded(`checkScopedRateLimit:${scope}`, err);
    return { allowed: true, limit, reset: 0, degraded: true };
  }
}
