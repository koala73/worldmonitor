/**
 * Validates user-owned API keys by hashing the provided key and looking up
 * the hash in Convex via the internal HTTP action.
 *
 * Uses cachedFetchJson for Redis caching with in-flight coalescing and
 * environment-partitioned keys (no raw=true — keys are prefixed by deploy).
 */

import { cachedFetchJson, deleteRedisKey } from './redis';

interface UserKeyResult {
  userId: string;
  /**
   * Only `userId` is guaranteed. Two producers write the shared
   * `user-api-key:<hash>` cache entry with DIFFERENT shapes:
   *   - fetchFromConvex below returns validateKeyByHash's row verbatim
   *     (`{ id, userId, name }`) — so `keyId` is undefined on that path.
   *   - api/_user-api-key.js maps `id` → `keyId` before caching.
   * No caller reads keyId/name (they read only `.userId`), so the runtime
   * guard below requires only `userId` — mirroring the sibling module's
   * check. Requiring keyId here would 401 every fresh Convex validation.
   */
  keyId?: string;
  name?: string;
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

/**
 * Runtime shape guard for whatever comes back from the cache or Convex.
 * `cachedFetchJson<UserKeyResult>` only CASTS its payload, so a poisoned cache
 * entry or an upstream shape drift (e.g. `{}`) would otherwise reach callers as
 * a truthy "authenticated principal" whose `.userId` reads as undefined.
 */
function isUserKeyResult(value: unknown): value is UserKeyResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  // OWN property only: a polluted Object.prototype.userId would otherwise let
  // a bare `{}` authenticate through the prototype chain.
  if (!Object.prototype.hasOwnProperty.call(value, 'userId')) return false;
  const userId = (value as { userId?: unknown }).userId;
  return typeof userId === 'string' && userId.length > 0;
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
 * Validate a user-owned API key.
 *
 * Returns the userId and key metadata if valid, or null if invalid/revoked
 * (including a Redis NEG_SENTINEL negative-cache hit for a definitive unknown key).
 * Throws {@link UserApiKeyUnavailableError} when Convex validation cannot be
 * performed — callers must not treat that as "invalid key" (401).
 *
 * Uses cachedFetchJson with `cacheFetcherErrors: false` so transient failures
 * are never written as NEG_SENTINEL.
 */
export async function validateUserApiKey(key: string): Promise<UserKeyResult | null> {
  // Reject malformed keys BEFORE hashing. `startsWith('wm_')` alone let `wm_x`
  // burn a SHA-256, a Redis round-trip and a Convex lookup per attempt, turning
  // an unauthenticated caller into a backend amplifier.
  if (!USER_API_KEY_RE.test(key ?? '')) return null;

  const keyHash = await sha256Hex(key);
  const cacheKey = `${CACHE_KEY_PREFIX}${keyHash}`;

  try {
    const result = await cachedFetchJson<UserKeyResult>(
      cacheKey,
      CACHE_TTL_SECONDS,
      () => fetchFromConvex(keyHash),
      NEG_TTL_SECONDS,
      { cacheFetcherErrors: false },
    );
    // null is the legitimate negative-cache / unknown-key answer — pass it
    // through untouched. Anything non-null must prove it carries an identity.
    if (result === null) return null;
    if (!isUserKeyResult(result)) {
      // Log the type only: the payload and the key hash are credential material.
      console.warn(`[user-api-key] discarding non-conforming validation payload (type=${Array.isArray(result) ? 'array' : typeof result})`);
      return null;
    }
    return result;
  } catch (err) {
    // Transient Convex/network/config errors must stay retryable. Do not
    // collapse them into null (that made gateway/MCP return a misleading 401).
    const unavailable = toUnavailableError(err);
    console.warn('[user-api-key] validateUserApiKey unavailable:', unavailable.message);
    throw unavailable;
  }
}

/** Fetch key validation from Convex internal endpoint. */
async function fetchFromConvex(keyHash: string): Promise<UserKeyResult | null> {
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
  if (!isUserKeyResult(value)) {
    throw new UserApiKeyUnavailableError('Convex user API key validation unavailable: invalid-payload');
  }
  return value;
}

/**
 * Delete the Redis cache entry for a specific API key hash.
 * Called after revocation to ensure the key cannot be used during the TTL window.
 * Uses prefixed keys (no raw=true) matching the cache writes above.
 */
export async function invalidateApiKeyCache(keyHash: string): Promise<void> {
  await deleteRedisKey(`${CACHE_KEY_PREFIX}${keyHash}`);
}
