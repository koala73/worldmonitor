import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { jsonResponse } from './_json-response.js';
import { captureSilentError } from './_sentry-edge.js';
import {
  durationToSeconds,
  limitWithFallback,
  resetRateLimitFallbackForTest,
} from './_rate-limit-fallback.js';
import {
  RATE_LIMIT_DEGRADED_HEADERS,
  getClientIp,
} from './_client-ip.js';
export {
  RATE_LIMIT_DEGRADED_HEADERS,
  UNKNOWN_CLIENT_IP,
  getClientIp,
} from './_client-ip.js';

// @upstash/redis defaults to 5 retries with exponential backoff (~4.3s total)
// before surfacing an unreachable-Redis error. Under the node test runner
// (NODE_TEST_CONTEXT is set) skip retries so fail-open / fail-closed tests that
// point UPSTASH_REDIS_REST_URL at a fake host degrade immediately instead of
// stalling. Production (env unset) keeps the resilient default. Mirrors
// REDIS_TEST_RETRY_OPTS in server/_shared/rate-limit.ts and PR #3963.
const REDIS_TEST_RETRY_OPTS = process.env.NODE_TEST_CONTEXT ? { retry: false } : {};

const DEFAULT_RATE_LIMIT_SCOPE = 'global';
const DEFAULT_RATE_LIMIT = 600;
const DEFAULT_RATE_LIMIT_WINDOW = '60 s';

let ratelimits = new Map();

function getRateLimitPolicy(opts = {}) {
  return {
    scope: opts.scope ?? DEFAULT_RATE_LIMIT_SCOPE,
    limit: opts.limit ?? DEFAULT_RATE_LIMIT,
    window: opts.window ?? DEFAULT_RATE_LIMIT_WINDOW,
  };
}

function getRatelimit(policy) {
  const cacheKey = `${policy.scope}|${policy.limit}|${policy.window}`;
  const cached = ratelimits.get(cacheKey);
  if (cached) return cached;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const ratelimit = new Ratelimit({
    redis: new Redis({ url, token, ...REDIS_TEST_RETRY_OPTS }),
    limiter: Ratelimit.slidingWindow(policy.limit, policy.window),
    prefix: policy.scope === DEFAULT_RATE_LIMIT_SCOPE ? 'rl' : `rl:${policy.scope}`,
    analytics: false,
  });
  ratelimits.set(cacheKey, ratelimit);

  return ratelimit;
}

// Decide the Sentry level for a degraded-rate-limit capture. Upstash runtime
// transients — the Lua limiter script timing out under fan-out load
// (`ERR Error running script: execution timed out`), a dropped command, or a
// network/timeout blip — are absorbed by the fail-open / `failClosed`-503 path,
// so the user is unaffected. Capture those at `warning` so a sustained Redis
// outage still escalates by volume without a transient script-timeout drowning
// genuine error-level signal in the dashboard (WORLDMONITOR-RX; mirrors the
// SERVICE_UNAVAILABLE `level: 'warning'` precedent in api/user-prefs.ts). A
// `missing-config` stage is a real deploy misconfiguration and any novel error
// is unclassified — both stay at `error` so on-call still sees them.
// Mirrored verbatim in server/_shared/rate-limit.ts.
function rateLimitErrorLevel(stage, msg) {
  if (stage.includes('missing-config')) return 'error';
  if (/Error running script|execution timed out|Command failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|network|timed out|socket hang up|Redis unavailable|Redis unreachable/i.test(msg)) {
    return 'warning';
  }
  return 'error';
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
    level: rateLimitErrorLevel(stage, msg),
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
 * @param {{ failClosed?: boolean, ctx?: { waitUntil: (p: Promise<unknown>) => void }, scope?: string, limit?: number, window?: import('@upstash/ratelimit').Duration }} [opts]
 *   When `failClosed` is true and Redis is unavailable, return a 503 with
 *   the `X-RateLimit-Mode: degraded` marker instead of allowing the
 *   request through. Pass `true` for endpoints where the rate-limit IS
 *   the abuse defence (LLM, checkout). Default `false` keeps the
 *   availability-first posture for general traffic so a Redis blip
 *   doesn't black-hole the whole site. `ctx` is the Vercel handler
 *   context — passing it lets the Sentry envelope dispatch survive
 *   isolate teardown. Top-level Edge handlers may pass `scope`, `limit`,
 *   and `window` for explicit endpoint budgets while retaining the shared
 *   degraded/429 response semantics. (#3531)
 */
export async function checkRateLimit(request, corsHeaders, opts = {}) {
  const policy = getRateLimitPolicy(opts);
  const rl = getRatelimit(policy);
  if (!rl) {
    if (opts.failClosed) {
      logRateLimitDegraded('checkRateLimit:missing-config', new Error('Upstash Redis is not configured'), opts.ctx);
      return rateLimitDegradedResponse(corsHeaders);
    }
    return null;
  }

  const ip = getClientIp(request);
  try {
    const fallbackPrefix = policy.scope === DEFAULT_RATE_LIMIT_SCOPE ? 'rl:fw' : `rl:${policy.scope}:fw`;
    const { success, limit, reset } = await limitWithFallback(
      rl,
      ip,
      `${fallbackPrefix}:${ip}`,
      policy.limit,
      durationToSeconds(policy.window),
    );

    if (!success) {
      // `reset` is a Unix epoch in MILLISECONDS (Upstash convention). The IETF
      // RateLimit fields carry a delta-seconds reset (`t` / RateLimit-Reset),
      // NOT an epoch, so derive the remaining-seconds view for them and for
      // Retry-After. The legacy X-RateLimit-Reset stays epoch-ms unchanged.
      const resetSeconds = Math.max(0, Math.ceil((reset - Date.now()) / 1000));
      const windowSeconds = durationToSeconds(policy.window);
      return jsonResponse({ error: 'Too many requests' }, 429, {
        // IETF RateLimit fields (draft-ietf-httpapi-ratelimit-headers). The
        // combined RateLimit member references the "default" policy advertised
        // on every API response via vercel.json so an agent can self-throttle.
        'RateLimit-Policy': `"default";q=${limit};w=${windowSeconds}`,
        'RateLimit-Limit': String(limit),
        'RateLimit-Remaining': '0',
        'RateLimit-Reset': String(resetSeconds),
        RateLimit: `"default";r=0;t=${resetSeconds}`,
        // Legacy X-RateLimit-* retained for back-compat (Reset is epoch-ms).
        'X-RateLimit-Limit': String(limit),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(reset),
        'Retry-After': String(resetSeconds),
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

export function __resetRateLimitForTest() {
  ratelimits = new Map();
  resetRateLimitFallbackForTest();
}
