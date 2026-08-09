/**
 * User-facing copy for a failed `/api/chat-analyst` response.
 *
 * Extracted from `src/components/ChatAnalystPanel.ts` as a zero-runtime-import
 * leaf, for the same reason `src/services/mcp-grant-denial.ts` and
 * `src/services/premium-denial.ts` exist: the panel module imports DOMPurify and
 * `marked` at module scope, both of which self-configure against the global DOM,
 * so nothing inside it is reachable from `tsx --test`. The decision below —
 * which denial is a retryable "we cannot confirm your access" vs a terminal
 * upsell — is exactly the #5600/#5622 flattening the sweep exists to remove, so
 * it needs to be executable by a test rather than asserted by a source grep.
 *
 * The only import is a TYPE, which erases at compile time.
 */

import type { PremiumDenialVerdict } from './premium-denial';

export const PRO_VERIFICATION_RETRY_MESSAGE =
  'Verifying your Pro access — try again in a moment.';

/**
 * Whether a response is the shared billing-verification 503.
 *
 * `classifyDenialResponse` deliberately owns only 401/403 — its own tests pin
 * that a 5xx is not its business — so this check has to happen before it, or the
 * one state where the user's subscription is fine and waiting actually works
 * renders the least actionable string we have, `Error 503`.
 *
 * Keyed on the header rather than the body so the caller's response stream stays
 * intact for `classifyDenialResponse`. The header is readable cross-origin
 * because #5622 added it to `Access-Control-Expose-Headers`.
 */
export function isBillingVerificationDenial(
  status: number,
  billingVerificationHeader: string | null,
): boolean {
  return status === 503 && Boolean(billingVerificationHeader);
}

/**
 * Copy for a verdict `classifyDenialResponse` already produced.
 *
 * `entitlement_desync` and the billing-verification 503 share copy on purpose:
 * from the user's side they are the same situation — we cannot confirm your
 * access right now, and retrying helps.
 */
export function analystDenialMessage(
  status: number,
  verdict: PremiumDenialVerdict | null,
): string {
  switch (verdict) {
    case 'sign_in_required':
      return 'Sign in to use the analyst.';
    case 'upgrade_required':
      return 'Pro subscription required.';
    case 'entitlement_desync':
      return PRO_VERIFICATION_RETRY_MESSAGE;
    case 'access_denied':
      return 'Analyst temporarily unavailable — try again in a moment.';
    default:
      return `Error ${status}`;
  }
}
