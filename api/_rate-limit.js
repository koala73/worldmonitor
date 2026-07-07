import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { jsonResponse } from './_json-response.js';
import { captureSilentError } from './_sentry-edge.js';
import { redisPipeline } from './_upstash-json.js';
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

// Duration parsing — same regex as @upstash/ratelimit's internal (unexported)
// `ms()` helper. Mirrored verbatim in server/_shared/rate-limit.ts.
function durationToSeconds(window) {
  const match = /^(\d+)\s?(ms|s|m|h|d)$/.exec(window);
  if (!match) throw new Error(`Unable to parse rate-limit window: ${window}`);
  const value = Number(match[1]);
  const unit = match[2] ?? 's';
  const unitSeconds = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86_400 };
  return Math.max(1, Math.ceil(value * (unitSeconds[unit] ?? 1)));
}

// The self-hosted redis-rest proxy (docker/redis-rest-proxy.mjs) blocks
// EVAL/EVALSHA/SCRIPT via its command allowlist. @upstash/ratelimit's
// sliding-window limiter is a Lua script run via EVALSHA (falling back to
// EVAL on NOSCRIPT) — against that proxy every `.limit()` call throws an
// UpstashError wrapping the proxy's `Command not allowed: EVALSHA` (or
// `EVAL`/`SCRIPT`) body. Detect that once per process and switch to the
// non-Lua fallback below — retrying the Lua path on every request would
// just double every rate-limit check's latency forever. Mirrored verbatim
// in server/_shared/rate-limit.ts.
let luaUnsupported = false;

const FALLBACK_REDIS_TIMEOUT_MS = 1_000;

// Non-Lua fixed-window fallback: INCR + EXPIRE-NX + TTL over the plain REST
// pipeline endpoint (no EVAL/EVALSHA/SCRIPT). Mirrors the pattern already
// proven in production by
// api/_user-api-key.js::checkBootstrapUserApiKeyRateLimit — EXPIRE's NX flag
// (Redis 7+) means whichever concurrent caller's INCR happens to be first
// also wins the one-time TTL set; every other command in the window no-ops
// on EXPIRE, so there's no double-set race and no crash-between-INCR-and-
// EXPIRE gap to reason about. Returns null when Redis itself is
// unreachable — callers treat that identically to a Lua-path outage
// (existing fail-open / failClosed handling below).
async function fixedWindowLimit(key, limit, windowSeconds) {
  const result = await redisPipeline([
    ['INCR', key],
    ['EXPIRE', key, String(windowSeconds), 'NX'],
    ['TTL', key],
  ], FALLBACK_REDIS_TIMEOUT_MS);
  if (!result) return null;

  const count = Number(result[0]?.result ?? 0);
  if (!Number.isFinite(count) || count < 1) return null;

  const ttlRaw = Number(result[2]?.result ?? -1);
  const ttlSeconds = Number.isFinite(ttlRaw) && ttlRaw >= 0 ? ttlRaw : windowSeconds;

  return { success: count <= limit, limit, reset: Date.now() + ttlSeconds * 1000 };
}

// Drop-in replacement for `ratelimit.limit(identifier)` that transparently
// falls back to fixedWindowLimit the moment EVAL/EVALSHA is detected as
// unsupported. Any OTHER error (genuine Redis outage/timeout) is rethrown
// unchanged so the existing per-caller fail-open/failClosed + Sentry
// reporting below is untouched.
async function limitWithFallback(rl, identifier, fallbackKey, limit, windowSeconds) {
  if (!luaUnsupported) {
    try {
      return await rl.limit(identifier);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/Command not allowed: (EVAL|EVALSHA|SCRIPT)\b/i.test(msg)) throw err;
      luaUnsupported = true;
      console.warn('[rate-limit] EVAL/EVALSHA rejected by this Redis endpoint — switching to the non-Lua fixed-window fallback for the rest of this process');
    }
  }
  const fallback = await fixedWindowLimit(fallbackKey, limit, windowSeconds);
  if (!fallback) throw new Error('rate-limit fallback: Redis unreachable');
  return fallback;
}

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
  if (/Error running script|execution timed out|Command failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|network|timed out|socket hang up/i.test(msg)) {
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

export function __resetRateLimitForTest() {
  ratelimits = new Map();
  luaUnsupported = false;
}
