import { waitUntil as vercelWaitUntil } from '@vercel/functions';

import { getCorsHeaders, getPublicCorsHeaders, isDisallowedOrigin } from './_cors.js';
import {
  USER_API_KEY_GATEWAY_VALIDATION_ERROR,
  getHeaderApiKey,
  validateApiKey,
} from './_api-key.js';
import { jsonResponse } from './_json-response.js';
import {
  checkBootstrapUserApiKeyRateLimit,
  isCanonicalUserApiKey,
  validateBootstrapUserApiAccess,
  validateBootstrapUserApiKey,
} from './_user-api-key.js';
// @ts-expect-error — JS module, no declaration file
import { redisPipeline } from './_upstash-json.js';
import { unwrapEnvelope } from './_seed-envelope.js';
import { bootstrapTierKeyNames, resolveBootstrapRegistry } from './_bootstrap-tier-keys.js';
import { compactWildfireDashboardPayload } from './_wildfire-dashboard.js';
import {
  BOOTSTRAP_R2_PROBE_CEILING_MS,
  readBootstrapTierObject,
} from './_bootstrap-r2.js';
import { deliverBootstrapR2Shadow, deriveExecutionRegion } from './_usage-telemetry.js';

export const config = { runtime: 'edge' };

// Iran-events domain sunset (war ended 2026-07). Default OFF: don't ship the
// domain to the client. Set IRAN_EVENTS_ENABLED=true to restore. See api/health.js.
const IRAN_EVENTS_ENABLED = (process.env.IRAN_EVENTS_ENABLED ?? 'false').toLowerCase() === 'true';

const { cacheKeys: BOOTSTRAP_CACHE_KEYS } = resolveBootstrapRegistry({
  iranEventsEnabled: IRAN_EVENTS_ENABLED,
});
const SLOW_KEYS = new Set(bootstrapTierKeyNames('slow', { iranEventsEnabled: IRAN_EVENTS_ENABLED }));
const FAST_KEYS = new Set(bootstrapTierKeyNames('fast', { iranEventsEnabled: IRAN_EVENTS_ENABLED }));
const ON_DEMAND_KEYS = new Set(bootstrapTierKeyNames('on-demand', { iranEventsEnabled: IRAN_EVENTS_ENABLED }));

// No public/s-maxage: CF (in front of api.worldmonitor.app) ignores Vary: Origin and would
// pin ACAO: worldmonitor.app on cached responses, breaking CORS for preview deployments.
// Vercel CDN caching is handled by TIER_CDN_CACHE via CDN-Cache-Control below.
const TIER_CACHE = {
  slow: 'max-age=300, stale-while-revalidate=600, stale-if-error=3600',
  fast: 'max-age=60, stale-while-revalidate=120, stale-if-error=900',
};
const TIER_CDN_CACHE = {
  slow: 'public, s-maxage=7200, stale-while-revalidate=1800, stale-if-error=7200',
  fast: 'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=900',
};

export function isPublicWeatherBootstrapRequest(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  const url = new URL(req.url);
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  if (pathname !== '/api/bootstrap') return false;

  const params = Array.from(url.searchParams.keys());
  if (params.some((key) => key !== 'keys')) return false;

  const keyParams = url.searchParams.getAll('keys');
  if (keyParams.length !== 1) return false;

  const requested = keyParams[0].split(',').map((key) => key.trim()).filter(Boolean);
  return requested.length === 1 && requested[0] === 'weatherAlerts';
}

const PUBLIC_BOOTSTRAP_TIERS = new Set(['fast', 'slow']);
let nextBootstrapR2ShadowProbeIsCold = true;
let scheduleBootstrapR2Shadow = vercelWaitUntil;

function shouldMeasureBootstrapR2Shadow(authKind, tier) {
  return process.env.BOOTSTRAP_R2_SHADOW_MEASURE === '1'
    && process.env.VERCEL_ENV === 'production'
    && authKind === 'public-tier'
    && PUBLIC_BOOTSTRAP_TIERS.has(tier);
}

function finishBootstrapR2ShadowResponse(req, ctx, tier, response, redisDurationMs) {
  response.headers.set('Server-Timing', `wm_bootstrap_redis;dur=${redisDurationMs.toFixed(3)}`);
  const exposedHeaders = response.headers.get('Access-Control-Expose-Headers');
  response.headers.set(
    'Access-Control-Expose-Headers',
    [exposedHeaders, 'Server-Timing', 'Age', 'X-Vercel-Cache', 'CF-Cache-Status']
      .filter(Boolean)
      .join(', '),
  );

  const executionCold = nextBootstrapR2ShadowProbeIsCold;
  nextBootstrapR2ShadowProbeIsCold = false;
  const probe = readBootstrapTierObject(tier, {
    timeoutMs: BOOTSTRAP_R2_PROBE_CEILING_MS,
  }).then((result) => deliverBootstrapR2Shadow({
      r2Outcome: result.status === 'ok' ? 'r2' : 'fallback',
      r2Reason: result.status === 'fallback' ? result.reason : null,
      bootstrapTier: tier,
      r2DurationMs: result.durationMs,
      executionRegion: deriveExecutionRegion(req) ?? process.env.VERCEL_REGION ?? 'unknown',
      executionCold,
      status: response.status,
    })).catch(() => {
    // readBootstrapTierObject is fail-soft by contract. Preserve that contract
    // if a future implementation accidentally throws before producing a result.
    return deliverBootstrapR2Shadow({
      r2Outcome: 'fallback',
      r2Reason: 'unreadable',
      bootstrapTier: tier,
      r2DurationMs: 0,
      executionRegion: deriveExecutionRegion(req) ?? process.env.VERCEL_REGION ?? 'unknown',
      executionCold,
      status: response.status,
    });
  });
  try {
    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(probe);
    else scheduleBootstrapR2Shadow(probe);
  } catch {
    // Background measurement must never alter the Redis response path.
  }
  return response;
}

// An explicit public tier bootstrap read (?tier=fast|slow&public=1, no other
// params) returns the shared
// production seed payload — identical for every caller (see PR #4499 non-goals:
// only static transforms like wildfire compaction / enrichmentMeta strip apply,
// never per-user variance). The explicit marker gives the shared response its
// own CDN cache key; the legacy ?tier=fast|slow URLs remain credentialed and
// no-store, so a warmed public response cannot bypass their auth/CORS contract.
// The public URL is public regardless of request credentials because a CDN hit
// occurs before handler auth. Callers that need credential processing must use
// the legacy URL. Scoped to the two fixed public shapes so the CDN key space
// stays tiny and hit rate high.
//
// GET only: a HEAD here would still run the full registry Redis read to build a
// body it must not return — the exact unshielded egress this path exists to
// avoid. HEAD tier reads have no client and fall through to the no-store path.
export function isPublicTierBootstrapRequest(req) {
  if (req.method !== 'GET') return false;

  const url = new URL(req.url);
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  if (pathname !== '/api/bootstrap') return false;

  const params = Array.from(url.searchParams.keys());
  if (params.some((key) => key !== 'tier' && key !== 'public')) return false;

  const tierParams = url.searchParams.getAll('tier');
  const publicParams = url.searchParams.getAll('public');
  if (tierParams.length !== 1 || publicParams.length !== 1 || publicParams[0] !== '1') return false;

  return PUBLIC_BOOTSTRAP_TIERS.has(tierParams[0]);
}

// The on-demand counterpart to the tier URL above: `?keys=<name>&public=1` for a
// SINGLE on-demand key. Same reasoning — the payload is the shared production
// seed value, identical for every caller — so it gets its own CDN entry and the
// same public contract regardless of attached credentials (a cache hit precedes
// handler auth).
//
// Restricted to ONE key drawn from ON_DEMAND_KEYS, deliberately: an arbitrary
// `?keys=a,b,c` would make the CDN key space combinatorial, and every distinct
// combination is a cache MISS that re-reads the registry from Redis — the exact
// amplification #5259/#5287 exist to prevent. One key per URL keeps the space at
// |ON_DEMAND_KEYS| entries, each independently cached and each fetched only by
// the clients that actually render it.
//
// The legacy multi-key `?keys=a,b` URL keeps working and stays credentialed +
// no-store, so nothing that relies on it changes.
export function isPublicOnDemandBootstrapRequest(req) {
  if (req.method !== 'GET') return false;

  const url = new URL(req.url);
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  if (pathname !== '/api/bootstrap') return false;

  const params = Array.from(url.searchParams.keys());
  if (params.some((key) => key !== 'keys' && key !== 'public')) return false;

  const keyParams = url.searchParams.getAll('keys');
  const publicParams = url.searchParams.getAll('public');
  if (keyParams.length !== 1 || publicParams.length !== 1 || publicParams[0] !== '1') return false;

  return ON_DEMAND_KEYS.has(keyParams[0]);
}

const BOOTSTRAP_CREDENTIAL_COOKIES = new Set(['wm-session', 'wm-pro-key', 'wm-widget-key']);

function hasBootstrapCredentialCookie(req) {
  const raw = req.headers.get('Cookie') || req.headers.get('cookie') || '';
  if (!raw) return false;

  for (const part of raw.split(';')) {
    const name = part.trim().split('=', 1)[0];
    if (BOOTSTRAP_CREDENTIAL_COOKIES.has(name)) return true;
  }
  return false;
}

const NEG_SENTINEL = '__WM_NEG__';
export const compactWildfireBootstrapPayload = compactWildfireDashboardPayload;

async function getCachedJsonBatch(keys, shadowMarkerTier = null) {
  const result = new Map();
  if (keys.length === 0) return result;

  // Always read unprefixed keys — bootstrap is a read-only consumer of
  // production cache data. Preview/branch deploys don't run handlers that
  // populate prefixed keys, so prefixing would always miss.
  const pipeline = keys.map((k) => ['GET', k]);
  if (shadowMarkerTier) {
    // This intentionally-missing marker makes shadow origin requests uniquely
    // countable in Redis MONITOR. The publisher reads the same tier registry,
    // so canonical GET counts alone no longer distinguish it from serving.
    pipeline.push(['GET', `bootstrap:r2-shadow-origin-marker:${shadowMarkerTier}`]);
  }
  const data = await redisPipeline(pipeline, 3000);
  if (!Array.isArray(data) || data.length !== pipeline.length) {
    throw new Error('Bootstrap Redis pipeline unavailable');
  }

  for (let i = 0; i < keys.length; i++) {
    const entry = data[i];
    if (
      !entry
      || typeof entry !== 'object'
      || !('result' in entry)
      || entry.error != null
    ) {
      throw new Error('Bootstrap Redis pipeline command failed');
    }
    const raw = entry.result;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed === NEG_SENTINEL) continue;
        // Envelope-aware: bootstrap is a public-boundary consumer — strip _seed
        // from contract-mode canonical keys so clients never see envelope
        // metadata. Legacy bare-shape values pass through unchanged.
        result.set(keys[i], unwrapEnvelope(parsed).data);
      } catch { /* skip malformed */ }
    }
  }
  return result;
}

function authFailure(body, status, cors, extraHeaders = {}) {
  // no-store is spread last so a caller-supplied Cache-Control in extraHeaders
  // can never weaken the non-cacheable posture of an auth-failure response.
  return jsonResponse(body, status, {
    ...cors,
    ...extraHeaders,
    'Cache-Control': 'no-store',
  });
}

async function validateBootstrapAuth(req, cors) {
  const headerKey = getHeaderApiKey(req);
  // The explicit public URL must have one response contract for every request:
  // Vercel may serve it from cache before cookie/header auth reaches this code.
  if (isPublicTierBootstrapRequest(req)) {
    return { ok: true, kind: 'public-tier' };
  }
  if (isPublicOnDemandBootstrapRequest(req)) {
    return { ok: true, kind: 'public-on-demand' };
  }
  if (!headerKey && !hasBootstrapCredentialCookie(req)) {
    if (isPublicWeatherBootstrapRequest(req)) {
      return { ok: true, kind: 'public-weather' };
    }
  }

  const apiKeyResult = await validateApiKey(req);
  if (!apiKeyResult.required || apiKeyResult.valid) {
    return { ok: true, kind: apiKeyResult.kind || 'unknown' };
  }

  if (apiKeyResult.error === USER_API_KEY_GATEWAY_VALIDATION_ERROR && headerKey.startsWith('wm_')) {
    if (!isCanonicalUserApiKey(headerKey)) {
      return {
        ok: false,
        response: authFailure({ error: 'Invalid API key' }, 401, cors),
      };
    }

    const rateLimitResult = await checkBootstrapUserApiKeyRateLimit(req);
    if (!rateLimitResult.ok) {
      return {
        ok: false,
        response: authFailure(
          { error: rateLimitResult.error },
          rateLimitResult.status,
          cors,
          rateLimitResult.headers,
        ),
      };
    }

    // Propagate the validation result's status/error/headers (all generic,
    // leak-free strings) rather than hardcoding 401/403: a Convex outage surfaces
    // as a retryable 503 + Retry-After (status 503, unavailable:true) instead of
    // a misleading "Invalid API key" 401, mirroring the rate-limit path above.
    const userKeyResult = await validateBootstrapUserApiKey(headerKey);
    if (!userKeyResult.ok) {
      return {
        ok: false,
        response: authFailure(
          { error: userKeyResult.error },
          userKeyResult.status,
          cors,
          userKeyResult.headers,
        ),
      };
    }

    const entitlementResult = await validateBootstrapUserApiAccess(userKeyResult.userId);
    if (!entitlementResult.ok) {
      return {
        ok: false,
        response: authFailure(
          { error: entitlementResult.error },
          entitlementResult.status,
          cors,
          entitlementResult.headers,
        ),
      };
    }

    return { ok: true, kind: 'user' };
  }

  const error = apiKeyResult.error === USER_API_KEY_GATEWAY_VALIDATION_ERROR
    ? 'Invalid API key'
    : apiKeyResult.error;
  return {
    ok: false,
    response: authFailure({ error }, 401, cors),
  };
}

function isPublicBootstrapKind(authKind) {
  return authKind === 'public-weather' || authKind === 'public-tier' || authKind === 'public-on-demand';
}

function successCacheHeaders(tier, authKind, cors) {
  if (!isPublicBootstrapKind(authKind)) {
    return {
      ...cors,
      'Cache-Control': 'no-store',
    };
  }

  // Public seed payload with no per-user variation: serve with ACAO:* (no
  // Vary: Origin, no Access-Control-Allow-Credentials) so the shared CDN stores
  // ONE entry per URL instead of one per Origin, and no preview/embed origin can
  // pin an echoed ACAO onto a cached response. Safe because isDisallowedOrigin()
  // already rejected unauthorized origins at the handler entry (this is exactly
  // the contract getPublicCorsHeaders documents).
  const publicCors = getPublicCorsHeaders();
  const cacheControl = (tier && TIER_CACHE[tier]) || 'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=900';
  return {
    ...publicCors,
    'Cache-Control': cacheControl,
    'CDN-Cache-Control': (tier && TIER_CDN_CACHE[tier]) || TIER_CDN_CACHE.fast,
  };
}

export default async function handler(req, ctx) {
  if (isDisallowedOrigin(req))
    return new Response('Forbidden', { status: 403 });

  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: cors });

  const auth = await validateBootstrapAuth(req, cors);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const tier = url.searchParams.get('tier');
  let registry;
  if (tier === 'slow' || tier === 'fast') {
    const tierSet = tier === 'slow' ? SLOW_KEYS : FAST_KEYS;
    registry = Object.fromEntries(Object.entries(BOOTSTRAP_CACHE_KEYS).filter(([k]) => tierSet.has(k)));
  } else {
    const requested = url.searchParams.get('keys')?.split(',').filter(Boolean).sort();
    registry = requested
      ? Object.fromEntries(Object.entries(BOOTSTRAP_CACHE_KEYS).filter(([k]) => requested.includes(k)))
      : BOOTSTRAP_CACHE_KEYS;
  }

  const keys = Object.values(registry);
  const names = Object.keys(registry);
  const measureR2Shadow = shouldMeasureBootstrapR2Shadow(auth.kind, tier);
  const redisStartedAt = measureR2Shadow ? performance.now() : null;

  let cached;
  try {
    cached = await getCachedJsonBatch(keys, measureR2Shadow ? tier : null);
  } catch {
    const isPublic = isPublicBootstrapKind(auth.kind);
    if (isPublic) {
      // Infrastructure failure is not an empty registry. Make it retryable and
      // omit every CDN cache header so the outage response cannot replace a
      // healthy public snapshot at the shared cache key.
      const response = jsonResponse(
        { error: 'Bootstrap service temporarily unavailable' },
        503,
        {
          ...getPublicCorsHeaders(),
          'Cache-Control': 'no-store',
          'Retry-After': '5',
        },
      );
      return measureR2Shadow
        ? finishBootstrapR2ShadowResponse(
            req,
            ctx,
            tier,
            response,
            Math.max(0, performance.now() - redisStartedAt),
          )
        : response;
    }
    return jsonResponse({ data: {}, missing: names }, 200, { ...cors, 'Cache-Control': 'no-store' });
  }

  const data = {};
  const missing = [];
  for (let i = 0; i < names.length; i++) {
    const val = cached.get(keys[i]);
    if (val !== undefined) {
      let responseValue = val;
      // Strip seed-internal metadata not intended for API clients
      if (names[i] === 'forecasts' && val != null && 'enrichmentMeta' in val) {
        const { enrichmentMeta: _stripped, ...rest } = val;
        responseValue = rest;
      }
      if (names[i] === 'wildfires') responseValue = compactWildfireBootstrapPayload(responseValue);
      data[names[i]] = responseValue;
    } else {
      missing.push(names[i]);
    }
  }

  // Stop before jsonResponse serializes the final body. That serialization also
  // exists on the future R2 serving path, so counting it as Redis-replaceable
  // work would make C_happy optimistic, especially for the larger slow tier.
  const redisDurationMs = measureR2Shadow
    ? Math.max(0, performance.now() - redisStartedAt)
    : null;
  // The browser runtime sends API requests with credentials so session and
  // entitlement cookies can ride along. Credentialed requests cannot consume
  // ACAO: * responses, even for public bootstrap data.
  // On-demand keys carry slow-tier seed data, so they get the slow-tier CDN
  // profile (s-maxage=7200) rather than the 600s default that a tier-less
  // `?keys=` request would otherwise fall back to.
  const cacheTier = tier ?? (auth.kind === 'public-on-demand' ? 'slow' : null);
  const response = jsonResponse({ data, missing }, 200, successCacheHeaders(cacheTier, auth.kind, cors));
  return measureR2Shadow
    ? finishBootstrapR2ShadowResponse(req, ctx, tier, response, redisDurationMs)
    : response;
}

export const __testing__ = {
  resetBootstrapR2ShadowForTests() {
    nextBootstrapR2ShadowProbeIsCold = true;
    scheduleBootstrapR2Shadow = vercelWaitUntil;
  },
  setWaitUntilForTests(waitUntil) {
    scheduleBootstrapR2Shadow = waitUntil;
  },
};
