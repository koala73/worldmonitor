interface EntitlementCoverage {
  validUntil: number;
  billingStatus?: string;
  verificationUnavailable?: boolean;
}

/** Where a paused subscriber updates their card. Same URL as api/customer-portal.ts's fallback. */
export const BILLING_PORTAL_URL = 'https://www.worldmonitor.app/dashboard?billing=portal';

/**
 * Billing states the provider confirmed, so retrying cannot change them: the
 * subscription ended, or it is paused because a renewal payment failed and
 * Dodo is still retrying. Every other billing status is about the verification.
 */
export const TERMINAL_BILLING_STATUSES = ['subscription_lapsed', 'payment_failed'] as const;

export function isTerminalBillingStatus(
  status: unknown,
): status is (typeof TERMINAL_BILLING_STATUSES)[number] {
  return (TERMINAL_BILLING_STATUSES as readonly unknown[]).includes(status);
}

/** Pending renewal may retain a current paid fallback; a confirmed lapse or pause cannot. */
export function hasCurrentEntitlementCoverage<T extends EntitlementCoverage>(
  entitlement: T | null | undefined,
  now = Date.now(),
): entitlement is T {
  return entitlement != null
    && entitlement.verificationUnavailable !== true
    && !isTerminalBillingStatus(entitlement.billingStatus)
    && Number.isFinite(entitlement.validUntil)
    && entitlement.validUntil >= now;
}
