import { sha256Hex } from './_crypto.js';
import { redisPipeline } from './_upstash-json.js';
import {
  RATE_LIMIT_DEGRADED_HEADERS,
  getClientIp,
} from './_client-ip.js';

const USER_API_KEY_RE = /^wm_[a-f0-9]{40}$/;
const CONVEX_VALIDATE_PATH = '/api/internal-validate-api-key';
const CONVEX_ENTITLEMENTS_PATH = '/api/internal-entitlements';
const VALIDATION_TIMEOUT_MS = 3_000;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX = 600;
const RATE_LIMIT_PREFIX = 'rl:bootstrap-user-api-key:';
const RATE_LIMIT_REDIS_TIMEOUT_MS = 1_000;
const USER_KEY_CACHE_TTL_SECONDS = 60;
const USER_KEY_NEGATIVE_CACHE_TTL_SECONDS = 60;
const USER_KEY_CACHE_PREFIX = 'user-api-key:';
const BOOTSTRAP_USER_KEY_NEGATIVE_CACHE_PREFIX = 'bootstrap-user-api-key-invalid:';
const ENTITLEMENT_CACHE_TTL_SECONDS = 900;
// Mirrors server/_shared/entitlement-check.ts (this .js file cannot import the
// .ts module under node --test; tests/billing-marker-ttl-parity.test.mjs pins
// the two copies together): lapsed markers stay short because their TTL is
// the worst-case wrongful-denial window; not_applicable markers get the full
// default TTL because syncEntitlementCache unconditionally overwrites the key
// on any tier change.
const LAPSED_BILLING_MARKER_TTL_SECONDS = 60;
const NOT_APPLICABLE_VERIFICATION_TTL_SECONDS = 900;
const ENTITLEMENT_ENV_PREFIX = process.env.DODO_PAYMENTS_ENVIRONMENT === 'live_mode' ? 'live' : 'test';
const NEG_SENTINEL = '__WM_NEG__';

const userKeyInFlight = new Map();
const entitlementInFlight = new Map();

function getServerRedisKeyPrefix() {
  const env = process.env.VERCEL_ENV;
  if (!env || env === 'production') return '';
  const sha = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || 'dev';
  return `${env}:${sha}:`;
}

function userApiKeyCacheKey(keyHash) {
  return `${getServerRedisKeyPrefix()}${USER_KEY_CACHE_PREFIX}${keyHash}`;
}

function bootstrapUserApiKeyNegativeCacheKey(keyHash) {
  return `${getServerRedisKeyPrefix()}${BOOTSTRAP_USER_KEY_NEGATIVE_CACHE_PREFIX}${keyHash}`;
}

function convexConfig() {
  const siteUrl = process.env.CONVEX_SITE_URL || '';
  const sharedSecret = process.env.CONVEX_SERVER_SHARED_SECRET || '';
  if (!siteUrl || !sharedSecret) return null;
  return { siteUrl, sharedSecret };
}

function noStoreHeaders(extra = {}) {
  return { 'Cache-Control': 'no-store', ...extra };
}

function rateLimitUnavailable(stage) {
  console.warn(`[bootstrap-user-api-key] rate-limit unavailable stage=${stage}`);
  return {
    ok: false,
    status: 503,
    error: 'Rate-limit service temporarily unavailable',
    headers: noStoreHeaders(RATE_LIMIT_DEGRADED_HEADERS),
  };
}

function validationUnavailable(stage, detail = '') {
  const suffix = detail ? ` ${detail}` : '';
  console.warn(`[bootstrap-user-api-key] validation unavailable stage=${stage}${suffix}`);
  return { ok: false, unavailable: true };
}

// Returned when key/entitlement validation cannot be performed (Convex
// unreachable, timed out, 5xx, or unconfigured). A 503 + Retry-After is the
// honest retryable signal — distinct from a genuinely invalid key (401) or a
// lapsed subscription (403). Mirrors the rate-limiter's fail-closed posture so
// the bootstrap caller can propagate status/headers uniformly. The error string
// is generic and leaks no infrastructure detail.
const VALIDATION_RETRY_AFTER_SECONDS = 5;
function serviceUnavailable() {
  return {
    ok: false,
    status: 503,
    error: 'Service temporarily unavailable',
    unavailable: true,
    // X-Validation-Mode mirrors the rate-limiter's X-RateLimit-Mode: degraded
    // marker so observability can correlate validation-service outages without
    // parsing the body; Retry-After signals the failure is transient.
    headers: noStoreHeaders({
      'Retry-After': String(VALIDATION_RETRY_AFTER_SECONDS),
      'X-Validation-Mode': 'degraded',
    }),
  };
}

function cacheUnavailable(stage) {
  console.warn(`[bootstrap-user-api-key] auth-cache unavailable stage=${stage}`);
}

async function readCachedJson(key) {
  const result = await redisPipeline([['GET', key]], 1_000);
  if (!result) return { status: 'unavailable' };

  const raw = result[0]?.result;
  if (raw == null) return { status: 'miss' };

  try {
    return { status: 'hit', value: JSON.parse(String(raw)) };
  } catch {
    cacheUnavailable('invalid-json');
    return { status: 'unavailable' };
  }
}

async function writeCachedJson(key, value, ttlSeconds) {
  const result = await redisPipeline([
    ['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)],
  ], 1_000);
  if (!result) cacheUnavailable('write-failed');
}

async function coalesce(map, key, load) {
  const existing = map.get(key);
  if (existing) return existing;

  const promise = load();
  map.set(key, promise);
  try {
    return await promise;
  } finally {
    map.delete(key);
  }
}

export function isCanonicalUserApiKey(key) {
  return USER_API_KEY_RE.test(key || '');
}

export async function checkBootstrapUserApiKeyRateLimit(req) {
  const identifier = getClientIp(req);
  const cacheKey = `${RATE_LIMIT_PREFIX}${identifier}`;
  const result = await redisPipeline([
    ['INCR', cacheKey],
    ['EXPIRE', cacheKey, String(RATE_LIMIT_WINDOW_SECONDS), 'NX'],
    ['TTL', cacheKey],
  ], RATE_LIMIT_REDIS_TIMEOUT_MS);

  if (!result) {
    return rateLimitUnavailable('redis-unavailable');
  }

  const count = Number(result[0]?.result ?? 0);
  if (!Number.isFinite(count) || count < 1) {
    return rateLimitUnavailable('invalid-count');
  }

  const ttl = Number(result[2]?.result ?? -1);
  // Redis TTL returns -1 (no expiry / immortal counter) or -2 (key gone) on the
  // genuine missing-expiry failure. A TTL of 0 is the normal sub-second tail of
  // an active fixed window (counter still exists, about to reset), so accept it
  // rather than fail-closing a valid under-limit request with a spurious 503.
  if (!Number.isFinite(ttl) || ttl < 0) {
    return rateLimitUnavailable('missing-expiry');
  }

  if (count > RATE_LIMIT_MAX) {
    return {
      ok: false,
      status: 429,
      error: 'Too many requests',
      headers: noStoreHeaders({ 'Retry-After': String(Math.ceil(ttl)) }),
    };
  }

  return { ok: true };
}

async function postConvexJson(path, body) {
  const config = convexConfig();
  if (!config) return validationUnavailable('missing-config');

  let resp;
  try {
    resp = await fetch(`${config.siteUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'worldmonitor-bootstrap/1.0',
        'x-convex-shared-secret': config.sharedSecret,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    });
  } catch {
    return validationUnavailable('fetch-error');
  }

  if (!resp.ok) return validationUnavailable('http-error', `status=${resp.status}`);

  try {
    return { ok: true, value: await resp.json() };
  } catch {
    return validationUnavailable('invalid-json');
  }
}

export async function validateBootstrapUserApiKey(key) {
  if (!isCanonicalUserApiKey(key)) {
    return { ok: false, status: 401, error: 'Invalid API key', reason: 'malformed' };
  }

  const keyHash = await sha256Hex(key);
  return coalesce(userKeyInFlight, keyHash, () => validateBootstrapUserApiKeyHash(keyHash));
}

async function validateBootstrapUserApiKeyHash(keyHash) {
  const cacheKey = userApiKeyCacheKey(keyHash);
  const cached = await readCachedJson(cacheKey);
  if (cached.status === 'hit') {
    if (cached.value && typeof cached.value === 'object' && typeof cached.value.userId === 'string' && cached.value.userId.length > 0) {
      return { ok: true, userId: cached.value.userId };
    }
  }

  // The gateway also owns user-api-key:<hash> and represents both invalid keys
  // and some validator failures with the shared NEG_SENTINEL. Treat that
  // sentinel as a cache miss here so bootstrap can preserve retryable 503s.
  const negativeCacheKey = bootstrapUserApiKeyNegativeCacheKey(keyHash);
  const cachedNegative = await readCachedJson(negativeCacheKey);
  if (cachedNegative.status === 'hit' && cachedNegative.value === NEG_SENTINEL) {
    return { ok: false, status: 401, error: 'Invalid API key', reason: 'cached-invalid' };
  }

  const result = await postConvexJson(CONVEX_VALIDATE_PATH, { keyHash });
  if (!result.ok) {
    return serviceUnavailable();
  }

  const value = result.value;
  if (!value || typeof value !== 'object' || typeof value.userId !== 'string' || value.userId.length === 0) {
    await writeCachedJson(negativeCacheKey, NEG_SENTINEL, USER_KEY_NEGATIVE_CACHE_TTL_SECONDS);
    return { ok: false, status: 401, error: 'Invalid API key', reason: 'invalid' };
  }

  // Cache the full gateway-shared shape ({ userId, keyId, name }) so the
  // gateway's validateUserApiKey (server/_shared/user-api-key.ts) — which reads
  // and writes the same `user-api-key:<hash>` key typed as UserKeyResult — never
  // reads back a value with keyId/name undefined when bootstrap won the cache
  // race. Convex validateKeyByHash returns `id`, so map it to `keyId` here.
  await writeCachedJson(
    cacheKey,
    { userId: value.userId, keyId: value.id, name: value.name },
    USER_KEY_CACHE_TTL_SECONDS,
  );
  return {
    ok: true,
    userId: value.userId,
  };
}

function hasCurrentApiAccess(value) {
  if (!value || typeof value !== 'object') return false;
  const validUntil = Number(value.validUntil ?? 0);
  return Boolean(value.features?.apiAccess === true && Number.isFinite(validUntil) && validUntil >= Date.now());
}

function clampRetryAfterSeconds(rawRetryAfter) {
  const parsed = Number(rawRetryAfter);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(60, Math.ceil(parsed)))
    : VALIDATION_RETRY_AFTER_SECONDS;
}

function billingVerificationFailure(value) {
  const status = value?.billingStatus;
  if (status === 'subscription_lapsed') {
    return {
      ok: false,
      status: 403,
      error: 'API access subscription lapsed',
      reason: status,
      headers: noStoreHeaders({ 'X-Billing-Verification': status }),
    };
  }
  if (status !== 'renewal_verification_pending' && status !== 'renewal_verification_failed') {
    return null;
  }

  const retryAfter = clampRetryAfterSeconds(value?.retryAfterSeconds);
  return {
    ok: false,
    status: 503,
    error: status === 'renewal_verification_pending'
      ? 'Renewal verification pending'
      : 'Renewal verification failed',
    reason: status,
    unavailable: true,
    headers: noStoreHeaders({
      'Retry-After': String(retryAfter),
      'X-Billing-Verification': status,
    }),
  };
}

function notApplicableVerificationTtlSeconds(value) {
  const marker = value?.renewalVerificationFreshness;
  if (marker?.status !== 'not_applicable') return null;
  if (typeof marker.checkedAt !== 'number' || !Number.isFinite(marker.checkedAt)) return null;
  const remainingMs = marker.checkedAt
    + NOT_APPLICABLE_VERIFICATION_TTL_SECONDS * 1_000
    - Date.now();
  return remainingMs > 0
    ? Math.max(1, Math.min(
      NOT_APPLICABLE_VERIFICATION_TTL_SECONDS,
      Math.ceil(remainingMs / 1_000),
    ))
    : null;
}

function entitlementCacheTtlSeconds(value) {
  const status = value?.billingStatus;
  if (status === 'subscription_lapsed') return LAPSED_BILLING_MARKER_TTL_SECONDS;
  if (status === 'renewal_verification_pending' || status === 'renewal_verification_failed') {
    return clampRetryAfterSeconds(value?.retryAfterSeconds);
  }
  const notApplicableTtl = notApplicableVerificationTtlSeconds(value);
  return notApplicableTtl ?? ENTITLEMENT_CACHE_TTL_SECONDS;
}

export async function validateBootstrapUserApiAccess(userId) {
  if (!userId || typeof userId !== 'string') {
    return { ok: false, status: 403, error: 'API access subscription required', reason: 'missing-user' };
  }

  return coalesce(entitlementInFlight, userId, () => validateBootstrapUserApiAccessUncached(userId));
}

async function validateBootstrapUserApiAccessUncached(userId) {
  const cacheKey = `entitlements:${ENTITLEMENT_ENV_PREFIX}:${userId}`;
  const cached = await readCachedJson(cacheKey);
  if (cached.status === 'hit' && cached.value && typeof cached.value === 'object') {
    if (hasCurrentApiAccess(cached.value)) return { ok: true };
    const cachedBillingFailure = billingVerificationFailure(cached.value);
    if (cachedBillingFailure) return cachedBillingFailure;
    if (notApplicableVerificationTtlSeconds(cached.value) !== null) {
      return { ok: false, status: 403, error: 'API access subscription required', reason: 'cached-forbidden' };
    }
    const validUntil = Number(cached.value.validUntil ?? 0);
    if (Number.isFinite(validUntil) && validUntil >= Date.now()) {
      return { ok: false, status: 403, error: 'API access subscription required', reason: 'cached-forbidden' };
    }
  }

  const result = await postConvexJson(CONVEX_ENTITLEMENTS_PATH, { userId });
  if (!result.ok) {
    // The entitlement backend could not be reached to verify a wm_ key: emit
    // the documented entitlement_verification_unavailable contract
    // (docs/usage-errors.mdx), matching server/gateway.ts's wm_-key branch.
    // X-Validation-Mode: degraded is kept for existing monitors.
    return {
      ok: false,
      status: 503,
      error: 'Unable to verify API access',
      reason: 'entitlement_verification_unavailable',
      unavailable: true,
      headers: noStoreHeaders({
        'Retry-After': String(VALIDATION_RETRY_AFTER_SECONDS),
        'X-Validation-Mode': 'degraded',
        'X-Billing-Verification': 'entitlement_verification_unavailable',
      }),
    };
  }

  if (result.value && typeof result.value === 'object') {
    await writeCachedJson(cacheKey, result.value, entitlementCacheTtlSeconds(result.value));
  }

  if (hasCurrentApiAccess(result.value)) return { ok: true };
  const billingFailure = billingVerificationFailure(result.value);
  if (billingFailure) return billingFailure;

  return { ok: false, status: 403, error: 'API access subscription required', reason: 'forbidden' };
}
