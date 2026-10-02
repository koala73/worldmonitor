/**
 * Validates partner-embed keys (`wme_…`) by hashing the provided key and
 * looking up the hash in Convex via the internal HTTP action.
 *
 * Deliberately a sibling of `user-api-key.ts` rather than a mode of it. An
 * embed key is published in the partner's HTML (`data-key` on public/embed.js),
 * so it must resolve ONLY on the embed surface; a `wm_` key and a `wme_` key
 * must never validate through the same function, the same Convex table, or the
 * same Redis namespace. The shape gates alone enforce the split before any
 * round-trip: `wme_…` fails `USER_API_KEY_RE` on its third character, and
 * `wm_…` fails `EMBED_KEY_RE` on the same character.
 */

import { cachedFetchJson, deleteRedisKey } from './redis';

/**
 * Who may mint an embed key. Re-exported so server-side callers reach it from
 * this module, but IMPLEMENTED in shared/ — `convex/embedKeys.ts` calls the
 * same function, and importing this module from Convex would drag the edge
 * Redis/usage stack into every `convex deploy` bundle.
 */
export { hasEmbedAccess, type EmbedAccessEntitlement } from '../../shared/embed-access';

interface EmbedKeyResult {
  userId: string;
  /**
   * Only `userId` is guaranteed — the runtime guard below requires nothing
   * else, mirroring `user-api-key.ts`. Convex's validateKeyByHash returns
   * `id`, not `keyId`; no caller reads either.
   */
  keyId?: string;
  name?: string;
}

/**
 * Thrown when Convex validation cannot be performed (missing config, transport
 * failure, non-OK HTTP, invalid JSON/payload). Distinct from a definitive
 * unknown/revoked key (`null`). Callers that own HTTP responses should map this
 * to a retryable 503; entitlement gates should fail closed.
 */
export class EmbedKeyUnavailableError extends Error {
  readonly code = 'validation_unavailable' as const;

  constructor(message: string) {
    super(message);
    this.name = 'EmbedKeyUnavailableError';
  }
}

export function isEmbedKeyUnavailableError(err: unknown): err is EmbedKeyUnavailableError {
  return err instanceof EmbedKeyUnavailableError;
}

/** Canonical partner-embed key: `wme_` + 40 lowercase hex (20 random bytes). */
const EMBED_KEY_RE = /^wme_[a-f0-9]{40}$/;

const CACHE_TTL_SECONDS = 60; // 1 min — short to limit staleness on revocation
const NEG_TTL_SECONDS = 60;   // negative cache: avoid hammering Convex with invalid keys
const CACHE_KEY_PREFIX = 'embed-key:';

/**
 * Runtime shape guard for whatever comes back from the cache or Convex.
 * `cachedFetchJson<EmbedKeyResult>` only CASTS its payload, so a poisoned cache
 * entry or an upstream shape drift (e.g. `{}`) would otherwise reach callers as
 * a truthy "authenticated principal" whose `.userId` reads as undefined.
 */
function isEmbedKeyResult(value: unknown): value is EmbedKeyResult {
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

function toUnavailableError(err: unknown): EmbedKeyUnavailableError {
  if (err instanceof EmbedKeyUnavailableError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new EmbedKeyUnavailableError(
    message.startsWith('Convex embed key validation unavailable')
      ? message
      : `Convex embed key validation unavailable: ${message}`,
  );
}

/**
 * Validate a partner-embed key.
 *
 * Returns the owning userId if valid, or null if malformed/unknown/revoked
 * (including a Redis NEG_SENTINEL negative-cache hit). Throws
 * {@link EmbedKeyUnavailableError} when Convex validation cannot be performed —
 * callers must not treat that as "invalid key" (401).
 */
export async function validateEmbedKey(key: string): Promise<EmbedKeyResult | null> {
  // Reject malformed keys BEFORE hashing, so an unauthenticated caller cannot
  // turn `wme_x` into a SHA-256 + Redis round-trip + Convex lookup per attempt.
  if (!EMBED_KEY_RE.test(key ?? '')) return null;

  const keyHash = await sha256Hex(key);
  const cacheKey = `${CACHE_KEY_PREFIX}${keyHash}`;

  try {
    const result = await cachedFetchJson<EmbedKeyResult>(
      cacheKey,
      CACHE_TTL_SECONDS,
      () => fetchFromConvex(keyHash),
      NEG_TTL_SECONDS,
      { cacheFetcherErrors: false },
    );
    // null is the legitimate negative-cache / unknown-key answer — pass it
    // through untouched. Anything non-null must prove it carries an identity.
    if (result === null) return null;
    if (!isEmbedKeyResult(result)) {
      // Log the type only: the payload and the key hash are credential material.
      console.warn(`[embed-key] discarding non-conforming validation payload (type=${Array.isArray(result) ? 'array' : typeof result})`);
      return null;
    }
    return result;
  } catch (err) {
    // Transient Convex/network/config errors must stay retryable. Do not
    // collapse them into null — that would return a misleading 401.
    const unavailable = toUnavailableError(err);
    console.warn('[embed-key] validateEmbedKey unavailable:', unavailable.message);
    throw unavailable;
  }
}

/** Fetch key validation from the Convex internal endpoint. */
async function fetchFromConvex(keyHash: string): Promise<EmbedKeyResult | null> {
  const convexSiteUrl = process.env.CONVEX_SITE_URL;
  const convexSharedSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
  if (!convexSiteUrl || !convexSharedSecret) {
    throw new EmbedKeyUnavailableError('Convex embed key validation unavailable: missing-config');
  }

  let resp: Response;
  try {
    resp = await fetch(`${convexSiteUrl}/api/internal-validate-embed-key`, {
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
    throw new EmbedKeyUnavailableError('Convex embed key validation unavailable: fetch-error');
  }

  if (!resp.ok) {
    throw new EmbedKeyUnavailableError(
      `Convex embed key validation unavailable: http-${resp.status}`,
    );
  }

  let value: unknown;
  try {
    value = await resp.json();
  } catch {
    throw new EmbedKeyUnavailableError('Convex embed key validation unavailable: invalid-json');
  }

  if (value === null) return null;
  if (!isEmbedKeyResult(value)) {
    throw new EmbedKeyUnavailableError('Convex embed key validation unavailable: invalid-payload');
  }
  return value;
}

/**
 * Delete the Redis cache entry for a specific embed key hash.
 * Called after revocation so the key cannot be used during the TTL window.
 * Uses prefixed keys (no raw=true) matching the cache writes above.
 */
export async function invalidateEmbedKeyCache(keyHash: string): Promise<void> {
  await deleteRedisKey(`${CACHE_KEY_PREFIX}${keyHash}`);
}
