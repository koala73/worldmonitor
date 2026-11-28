/**
 * The desktop app hands checkout to the OS browser (#5911), where /pro runs
 * on the browser's own Clerk session. The handoff names the account signed in
 * to the app so /pro can stop a checkout on a different account (#10342).
 *
 * Kept apart from checkout-attribution.ts: the desktop opener loads this on
 * every app start, and the attribution tables would cost it ~3 KB.
 */
export const CHECKOUT_HANDOFF_PARAM = 'wm_checkout_handoff';
export const DESKTOP_CHECKOUT_HANDOFF = 'desktop';
export const CHECKOUT_DESKTOP_ACCOUNT_PARAM = 'wm_checkout_account';

/**
 * The app could not read its own session in time (Clerk still loading or
 * failed), so /pro must ask which account to upgrade rather than assume.
 */
export const UNKNOWN_DESKTOP_ACCOUNT = 'unknown';

/**
 * `account` is `desktopAccountDigest` of the account signed in to the app, or
 * `UNKNOWN_DESKTOP_ACCOUNT`. It is absent when the app was signed out, or was
 * a build from before #10342, and then /pro cannot tell whether its own
 * session is the same account.
 */
export interface DesktopCheckoutHandoff {
  account?: string;
}

const DESKTOP_ACCOUNT_DIGEST_PATTERN = /^[0-9a-f]{16}$/;

/**
 * A stable, non-reversible stand-in for a Clerk user id. The handoff URL sits
 * in the OS browser's history and in analytics page URLs, and /pro only needs
 * to compare two accounts, never to name one.
 */
export async function desktopAccountDigest(userId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`wm-desktop-checkout:${userId}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function stampDesktopCheckoutHandoff(params: URLSearchParams, handoff: DesktopCheckoutHandoff): void {
  params.set(CHECKOUT_HANDOFF_PARAM, DESKTOP_CHECKOUT_HANDOFF);
  if (handoff.account) params.set(CHECKOUT_DESKTOP_ACCOUNT_PARAM, handoff.account);
  else params.delete(CHECKOUT_DESKTOP_ACCOUNT_PARAM);
}

export function parseDesktopCheckoutHandoff(search: string): DesktopCheckoutHandoff | null {
  const params = new URLSearchParams(search);
  if (params.get(CHECKOUT_HANDOFF_PARAM) !== DESKTOP_CHECKOUT_HANDOFF) return null;
  const account = params.get(CHECKOUT_DESKTOP_ACCOUNT_PARAM);
  return account && (account === UNKNOWN_DESKTOP_ACCOUNT || DESKTOP_ACCOUNT_DIGEST_PATTERN.test(account))
    ? { account }
    : {};
}
