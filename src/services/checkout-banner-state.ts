/**
 * Pure helpers for the checkout-success banner's extended-unlock state
 * machine. Lives in its own module so tests (and any future consumer)
 * can exercise the decision logic without pulling in `dodopayments-
 * checkout` through `checkout.ts`.
 */

export type CheckoutSuccessBannerState = 'pending' | 'active' | 'timeout';

/**
 * How long to wait for the post-checkout entitlement transition before
 * switching into the `timeout` state. Median webhook-to-entitlement
 * latency observed in prod is <5s (per 2026-04-18 incident analysis);
 * 30s covers the long tail without letting a genuinely stuck
 * activation hide behind a "still loading" banner.
 */
export const EXTENDED_UNLOCK_TIMEOUT_MS = 30_000;

/**
 * Auto-dismiss window for the classic (non-waitForEntitlement) banner.
 * Informational-only usage where the panel unlock is already guaranteed.
 */
export const CLASSIC_AUTO_DISMISS_MS = 5_000;

/**
 * Decide the initial banner state at mount time.
 *
 * If the user already has pro entitlement when the banner fires
 * (e.g., the post-reload `consumePostCheckoutFlag` path where the
 * entitlement watcher already flipped true), skip "pending" and go
 * straight to "active" so the banner doesn't falsely suggest the
 * webhook is still in flight.
 */
export function computeInitialBannerState(entitledNow: boolean): CheckoutSuccessBannerState {
  return entitledNow ? 'active' : 'pending';
}
