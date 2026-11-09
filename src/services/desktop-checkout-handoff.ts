/**
 * Desktop -> /pro handoff URLs (#5911, #10342).
 *
 * The desktop app cannot run checkout in its WebView (3DS), so every upgrade
 * exit opens /pro in the OS browser. That browser has its own Clerk session,
 * which may belong to a different account. Each handoff URL therefore carries
 * the desktop marker plus a fingerprint of the app's account, and /pro asks
 * before charging any other account.
 *
 * Callers decide whether they are on desktop; on the web they must open the
 * plain URL synchronously inside the click gesture and never call this.
 */
import type { CheckoutAttribution } from './analytics';
import { buildAttributedProUrl, fingerprintCheckoutAccount } from '../../shared/checkout-attribution';

/** How long a click waits for the deferred Clerk load before sending no fingerprint. */
const AUTH_SETTLE_TIMEOUT_MS = 4_000;

/**
 * The signed-in desktop user id, waiting out the deferred Clerk load. Auth
 * state starts as `{ user: null, isPending: true }` until the idle-scheduled
 * SDK load finishes; reading it early makes a signed-in user look signed out,
 * and the handoff would then carry no fingerprint for /pro to check.
 */
async function settledDesktopUserId(): Promise<string | null> {
  const { getAuthState, subscribeAuthState } = await import('./auth-state');
  const current = getAuthState();
  if (!current.isPending) return current.user?.id ?? null;

  return new Promise((resolve) => {
    let done = false;
    let unsubscribe: () => void = () => {};
    const finish = (userId: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(userId);
    };
    // The click is the first thing that needs auth: start the load now instead
    // of waiting for the idle callback (single-flight in clerk.ts). A load that
    // fails will never settle auth state, so stop waiting at once (offline
    // desktop) rather than holding the click for the whole timeout.
    void import('./clerk').then((clerk) => clerk.initClerk()).catch(() => finish(null));
    const timer = setTimeout(() => finish(getAuthState().user?.id ?? null), AUTH_SETTLE_TIMEOUT_MS);
    // subscribeAuthState emits the current state synchronously, so `finish`
    // can run before the unsubscribe handle exists.
    unsubscribe = subscribeAuthState((state) => {
      if (!state.isPending) finish(state.user?.id ?? null);
    });
    if (done) unsubscribe();
  });
}

/**
 * `baseUrl` as a desktop handoff: marker, mission attribution, and the account
 * fingerprint when one can be resolved. Never rejects. A missing fingerprint
 * (signed out, auth never settled, hashing unavailable) degrades to the
 * unbound handoff rather than blocking the way to the pricing page.
 *
 * Pass `userId` when the caller already knows it (`null` for signed out);
 * omit it to read the settled auth state.
 */
export async function buildDesktopProHandoffUrl(
  baseUrl: string,
  attribution?: CheckoutAttribution | null,
  userId?: string | null,
): Promise<string> {
  let accountFingerprint: string | null = null;
  try {
    const id = userId === undefined ? await settledDesktopUserId() : userId;
    accountFingerprint = id ? await fingerprintCheckoutAccount(id) : null;
  } catch {
    accountFingerprint = null;
  }
  return buildAttributedProUrl(baseUrl, attribution, { desktopHandoff: true, accountFingerprint });
}
