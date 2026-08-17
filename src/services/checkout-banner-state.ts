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
 * How often the banner re-reads `isEntitled()` while it waits.
 *
 * The entitlement subscription only emits on a TRANSITION this page observed.
 * A buyer returning from Dodo's hosted checkout is on a cold load, so the
 * entitlement is often already true by the time Convex authenticates — no
 * transition, no event, and an event-only wait never settles (WORLDMONITOR-PZ).
 * Polling is a synchronous read of an in-memory store, so 1s costs nothing.
 */
export const ENTITLEMENT_POLL_MS = 1_000;

/**
 * How long the banner keeps watching after it has announced a timeout.
 *
 * The banner never auto-dismisses in the wait-for-entitlement flow, so a
 * genuinely slow activation should still be able to correct the message rather
 * than leave a paying customer looking at a failure until they reload. Bounded
 * rather than page-lifetime so the watchers cannot leak.
 */
export const LATE_ACTIVATION_GRACE_MS = 300_000;

/**
 * Auto-dismiss window for the classic (non-waitForEntitlement) banner.
 * Informational-only usage where the panel unlock is already guaranteed.
 */
export const CLASSIC_AUTO_DISMISS_MS = 5_000;

/**
 * Mask an email address for display in the success banner so the
 * full address isn't rendered in plaintext (privacy — a top-of-
 * viewport banner can be screen-shared, photographed, or recorded).
 *
 * Shape: first character of the local part + `***` + `@domain`.
 * Short local parts (1 char) still render safely: `a***@x.com`.
 * IDN / plus-addressing / dots in the local part pass through the
 * domain unchanged so the user can still recognize "yes, that's
 * where the receipt went."
 *
 * Returns null when the input isn't a minimally-valid email so
 * callers can fall back to the email-less banner copy rather than
 * render obviously-broken output.
 */
export function maskEmail(email: string | undefined | null): string | null {
  if (!email || typeof email !== 'string') return null;
  const trimmed = email.trim();
  const atIndex = trimmed.indexOf('@');
  // Require at least `a@b` — one char local, one char domain.
  if (atIndex < 1 || atIndex === trimmed.length - 1) return null;
  const local = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex);
  const firstChar = local.charAt(0);
  return `${firstChar}***${domain}`;
}
