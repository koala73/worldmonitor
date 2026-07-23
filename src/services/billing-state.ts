/**
 * Pure billing UX state derivation (#4771).
 *
 * Turns the two reactive client snapshots (Convex subscription row +
 * entitlement row) into one explicit customer-facing billing state, so the
 * UI can distinguish "we are verifying your renewal" from "you are a free
 * user" instead of showing a generic Upgrade CTA to a paying customer whose
 * local renewal evidence went stale (missed/exhausted webhook).
 *
 * Server-side counterparts: the on-demand Dodo re-check (#4770/#5447) writes
 * `subscriptions.renewalVerificationState`, and the gateway/MCP already emit
 * the matching stable codes (`renewal_verification_pending/failed`,
 * `subscription_lapsed`) via `server/_shared/entitlement-check.ts`.
 *
 * MUST stay a zero-import leaf: it is unit-tested under `tsx --test`
 * (no jsdom, no Vite globals), and both services and components import it.
 */

export interface BillingSubscriptionSnapshot {
  status: 'active' | 'on_hold' | 'cancelled' | 'expired';
  /** Epoch ms end of the currently-paid period. */
  currentPeriodEnd: number;
  /** Verdict of the request-path renewal verification (#4770), if any. */
  renewalVerificationState?: 'pending' | 'failed' | 'lapsed' | null;
}

export interface BillingEntitlementSnapshot {
  planKey: string;
  /** Epoch ms until which the entitlement row grants access (0 = never). */
  validUntil: number;
}

export type BillingUxState =
  | 'free'
  | 'active'
  | 'on_hold'
  | 'renewal_verification_pending'
  | 'renewal_verification_failed'
  | 'lapsed';

/**
 * Precedence, mirroring the affirmative-denial philosophy of panel gating
 * (never over-gate on missing data):
 *
 * 1. `on_hold` always surfaces — the payment-failed banner must show even
 *    while the retry-window entitlement is still valid.
 * 2. A currently-valid paid entitlement means access works: `active`.
 * 3. No subscription row and no valid entitlement: plain `free`.
 * 4. An `active` subscription row without a valid entitlement is *stale paid
 *    evidence*: the verification verdict decides (`failed`/`lapsed`), an
 *    in-period row stays `active` (entitlement snapshot late/skipped), and a
 *    past-period row is `renewal_verification_pending` — reconciliation is
 *    queued (#4794) or in flight (#4770) even when no verdict is recorded yet.
 * 5. `cancelled` still inside its paid window keeps coverage (`active`) even
 *    when the entitlement snapshot is late — mirrors `isCoveringAt` in
 *    convex/payments/subscriptionHelpers.ts ("cancelled-but-paid-through").
 *    `cancelled` past the window and `expired` (never covering, same helper):
 *    provider-confirmed end of coverage — `lapsed`, not `free`, so copy can
 *    say "resubscribe".
 */
export function deriveBillingUxState(
  sub: BillingSubscriptionSnapshot | null,
  ent: BillingEntitlementSnapshot | null,
  now: number,
): BillingUxState {
  const entitledNow = ent !== null && ent.planKey !== 'free' && ent.validUntil >= now;
  if (!sub) return entitledNow ? 'active' : 'free';
  if (sub.status === 'on_hold') return 'on_hold';
  if (entitledNow) return 'active';
  if (sub.status === 'active') {
    if (sub.renewalVerificationState === 'failed') return 'renewal_verification_failed';
    if (sub.renewalVerificationState === 'lapsed') return 'lapsed';
    if (sub.currentPeriodEnd >= now) return 'active';
    return 'renewal_verification_pending';
  }
  if (sub.status === 'cancelled' && sub.currentPeriodEnd >= now) return 'active';
  return 'lapsed';
}

// Per-state sessionStorage dismissal keys. Distinct keys so dismissing the
// pending banner never suppresses a later failed banner. The bare
// 'pf-banner-dismissed' value predates #4771 and must stay unchanged so
// in-flight sessions keep their on_hold dismissal.
const ON_HOLD_DISMISS_KEY = 'pf-banner-dismissed';
const RENEWAL_PENDING_DISMISS_KEY = 'pf-banner-dismissed-renewal-pending';
const RENEWAL_FAILED_DISMISS_KEY = 'pf-banner-dismissed-renewal-failed';

/** Every dismissal key, for clearing when billing state recovers. */
export const BILLING_BANNER_DISMISS_KEYS: readonly string[] = [
  ON_HOLD_DISMISS_KEY,
  RENEWAL_PENDING_DISMISS_KEY,
  RENEWAL_FAILED_DISMISS_KEY,
];

export interface BillingBannerVariant {
  tone: 'error' | 'warning';
  /** i18n key (components.billingState.*) for the banner message. */
  messageKey: string;
  /** i18n key for the action button label; null renders no action button. */
  actionLabelKey: string | null;
  /** What the action button does. Only present when actionLabelKey is set. */
  action?: 'billing-portal';
  /** sessionStorage key scoping manual dismissal to this state. */
  dismissKey: string;
}

/**
 * Top-of-page banner content per state, as i18n keys — the same
 * components.billingState.* strings the panel CTA uses, so the two surfaces
 * cannot drift and the banner localizes. `on_hold` must stay compatible with
 * the pre-#4771 payment-failure banner (issue #4771 requires it intact):
 * onHoldBannerMessage's English value is byte-identical to the previously
 * hardcoded copy, and the dismiss key is unchanged. `lapsed` intentionally
 * renders no persistent banner: the panel CTA carries the resubscribe
 * message, and a permanent banner for long-lapsed users would just be
 * nagware.
 */
export function getBillingBannerVariant(state: BillingUxState): BillingBannerVariant | null {
  switch (state) {
    case 'on_hold':
      return {
        tone: 'error',
        messageKey: 'components.billingState.onHoldBannerMessage',
        actionLabelKey: 'components.billingState.updatePayment',
        action: 'billing-portal',
        dismissKey: ON_HOLD_DISMISS_KEY,
      };
    case 'renewal_verification_pending':
      return {
        tone: 'warning',
        messageKey: 'components.billingState.renewalPendingDesc',
        actionLabelKey: null,
        dismissKey: RENEWAL_PENDING_DISMISS_KEY,
      };
    case 'renewal_verification_failed':
      return {
        tone: 'error',
        messageKey: 'components.billingState.renewalFailedDesc',
        actionLabelKey: 'components.billingState.manageBilling',
        action: 'billing-portal',
        dismissKey: RENEWAL_FAILED_DISMISS_KEY,
      };
    default:
      return null;
  }
}

export type BillingGateOverride =
  | 'payment_on_hold'
  | 'renewal_pending'
  | 'renewal_failed'
  | 'lapsed';

/**
 * Which billing-specific gate reason (if any) should replace the generic
 * FREE_TIER "Upgrade to Pro" CTA for a locked premium panel. Values mirror
 * the PanelGateReason string enum in panel-gating.ts (kept as plain strings
 * here so this module stays a leaf).
 */
export function getBillingGateOverride(state: BillingUxState): BillingGateOverride | null {
  switch (state) {
    case 'on_hold':
      return 'payment_on_hold';
    case 'renewal_verification_pending':
      return 'renewal_pending';
    case 'renewal_verification_failed':
      return 'renewal_failed';
    case 'lapsed':
      return 'lapsed';
    default:
      return null;
  }
}
