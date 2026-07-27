/**
 * The Pro-MCP access decision, shared by every gate in the OAuth grant flow.
 *
 * Three call sites re-implemented the same four-clause check
 * (`tier >= 1 && mcpAccess === true && validUntil >= now`, plus the null case):
 *
 *   - `api/internal/mcp-grant-context.ts` — renders the consent card
 *   - `api/internal/mcp-grant-mint.ts`    — mints the signed grant
 *   - `api/oauth/authorize-pro.ts`        — finishes authorization on the
 *                                          api subdomain
 *
 * Each carried a comment saying "the two gates must agree", which is exactly
 * the kind of invariant a comment cannot enforce: the mcpAccess clause had to be
 * retro-fitted to all three in one review round precisely because gating on tier
 * alone let a user complete OAuth and then fail every tools/call.
 *
 * The decision lives here so those three cannot drift, and so the
 * retryable-vs-terminal split (#5622) reaches all three at once even though they
 * render it three different ways (JSON error vocabulary, JSON error vocabulary,
 * HTML page). Rendering stays with each caller; only the decision is shared.
 *
 * SCOPE — this owns the OAuth-grant flow, not every Pro-MCP check in the repo.
 * `api/mcp/auth.ts::checkMcpEntitlementGate` (the downstream MCP-edge gate the
 * three comments above say they mirror) and the gateway's own inline check still
 * spell the four clauses out themselves. They are the harder migration: their
 * denials are JSON-RPC envelopes with their own billing-denial helper and
 * telemetry, so folding them in is a separate change — tracked in #5653. Until
 * then "cannot drift" is a claim about these three call sites only.
 */

import {
  classifyBillingVerification,
  type BillingVerificationDenial,
  type BillingVerificationInput,
} from './entitlement-check';

/** The entitlement shape this gate reads. */
export type ProMcpEntitlement = {
  features: { tier: number; mcpAccess?: boolean };
  validUntil: number;
} & BillingVerificationInput;

export type ProMcpGateDenial =
  /**
   * The entitlement could not be verified, or a renewal re-check is in flight,
   * or the provider confirmed a lapse. `denial.retryable` distinguishes the
   * first two (retry) from the third (resubscribe) — callers must not flatten
   * them, that flattening is #5600.
   */
  | { kind: 'billing_verification'; denial: BillingVerificationDenial }
  /**
   * A confirmed answer that simply does not grant Pro MCP access: free tier, a
   * plan without mcpAccess, an expired validUntil, or a fail-closed null. This
   * is the honest upsell.
   */
  | { kind: 'insufficient_tier' };

/**
 * Returns null when the caller may proceed, else the reason.
 *
 * Ordering is load-bearing: an entitlement that currently grants Pro MCP access
 * is authorized even if it carries a renewal-verification marker for a stronger
 * plan, mirroring `checkEntitlementDetailed`'s tier-fallback. Classifying the
 * billing metadata first would 503 a user whose access is fine.
 */
export function checkProMcpAccess(
  entitlements: ProMcpEntitlement | null | undefined,
  now: number,
): ProMcpGateDenial | null {
  if (
    entitlements &&
    entitlements.features.tier >= 1 &&
    entitlements.features.mcpAccess === true &&
    entitlements.validUntil >= now
  ) {
    return null;
  }

  const denial = classifyBillingVerification(entitlements);
  return denial ? { kind: 'billing_verification', denial } : { kind: 'insufficient_tier' };
}

// ---------------------------------------------------------------------------
// JSON rendering for the two `api/internal/mcp-grant-*` handshake endpoints
// ---------------------------------------------------------------------------

/**
 * The ONE new error code the grant handshake gained in #5622.
 *
 * Why only one, when the shared contract has three retryable states: the two
 * grant endpoints exist to keep the apex `/mcp-grant` SPA "on a single canonical
 * contract" (see each file's header), and inside an OAuth handshake the only
 * distinction the SPA can act on is retry-vs-don't. The precise reason still
 * travels, in `X-Billing-Verification` and `error_description`, for monitoring
 * and support — it just does not fork the SPA's control flow three ways.
 *
 * `INSUFFICIENT_TIER` deliberately keeps covering a provider-confirmed lapse: it
 * IS a confirmed insufficient tier, retrying cannot fix it, and every existing
 * SPA/consumer branch for that code stays correct. Only the header is added, so
 * a lapse is distinguishable from a plain free account in logs.
 */
export const GRANT_VERIFICATION_UNAVAILABLE_CODE = 'TIER_VERIFICATION_UNAVAILABLE';

const NO_STORE_JSON: Record<string, string> = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

/**
 * Renders a gate denial in the grant handshake's `{error, error_description}`
 * vocabulary. Shared so `mcp-grant-mint.ts` and `mcp-grant-context.ts` cannot
 * answer the same entitlement state two different ways — the SPA branches on
 * `error`, so a divergence would show the user a different outcome depending on
 * whether they had clicked Authorize yet.
 */
export function proMcpGateDenialResponse(gate: ProMcpGateDenial): Response {
  if (gate.kind === 'insufficient_tier') {
    return jsonError('INSUFFICIENT_TIER', 'A WorldMonitor Pro subscription is required.', 403, {});
  }

  const { denial } = gate;
  if (!denial.retryable) {
    return jsonError(
      'INSUFFICIENT_TIER',
      'Your WorldMonitor Pro subscription is no longer active. Renew it, then start the connection again.',
      403,
      { 'X-Billing-Verification': denial.code },
    );
  }

  return jsonError(
    GRANT_VERIFICATION_UNAVAILABLE_CODE,
    `Your Pro subscription could not be verified just now (${denial.code}). `
    + 'This is temporary — retry in a moment.',
    503,
    {
      'X-Billing-Verification': denial.code,
      'Retry-After': String(denial.retryAfterSeconds),
    },
  );
}

function jsonError(
  error: string,
  error_description: string,
  status: number,
  extraHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ error, error_description }), {
    status,
    headers: { ...NO_STORE_JSON, ...extraHeaders },
  });
}
