import { sha256Hex } from './_crypto.js';
import { redisPipeline } from './_upstash-json.js';
import {
  RATE_LIMIT_DEGRADED_HEADERS,
  getClientRateLimitKey,
} from './_client-ip.js';
// Plain JS with a .d.ts beside it, written for exactly this import (the same
// pairing as shared/bootstrap-tier-keys.js); lint-boundaries allows shared/.
import { DESKTOP_KEY_LIMIT_ERROR, admitsDesktopKeyPrincipal } from '../shared/desktop-key-access.js';
import { chargeDesktopKeyBudget } from './_desktop-key-meter.js';

const USER_API_KEY_RE = /^wm_[a-f0-9]{40}$/;
// Plan 2026-10-25-001 (KTD3, KTD8). Cache-entry version for the shared
// user-api-key:<hash> entry; tests/user-api-key-desktop-kind.test.mts pins it
// equal to the copy in server/_shared/user-api-key.ts. A hit without it is
// re-validated at Convex, never trusted and never a 401.
const USER_API_KEY_CACHE_VERSION = 2;
const USER_API_KEY_KINDS = new Set(['api', 'desktop']);
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
// Self-contained Edge entry: keep this local mirror pinned by API-key and
// Company Monitoring contract tests rather than importing TypeScript here.
const COMPANY_MONITORING_SCOPES = new Set(['company_monitoring:read', 'company_monitoring:write']);
const BOOTSTRAP_USER_KEY_NEGATIVE_CACHE_PREFIX = 'bootstrap-user-api-key-invalid:';
const ENTITLEMENT_CACHE_TTL_SECONDS = 900;
// Mirrors server/_shared/entitlement-check.ts (this .js file cannot import the
// .ts module under node --test; tests/billing-marker-ttl-parity.test.mjs pins
// the two copies together): both marker TTLs stay short because each is the
// worst-case wrongful-denial window for its cohort. The not_applicable marker
// is stamped only for a user with NO subscription row — which is also what a
// buyer looks like between checkout return and the Dodo webhook landing, so a
// long TTL turns a lost cache-write race into minutes of 403s for a paying
// customer (#5600). See the fuller note in entitlement-check.ts.
const LAPSED_BILLING_MARKER_TTL_SECONDS = 60;
const NOT_APPLICABLE_VERIFICATION_TTL_SECONDS = 60;
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

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNonEmptyString(value, field) {
  if (!Object.prototype.hasOwnProperty.call(value, field)) return false;
  return typeof value[field] === 'string' && value[field].length > 0;
}

// Company Monitoring binding rule shared by the Convex row and the cache
// entry: either no binding at all, or exact scopes AND an account.
function hasValidCompanyMonitoringBinding(value) {
  if (value.scopes === undefined && value.companyMonitoringAccountId === undefined) return true;
  if (!Array.isArray(value.scopes) || value.scopes.length === 0) return false;
  if (typeof value.companyMonitoringAccountId !== 'string' || value.companyMonitoringAccountId.length === 0) {
    return false;
  }
  return new Set(value.scopes).size === value.scopes.length &&
    value.scopes.every((scope) => typeof scope === 'string' && COMPANY_MONITORING_SCOPES.has(scope));
}

// A cache entry is trusted only in the current shape: version stamp, userId,
// keyId, an explicit known keyKind, and a valid (or absent) Company Monitoring
// binding. Anything else — a pre-version entry, a missing or unknown kind, a
// poisoned value — falls through to Convex (never trusted, never a 401).
function isCurrentUserKeyCacheEntry(value) {
  if (!isPlainObject(value)) return false;
  if (!Object.prototype.hasOwnProperty.call(value, 'v') || value.v !== USER_API_KEY_CACHE_VERSION) return false;
  if (!hasNonEmptyString(value, 'userId') || !hasNonEmptyString(value, 'keyId')) return false;
  if (typeof value.keyKind !== 'string' || !USER_API_KEY_KINDS.has(value.keyKind)) return false;
  if (value.activeKeyRank !== undefined && !isActiveKeyRank(value.activeKeyRank)) return false;
  return hasValidCompanyMonitoringBinding(value);
}

// 0-based rank among the owner's active keys of both kinds, oldest first
// (plan 2026-10-25-001 KTD5; computed by Convex validateKeyByHash). Optional
// on the entry: absent means Convex did not say, and the desktop-scope
// consumers fail closed on it. A rank is a non-negative integer, else dropped.
function isActiveKeyRank(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

// Convex validateKeyByHash returns `id`, not `keyId`; map it so the gateway
// (server/_shared/user-api-key.ts), which reads the same entry, never sees
// keyId undefined when bootstrap won the cache race. `keyKind` is explicit on
// every row Convex writes since U2; a row WITHOUT it can only come from a
// backend that predates the column, which cannot hold desktop rows (Deploy
// Order: the edge ships first, desktop creation stays off until the Convex
// deploy is live), so it is an `api` key. Any other value is contract drift:
// null here, which the caller denies like any unreadable payload (this
// module's existing posture), never a principal.
function toCacheEntry(value) {
  if (!isPlainObject(value)) return null;
  if (!hasNonEmptyString(value, 'userId') || !hasNonEmptyString(value, 'id')) return null;
  if (!hasValidCompanyMonitoringBinding(value)) return null;
  if (value.keyKind !== undefined && (typeof value.keyKind !== 'string' || !USER_API_KEY_KINDS.has(value.keyKind))) {
    return null;
  }
  return {
    v: USER_API_KEY_CACHE_VERSION,
    userId: value.userId,
    keyId: value.id,
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    keyKind: value.keyKind === undefined ? 'api' : value.keyKind,
    ...(isActiveKeyRank(value.activeKeyRank) ? { activeKeyRank: value.activeKeyRank } : {}),
    ...(value.scopes === undefined ? {} : { scopes: value.scopes }),
    ...(value.companyMonitoringAccountId === undefined
      ? {}
      : { companyMonitoringAccountId: value.companyMonitoringAccountId }),
  };
}

// Generic bootstrap auth accepts only legacy, unscoped user API keys.
function isGenericUserKeyResult(value) {
  return value.scopes === undefined && value.companyMonitoringAccountId === undefined;
}

function invalidKey(reason) {
  return { ok: false, status: 401, error: 'Invalid API key', reason };
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

// Both cache helpers below receive keys that are already final:
// user-api-key:<hash> and bootstrap-user-api-key-invalid:<hash> carry the
// deployment prefix from getServerRedisKeyPrefix(), and entitlements:<env>:
// <userId> is deliberately cross-deployment (server/_shared/entitlement-check.ts
// reads it raw too, P2-3). Send the commands verbatim (#7674).
async function readCachedJson(key) {
  const result = await redisPipeline([['GET', key]], 1_000, true);
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
  ], 1_000, true);
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
  const identifier = getClientRateLimitKey(req);
  const cacheKey = `${RATE_LIMIT_PREFIX}${identifier}`;
  // App-owned rate-limit counter (#7674): rides the deployment-prefixed
  // default, matching the server layer's own prefixed rate-limit keys
  // (server/_shared/api-key-rate-limit.ts).
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

// Generic bootstrap/OAuth/telegram auth: only an explicit `api` kind with no
// Company Monitoring binding is a principal. A desktop key gets the same 401
// as an unknown key while its cache entry stays intact for the desktop-aware
// variant below (KTD3).
export async function validateBootstrapUserApiKey(key) {
  if (!isCanonicalUserApiKey(key)) return invalidKey('malformed');

  const keyHash = await sha256Hex(key);
  return validateUserApiKeyHash(keyHash);
}

// OAuth stores only the key hash. Reuse the same revocation and scope checks.
export async function validateUserApiKeyHash(keyHash) {
  const resolved = await resolveUserApiKeyHash(keyHash);
  if (!resolved.ok) return resolved;
  const { entry } = resolved;
  if (!isGenericUserKeyResult(entry) || entry.keyKind !== 'api') return invalidKey('invalid');
  return { ok: true, userId: entry.userId };
}

// Desktop-aware variant for the surfaces that admit desktop keys (bootstrap,
// U4). Returns the principal with its kind and hash for an `api` or `desktop`
// key; Company Monitoring-bound keys and unknown kinds are rejected exactly as
// in the generic validator. The caller decides what the kind may reach.
export async function validateBootstrapUserApiKeyPrincipal(key) {
  if (!isCanonicalUserApiKey(key)) return invalidKey('malformed');

  const keyHash = await sha256Hex(key);
  const resolved = await resolveUserApiKeyHash(keyHash);
  if (!resolved.ok) return resolved;
  const { entry } = resolved;
  if (!isGenericUserKeyResult(entry)) return invalidKey('invalid');
  return {
    ok: true,
    userId: entry.userId,
    keyId: entry.keyId,
    keyKind: entry.keyKind,
    keyHash,
    ...(entry.activeKeyRank === undefined ? {} : { activeKeyRank: entry.activeKeyRank }),
  };
}

// Cache-then-Convex lookup shared by every validator above. Resolves to
// `{ ok: true, entry }` with a current cache entry, or to the same failure
// objects the validators return (401 invalid / 503 unavailable).
async function resolveUserApiKeyHash(keyHash) {
  if (typeof keyHash !== 'string' || !/^[a-f0-9]{64}$/.test(keyHash)) return invalidKey('malformed');
  return coalesce(userKeyInFlight, keyHash, () => resolveUserApiKeyHashUncached(keyHash));
}

async function resolveUserApiKeyHashUncached(keyHash) {
  const cacheKey = userApiKeyCacheKey(keyHash);
  const cached = await readCachedJson(cacheKey);
  // Only a current-shape entry is trusted. A pre-version entry, a missing or
  // unknown kind, or a poisoned value falls through to Convex and is rewritten
  // (KTD8): "not trusted" is not "denied".
  if (cached.status === 'hit' && isCurrentUserKeyCacheEntry(cached.value)) {
    return { ok: true, entry: cached.value };
  }

  // The gateway also owns user-api-key:<hash> and represents both invalid keys
  // and some validator failures with the shared NEG_SENTINEL. Treat that
  // sentinel as a cache miss here so bootstrap can preserve retryable 503s.
  const negativeCacheKey = bootstrapUserApiKeyNegativeCacheKey(keyHash);
  const cachedNegative = await readCachedJson(negativeCacheKey);
  if (cachedNegative.status === 'hit' && cachedNegative.value === NEG_SENTINEL) {
    return invalidKey('cached-invalid');
  }

  const result = await postConvexJson(CONVEX_VALIDATE_PATH, { keyHash });
  if (!result.ok) {
    return serviceUnavailable();
  }

  // null is the definitive unknown/revoked answer. A non-null payload this
  // module cannot read (ownerless binding, unknown kind) is denied the same
  // way and never written to the shared positive entry.
  const entry = toCacheEntry(result.value);
  if (entry === null) {
    await writeCachedJson(negativeCacheKey, NEG_SENTINEL, USER_KEY_NEGATIVE_CACHE_TTL_SECONDS);
    return invalidKey('invalid');
  }

  // Cache the full gateway-shared shape, including immutable Company
  // Monitoring scope/account binding when present, so both validators see the
  // same principal contract.
  await writeCachedJson(cacheKey, entry, USER_KEY_CACHE_TTL_SECONDS);
  return { ok: true, entry };
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

function billingVerificationFailure(value, lapsedError = API_ACCESS_POLICY.lapsedError) {
  const status = value?.billingStatus;
  if (status === 'subscription_lapsed') {
    return {
      ok: false,
      status: 403,
      error: lapsedError,
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

// Which entitlement admits the principal. Both policies read the same
// `entitlements:<env>:<userId>` cache entry, which holds Convex's wire
// response — already merged with the catalog at read time
// (convex/entitlements.ts getEntitlementsHandler → mergeEntitlementFeatures),
// so `desktopKeyAccess` is present on every Pro row the edge sees, including
// rows written before the flag existed.
const API_ACCESS_POLICY = Object.freeze({
  name: 'api',
  admits: hasCurrentApiAccess,
  forbiddenError: 'API access subscription required',
  lapsedError: 'API access subscription lapsed',
});

// Desktop keys (plan 2026-10-25-001): covered and `desktopKeyAccess` or
// `apiAccess` (R8 upgrade case), decided by the shared predicate.
//
// `trustsCachedEntry`: a cache entry written before the catalog carried
// `desktopKeyAccess` — a current tier>=1 row with the field absent, not false
// — cannot answer this policy: the predicate reads absence as false and would
// deny a paying Pro owner until the entry expired. Such an entry is a MISS
// here and is refetched through Convex, whose read-time merge rewrites it with
// the flag. The API-access policy never reads the field and keeps the entry.
const DESKTOP_KEY_POLICY = Object.freeze({
  name: 'desktop',
  admits: (value) => isPlainObject(value) && isPlainObject(value.features)
    && admitsDesktopKeyPrincipal(value, Date.now()),
  trustsCachedEntry: (value) => {
    if (!isPlainObject(value) || !isPlainObject(value.features)) return true;
    const validUntil = Number(value.validUntil ?? 0);
    const current = Number.isFinite(validUntil) && validUntil >= Date.now();
    if (!current || !(Number(value.features.tier) >= 1)) return true;
    return value.features.desktopKeyAccess !== undefined;
  },
  forbiddenError: 'Pro subscription required',
  lapsedError: 'Subscription lapsed',
});

export async function validateBootstrapUserApiAccess(userId) {
  return validateBootstrapEntitlement(userId, API_ACCESS_POLICY);
}

// Which scope a validated wm_ principal gets on bootstrap (plan
// 2026-10-25-001 KTD4/KTD5/R5/R8), mirroring resolveUserKeyScope in
// server/_shared/desktop-key-principal.ts:
//   - `api` key whose owner has current apiAccess → { scope: 'api' } (today).
//     When that check could not run (Convex outage, 503) the outage is
//     returned as is: a second Convex call for the desktop check would double
//     the load on the dependency that just failed and answer the same way.
//   - `desktop` key whose owner has current apiAccess → desktop scope with no
//     cap (an API plan sells 0 desktop slots; AE7).
//   - either kind whose owner lacks apiAccess → the desktop check decides, and
//     only the owner's OLDEST active keys up to `maxDesktopKeys` qualify, by
//     the rank Convex reports — so a Pro Business owner who drops to Pro keeps
//     two of three desktop keys (R5). Beyond the cap is a 403 with one
//     sentence; an absent rank fails closed with the kind's own 403.
// Failures are the same objects the two entitlement checks return, so the
// caller renders them as before.
export async function resolveBootstrapUserKeyAccess(principal) {
  let rankUnknownFailure;
  if (principal.keyKind !== 'desktop') {
    const apiResult = await validateBootstrapUserApiAccess(principal.userId);
    if (apiResult.ok) return { ok: true, scope: 'api', entitlement: apiResult.entitlement };
    if (apiResult.unavailable || apiResult.status === 503) return apiResult;
    const desktopResult = await validateBootstrapDesktopKeyAccess(principal.userId);
    if (!desktopResult.ok) return apiResult;
    rankUnknownFailure = apiResult;
    return applyDesktopKeyCap(principal, desktopResult.entitlement, rankUnknownFailure);
  }
  const desktopResult = await validateBootstrapDesktopKeyAccess(principal.userId);
  if (!desktopResult.ok) return desktopResult;
  if (hasCurrentApiAccess(desktopResult.entitlement)) {
    return { ok: true, scope: 'desktop', entitlement: desktopResult.entitlement };
  }
  rankUnknownFailure = {
    ok: false, status: 403, error: DESKTOP_KEY_POLICY.forbiddenError, reason: 'rank-unknown',
  };
  return applyDesktopKeyCap(principal, desktopResult.entitlement, rankUnknownFailure);
}

// `activeKeyRank < maxDesktopKeys` for an owner without apiAccess. The rank is
// 0-based among the owner's active keys of both kinds, oldest first, computed
// by Convex validateKeyByHash; a missing rank is the caller's fail-closed 403.
function applyDesktopKeyCap(principal, entitlement, rankUnknownFailure) {
  const rank = principal.activeKeyRank;
  if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 0) return rankUnknownFailure;
  const cap = entitlement?.features?.maxDesktopKeys;
  if (typeof cap === 'number' && Number.isInteger(cap) && rank < cap) {
    return { ok: true, scope: 'desktop', entitlement };
  }
  return { ok: false, status: 403, error: DESKTOP_KEY_LIMIT_ERROR, reason: 'desktop-key-limit' };
}

// Per-account desktop-key meter on bootstrap (KTD6): the same owner-keyed
// day counter and burst bucket the gateway charges, through this entry's own
// Redis client, rendered by the shared contract in _desktop-key-meter.js so
// the 429 and the degraded 503 are byte-identical to the gateway's.
export async function checkBootstrapDesktopKeyBudget(userId, entitlement) {
  const budget = await chargeDesktopKeyBudget({
    userId,
    entitlement,
    pipeline: (commands) => redisPipeline(commands, RATE_LIMIT_REDIS_TIMEOUT_MS),
  });
  if (budget.ok) return { ok: true };
  if (budget.reason === 'unavailable') console.warn('[bootstrap-user-api-key] rate-limit unavailable stage=desktop-key-meter');
  return {
    ok: false,
    status: budget.status,
    error: String(budget.body.error),
    body: budget.body,
    headers: budget.headers,
  };
}

// Desktop variant of the bootstrap entitlement check (U3; wired by U4). Same
// cache, billing-verification contract and outage 503 as the API-plan check;
// only the admission predicate differs.
export async function validateBootstrapDesktopKeyAccess(userId) {
  return validateBootstrapEntitlement(userId, DESKTOP_KEY_POLICY);
}

async function validateBootstrapEntitlement(userId, policy) {
  if (!userId || typeof userId !== 'string') {
    return { ok: false, status: 403, error: policy.forbiddenError, reason: 'missing-user' };
  }

  // Keyed per policy: two checks for one owner must not share an answer.
  return coalesce(
    entitlementInFlight,
    `${policy.name}:${userId}`,
    () => validateBootstrapEntitlementUncached(userId, policy),
  );
}

async function validateBootstrapEntitlementUncached(userId, policy) {
  const cacheKey = `entitlements:${ENTITLEMENT_ENV_PREFIX}:${userId}`;
  const cached = await readCachedJson(cacheKey);
  if (
    cached.status === 'hit' && cached.value && typeof cached.value === 'object'
    && (policy.trustsCachedEntry === undefined || policy.trustsCachedEntry(cached.value))
  ) {
    if (policy.admits(cached.value)) return { ok: true, entitlement: cached.value };
    const cachedBillingFailure = billingVerificationFailure(cached.value, policy.lapsedError);
    if (cachedBillingFailure) return cachedBillingFailure;
    if (notApplicableVerificationTtlSeconds(cached.value) !== null) {
      return { ok: false, status: 403, error: policy.forbiddenError, reason: 'cached-forbidden' };
    }
    const validUntil = Number(cached.value.validUntil ?? 0);
    if (Number.isFinite(validUntil) && validUntil >= Date.now()) {
      return { ok: false, status: 403, error: policy.forbiddenError, reason: 'cached-forbidden' };
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

  if (policy.admits(result.value)) return { ok: true, entitlement: result.value };
  const billingFailure = billingVerificationFailure(result.value, policy.lapsedError);
  if (billingFailure) return billingFailure;

  return { ok: false, status: 403, error: policy.forbiddenError, reason: 'forbidden' };
}
