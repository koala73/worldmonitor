/**
 * Single-source Pro MCP entitlement gate.
 *
 * The four-clause decision (`tier >= 1 && mcpAccess === true && validUntil >= now`,
 * plus the null case) lives here so it cannot drift between:
 *   - api/mcp/auth.ts        (MCP-edge JSON-RPC gate)
 *   - server/gateway.ts      (gateway internal-MCP re-check)
 *   - api/internal/mcp-grant-mint.ts   (OAuth grant mint)
 *   - api/internal/mcp-grant-context.ts (OAuth grant context)
 *
 * Each call site renders its own denial response (JSON-RPC -32001, HTTP 401,
 * structured JSON `INSUFFICIENT_TIER`, etc.) — this module only answers
 * "does this entitlement pass the Pro MCP gate?" as a boolean.
 *
 * Ref: #5653 — fold duplicated conditionals into a single truth source.
 */

/**
 * Minimal entitlement shape accepted by the gate. Matches the subset of
 * `CachedEntitlements` that the decision inspects. Kept structural (not a
 * direct import) so both the Edge Function layer and the server layer can
 * consume this without import-graph constraints.
 */
export interface ProMcpEntitlement {
  features: {
    tier: number;
    mcpAccess?: boolean;
  };
  validUntil: number;
}

/**
 * Returns `true` when the entitlement satisfies the Pro MCP access gate:
 *   1. Entitlement is non-null
 *   2. `tier >= 1`
 *   3. `mcpAccess === true` (undefined = fail-closed, per plan 2026-05-10-001)
 *   4. `validUntil >= now`
 *
 * @param ent  - The resolved entitlement (or null/undefined if lookup failed)
 * @param now  - Current timestamp in milliseconds (injectable for tests)
 */
export function checkProMcpAccess(
  ent: ProMcpEntitlement | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!ent || !ent.features) return false;
  return (
    ent.features.tier >= 1 &&
    ent.features.mcpAccess === true &&
    ent.validUntil >= now
  );
}
