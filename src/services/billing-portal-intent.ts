/**
 * `/dashboard?billing=portal`: open the Dodo billing portal once signed in.
 *
 * The payment-failure email CTA (`GET /api/customer-portal?t=`) lands here
 * whenever it cannot mint a session itself: expired or revoked token, rate
 * limit, relay error. A hold whose paid period ended derives `lapsed`, which
 * renders no payment banner, so without this intent that user had no route
 * from the email to the card form.
 *
 * Mirrors the pending-checkout lifecycle: capture strips the param and
 * persists the intent (so it survives the sign-in modal), and resume runs
 * at boot and again on every sign-in.
 */

export const BILLING_PORTAL_INTENT_PARAM = 'billing';
export const BILLING_PORTAL_INTENT_VALUE = 'portal';

const PENDING_BILLING_PORTAL_KEY = 'wm-pending-billing-portal';
// Long enough to finish a sign-in, short enough that an abandoned modal does
// not ambush an unrelated later sign-in with a portal redirect.
export const PENDING_BILLING_PORTAL_TTL_MS = 15 * 60 * 1000;

type PortalOutcome =
  | { outcome: 'opened' | 'open-failed'; url: string }
  | { outcome: 'no-customer' | 'account-changed' };

export interface ResumeBillingPortalDeps {
  getUserId: () => string | null | undefined;
  openAuth: () => void;
  openPortal: () => Promise<PortalOutcome>;
  notify: (message: string) => void;
  now?: () => number;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Strip `?billing=portal` from the URL and persist the intent. */
export function captureBillingPortalIntentFromUrl(options?: {
  location?: Pick<Location, 'href'>;
  replaceUrl?: (url: string) => void;
  now?: () => number;
  storage?: Pick<Storage, 'setItem'> | null;
}): boolean {
  const href = options?.location?.href ?? (typeof window === 'undefined' ? '' : window.location.href);
  if (!href) return false;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.searchParams.get(BILLING_PORTAL_INTENT_PARAM) !== BILLING_PORTAL_INTENT_VALUE) return false;

  url.searchParams.delete(BILLING_PORTAL_INTENT_PARAM);
  const replaceUrl = options?.replaceUrl ?? ((next: string) => window.history.replaceState({}, '', next));
  try {
    replaceUrl(url.toString());
  } catch {
    // A refresh would re-capture; harmless.
  }
  const storage = options?.storage === undefined ? defaultStorage() : options.storage;
  try {
    storage?.setItem(PENDING_BILLING_PORTAL_KEY, String((options?.now ?? Date.now)()));
  } catch {
    // Without storage the boot-time resume still runs for a signed-in user.
  }
  return true;
}

let resumeInFlight = false;

/**
 * Open the portal for a pending intent. Signed out: open the sign-in modal
 * and keep the intent for the post-auth resume. Signed in: consume the
 * intent first, so the boot path and the auth listener cannot both navigate.
 */
export async function resumePendingBillingPortal(
  deps: ResumeBillingPortalDeps,
  capturedThisLoad = false,
): Promise<boolean> {
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  const now = (deps.now ?? Date.now)();
  let savedAt: number | null = null;
  try {
    const raw = storage?.getItem(PENDING_BILLING_PORTAL_KEY);
    savedAt = raw ? Number(raw) : null;
  } catch {
    savedAt = null;
  }
  const fresh = savedAt !== null && Number.isFinite(savedAt) && now - savedAt <= PENDING_BILLING_PORTAL_TTL_MS;
  if (!fresh && !capturedThisLoad) {
    try {
      if (savedAt !== null) storage?.removeItem(PENDING_BILLING_PORTAL_KEY);
    } catch {
      // Ignore storage failures.
    }
    return false;
  }
  if (resumeInFlight) return false;

  if (!deps.getUserId()) {
    deps.openAuth();
    return false;
  }

  resumeInFlight = true;
  try {
    try {
      storage?.removeItem(PENDING_BILLING_PORTAL_KEY);
    } catch {
      // Ignore storage failures.
    }
    const result = await deps.openPortal();
    if (result.outcome === 'open-failed') {
      deps.notify('Could not open the billing portal. Please allow pop-ups and try again.');
    } else if (result.outcome === 'no-customer') {
      deps.notify('Billing portal unavailable. Email support@worldmonitor.app for help.');
    }
    return result.outcome === 'opened';
  } finally {
    resumeInFlight = false;
  }
}
