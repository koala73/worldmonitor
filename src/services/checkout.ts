/**
 * Checkout overlay orchestration service.
 *
 * Manages the full checkout lifecycle in the vanilla TS dashboard:
 * - Lazy-initializes the Dodo Payments overlay SDK
 * - Creates checkout sessions via the Convex createCheckout action
 * - Opens the overlay with dark-theme styling matching the dashboard
 * - Stores pending checkout intents for /pro handoff flows
 * - Handles overlay events (success, error, close)
 *
 * UI code calls startCheckout(productId) -- everything else is internal.
 */

import * as Sentry from '@sentry/browser';
import { DodoPayments } from 'dodopayments-checkout';
import type { CheckoutEvent } from 'dodopayments-checkout';
import { openBillingPortal } from './billing';
import { getCurrentClerkUser, getClerkToken } from './clerk';
import { subscribeAuthState } from './auth-state';
import { saveCheckoutAttempt, clearCheckoutAttempt } from './checkout-attempt';

export {
  saveCheckoutAttempt,
  loadCheckoutAttempt,
  clearCheckoutAttempt,
  sweepAbandonedCheckoutAttempt,
  type CheckoutAttempt,
  type CheckoutAttemptClearReason,
} from './checkout-attempt';

const CHECKOUT_PRODUCT_PARAM = 'checkoutProduct';
const CHECKOUT_REFERRAL_PARAM = 'checkoutReferral';
const CHECKOUT_DISCOUNT_PARAM = 'checkoutDiscount';
const PENDING_CHECKOUT_KEY = 'wm-pending-checkout';
const POST_CHECKOUT_FLAG_KEY = 'wm-post-checkout';
const APP_CHECKOUT_BASE_URL = 'https://worldmonitor.app/';
const ACTIVE_SUBSCRIPTION_EXISTS = 'ACTIVE_SUBSCRIPTION_EXISTS';

/**
 * Session flag set just before the post-overlay reload. Lets panel-layout
 * detect "we just returned from an overlay checkout" on the reloaded page —
 * the overlay uses manualRedirect:true so there are no subscription_id URL
 * params to key off, unlike the full-page redirect return handled by
 * handleCheckoutReturn. Exported as a pair (consume+mark) to keep the key
 * centralized with the rest of the checkout storage constants.
 */
export function consumePostCheckoutFlag(): boolean {
  try {
    if (sessionStorage.getItem(POST_CHECKOUT_FLAG_KEY) === '1') {
      sessionStorage.removeItem(POST_CHECKOUT_FLAG_KEY);
      return true;
    }
  } catch {
    // Private browsing / storage disabled — fall through to false.
  }
  return false;
}

function markPostCheckout(): void {
  try {
    sessionStorage.setItem(POST_CHECKOUT_FLAG_KEY, '1');
  } catch {
    // Storage denied — the reload will still run; transition detector will
    // fall back to its null baseline, matching the pre-flag behavior.
  }
}

interface PendingCheckoutIntent {
  productId: string;
  referralCode?: string;
  discountCode?: string;
  /**
   * User id who saved this intent, or null if saved anonymously (the
   * common "click Buy, get sign-in modal" path). On resume, we only
   * fire the auto-checkout if:
   *   - savedByUserId === current user id (mid-flow redirect return), OR
   *   - savedByUserId === null AND current user is authenticated
   *     (anonymous intent → user just signed up/in — THIS IS the
   *     auto-resume case)
   * Anything else (A saved, B is now signed in) is a cross-user leak
   * and the intent is discarded.
   */
  savedByUserId?: string | null;
}

let initialized = false;
let onSuccessCallback: (() => void) | null = null;
let _successFired = false;
let _watchersInitialized = false;

/**
 * Initialize the Dodo overlay SDK. Idempotent -- second+ calls are no-ops.
 * Optionally accepts a success callback that fires when payment succeeds.
 */
export function initCheckoutOverlay(onSuccess?: () => void): void {
  if (initialized) return;

  if (onSuccess) {
    onSuccessCallback = onSuccess;
  }

  const env = import.meta.env.VITE_DODO_ENVIRONMENT;

  DodoPayments.Initialize({
    mode: env === 'live_mode' ? 'live' : 'test',
    displayType: 'overlay',
    onEvent: (event: CheckoutEvent) => {
      switch (event.event_type) {
        case 'checkout.status': {
          // Dodo SDK has emitted `event.data.status` in some versions and
          // `event.data.message.status` in others (the /pro build reads both
          // already; main app was only reading the first, so successes went
          // unnoticed whenever the SDK used the nested shape). Read both.
          const rawData = event.data as Record<string, unknown> | undefined;
          const status = typeof rawData?.status === 'string'
            ? rawData.status
            : (rawData?.message as Record<string, unknown> | undefined)?.status;
          if (status === 'succeeded') {
            _successFired = true;
            onSuccessCallback?.();
            // Terminal success: clear both keys. LAST_CHECKOUT_ATTEMPT_KEY
            // is no longer needed (no retry context required); PENDING is
            // cleared to avoid auto-opening the overlay on the reload.
            clearCheckoutAttempt('success');
            clearPendingCheckoutIntent();
            // Belt-and-braces: reload after the webhook is likely to have
            // landed (median <5s). Mark a session flag so the reloaded page
            // can seed the entitlement transition detector as post-checkout
            // — the overlay uses manualRedirect:true so the reload lands at
            // the original URL without subscription_id params, and the
            // detector would otherwise treat the first pro snapshot as the
            // legacy-pro baseline and swallow it.
            markPostCheckout();
            setTimeout(() => window.location.reload(), 3_000);
          }
          break;
        }
        case 'checkout.closed':
          // Only clear the auto-resume intent. Do NOT clear
          // LAST_CHECKOUT_ATTEMPT_KEY here — Dodo can emit `closed` BEFORE
          // the browser navigates to ?status=failed, and the failure
          // banner on the next page needs the attempt record to populate
          // the retry CTA. The attempt record will be cleared later by
          // the terminal path that actually resolves (success, dismissed,
          // duplicate, or the mount-time abandonment sweep).
          if (!_successFired) {
            clearPendingCheckoutIntent();
          }
          break;
        case 'checkout.error':
          console.error('[checkout] Overlay error:', event.data?.message);
          Sentry.captureMessage(`Dodo checkout overlay error: ${event.data?.message || 'unknown'}`, { level: 'error', tags: { component: 'dodo-checkout' } });
          break;
      }
    },
  });

  initialized = true;
}

/**
 * Destroy the checkout overlay — resets initialized flag and clears the
 * stored success callback so a new layout can register its own callback.
 */
export function destroyCheckoutOverlay(): void {
  initialized = false;
  onSuccessCallback = null;
}

function loadPendingCheckoutIntent(): PendingCheckoutIntent | null {
  try {
    const raw = sessionStorage.getItem(PENDING_CHECKOUT_KEY);
    return raw ? (JSON.parse(raw) as PendingCheckoutIntent) : null;
  } catch {
    return null;
  }
}

function savePendingCheckoutIntent(intent: PendingCheckoutIntent): void {
  try {
    sessionStorage.setItem(PENDING_CHECKOUT_KEY, JSON.stringify(intent));
  } catch {
    // Ignore storage failures; the current page load still has the URL params.
  }
}

function clearPendingCheckoutIntent(): void {
  try {
    sessionStorage.removeItem(PENDING_CHECKOUT_KEY);
  } catch {
    // Ignore storage failures.
  }
}

/**
 * Wire lifecycle watchers that need to fire outside the direct
 * startCheckout() call path. Idempotent.
 *
 * Clears per-session checkout state on ANY user-id change:
 *   - null → user (sign-in): nothing to clear, but initialize baseline.
 *   - user → null (sign-out): wipe state so the next user doesn't
 *     inherit it.
 *   - userA → userB (account switch, Clerk session swap, SSO
 *     re-attribution): also wipe — accidentally showing user B a retry
 *     button for user A's failed Pro checkout is worse than losing
 *     retry context.
 *
 * The `auth-state` subscription fires immediately with the current
 * session on subscribe, so we track the previously-observed id to
 * distinguish real transitions from the initial snapshot.
 */
export function initCheckoutWatchers(): void {
  if (_watchersInitialized) return;
  _watchersInitialized = true;

  let _lastUserId: string | null = null;
  let _initialized = false;
  subscribeAuthState((state) => {
    const nextId = state.user?.id ?? null;
    if (!_initialized) {
      _initialized = true;
      _lastUserId = nextId;
      // Defensive sweep on first snapshot: if the tab loads signed-out,
      // there's no legitimate owner for any prior checkout state — wipe
      // pending/post-checkout/attempt so a stale marker from a previous
      // user (closed tab, session expiry, account switch before reload)
      // can't leak into the next signed-in user's session. Signed-in
      // loads preserve state because that user may be returning from a
      // Dodo redirect mid-flow.
      if (nextId === null) {
        clearCheckoutAttempt('signout');
        clearPendingCheckoutIntent();
        try { sessionStorage.removeItem(POST_CHECKOUT_FLAG_KEY); } catch { /* ignore */ }
      }
      return;
    }
    if (nextId !== _lastUserId) {
      const isSignIn = _lastUserId === null && nextId !== null;
      if (isSignIn) {
        // null→user transition is a sign-IN, NOT a sign-OUT. The whole
        // point of pending/attempt state is to survive a sign-in so the
        // post-auth auto-resume listener can fire the deferred checkout.
        // Clearing here would race the resume listener and kill the
        // flow — reviewer flagged this as a subscriber-order bug.
        // Do NOT clear pending / post-checkout on sign-in.
      } else {
        // Everything else — sign-out, account switch (A→B), session
        // rotation — must wipe all checkout state so the next user
        // never inherits the previous user's intent/flag/attempt.
        clearCheckoutAttempt('signout');
        clearPendingCheckoutIntent();
        try { sessionStorage.removeItem(POST_CHECKOUT_FLAG_KEY); } catch { /* ignore */ }
      }
    }
    _lastUserId = nextId;
  });
}

export function buildCheckoutLaunchUrl(
  productId: string,
  options?: { referralCode?: string; discountCode?: string },
): string {
  const url = new URL(APP_CHECKOUT_BASE_URL);
  url.searchParams.set(CHECKOUT_PRODUCT_PARAM, productId);
  if (options?.referralCode) {
    url.searchParams.set(CHECKOUT_REFERRAL_PARAM, options.referralCode);
  }
  if (options?.discountCode) {
    url.searchParams.set(CHECKOUT_DISCOUNT_PARAM, options.discountCode);
  }
  return url.toString();
}

export function capturePendingCheckoutIntentFromUrl(): PendingCheckoutIntent | null {
  const url = new URL(window.location.href);
  const productId = url.searchParams.get(CHECKOUT_PRODUCT_PARAM);
  if (!productId) return null;

  console.log(`[checkout] Captured intent from URL: product=${productId}`);

  const intent: PendingCheckoutIntent = {
    productId,
    referralCode: url.searchParams.get(CHECKOUT_REFERRAL_PARAM) ?? undefined,
    discountCode: url.searchParams.get(CHECKOUT_DISCOUNT_PARAM) ?? undefined,
    // Stamp the owning user id at save time so a later load in the
    // same tab by a different user can discard this intent instead of
    // auto-resuming it. null = saved anonymously (the click-sign-in
    // flow), which is fair game for the first signed-in user.
    savedByUserId: getCurrentClerkUser()?.id ?? null,
  };
  savePendingCheckoutIntent(intent);
  // /pro-origin intent captured here also populates the failure-retry
  // record so a decline on this session's checkout can retry cross-origin.
  saveCheckoutAttempt({
    productId,
    referralCode: intent.referralCode,
    discountCode: intent.discountCode,
    startedAt: Date.now(),
    origin: 'pro',
  });

  url.searchParams.delete(CHECKOUT_PRODUCT_PARAM);
  url.searchParams.delete(CHECKOUT_REFERRAL_PARAM);
  url.searchParams.delete(CHECKOUT_DISCOUNT_PARAM);
  const cleanUrl = url.pathname + (url.searchParams.toString() ? `?${url.searchParams.toString()}` : '') + url.hash;
  window.history.replaceState({}, '', cleanUrl);

  return intent;
}

export async function resumePendingCheckout(options?: {
  openAuth?: () => void;
}): Promise<boolean> {
  const intent = loadPendingCheckoutIntent();
  if (!intent) {
    console.log('[checkout] resumePendingCheckout: no pending intent');
    return false;
  }

  const clerkUser = getCurrentClerkUser();
  console.log(`[checkout] resumePendingCheckout: intent=${intent.productId}, clerkUser=${clerkUser?.id ?? 'null'}, savedBy=${intent.savedByUserId ?? 'anon'}, hasOpenAuth=${!!options?.openAuth}`);

  if (!clerkUser?.id) {
    console.log('[checkout] resumePendingCheckout: no Clerk user, opening auth');
    options?.openAuth?.();
    return false;
  }

  // Cross-user leak guard: drop the intent if it was saved by a
  // different signed-in user. Anonymous saves (savedByUserId === null
  // OR missing for legacy intents pre-fix) are fair game for the
  // now-signed-in user — that's the auto-resume case.
  const savedBy = intent.savedByUserId;
  if (savedBy != null && savedBy !== clerkUser.id) {
    console.log('[checkout] resumePendingCheckout: intent belongs to different user, discarding');
    clearPendingCheckoutIntent();
    return false;
  }

  console.log(`[checkout] resumePendingCheckout: starting checkout for ${intent.productId}`);
  const success = await startCheckout(
    intent.productId,
    {
      referralCode: intent.referralCode,
      discountCode: intent.discountCode,
    },
    { fallbackToPricingPage: false },
  );
  if (success) clearPendingCheckoutIntent();
  return success;
}

/**
 * Open the Dodo checkout overlay for a given checkout URL.
 * Lazily initializes the SDK if not already done.
 */
export function openCheckout(checkoutUrl: string): void {
  initCheckoutOverlay();

  DodoPayments.Checkout.open({
    checkoutUrl,
    options: {
      manualRedirect: true,
      themeConfig: {
        dark: {
          bgPrimary: '#0d0d0d',
          bgSecondary: '#1a1a1a',
          borderPrimary: '#323232',
          textPrimary: '#ffffff',
          textSecondary: '#909090',
          buttonPrimary: '#22c55e',
          buttonPrimaryHover: '#16a34a',
          buttonTextPrimary: '#0d0d0d',
        },
        light: {
          bgPrimary: '#ffffff',
          bgSecondary: '#f8f9fa',
          borderPrimary: '#d4d4d4',
          textPrimary: '#1a1a1a',
          textSecondary: '#555555',
          buttonPrimary: '#16a34a',
          buttonPrimaryHover: '#15803d',
          buttonTextPrimary: '#ffffff',
        },
        radius: '4px',
      },
    },
  });
}

let _checkoutInFlight = false;

/**
 * High-level checkout entry point for UI code.
 *
 * Creates a checkout session via the /api/create-checkout edge endpoint
 * (which relays to Convex). Returns true if the overlay opened successfully.
 * Falls back to /pro page on any failure.
 */
export async function startCheckout(
  productId: string,
  options?: { discountCode?: string; referralCode?: string },
  behavior?: { fallbackToPricingPage?: boolean },
): Promise<boolean> {
  if (_checkoutInFlight) return false;
  const fallbackToPricingPage = behavior?.fallbackToPricingPage ?? true;

  const user = getCurrentClerkUser();
  if (!user) {
    if (fallbackToPricingPage) window.open('https://worldmonitor.app/pro', '_blank');
    return false;
  }

  _checkoutInFlight = true;
  _successFired = false;
  // Record the attempt BEFORE the network call so the failure-retry
  // banner has context even if every subsequent step fails (timeout,
  // user closes tab before Dodo redirects, SDK crashes, etc.).
  saveCheckoutAttempt({
    productId,
    referralCode: options?.referralCode,
    discountCode: options?.discountCode,
    startedAt: Date.now(),
    origin: 'dashboard',
  });
  try {
    let token = await getClerkToken();
    if (!token) {
      await new Promise((r) => setTimeout(r, 2000));
      token = await getClerkToken();
    }
    if (!token) {
      if (fallbackToPricingPage) window.open('https://worldmonitor.app/pro', '_blank');
      return false;
    }

    const resp = await fetch('/api/create-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        productId,
        returnUrl: window.location.origin,
        discountCode: options?.discountCode,
        referralCode: options?.referralCode,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      console.error('[checkout] Edge endpoint error:', resp.status, err);
      if (resp.status === 409 && err?.error === ACTIVE_SUBSCRIPTION_EXISTS) {
        clearPendingCheckoutIntent();
        clearCheckoutAttempt('duplicate');
        await openBillingPortal();
        return false;
      }
      if (fallbackToPricingPage) window.open('https://worldmonitor.app/pro', '_blank');
      return false;
    }

    const result = await resp.json();
    if (result?.checkout_url) {
      openCheckout(result.checkout_url);
      return true;
    }
    return false;
  } catch (err) {
    console.error('[checkout] Failed to create checkout session:', err);
    Sentry.captureException(err, { tags: { component: 'dodo-checkout', action: 'createCheckout' }, extra: { productId } });
    if (fallbackToPricingPage) window.open('https://worldmonitor.app/pro', '_blank');
    return false;
  } finally {
    _checkoutInFlight = false;
  }
}

/**
 * Show a transient success banner at the top of the viewport.
 * Auto-dismisses after 5 seconds.
 */
export function showCheckoutSuccess(): void {
  const existing = document.getElementById('checkout-success-banner');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.id = 'checkout-success-banner';
  Object.assign(banner.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    right: '0',
    zIndex: '99999',
    padding: '14px 20px',
    background: 'linear-gradient(135deg, #16a34a, #22c55e)',
    color: '#fff',
    fontWeight: '600',
    fontSize: '14px',
    textAlign: 'center',
    boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
    transition: 'opacity 0.4s ease, transform 0.4s ease',
    transform: 'translateY(-100%)',
    opacity: '0',
  });
  banner.textContent = 'Payment received! Unlocking your premium features...';

  document.body.appendChild(banner);

  requestAnimationFrame(() => {
    banner.style.transform = 'translateY(0)';
    banner.style.opacity = '1';
  });

  setTimeout(() => {
    banner.style.transform = 'translateY(-100%)';
    banner.style.opacity = '0';
    setTimeout(() => banner.remove(), 400);
  }, 5000);
}
