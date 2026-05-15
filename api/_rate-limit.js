import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { jsonResponse } from './_json-response.js';
import { captureSilentError } from './_sentry-edge.js';

let ratelimit = null;

function getRatelimit() {
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
// identities by toggling x-forwarded-for. (#3531) Mirrors the constant in
// server/_shared/rate-limit.ts.
export const UNKNOWN_CLIENT_IP = 'unknown';

// Marker headers set on every degraded (fail-closed) response so observability
// can correlate "rate-limit unavailable" windows with downstream behaviour
// without parsing the JSON body. Mirrors RATE_LIMIT_DEGRADED_HEADERS in
// server/_shared/rate-limit.ts.
export const RATE_LIMIT_DEGRADED_HEADERS = Object.freeze({
  'X-RateLimit-Mode': 'degraded',
  'Retry-After': '5',
});

export function getClientIp(request) {
  // With Cloudflare proxy → Vercel, x-real-ip is the CF edge IP (shared
  // across users). cf-connecting-ip is the actual client IP set by
  // Cloudflare — prefer it.
  //
  // x-forwarded-for is client-settable and MUST NOT be trusted for rate
  // limiting (#3531) — without that fallback removed, a caller bypassing
  // CF entirely (direct request) could rotate identities by toggling the
  // header and beat the per-IP window. When neither trusted header is
  // present we return the UNKNOWN_CLIENT_IP sentinel so Upstash treats
  // the whole untrusted-identity population as one shared bucket.
  //
  // Trim each header value before falling through — a whitespace-only
  // cf-connecting-ip would otherwise short-circuit past x-real-ip.
  // (Mirrors getClientIp in server/_shared/rate-limit.ts.)
  const cf = (request.headers.get('cf-connecting-ip') ?? '').trim();
  const xr = (request.headers.get('x-real-ip') ?? '').trim();
  return cf || xr || UNKNOWN_CLIENT_IP;
}

function logRateLimitDegraded(stage, err, ctx) {
  const msg = err instanceof Error ? err.message : String(err);
  // Keep the prefix stable — server/_shared/rate-limit.ts emits the same
  // shape and operators grep across both surfaces.
  console.error(`[rate-limit] redis-error stage=${stage} msg=${msg}`);
  captureSilentError(err, {
    tags: { surface: 'api', component: 'rate-limit', stage },
    fingerprint: ['rate-limit', 'redis-error', stage],
    ctx,
  });
}

function rateLimitDegradedResponse(corsHeaders) {
  return jsonResponse(
    { error: 'Rate-limit service temporarily unavailable' },
    503,
    { ...RATE_LIMIT_DEGRADED_HEADERS, ...corsHeaders },
  );
}

/**
 * @param {Request} request
 * @param {Record<string, string>} corsHeaders
 * @param {{ failClosed?: boolean, ctx?: { waitUntil: (p: Promise<unknown>) => void } }} [opts]
 *   When `failClosed` is true and Redis is unavailable, return a 503 with
 *   the `X-RateLimit-Mode: degraded` marker instead of allowing the
 *   request through. Pass `true` for endpoints where the rate-limit IS
 *   the abuse defence (LLM, checkout). Default `false` keeps the
 *   availability-first posture for general traffic so a Redis blip
 *   doesn't black-hole the whole site. `ctx` is the Vercel handler
 *   context — passing it lets the Sentry envelope dispatch survive
 *   isolate teardown. (#3531)
 */
export async function checkRateLimit(request, corsHeaders, opts = {}) {
  const rl = getRatelimit();
  if (!rl) return null;

  const ip = getClientIp(request);
  try {
    const { success, limit, reset } = await rl.limit(ip);

    if (!success) {
      return jsonResponse({ error: 'Too many requests' }, 429, {
        'X-RateLimit-Limit': String(limit),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(reset),
        'Retry-After': String(Math.ceil((reset - Date.now()) / 1000)),
        ...corsHeaders,
      });
    }

    return null;
  } catch (err) {
    logRateLimitDegraded('checkRateLimit', err, opts.ctx);
    if (opts.failClosed) return rateLimitDegradedResponse(corsHeaders);
    return null;
  }
}
