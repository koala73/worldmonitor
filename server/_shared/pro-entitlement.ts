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

  return {
    allowed: false,
    billingDenial: getBillingVerificationDenial(entitlements, corsHeaders, 1),
  };
}
