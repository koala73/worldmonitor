import { waitUntil as vercelWaitUntil } from '@vercel/functions';

import {
  PUBLIC_BOOTSTRAP_TIERS,
  classifyPublicBootstrapRequest,
} from './_bootstrap-public-tier.js';
export {
  isPublicOnDemandBootstrapRequest,
  isPublicTierBootstrapRequest,
  isPublicWeatherBootstrapRequest,
} from './_bootstrap-public-tier.js';
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
import {
  PUBLIC_WEATHER_BOOTSTRAP_KEY,
  bootstrapTierKeyNames,
  resolveBootstrapRegistry,
} from './_bootstrap-tier-keys.js';
import { compactNaturalEventsDashboardPayload } from './_natural-events-dashboard.js';
import { compactWildfireDashboardPayload } from './_wildfire-dashboard.js';
import {
  canadaAlertsCutoverFallbackValue,
  extraCanadaAlertsCutoverReadKeys,
} from './_canada-alerts-cutover.js';
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

// Temporary #6659 cutover fallback. Keep the new multi-province aggregate
// authoritative, but let bootstrap clients use the Alberta sibling first and
// the abandoned legacy key second until alerts:canada:v1 has been published
// in every environment.
// R4 (#6654) fields that must never appear in a bootstrap-tier payload.
// `text` is the X post body: the first-party panel may render it (via
// /api/x-feed), but alerts, MCP, and embed/OEM partners get derived facts plus
// a permalink only. `pollState` is seed-internal cursor state.
// Kept in sync with stripXFeedRestrictedFields in scripts/publish-bootstrap-tiers.mjs.
export function stripXFeedRestrictedFields(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return value;
  const { pollState: _pollState, ...rest } = value;
  if (!Array.isArray(rest.items)) return rest;
  return {
    ...rest,
    items: rest.items.map((item) => {
      if (item == null || typeof item !== 'object' || Array.isArray(item)) return item;
      const { text: _text, ...itemRest } = item;
      return itemRest;
    }),
  };
}

function bootstrapRedisReadKeys(keys) {
  const extra = extraCanadaAlertsCutoverReadKeys(keys, BOOTSTRAP_CACHE_KEYS.canadaAlerts);
  return extra.length > 0 ? [...keys, ...extra] : keys;
}

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
// An on-demand key with no entry here inherits the SLOW shield (s-maxage=7200,
// 2h). Any key published more often than that MUST declare a profile: the CDN
// would otherwise hand browsers a payload api/health.js already calls
// STALE_SEED, and the client stamps it fresh on arrival — a green freshness
// panel over data nobody re-fetched, with nothing to page on because health
// reads Redis and never sees the cached copy.
//
// Size `cdn` to the publisher's own interval, not to the freshness budget: the
// budget is 2-3x the interval to absorb a missed tick, so caching out to the
// budget guarantees the shield outlives a complete seed cycle.
// tests/bootstrap-on-demand-cache-budget.test.mts enforces the ceiling.
const ON_DEMAND_CACHE_PROFILES = {
  // Correlation cards publish every 5 minutes and have a 30-minute health
  // budget. The conservative complete CDN window is 11m.
  correlationCards: {
    browser: 'max-age=60, stale-while-revalidate=60, stale-if-error=300',
    cdn: 'public, s-maxage=300, stale-while-revalidate=60, stale-if-error=300',
  },
  // Hourly publisher, 90-minute health budget. The conservative full CDN
  // serving window is 80m, so one failed refresh cannot be hidden past health.
  forecasts: {
    browser: 'max-age=300, stale-while-revalidate=300, stale-if-error=1800',
    cdn: 'public, s-maxage=3600, stale-while-revalidate=300, stale-if-error=900',
  },
  // Seeded every 15 minutes. Keep the caller-invariant public URL from
  // outliving a complete seed interval; per-group stale/unavailable states
  // remain part of the payload contract.
  chinaDecisionSignals: {
    browser: 'max-age=60, stale-while-revalidate=120, stale-if-error=900',
    cdn: 'public, s-maxage=900, stale-while-revalidate=120, stale-if-error=900',
  },
  // Both published by seed-provincial-511 on one 15min member interval against
  // a 45min health budget. They only need a profile because #6763 moved them
  // off the fast tier, where they inherited the fast shield: without this the
  // move would have traded 508 KB of universal page weight for a 2h stale
  // window on live road closures.
  canadaRoads: {
    browser: 'max-age=60, stale-while-revalidate=120, stale-if-error=900',
    cdn: 'public, s-maxage=900, stale-while-revalidate=120, stale-if-error=900',
  },
  albertaRoads: {
    browser: 'max-age=60, stale-while-revalidate=120, stale-if-error=900',
    cdn: 'public, s-maxage=900, stale-while-revalidate=120, stale-if-error=900',
  },
  manitobaRoads: {
    browser: 'max-age=60, stale-while-revalidate=120, stale-if-error=900',
    cdn: 'public, s-maxage=900, stale-while-revalidate=120, stale-if-error=900',
  },
  // seed-bundle-canada member interval 30min, 90min health budget. The default
  // 2h shield outlived the budget by half an hour (#6667).
  bcOpen511: {
    browser: 'max-age=60, stale-while-revalidate=120, stale-if-error=1800',
    cdn: 'public, s-maxage=1800, stale-while-revalidate=300, stale-if-error=1800',
  },
  // seed-bundle-market-backup member interval 15min, 45min health budget. Same
  // defect as bcOpen511: the default 2h shield was 2.6x the budget.
  marketCorrelationSeries: {
    browser: 'max-age=60, stale-while-revalidate=120, stale-if-error=900',
    cdn: 'public, s-maxage=900, stale-while-revalidate=120, stale-if-error=900',
  },
  // Planned IMD cyclone/port/coastal/marine seeder on a 15min interval against
  // a 45min health budget (#7005). The public on-demand URL would otherwise
  // inherit the 2h slow shield and outlive health's stale declaration.
  imdCycloneMarine: {
    browser: 'max-age=60, stale-while-revalidate=120, stale-if-error=900',
    cdn: 'public, s-maxage=900, stale-while-revalidate=120, stale-if-error=900',
  },
  // seed-aviation aggregate, 90min health budget. Default 2h on-demand
  // shield would outlive the budget after #7046 moved this key off FAST.
  flightDelays: {
    browser: 'max-age=60, stale-while-revalidate=120, stale-if-error=1800',
    cdn: 'public, s-maxage=1800, stale-while-revalidate=300, stale-if-error=1800',
  },
};

// The legacy unmarked weather URL: `?keys=weatherAlerts` with no credentials.
// Still anonymous and still serves the public payload — it is a documented
// public path (docs/api-platform.mdx) and the only bootstrap read the map embed
// could make before the marked URL existed — but it is NEVER shared-cacheable.
//
// That is the whole of #5386: this is the SAME URL a credentialed caller uses,
// and a CDN hit precedes handler auth, so while a warm public entry sat here it
// answered an invalid-key request with the cached anonymous 200 instead of the
// origin's 401. The origin and the edge disagreed about one URL. Keeping every
// response on this URL no-store means the edge never holds an entry that can
// answer for the origin, so an invalid key always reaches validateApiKey.
//
// Deliberately NOT built on the marked public classifier: this predicate is the
// pre-#5386 one, kept verbatim. It accepts HEAD and tolerates whitespace forms
// that the marked shape rejects. Reusing the strict classifier here would narrow
// which requests still reach the documented anonymous path.
export function isAnonymousWeatherBootstrapRequest(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  const url = new URL(req.url);
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  if (pathname !== '/api/bootstrap') return false;

  const params = Array.from(url.searchParams.keys());
  if (params.some((key) => key !== 'keys')) return false;

  const keyParams = url.searchParams.getAll('keys');
  if (keyParams.length !== 1) return false;

  const requested = keyParams[0].split(',').map((key) => key.trim()).filter(Boolean);
  return requested.length === 1 && requested[0] === PUBLIC_WEATHER_BOOTSTRAP_KEY;
}

let nextBootstrapR2ShadowProbeIsCold = true;
let scheduleBootstrapR2Shadow = vercelWaitUntil;
let readBootstrapR2ShadowTier = readBootstrapTierObject;

function shouldMeasureBootstrapR2Shadow(authKind, tier) {
  return process.env.BOOTSTRAP_R2_SHADOW_MEASURE === '1'
    && process.env.VERCEL_ENV === 'production'
    && authKind === 'public-tier'
    && PUBLIC_BOOTSTRAP_TIERS.has(tier);
}

function finishBootstrapR2ShadowResponse(req, ctx, tier, response, redisDurationMs) {
  const serializedRedisDurationMs = redisDurationMs.toFixed(3);
  response.headers.set('Server-Timing', `wm_bootstrap_redis;dur=${serializedRedisDurationMs}`);
  // Vercel strips user-authored Server-Timing from Edge responses. Keep it for
  // runtimes that preserve the standard header, but expose the same temporary
  // U3a diagnostic through a platform-safe header so browser RUM can observe it.
  response.headers.set('X-WorldMonitor-Bootstrap-Redis-Duration', serializedRedisDurationMs);
  // A browser cache replay preserves the origin-MISS headers and would make a
  // local response look like a fresh origin sample. Disable only browser
  // storage during U3a; CDN-Cache-Control continues to shield the Vercel origin.
  response.headers.set('Cache-Control', 'no-store');
  const exposedHeaders = response.headers.get('Access-Control-Expose-Headers');
  response.headers.set(
    'Access-Control-Expose-Headers',
    [
      exposedHeaders,
      'Server-Timing',
      'X-WorldMonitor-Bootstrap-Redis-Duration',
      'Age',
      'X-Vercel-Cache',
      'CF-Cache-Status',
    ]
      .filter(Boolean)
      .join(', '),
  );

  const executionCold = nextBootstrapR2ShadowProbeIsCold;
  nextBootstrapR2ShadowProbeIsCold = false;
  const deliverProbeResult = (result) => deliverBootstrapR2Shadow({
    r2Outcome: result.status === 'ok' ? 'r2' : 'fallback',
    r2Reason: result.status === 'fallback' ? result.reason : null,
    bootstrapTier: tier,
    r2DurationMs: result.durationMs,
    redisDurationMs,
    executionRegion: deriveExecutionRegion(req) ?? process.env.VERCEL_REGION ?? 'unknown',
    executionCold,
    status: response.status,
  });
  const probe = readBootstrapR2ShadowTier(tier, {
    timeoutMs: BOOTSTRAP_R2_PROBE_CEILING_MS,
  }).then(deliverProbeResult).catch(() => {
    // readBootstrapTierObject is fail-soft by contract. Preserve that contract
    // if a future implementation accidentally throws before producing a result.
    return deliverProbeResult({
      status: 'fallback',
      reason: 'unreadable',
      durationMs: 0,
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
export { compactNaturalEventsDashboardPayload };

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
  const publicBootstrap = classifyPublicBootstrapRequest(req);
  if (publicBootstrap) {
    return { ok: true, kind: publicBootstrap.authKind };
  }
  if (!headerKey && !hasBootstrapCredentialCookie(req)) {
    if (isAnonymousWeatherBootstrapRequest(req)) {
      return { ok: true, kind: 'anonymous-weather' };
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
          {
            error: entitlementResult.error,
            // Billing-verification denials (#4770) expose their machine-readable
            // code in the body, matching the {error, code} shape the REST
            // gateway emits for the same statuses.
            ...(entitlementResult.headers?.['X-Billing-Verification']
              ? { code: entitlementResult.reason }
              : {}),
          },
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

// Kinds that serve the shared public seed payload with no per-user variation.
// They all get ACAO:* and the retryable-outage contract; only the subset below
// is additionally allowed into a shared cache.
function isPublicBootstrapKind(authKind) {
  return authKind === 'public-weather'
    || authKind === 'anonymous-weather'
    || authKind === 'public-tier'
    || authKind === 'public-on-demand';
}

// Only the explicitly-marked `&public=1` URLs may be stored by a shared cache.
// The unmarked weather URL is public but no-store — see
// isAnonymousWeatherBootstrapRequest for why (#5386).
function isSharedCacheableBootstrapKind(authKind) {
  return authKind === 'public-weather' || authKind === 'public-tier' || authKind === 'public-on-demand';
}

function getPublicBootstrapHeaders() {
  return {
    ...getPublicCorsHeaders(),
    'Timing-Allow-Origin': '*',
  };
}

// `tier` is the requested tier, or null for a single-key read. The on-demand
// default lives here rather than at the call site so there is ONE resolution
// path: a test that re-derived "on-demand falls back to slow" would be checking
// its own copy of the rule, which is the rule that was wrong (#6763).
function successCacheHeaders(requestedTier, authKind, cors, onDemandKey = null) {
  // Most on-demand keys carry slow-tier seed data. Keys with a faster publisher
  // cadence must override that through ON_DEMAND_CACHE_PROFILES — the slow CDN
  // shield is 2h, which outlives the freshness budget of anything seeded more
  // often than that.
  const tier = requestedTier ?? (authKind === 'public-on-demand' ? 'slow' : null);
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
  const publicCors = getPublicBootstrapHeaders();
  if (!isSharedCacheableBootstrapKind(authKind)) {
    return {
      ...publicCors,
      'Cache-Control': 'no-store',
    };
  }
  const onDemandProfile = authKind === 'public-on-demand'
    ? ON_DEMAND_CACHE_PROFILES[onDemandKey]
    : null;
  const cacheControl = onDemandProfile?.browser
    || (tier && TIER_CACHE[tier])
    || 'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=900';
  return {
    ...publicCors,
    'Cache-Control': cacheControl,
    'CDN-Cache-Control': onDemandProfile?.cdn
      || (tier && TIER_CDN_CACHE[tier])
      || TIER_CDN_CACHE.fast,
  };
}

export default async function handler(req, ctx) {
  // no-store because this rejection is decided by the Origin header, which no
  // cache layer here keys on (CF ignores Vary — see TIER_CACHE above). Without
  // it, a 403 minted by one disallowed origin is an ordinary cacheable response
  // on a `&public=1` URL that every other caller shares, and a shared cache is
  // free to replay it to legitimate ones. Same reasoning as the split below:
  // anything whose answer depends on the request must never be cacheable.
  if (isDisallowedOrigin(req))
    return new Response('Forbidden', { status: 403, headers: { 'Cache-Control': 'no-store' } });

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
    cached = await getCachedJsonBatch(
      bootstrapRedisReadKeys(keys),
      measureR2Shadow ? tier : null,
    );
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
          ...getPublicBootstrapHeaders(),
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
    const val = keys[i] === BOOTSTRAP_CACHE_KEYS.canadaAlerts
      && !cached.has(BOOTSTRAP_CACHE_KEYS.canadaAlerts)
      ? canadaAlertsCutoverFallbackValue(cached)
      : cached.get(keys[i]);
    if (val !== undefined) {
      let responseValue = val;
      // Strip seed-internal metadata not intended for API clients
      if (names[i] === 'forecasts' && val != null && 'enrichmentMeta' in val) {
        const { enrichmentMeta: _stripped, ...rest } = val;
        responseValue = rest;
      }
      // R4 (#6654): X post bodies must never leave the first-party path.
      // `?tier=slow&public=1` is unauthenticated, ACAO:*, and CDN-cacheable for
      // 2h, so anything here reaches embed/OEM and server-to-server callers —
      // exactly the audience R4 excludes. `xFeed` is deliberately NOT registered
      // in BOOTSTRAP_CACHE_KEYS (same as `telegramFeed`); this strip is the
      // regression guard if it is ever re-added. Post text is served only by
      // /api/x-feed. Mirrored in scripts/publish-bootstrap-tiers.mjs.
      if (names[i] === 'xFeed' && val != null && typeof val === 'object' && !Array.isArray(val)) {
        responseValue = stripXFeedRestrictedFields(val);
      }
      if (names[i] === 'wildfires') responseValue = compactWildfireBootstrapPayload(responseValue);
      if (names[i] === 'naturalEvents') responseValue = compactNaturalEventsDashboardPayload(responseValue);
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
  const onDemandKey = auth.kind === 'public-on-demand' && names.length === 1
    ? names[0]
    : null;
  // A public on-demand miss is an empty body, not a payload. Caching it at the
  // publisher interval would hide a recovered seeder until the shield expires
  // (#6784): health probes Redis, so nothing pages, and the client stamps the
  // empty hit as a fresh read.
  const cacheHeaders = onDemandKey && missing.includes(onDemandKey)
    ? { ...getPublicBootstrapHeaders(), 'Cache-Control': 'no-store' }
    : successCacheHeaders(tier, auth.kind, cors, onDemandKey);
  const response = jsonResponse(
    { data, missing },
    200,
    cacheHeaders,
  );
  return measureR2Shadow
    ? finishBootstrapR2ShadowResponse(req, ctx, tier, response, redisDurationMs)
    : response;
}

export const __testing__ = {
  // The real resolver, so the CDN-shield guard in
  // tests/bootstrap-on-demand-cache-budget.test.mts calls the same code the
  // handler does instead of restating the fallback chain.
  successCacheHeaders,
  resetBootstrapR2ShadowForTests() {
    nextBootstrapR2ShadowProbeIsCold = true;
    scheduleBootstrapR2Shadow = vercelWaitUntil;
    readBootstrapR2ShadowTier = readBootstrapTierObject;
  },
  setWaitUntilForTests(waitUntil) {
    scheduleBootstrapR2Shadow = waitUntil;
  },
  setBootstrapR2ShadowReaderForTests(reader) {
    readBootstrapR2ShadowTier = reader;
  },
};
