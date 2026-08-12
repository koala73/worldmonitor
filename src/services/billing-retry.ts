/**
 * The client half of the retryable billing-verification contract (#5622).
 *
 * The server marks an entitlement lookup it could not complete as RETRYABLE:
 * HTTP 503 + `Retry-After` + `X-Billing-Verification: <code>` (built in one
 * place by `classifyBillingVerification` in
 * server/_shared/entitlement-check.ts, documented in docs/usage-errors.mdx).
 * That contract is inert unless a client actually honors it.
 *
 * This module is the single client-side decision point, mirroring the server's
 * own "one classifier, many renderers" shape. It was extracted from
 * `notification-channels.ts` when the premium RPC surface needed the same
 * decision (#6483): the gateway 503s EVERY tier-gated path on an unverifiable
 * entitlement, so the settings wizard was never the only caller that could see
 * one — it was just the only one that coped.
 *
 * Pure and transport-free on purpose. Callers own the waiting and the re-send,
 * because "how do I re-issue this request" differs per surface (an authenticated
 * POST must re-derive its token and re-assert its account; a premium GET must
 * not).
 */

/**
 * The `code`s the server marks RETRYABLE on a 503.
 *
 * An allowlist, not "any 503", and that is the whole point. Endpoints also
 * answer 503 for a missing Convex/relay env and for relay failures that happen
 * AFTER a mutation may have partially landed — blind-retrying a POST on those
 * risks a duplicate write. A billing-verification denial is emitted by the gate
 * BEFORE the handler runs, so retrying it is side-effect-free.
 *
 * `subscription_lapsed` is absent on purpose: it is a 403 and terminal.
 */
const RETRYABLE_BILLING_CODES = new Set([
  'entitlement_verification_unavailable',
  'renewal_verification_pending',
  'renewal_verification_failed',
]);

/** Used when the server omitted Retry-After; matches the server's own default. */
const DEFAULT_BILLING_RETRY_AFTER_SECONDS = 5;

/**
 * Longest delay worth waiting out inline. The server clamps Retry-After to
 * 1-60s; a user sitting in front of the page will not wait a minute, so a
 * longer hint means "surface the failure now" rather than "retry early".
 *
 * This threshold is not arbitrary — it lands between the delays the three
 * retryable states actually ask for (convex/payments/billing.ts):
 *
 *   entitlement_verification_unavailable  fixed 5s      -> retried
 *   renewal_verification_pending          1-3s, from
 *                                         the 2s Dodo
 *                                         re-check window -> retried
 *   renewal_verification_failed           up to 60s, the
 *                                         per-subscription
 *                                         failure cooldown -> NOT retried
 *
 * Declining the third is the correct outcome, not a shortfall: that cooldown
 * exists to stop re-querying Dodo, so a retry inside it is answered from the
 * same cooled-down state. Waiting it out inline would block for a minute to
 * arrive at the same denial.
 *
 * Retrying EARLIER than the server asked is deliberately not an option either:
 * it violates the Retry-After contract and, because the server negative-caches
 * a transient answer for a few seconds
 * (UNAVAILABLE_NEGATIVE_CACHE_TTL_MS in server/_shared/entitlement-check.ts),
 * an early retry would deterministically be served the same cached failure.
 */
export const BILLING_RETRY_MAX_DELAY_MS = 10_000;

/**
 * How long to wait before the single retry, or null when this response must not
 * be retried. Pure — the wire decision, testable without a network.
 */
export function billingVerificationRetryDelayMs(input: {
  status: number;
  code: string | null;
  retryAfterHeader: string | null;
}): number | null {
  if (input.status !== 503) return null;
  if (!input.code || !RETRYABLE_BILLING_CODES.has(input.code)) return null;

  const parsed = Number(input.retryAfterHeader);
  const seconds = Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_BILLING_RETRY_AFTER_SECONDS;
  const delayMs = Math.ceil(seconds * 1_000);
  return delayMs > BILLING_RETRY_MAX_DELAY_MS ? null : delayMs;
}

/**
 * The denial code, header-first with a body fallback.
 *
 * `X-Billing-Verification` is now in Access-Control-Expose-Headers (#5622), but
 * the dashboard's same-origin calls are not the only consumers — the Tauri shell
 * and widget embeds are cross-origin, and an intermediary can strip a header.
 * The body's `code` mirrors it, read off a CLONE so the caller's response stream
 * is untouched whether or not we end up retrying.
 */
export async function readBillingVerificationCode(res: Response): Promise<string | null> {
  const header = res.headers.get('X-Billing-Verification');
  if (header) return header;
  try {
    const body = await res.clone().json() as { code?: unknown };
    return typeof body.code === 'string' ? body.code : null;
  } catch {
    return null;
  }
}
