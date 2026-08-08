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
