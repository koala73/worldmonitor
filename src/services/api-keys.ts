/**
 * Frontend service for managing user API keys.
 *
 * Uses the shared ConvexClient (WebSocket) to call mutations/queries in
 * convex/apiKeys.ts. Key generation + hashing happens client-side so the
 * plaintext key is shown to the user exactly once without a round-trip
 * that could log it.
 */

import { getConvexClient, getConvexApi, waitForConvexAuth } from './convex-client';
import { getClerkToken } from './clerk';

export interface ApiKeyInfo {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
}

export interface CreateApiKeyResult {
  id: string;
  name: string;
  keyPrefix: string;
  /** Plaintext key — shown to the user ONCE. */
  key: string;
}

/** Generate a random key: wm_<40 hex chars> (20 bytes = 160 bits). */
function generateKey(): string {
  const raw = new Uint8Array(20);
  crypto.getRandomValues(raw);
  const hex = Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('');
  return `wm_${hex}`;
}

/** SHA-256 hex digest of a string. */
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Create a new API key for the current user.
 * Returns the full plaintext key (shown once) and metadata.
 */
export async function createApiKey(name: string): Promise<CreateApiKeyResult> {
  const client = await getConvexClient();
  const api = await getConvexApi();
  if (!client || !api) throw new Error('Convex unavailable');

  await waitForConvexAuth();

  const plaintext = generateKey();
  const keyPrefix = plaintext.slice(0, 8);
  const keyHash = await sha256Hex(plaintext);

  const result = await client.mutation(
    (api as any).apiKeys.createApiKey,
    { name: name.trim(), keyPrefix, keyHash },
  );

  return { id: result.id, name: result.name, keyPrefix: result.keyPrefix, key: plaintext };
}

/** List all API keys for the current user. */
export async function listApiKeys(): Promise<ApiKeyInfo[]> {
  const client = await getConvexClient();
  const api = await getConvexApi();
  if (!client || !api) return [];

  await waitForConvexAuth();

  return client.query((api as any).apiKeys.listApiKeys, {});
}

/** Revoke an API key by its Convex document ID. */
export async function revokeApiKey(keyId: string): Promise<void> {
  const client = await getConvexClient();
  const api = await getConvexApi();
  if (!client || !api) throw new Error('Convex unavailable');

  await waitForConvexAuth();

  const result = await client.mutation((api as any).apiKeys.revokeApiKey, { keyId });

  // Await cache bust so the gateway stops accepting the revoked key immediately.
  // If this fails, the 60s cache TTL limits the staleness window.
  if (result?.keyHash) {
    const token = await getClerkToken();
    if (token) {
      const resp = await fetch('/api/invalidate-user-api-key-cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ keyHash: result.keyHash }),
      });
      if (!resp.ok) {
        console.warn('[api-keys] cache invalidation failed:', resp.status);
      }
    }
  }
}
