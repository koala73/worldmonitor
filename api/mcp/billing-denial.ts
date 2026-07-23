// #4770 review: billing-verification denials from the gateway must survive the
// tool `_execute` fetch layer. Without this, a mid-request entitlement lapse
// (gateway 403/503 with X-Billing-Verification) is flattened by dispatch's
// catch-all into HTTP 200 / -32603 "Internal error: data fetch failed" — the
// agent loses the retry/billing signal for exactly the window the on-demand
// renewal verification exists to cover.

import type { BillingVerificationStatus } from '../../server/_shared/entitlement-check';

export type BillingVerificationCode =
  | BillingVerificationStatus
  // Gateway-synthesized (server/gateway.ts wm_-key branch): backend-unreachable
  // fail-closed 503. Deliberately NOT in the Convex-facing
  // BillingVerificationStatus union — Convex never produces it.
  | 'entitlement_verification_unavailable';

const BILLING_VERIFICATION_CODES: ReadonlySet<string> = new Set([
  'subscription_lapsed',
  'renewal_verification_pending',
  'renewal_verification_failed',
  'entitlement_verification_unavailable',
] satisfies BillingVerificationCode[]);

export class BillingDenialError extends Error {
  readonly status: number;
  readonly billingCode: BillingVerificationCode;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    label: string,
    status: number,
    billingCode: BillingVerificationCode,
    retryAfterSeconds: number | undefined,
  ) {
    // Keep the `<tool> HTTP <status>` shape: dispatch's log-severity downgrade
    // for expected 4xx keys on this message format.
    super(`${label} HTTP ${status} (${billingCode})`);
    this.name = 'BillingDenialError';
    this.status = status;
    this.billingCode = billingCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Structural subset of Response so test doubles that stub only {ok, status}
// (several suites do) pass through the non-billing path instead of throwing
// on a missing headers object.
type ToolFetchResponse = {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
};

/**
 * Throws BillingDenialError when a non-ok gateway response carries the
 * billing-verification marker header. Detection is header-only, so callers
 * that read the error body for detail can still consume it afterwards.
 */
export function throwIfBillingDenial(response: ToolFetchResponse, label: string): void {
  if (response.ok) return;
  const marker = response.headers?.get('X-Billing-Verification');
  if (!marker || !BILLING_VERIFICATION_CODES.has(marker)) return;
  // Distinguish a missing header from a present-but-zero value: Number(null)
  // is 0 (finite), which would silently masquerade as an explicit 0s hint.
  const retryHeader = response.headers?.get('Retry-After');
  const rawRetryAfter = retryHeader == null ? Number.NaN : Number(retryHeader);
  throw new BillingDenialError(
    label,
    response.status,
    marker as BillingVerificationCode,
    Number.isFinite(rawRetryAfter) ? rawRetryAfter : undefined,
  );
}

/**
 * Standard non-ok handling for tool `_execute` gateway fetches: billing
 * denials become typed errors dispatch can re-emit faithfully; everything
 * else keeps the existing `<label> HTTP <status>` Error contract.
 */
export function assertToolFetchOk(response: ToolFetchResponse, label: string): void {
  if (response.ok) return;
  throwIfBillingDenial(response, label);
  throw new Error(`${label} HTTP ${response.status}`);
}
