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

function getClientIp(request: Request): string {
  // With Cloudflare proxy → Vercel, x-real-ip is the CF edge IP (shared across users).
  // cf-connecting-ip is the actual client IP set by Cloudflare — prefer it.
  // x-forwarded-for is client-settable and MUST NOT be trusted for rate limiting.
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-real-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    '0.0.0.0'
  );
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

export async function checkRateLimit(
  request: Request,
  corsHeaders: Record<string, string>,
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
  } catch {
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
  } catch {
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
}

/**
 * Returns whether the request is under the scoped budget. `scope` is an
 * opaque namespace (e.g. `${pathname}#desktop`); `identifier` is usually the
 * client IP but can be any stable caller identifier. Fail-open on Redis errors
 * to stay consistent with checkRateLimit / checkEndpointRateLimit semantics.
 */
export async function checkScopedRateLimit(
  scope: string,
  limit: number,
  window: Duration,
  identifier: string,
): Promise<ScopedRateLimitResult> {
  const rl = getScopedRatelimit(scope, limit, window);
  if (!rl) return { allowed: true, limit, reset: 0 };
  try {
    const result = await rl.limit(`${scope}:${identifier}`);
    return { allowed: result.success, limit: result.limit, reset: result.reset };
  } catch {
    return { allowed: true, limit, reset: 0 };
  }
}
