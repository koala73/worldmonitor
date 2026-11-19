/**
 * Validates user-owned API keys by hashing the provided key and looking up
 * the hash in Convex via the internal HTTP action.
 *
 * Uses cachedFetchJson for Redis caching with in-flight coalescing and
 * environment-partitioned keys (no raw=true — keys are prefixed by deploy).
 *
 * Plan 2026-10-25-001 (KTD3, KTD8): the cache entry `user-api-key:<hash>` is
 * shared with api/_user-api-key.js. Both producers write one versioned shape,
 * and a `wm_` key carries a server-side kind — `api` or `desktop`. The generic
 * validator admits only `api`; the desktop-aware variant returns the kind.
 */

import { cachedFetchJson, deleteRedisKey, readCachedJson, setCachedJson } from './redis.js';
import {
  COMPANY_MONITORING_RPC_SCOPES,
  type CompanyMonitoringApiScope,
} from '../../shared/company-monitoring-contract.js';

const COMPANY_MONITORING_SCOPES = new Set<string>(Object.values(COMPANY_MONITORING_RPC_SCOPES));

/** A `wm_` key's kind, fixed at creation (plan 2026-10-25-001 R7/R8). */
export type UserApiKeyKind = 'api' | 'desktop';
const USER_API_KEY_KINDS: ReadonlySet<string> = new Set<UserApiKeyKind>(['api', 'desktop']);

/**
 * Cache-entry version (KTD8). Both producers of `user-api-key:<hash>` stamp it;
 * a hit without the current value is re-validated at Convex and rewritten —
 * never trusted, never turned into a 401. Bump it when the entry's meaning
 * changes. tests/user-api-key-desktop-kind.test.mts pins it equal to the copy
 * in api/_user-api-key.js.
 */
const USER_API_KEY_CACHE_VERSION = 2;

/**
 * The one shape every producer writes to `user-api-key:<hash>`. `keyId` is
 * always set (Convex's `id` is mapped on the way in) and `keyKind` is always
 * explicit; Convex maps rows that predate the column to `api` at the source.
 */
interface UserKeyCacheEntry {
  v: number;
  userId: string;
  keyId: string;
  name?: string;
  keyKind: UserApiKeyKind;
  /**
   * 0-based rank among the owner's active keys of both kinds, oldest first
   * (KTD5 / R5; computed by Convex `validateKeyByHash`). Optional: an entry
   * written before Convex carried it, or by a backend that predates it, has
   * none, and the desktop-scope consumers fail CLOSED on an absent rank. Same
   * version stamp — the meaning of the existing fields is unchanged.
   */
  activeKeyRank?: number;
  scopes?: CompanyMonitoringApiScope[];
  companyMonitoringAccountId?: string;
}

/** What the generic validator hands to callers: a current `api` entry. */
export type UserKeyResult = UserKeyCacheEntry & { keyKind: 'api' };

/**
 * A validated `wm_` principal with its kind, for the three surfaces that opt
 * in to desktop keys (gateway, premium-check, bootstrap — U4). `keyHash` lets
 * those callers meter and invalidate by hash without re-digesting the key.
 */
export interface UserKeyPrincipal {
  userId: string;
  keyId: string;
  keyKind: UserApiKeyKind;
  keyHash: string;
  /** See `UserKeyCacheEntry.activeKeyRank`; absent when Convex did not say. */
  activeKeyRank?: number;
}

/**
 * Thrown when Convex validation cannot be performed (missing config, transport
 * failure, non-OK HTTP, invalid JSON/payload). Distinct from a definitive
 * unknown/revoked key (`null`). Callers that own HTTP responses (gateway, MCP)
 * should map this to a retryable 503; premium gates should fail closed.
 */
export class UserApiKeyUnavailableError extends Error {
  readonly code = 'validation_unavailable' as const;

  constructor(message: string) {
    super(message);
    this.name = 'UserApiKeyUnavailableError';
  }
}

export function isUserApiKeyUnavailableError(err: unknown): err is UserApiKeyUnavailableError {
  return err instanceof UserApiKeyUnavailableError;
}

/**
 * Canonical user API key: `wm_` + 40 lowercase hex (20 random bytes). This is
 * the only shape `generateKey()` in src/services/api-keys.ts ever mints.
 *
 * Deliberately DUPLICATED from `USER_API_KEY_RE` in api/_user-api-key.js rather
 * than imported: that module evaluates env at load and pulls in redisPipeline +
 * client-ip, none of which belong in the edge gateway bundle for one regex.
 * server/__tests__/user-api-key-validation.test.ts asserts the two literals stay
 * byte-identical, so drift fails CI instead of silently splitting the contract.
 */
const USER_API_KEY_RE = /^wm_[a-f0-9]{40}$/;

const CACHE_TTL_SECONDS = 60; // 1 min — short to limit staleness on revocation
const NEG_TTL_SECONDS = 60;   // negative cache: avoid hammering Convex with invalid keys
const CACHE_KEY_PREFIX = 'user-api-key:';

/** In-flight re-validations of stale cache entries, keyed by cache key. */
const revalidateInFlight = new Map<string, Promise<UserKeyCacheEntry | null>>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNonEmptyString(value: Record<string, unknown>, field: string): boolean {
  // OWN property only: a polluted Object.prototype.userId would otherwise let
  // a bare `{}` authenticate through the prototype chain.
  if (!Object.prototype.hasOwnProperty.call(value, field)) return false;
  const candidate = value[field];
  return typeof candidate === 'string' && candidate.length > 0;
}

/**
 * Company Monitoring binding rule shared by the Convex row and the cache
 * entry: either no binding at all, or exact scopes AND an account.
 */
function hasValidCompanyMonitoringBinding(value: Record<string, unknown>): boolean {
  const { scopes, companyMonitoringAccountId } = value;
  if (scopes === undefined && companyMonitoringAccountId === undefined) return true;
  if (!Array.isArray(scopes) || scopes.length === 0) return false;
  if (typeof companyMonitoringAccountId !== 'string' || companyMonitoringAccountId.length === 0) return false;
  return new Set(scopes).size === scopes.length &&
    scopes.every((scope) => typeof scope === 'string' && COMPANY_MONITORING_SCOPES.has(scope));
}

/**
 * Runtime shape guard for whatever comes back from the cache. `cachedFetchJson`
 * only CASTS its payload, so a poisoned entry, a pre-version entry, or one
 * written by a producer that did not stamp the kind must never reach callers
 * as a truthy "authenticated principal". Anything that fails here is
 * re-validated at Convex (see loadUserKeyEntry), not trusted and not denied.
 */
function isCurrentUserKeyCacheEntry(value: unknown): value is UserKeyCacheEntry {
  if (!isPlainObject(value)) return false;
  if (!Object.prototype.hasOwnProperty.call(value, 'v') || value.v !== USER_API_KEY_CACHE_VERSION) return false;
  if (!hasNonEmptyString(value, 'userId') || !hasNonEmptyString(value, 'keyId')) return false;
  if (typeof value.keyKind !== 'string' || !USER_API_KEY_KINDS.has(value.keyKind)) return false;
  if (value.activeKeyRank !== undefined && !isActiveKeyRank(value.activeKeyRank)) return false;
  return hasValidCompanyMonitoringBinding(value);
}

/** A rank is a non-negative integer; anything else is dropped, never trusted. */
function isActiveKeyRank(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Shape guard for a fresh Convex `validateKeyByHash` row. `keyKind` is
 * explicit on every row Convex writes since U2; a row WITHOUT it can only come
 * from a backend that predates the column, which cannot hold desktop rows
 * (Deploy Order: the edge ships first, desktop creation stays off until the
 * Convex deploy is live), so it is an `api` key. Any other value is contract
 * drift and is treated as an unavailable payload, never as a principal.
 */
function toCacheEntry(value: unknown): UserKeyCacheEntry | null {
  if (!isPlainObject(value)) return null;
  if (!hasNonEmptyString(value, 'userId') || !hasNonEmptyString(value, 'id')) return null;
  if (!hasValidCompanyMonitoringBinding(value)) return null;
  const rawKind = value.keyKind;
  if (rawKind !== undefined && (typeof rawKind !== 'string' || !USER_API_KEY_KINDS.has(rawKind))) return null;
  const keyKind = rawKind === undefined ? 'api' : (rawKind as UserApiKeyKind);
  return {
    v: USER_API_KEY_CACHE_VERSION,
    userId: value.userId as string,
    keyId: value.id as string,
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    keyKind,
    ...(isActiveKeyRank(value.activeKeyRank) ? { activeKeyRank: value.activeKeyRank } : {}),
    ...(value.scopes === undefined ? {} : { scopes: value.scopes as CompanyMonitoringApiScope[] }),
    ...(value.companyMonitoringAccountId === undefined
      ? {}
      : { companyMonitoringAccountId: value.companyMonitoringAccountId as string }),
  };
}

/** Generic gateway/MCP auth accepts only legacy, unscoped user API keys. */
function isGenericUserKeyResult(value: UserKeyCacheEntry): boolean {
  return value.scopes === undefined && value.companyMonitoringAccountId === undefined;
}

/** SHA-256 hex digest (Web Crypto API — works in Edge Runtime). */
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function toUnavailableError(err: unknown): UserApiKeyUnavailableError {
  if (err instanceof UserApiKeyUnavailableError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new UserApiKeyUnavailableError(
    message.startsWith('Convex user API key validation unavailable')
      ? message
      : `Convex user API key validation unavailable: ${message}`,
  );
}

/**
 * Validate a user-owned API key for GENERIC consumers (MCP, v2 webhooks,
 * OAuth, embed): only an explicit `api` kind with no Company Monitoring
 * binding is a principal here. A desktop key is `null` — the same answer as an
 * unknown key — while its full cache entry stays intact for the desktop-aware
 * variant below.
 *
 * Returns the principal if valid, or null if invalid/revoked (including a
 * Redis NEG_SENTINEL negative-cache hit for a definitive unknown key).
 * Throws {@link UserApiKeyUnavailableError} when Convex validation cannot be
 * performed — callers must not treat that as "invalid key" (401).
 */
export async function validateUserApiKey(key: string): Promise<UserKeyResult | null> {
  const entry = await validateUserApiKeyEntry(key);
  if (entry === null) return null;
  // Company Monitoring keys are bound to an account and exact RPC scopes.
  // Generic gateway/MCP callers do not enforce either constraint, so they
  // must not receive the principal. Keep the full positive cache entry intact
  // for a future dedicated validator instead of replacing it with a negative.
  if (!isGenericUserKeyResult(entry)) return null;
  // KTD3: fail closed on any kind but `api`. The entry is current (kind is
  // explicit and known), so this is a definitive denial for this consumer.
  if (entry.keyKind !== 'api') return null;
  return entry as UserKeyResult;
}

/**
 * Validate a user-owned API key for the surfaces that admit desktop keys
 * (gateway, premium-check, bootstrap — U4). Returns the principal with its
 * kind and hash for an `api` or `desktop` key; Company Monitoring-bound keys
 * and unknown kinds are rejected exactly as in the generic validator. The
 * caller decides what the kind may reach (KTD4, KTD7).
 *
 * Same null / {@link UserApiKeyUnavailableError} contract as `validateUserApiKey`.
 */
export async function validateUserApiKeyPrincipal(key: string): Promise<UserKeyPrincipal | null> {
  const entry = await validateUserApiKeyEntry(key);
  if (entry === null || !isGenericUserKeyResult(entry)) return null;
  return {
    userId: entry.userId,
    keyId: entry.keyId,
    keyKind: entry.keyKind,
    // The hash is what the entry was looked up by; recomputing it here keeps
    // the function pure for callers that never saw the cache key.
    keyHash: await sha256Hex(key),
    ...(entry.activeKeyRank === undefined ? {} : { activeKeyRank: entry.activeKeyRank }),
  };
}

async function validateUserApiKeyEntry(key: string): Promise<UserKeyCacheEntry | null> {
  // Reject malformed keys BEFORE hashing. `startsWith('wm_')` alone let `wm_x`
  // burn a SHA-256, a Redis round-trip and a Convex lookup per attempt, turning
  // an unauthenticated caller into a backend amplifier.
  if (!USER_API_KEY_RE.test(key ?? '')) return null;

  const keyHash = await sha256Hex(key);
  try {
    return await loadUserKeyEntry(keyHash);
  } catch (err) {
    // Transient Convex/network/config errors must stay retryable. Do not
    // collapse them into null (that made gateway/MCP return a misleading 401).
    const unavailable = toUnavailableError(err);
    console.warn('[user-api-key] validateUserApiKey unavailable:', unavailable.message);
    throw unavailable;
  }
}

/**
 * Cache-then-Convex lookup that never trusts a non-current entry.
 *
 * `cachedFetchJson` returns any hit verbatim and cannot treat one as a miss,
 * so a pre-read decides first: an object hit that is not a current entry
 * (pre-version shape, missing or unknown kind, `id` instead of `keyId`,
 * poisoned) is re-validated at Convex and rewritten (KTD8 — no 401 window).
 * Everything else — a miss, the negative sentinel, a read error — goes through
 * `cachedFetchJson` as before, keeping its coalescing, negative caching and
 * unavailable backoff. A current entry raced in between is accepted; a stale
 * one raced in is re-validated the same way.
 */
async function loadUserKeyEntry(keyHash: string): Promise<UserKeyCacheEntry | null> {
  const cacheKey = `${CACHE_KEY_PREFIX}${keyHash}`;

  const pre = await readCachedJson(cacheKey);
  if (pre.status === 'hit' && isPlainObject(pre.value)) {
    // A warm current hit is the answer; reading it again through
    // `cachedFetchJson` would cost every key check a second Redis trip.
    if (isCurrentUserKeyCacheEntry(pre.value)) return pre.value;
    return revalidateUserKey(cacheKey, keyHash);
  }

  const result = await cachedFetchJson<UserKeyCacheEntry>(
    cacheKey,
    CACHE_TTL_SECONDS,
    () => fetchFromConvex(keyHash),
    NEG_TTL_SECONDS,
    { cacheFetcherErrors: false },
  );
  // null is the legitimate negative-cache / unknown-key answer — pass it
  // through untouched. Anything non-null must prove it carries an identity.
  if (result === null) return null;
  if (isCurrentUserKeyCacheEntry(result)) return result;
  if (isPlainObject(result)) return revalidateUserKey(cacheKey, keyHash);
  // Log the type only: the payload and the key hash are credential material.
  console.warn(`[user-api-key] discarding non-conforming validation payload (type=${Array.isArray(result) ? 'array' : typeof result})`);
  return null;
}

/**
 * Re-validate at the source and rewrite the entry in the current shape.
 * Coalesced per cache key so a burst on one stale entry costs one Convex call.
 * A key Convex no longer knows has its stale entry deleted; the next lookup
 * negative-caches it through `cachedFetchJson` as usual.
 */
function revalidateUserKey(cacheKey: string, keyHash: string): Promise<UserKeyCacheEntry | null> {
  const existing = revalidateInFlight.get(cacheKey);
  if (existing) return existing;
  const pending = (async () => {
    const fresh = await fetchFromConvex(keyHash);
    if (fresh === null) {
      await deleteRedisKey(cacheKey);
      return null;
    }
    await setCachedJson(cacheKey, fresh, CACHE_TTL_SECONDS);
    return fresh;
  })();
  revalidateInFlight.set(cacheKey, pending);
  return pending.finally(() => {
    revalidateInFlight.delete(cacheKey);
  });
}

/** Fetch key validation from Convex internal endpoint, in cache-entry shape. */
async function fetchFromConvex(keyHash: string): Promise<UserKeyCacheEntry | null> {
  const convexSiteUrl = process.env.CONVEX_SITE_URL;
  const convexSharedSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
  if (!convexSiteUrl || !convexSharedSecret) {
    throw new UserApiKeyUnavailableError('Convex user API key validation unavailable: missing-config');
  }

  let resp: Response;
  try {
    resp = await fetch(`${convexSiteUrl}/api/internal-validate-api-key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'worldmonitor-gateway/1.0',
        'x-convex-shared-secret': convexSharedSecret,
      },
      body: JSON.stringify({ keyHash }),
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    throw new UserApiKeyUnavailableError('Convex user API key validation unavailable: fetch-error');
  }

  if (!resp.ok) {
    throw new UserApiKeyUnavailableError(
      `Convex user API key validation unavailable: http-${resp.status}`,
    );
  }

  let value: unknown;
  try {
    value = await resp.json();
  } catch {
    throw new UserApiKeyUnavailableError('Convex user API key validation unavailable: invalid-json');
  }

  if (value === null) return null;
  const entry = toCacheEntry(value);
  if (entry === null) {
    throw new UserApiKeyUnavailableError('Convex user API key validation unavailable: invalid-payload');
  }
  return entry;
}

/**
 * Delete the Redis cache entry for a specific API key hash.
 * Called after revocation to ensure the key cannot be used during the TTL window.
 * Uses prefixed keys (no raw=true) matching the cache writes above.
 */
export async function invalidateApiKeyCache(keyHash: string): Promise<void> {
  await deleteRedisKey(`${CACHE_KEY_PREFIX}${keyHash}`);
}
