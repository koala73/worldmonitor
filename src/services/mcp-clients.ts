/**
 * Frontend service for the Connected MCP clients tab (plan 2026-05-10-001 U9).
 *
 * Two surfaces:
 *   - `listMcpClients()` — calls Convex `mcpProTokens.listProMcpTokens` (public
 *     query, requires Clerk auth via ctx.auth). Returns rows for the caller's
 *     userId. Sibling of `listApiKeys()` in services/api-keys.ts.
 *   - `revokeMcpClient(tokenId)` — POSTs `/api/user/mcp-revoke` so the edge
 *     handler can pair the Convex revoke with the negative-cache invalidation
 *     atomically. Calling the public Convex mutation directly from the
 *     browser would skip the cache-invalidation step.
 *   - `fetchMcpQuota()` — GETs `/api/user/mcp-quota` to display the daily
 *     usage counter. Reads the same Redis key as api/mcp.ts (single source
 *     of truth — no client-side enforcement, just display).
 */

import {
  getConvexClient,
  getConvexApi,
  waitForConvexAuthForUser,
} from './convex-client';
import { getClerkToken, getCurrentClerkUser } from './clerk';
import {
  assertAccountStillCurrent,
  settleAccountOperation,
} from './account-operation';

export interface McpClientInfo {
  id: string;
  name?: string;
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
}

export interface McpQuota {
  used: number;
  /** Plan-resolved daily allowance. `null` = unlimited (plan 2026-07-25-001 U3b). */
  limit: number | null;
  resetsAt: string;
}

/** List all Pro MCP tokens for the current user. */
export async function listMcpClients(): Promise<McpClientInfo[]> {
  const userId = getCurrentClerkUser()?.id;
  if (!userId) return [];

  const [client, api] = await Promise.all([getConvexClient(), getConvexApi()]);
  if (!client || !api) return [];
  if (!await waitForConvexAuthForUser(userId)) {
    assertAccountStillCurrent(userId, 'loading MCP clients');
    throw new Error('Authentication unavailable while loading MCP clients. Try again.');
  }

  // Mirror services/api-keys.ts:listApiKeys cast pattern — the generated
  // Convex `api` is fully typed at module level but each service casts
  // `as any` at the call-site to avoid pulling the entire generated index
  // type into every service file.
  const rows = await settleAccountOperation(
    userId,
    'loading MCP clients',
    () => client.query((api as any).mcpProTokens.listProMcpTokens, {}),
  );
  assertAccountStillCurrent(userId, 'loading MCP clients');
  return rows as McpClientInfo[];
}

/**
 * Revoke a Pro MCP token by tokenId.
 *
 * Calls the edge endpoint (NOT the public Convex mutation directly) so the
 * negative-cache sentinel write is paired atomically with the Convex revoke.
 * Throws on non-2xx so the UI can surface the error.
 */
export async function revokeMcpClient(tokenId: string): Promise<void> {
  const token = await getClerkToken();
  if (!token) throw new Error('Sign in to revoke MCP clients.');

  const resp = await fetch('/api/user/mcp-revoke', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ tokenId }),
  });

  if (resp.ok) return;

  if (resp.status === 404) {
    throw new Error('This client was already revoked or no longer exists.');
  }
  if (resp.status === 409) {
    throw new Error('This client was already revoked.');
  }
  if (resp.status === 401) {
    throw new Error('Sign in to revoke MCP clients.');
  }
  if (resp.status === 503) {
    throw new Error('Revoke service is temporarily unavailable. Try again in a moment.');
  }
  throw new Error(`Revoke failed (HTTP ${resp.status}).`);
}

/**
 * Fetch the caller's daily Pro MCP quota usage. Returns sane defaults on
 * any failure — the settings UI is informational and should never break
 * because the quota counter is unreachable.
 */
export async function fetchMcpQuota(): Promise<McpQuota> {
  const fallback: McpQuota = { used: 0, limit: 50, resetsAt: nextUtcMidnightIso() };

  const token = await getClerkToken();
  if (!token) return fallback;

  try {
    const resp = await fetch('/api/user/mcp-quota', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return fallback;
    const data = (await resp.json()) as Partial<McpQuota>;
    return {
      used: typeof data.used === 'number' && data.used >= 0 ? data.used : 0,
      limit: normalizeQuotaLimit(data.limit),
      resetsAt: typeof data.resetsAt === 'string' ? data.resetsAt : fallback.resetsAt,
    };
  } catch {
    return fallback;
  }
}

/**
 * `null` is a real value on the wire — the plan is unlimited — so it must
 * survive normalisation instead of collapsing into the 50/day fallback. `0` is
 * likewise a real allowance, not a missing one. Anything else (absent field,
 * malformed type, negative) falls back to the plan default.
 *
 * Exported so tests/mcp-quota.test.mjs can pin the client end of the same wire
 * contract the endpoint's own cases pin: a truthiness check here would put
 * "50 / 50" back in front of an unlimited caller.
 */
export function normalizeQuotaLimit(raw: McpQuota['limit'] | undefined): number | null {
  if (raw === null) return null;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : 50;
}

function nextUtcMidnightIso(): string {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0,
  ));
  return next.toISOString();
}
