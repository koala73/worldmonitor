/**
 * The Pro-MCP access decision, shared by the five entitlement gates listed below.
 *
 * Five call sites previously re-implemented the same four-clause check
 * (`tier >= 1 && mcpAccess === true && validUntil >= now`, plus the null case):
 *
 *   - `api/internal/mcp-grant-context.ts` — renders the consent card
 *   - `api/internal/mcp-grant-mint.ts`    — mints the signed grant
 *   - `api/oauth/authorize-pro.ts`        — finishes authorization on the
 *                                          api subdomain
 *   - `api/mcp/auth.ts`                   — protects MCP-edge requests
 *   - `server/gateway.ts`                 — re-checks signed internal MCP calls
 *
 * The decision lives here so the OAuth handshake cannot authorize an account
 * that the MCP edge or gateway later rejects. Each caller keeps its own response
 * envelope and telemetry (#5622, #5653).
 *
 * What this module owns, precisely: the ACCESS decision, for all five. The
 * `ProMcpGateDenial` union is consumed as a rendered decision only by the three
 * grant-flow callers (via `proMcpGateDenialResponse`). `api/mcp/auth.ts` and
 * `server/gateway.ts` read the return value as pass/deny and render billing
 * denials through their own helpers — which bottom out in the same
 * `entitlement-check.ts::classifyBillingVerification`. That function, not this
 * one, is the single source for billing classification.
 *
 * SCOPE — this does not own every Pro-MCP check in the repo. Two sites still
 * spell the predicate out by hand and are deliberately NOT routed here:
 *
 *   - `server/_shared/premium-check.ts` (internal-MCP trusted-marker branch) —
 *     tier + mcpAccess only, WITHOUT the `validUntil` clause. Safe today because
 *     `server/gateway.ts` is the sole setter of the trusted markers that reach
 *     it and applies this gate — validUntil included — before minting them. It
 *     is a weaker second layer, not a mirror.
 *   - `convex/mcpProTokens.ts::issueProMcpToken` — all four clauses, kept inline
 *     because the Convex runtime does not import from `server/_shared`.
 *
 * Both are comment-enforced mirrors. Tighten the predicate below and you must
 * check those two by hand; "cannot drift" is a claim about the five above only.
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
  /**
   * Some request-layer dependency types expose the marker as boolean even
   * though only literal true has billing semantics. False is normalized to
   * absence before classification below.
   */
  verificationUnavailable?: boolean;
} & Omit<BillingVerificationInput, 'verificationUnavailable'>;

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
    entitlements.features &&
    entitlements.features.tier >= 1 &&
    entitlements.features.mcpAccess === true &&
    entitlements.validUntil >= now
  ) {
    return null;
  }

  // Spread, never a hand-copied field list: every member of
  // BillingVerificationInput must reach the classifier by construction. That
  // Pick has grown before (#5622 added two of its three members), and because
  // its members are all OPTIONAL a literal that forgets a future one stays
  // assignable — typecheck passes while the field is silently dropped and a
  // retryable state renders as terminal. `premium-check.ts` (see the
  // verificationUnavailable comment there) documents that exact regression
  // already shipping once as #5600.
  //
  // Only the marker is overridden: ProMcpEntitlement widens it to `boolean` for
  // request-layer dependency types, while BillingVerificationInput wants the
  // literal `true`. False normalizes to absence, matching the truthiness test
  // the classifier already applied. The annotation is load-bearing — it supplies
  // the contextual type that stops that `true` from widening back to `boolean`.
  // Spread members are exempt from excess-property checking, so the extra
  // `features` / `validUntil` riding along are fine.
  const billingInput: BillingVerificationInput | null | undefined = entitlements
    ? {
        ...entitlements,
        verificationUnavailable: entitlements.verificationUnavailable === true ? true : undefined,
      }
    : entitlements;
  const denial = classifyBillingVerification(billingInput);
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
