/**
 * Canonical entitlement decisions for standalone tier-1 JSON endpoints.
 *
 * Content-only Pro access has two equivalent signals:
 *   - Clerk session role === 'pro' (complimentary, tester, or legacy grants)
 *   - a resolved Convex entitlement with tier >= 1
 *
 * Notification-backed workflows deliberately require the second signal because
 * their configuration and relay delivery paths also require a Convex tier.
 */
import {
  getBillingVerificationDenial,
  getEntitlements,
  isEntitlementBackendConfigured,
  renderBillingVerificationDenial,
  unverifiableEntitlementDenial,
  type EntitlementCheckOptions,
} from './entitlement-check';

type ProEntitlementDecision =
  | { allowed: true }
  | { allowed: false; billingDenial: Response | null };

type EntitlementLoader = typeof getEntitlements;

export async function checkProEntitlement(
  userId: string,
  clerkRole: EntitlementCheckOptions['clerkRole'],
  corsHeaders: Record<string, string>,
  loadEntitlements: EntitlementLoader = getEntitlements,
): Promise<ProEntitlementDecision> {
  // Avoid turning a complimentary Clerk grant into a dependency on a Convex
  // row it does not have. This also avoids an unnecessary backend lookup for
  // role-only Pro.
  if (clerkRole === 'pro') return { allowed: true };

  return checkTierProEntitlement(userId, corsHeaders, loadEntitlements);
}

export async function checkTierProEntitlement(
  userId: string,
  corsHeaders: Record<string, string>,
  loadEntitlements: EntitlementLoader = getEntitlements,
): Promise<ProEntitlementDecision> {
  // Preserves the exact tier check these handlers already ran
  // inline (tier >= 1, no validUntil check) — this intentionally does NOT
  // match checkEntitlementDetailed, which additionally requires
  // `validUntil >= Date.now()`. Unifying that gap is a separate concern from
  // this PR's Clerk-role fix.
  const entitlements = await loadEntitlements(userId);
  if (entitlements && entitlements.features.tier >= 1) {
    return { allowed: true };
  }

  // An absent row is a verdict ("this account has no entitlement") only when a
  // lookup could actually run. With CONVEX_SITE_URL or the shared secret
  // missing, getEntitlements returns null before attempting one — for everyone,
  // paying customers included — and rendering that as `pro_required` sells the
  // plan they already own back to them because of OUR deploy defect (#5619).
  //
  // The null deliberately stays a null upstream: server/gateway.ts detects this
  // same state with isEntitlementBackendConfigured() and serves wm_-key traffic
  // fail-open, because 503ing a missing env var turns a config regression into
  // a fleet-wide API outage. That exception is for key-authenticated machine
  // traffic; a browser gate has no such trade-off to make, so it answers the
  // honest retryable contract instead.
  if (!entitlements && !isEntitlementBackendConfigured()) {
    return {
      allowed: false,
      billingDenial: renderBillingVerificationDenial(
        unverifiableEntitlementDenial(),
        corsHeaders,
        1,
      ),
    };
  }

  return {
    allowed: false,
    billingDenial: getBillingVerificationDenial(entitlements, corsHeaders, 1),
  };
}
