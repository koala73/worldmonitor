/**
 * Frontend service for managing partner-embed keys (`wme_…`).
 *
 * A sibling of `api-keys.ts`, not a mode of it. The two credential classes are
 * separate tables, separate validators and separate entitlements, and the one
 * thing that must never happen is a caller reaching for the wrong helper: an
 * embed key is MEANT to be published in a partner's page HTML, a `wm_` key
 * carries the account's whole REST allowance. Keeping the modules apart makes
 * that a compile-time distinction rather than an argument.
 *
 * Generation and hashing stay client-side for the same reason they do in
 * `api-keys.ts`: the plaintext is shown once and never reaches a server log.
 */

import {
  getConvexClient,
  getConvexApi,
  waitForConvexAuthForUser,
} from './convex-client';
import { getCurrentClerkUser } from './clerk';
import {
  assertAccountStillCurrent,
  settleAccountOperation,
} from './account-operation';

export interface EmbedKeyInfo {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
  allowedOrigins?: string[];
}

export interface CreateEmbedKeyResult {
  id: string;
  name: string;
  keyPrefix: string;
  /** Plaintext key — shown to the user ONCE. */
  key: string;
}

/**
 * Generate a random embed key: `wme_<40 hex chars>` (20 bytes = 160 bits).
 *
 * The shape is pinned on the edge by `EMBED_KEY_RE` in
 * `server/_shared/embed-key.ts` and on the display prefix by
 * `convex/embedKeys.ts`; both reject uppercase, so `padStart` output must stay
 * lowercase hex.
 */
export function generateEmbedKey(): string {
  const raw = new Uint8Array(20);
  crypto.getRandomValues(raw);
  const hex = Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('');
  return `wme_${hex}`;
}

/** SHA-256 hex digest of a string. */
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The display prefix stored alongside the hash.
 *
 * Nine characters — `wme_` plus five hex — because Convex validates it against
 * `/^wme_[a-f0-9]{5}$/`. `api-keys.ts` slices eight for `wm_` + five; the
 * longer scheme prefix is the whole difference, so this cannot be shared as a
 * constant without one of the two silently taking the other's length.
 */
function embedKeyPrefix(plaintext: string): string {
  return plaintext.slice(0, 9);
}

/**
 * Create a new embed key for the current user.
 * Returns the full plaintext key (shown once) and metadata.
 */
export async function createEmbedKey(name: string): Promise<CreateEmbedKeyResult> {
  const userId = getCurrentClerkUser()?.id;
  if (!userId) throw new Error('Sign in to create an embed key.');

  const plaintext = generateEmbedKey();
  const keyPrefix = embedKeyPrefix(plaintext);
  const keyHash = await sha256Hex(plaintext);

  const [client, api] = await Promise.all([getConvexClient(), getConvexApi()]);
  if (!client || !api) throw new Error('Convex unavailable');
  if (!await waitForConvexAuthForUser(userId)) {
    throw new Error('Account changed while creating the embed key. Try again.');
  }

  const result = await settleAccountOperation(
    userId,
    'creating the embed key',
    () => client.mutation(
      (api as any).embedKeys.createEmbedKey,
      { name: name.trim(), keyPrefix, keyHash },
    ),
  );
  assertAccountStillCurrent(userId, 'creating the embed key');

  return { id: result.id, name: result.name, keyPrefix: result.keyPrefix, key: plaintext };
}

/** List all embed keys for the current user. */
export async function listEmbedKeys(): Promise<EmbedKeyInfo[]> {
  const userId = getCurrentClerkUser()?.id;
  if (!userId) return [];

  const [client, api] = await Promise.all([getConvexClient(), getConvexApi()]);
  if (!client || !api) return [];
  if (!await waitForConvexAuthForUser(userId)) {
    assertAccountStillCurrent(userId, 'loading embed keys');
    throw new Error('Authentication unavailable while loading embed keys. Try again.');
  }

  return settleAccountOperation(
    userId,
    'loading embed keys',
    () => client.query((api as any).embedKeys.listEmbedKeys, {}),
  );
}

/**
 * Revoke an embed key by its Convex document ID.
 *
 * Unlike `revokeApiKey`, this does not bust the edge validation cache: there is
 * no ownership-checked invalidation route for `embedKeys` yet, so a revoked key
 * keeps validating for at most the 60s `CACHE_TTL_SECONDS` in
 * `server/_shared/embed-key.ts`.
 *
 * A map frame is slower still: it already holds a `wmg_` grant good for up to
 * `EMBED_GRANT_TTL_MS` (30 minutes), and revocation only stops the NEXT mint.
 * The UI copy states both windows rather than promising one.
 */
export async function revokeEmbedKey(keyId: string): Promise<void> {
  const userId = getCurrentClerkUser()?.id;
  if (!userId) throw new Error('Sign in to revoke embed keys.');

  const [client, api] = await Promise.all([getConvexClient(), getConvexApi()]);
  if (!client || !api) throw new Error('Convex unavailable');
  if (!await waitForConvexAuthForUser(userId)) {
    throw new Error('Account changed while revoking the embed key. Try again.');
  }

  await settleAccountOperation(
    userId,
    'revoking the embed key',
    () => client.mutation((api as any).embedKeys.revokeEmbedKey, { keyId }),
  );
  assertAccountStillCurrent(userId, 'revoking the embed key');
}
