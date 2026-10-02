interface EntitlementCoverage {
  validUntil: number;
  billingStatus?: string;
  verificationUnavailable?: boolean;
}

/** Pending renewal may retain a current paid fallback; a confirmed lapse cannot. */
export function hasCurrentEntitlementCoverage<T extends EntitlementCoverage>(
  entitlement: T | null | undefined,
  now = Date.now(),
): entitlement is T {
  return entitlement != null
    && entitlement.verificationUnavailable !== true
    && entitlement.billingStatus !== 'subscription_lapsed'
    && Number.isFinite(entitlement.validUntil)
    && entitlement.validUntil >= now;
}
