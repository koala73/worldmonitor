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
import { getCurrentClerkUser, getClerkToken, openSignIn } from './clerk';
import { subscribeAuthState } from './auth-state';
import { saveCheckoutAttempt, clearCheckoutAttempt } from './checkout-attempt';
import {
  classifyHttpCheckoutError,
  classifySyntheticCheckoutError,
  classifyThrownCheckoutError,
  type CheckoutError,
  type CheckoutErrorBody,
  type CheckoutErrorCode,
} from './checkout-errors';
import { showCheckoutErrorToast } from './checkout-error-toast';
import { decideNoUserPathOutcome } from './checkout-no-user-policy';
import { isEntitled, onEntitlementChange } from './entitlements';
import {
  CLASSIC_AUTO_DISMISS_MS,
  EXTENDED_UNLOCK_TIMEOUT_MS,
  computeInitialBannerState,
  type CheckoutSuccessBannerState,
} from './checkout-banner-state';

export {
  EXTENDED_UNLOCK_TIMEOUT_MS,
  computeInitialBannerState,
  type CheckoutSuccessBannerState,
} from './checkout-banner-state';

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
            // Mark a session flag so the reloaded page seeds the entitlement
            // transition detector as post-checkout — without this, the
            // detector would treat the first pro snapshot as "legacy-pro
            // baseline" and swallow the activation.
            //
            // Reload ownership: as of PR-4, the entitlement watcher in
            // panel-layout.ts is the SINGLE reload source (fires on
            // free→pro transition). We no longer schedule a 3s setTimeout
            // reload here — that competed with the entitlement watcher's
            // reload and made "still unlocking" UX impossible because the
            // banner was guaranteed to be wiped at 3s regardless of
            // webhook latency. The watcher's reload depends on the
            // 2026-04-18-001 fix landing first (#3163, merged).
            markPostCheckout();
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
    const intent = {
      productId,
      referralCode: options?.referralCode,
      discountCode: options?.discountCode,
    };
    reportCheckoutError(
      classifySyntheticCheckoutError('unauthorized'),
      { productId, action: 'no-user' },
    );
    // Pure policy decision lives in checkout-no-user-policy.ts; tested
    // against regression in tests/checkout-no-user-policy.test.mts. The
    // contract: redirect path MUST NOT write sessionStorage (would
    // create a stale dashboard intent that a later unrelated sign-in
    // would auto-resume); inline path MUST write so the post-auth
    // Clerk listener can resume the exact checkout.
    const outcome = decideNoUserPathOutcome(fallbackToPricingPage);
    if (outcome.kind === 'redirect-pro') {
      window.location.assign(outcome.redirectUrl);
    } else {
      savePendingCheckoutIntent(intent);
      saveCheckoutAttempt({
        ...intent,
        startedAt: Date.now(),
        origin: 'dashboard',
      });
      openSignIn();
    }
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
      const error = classifySyntheticCheckoutError('session_expired');
      reportCheckoutError(error, { productId, action: 'no-token' });
      renderCheckoutErrorSurface(error, fallbackToPricingPage);
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
      const body = (await resp.json().catch(() => ({}))) as CheckoutErrorBody;
      const error = classifyHttpCheckoutError(resp.status, body);
      reportCheckoutError(error, { productId, action: 'http-error' });
      // 409 duplicate-subscription continues to route through the
      // billing portal (PR-7 will add a user-facing dialog before the
      // portal hand-off). The taxonomy now classifies the code but we
      // preserve the current navigation until PR-7.
      if (error.code === 'duplicate_subscription') {
        clearPendingCheckoutIntent();
        clearCheckoutAttempt('duplicate');
        await openBillingPortal();
        return false;
      }
      // 401 from /api/create-checkout means the Clerk session we sent
      // is invalid or expired. A toast alone is a dead end — the user
      // needs to re-auth to retry. Save the intent and reopen sign-in
      // inline so the post-auth Clerk listener can auto-resume the
      // exact checkout without manual re-click.
      //
      // 403 is intentionally NOT routed here: 403 = valid auth but
      // forbidden action (banned account, plan-tier mismatch, etc.).
      // Reopening sign-in would not change the outcome and would
      // confuse the user. 403 falls through to the normal error
      // surface (toast) below.
      if (error.code === 'unauthorized' || error.code === 'session_expired') {
        savePendingCheckoutIntent({
          productId,
          referralCode: options?.referralCode,
          discountCode: options?.discountCode,
        });
        openSignIn();
        return false;
      }
      renderCheckoutErrorSurface(error, fallbackToPricingPage);
      return false;
    }

    const result = await resp.json();
    if (result?.checkout_url) {
      openCheckout(result.checkout_url);
      return true;
    }
    // 200 OK but no checkout_url is a server contract violation (the
    // edge relayer returned success but the payload is unusable). Used
    // to silently `return false` — the user saw nothing happen and the
    // bug was invisible in Sentry. Classify as service_unavailable
    // (closest accurate user-facing copy) and tag action so engineers
    // can filter this specific contract violation in Sentry. httpStatus
    // stays 200 — we want the actual status the server returned, not a
    // synthetic 5xx that would mask the real anomaly.
    const missingUrlError: CheckoutError = {
      code: 'service_unavailable',
      userMessage: 'Checkout is temporarily unavailable. Please try again in a moment.',
      serverMessage: 'Server returned 200 without a checkout_url',
      httpStatus: resp.status,
      retryable: true,
    };
    reportCheckoutError(missingUrlError, { productId, action: 'missing-checkout-url' });
    renderCheckoutErrorSurface(missingUrlError, fallbackToPricingPage);
    return false;
  } catch (err) {
    const error = classifyThrownCheckoutError(err);
    reportCheckoutError(error, { productId, action: 'exception' }, err);
    renderCheckoutErrorSurface(error, fallbackToPricingPage);
    return false;
  } finally {
    _checkoutInFlight = false;
  }
}

/**
 * Capture a checkout error to Sentry with structured context. Raw
 * server-generated text is attached as `extra.serverMessage` — never
 * surfaces to the user.
 *
 * Unauthorized / session_expired are *expected* user states (nobody
 * signed in yet, Clerk session aged out) rather than engineering
 * failures. They fire on every free-tier pricing click, so reporting
 * them at `error` level would drown Sentry in non-actionable noise.
 * Capture them at `info` so the funnel is still observable without
 * triggering alerts. Everything else stays at `error`.
 */
type SentryLevel = 'error' | 'info';
const INFO_LEVEL_CODES: ReadonlySet<CheckoutErrorCode> = new Set([
  'unauthorized',
  'session_expired',
]);

function reportCheckoutError(
  error: CheckoutError,
  context: { productId: string; action: string },
  caught?: unknown,
): void {
  const level: SentryLevel = INFO_LEVEL_CODES.has(error.code) ? 'info' : 'error';
  const payload = {
    level,
    tags: {
      component: 'dodo-checkout',
      action: context.action,
      code: error.code,
    },
    extra: {
      productId: context.productId,
      httpStatus: error.httpStatus,
      serverMessage: error.serverMessage,
    },
  };
  if (caught) {
    Sentry.captureException(caught, payload);
  } else {
    Sentry.captureMessage(`Checkout error: ${error.code}`, payload);
  }
  const logger = level === 'info' ? console.info : console.error;
  logger(
    `[checkout] ${error.code}${error.httpStatus ? ` (HTTP ${error.httpStatus})` : ''}`,
    error.serverMessage ?? '',
  );
}

/**
 * Render the appropriate user-facing surface for a checkout error.
 *
 * `fallbackToPricingPage` semantics:
 *   - true  → same-tab navigate to `/pro` so the user lands on the
 *             marketing pricing page (used by in-product upsells that
 *             expect to route users away from the dashboard).
 *   - false → inline toast only (default for dashboard-origin retries
 *             and resumePendingCheckout).
 *
 * Never uses `window.open(..., '_blank')` anymore — the stranded new
 * tab pattern was the failure mode this PR closes.
 */
function renderCheckoutErrorSurface(
  error: CheckoutError,
  fallbackToPricingPage: boolean,
): void {
  if (fallbackToPricingPage) {
    window.location.assign('https://worldmonitor.app/pro');
    return;
  }
  showCheckoutErrorToast(error.userMessage);
}

/**
 * Show the post-checkout success banner.
 *
 * Classic mode (no `waitForEntitlement`): renders "Payment received! ..."
 * and auto-dismisses after 5s. Used when entitlement unlock is a
 * synchronous consequence of the current page load (e.g., the overlay
 * handler firing pre-reload) or when the caller does not own the
 * entitlement lifecycle.
 *
 * Extended-unlock mode (`waitForEntitlement: true`): stays mounted and
 * transitions through three states that are observable via the
 * `data-entitlement-state` attribute:
 *   - `pending` (initial): "Payment received! Unlocking..."
 *   - `active`: "Premium activated — reloading..." (set either on
 *               mount when already entitled, or when the entitlement
 *               watcher fires free→pro). Lets the watcher trigger the
 *               actual reload so the banner persists across it.
 *   - `timeout`: after 30s with no transition, swap to an explicit
 *               "Refresh if features haven't unlocked" CTA + Sentry
 *               warning. Never silently disappears.
 */
export function showCheckoutSuccess(
  options?: { waitForEntitlement?: boolean },
): void {
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
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '12px',
  });

  setBannerText(banner, 'pending');
  document.body.appendChild(banner);

  requestAnimationFrame(() => {
    banner.style.transform = 'translateY(0)';
    banner.style.opacity = '1';
  });

  if (!options?.waitForEntitlement) {
    setTimeout(() => dismissBanner(banner), CLASSIC_AUTO_DISMISS_MS);
    return;
  }

  const initial = computeInitialBannerState(isEntitled());
  if (initial === 'active') {
    // Already entitled at mount (e.g., returned to the page after the
    // watcher-reload already flipped lock state, or Convex cache hit
    // before any transition could fire). The 'active' branch previously
    // sat forever with "Premium activated — reloading…" because:
    //   - onEntitlementChange listener below only fires on transitions,
    //     and we're already in steady pro state — no transition to
    //     observe.
    //   - No auto-dismiss / timeout existed for the fast-path.
    // Treat this like a classic confirmation: show active text and
    // auto-dismiss on the CLASSIC_AUTO_DISMISS_MS window so the user
    // gets closure instead of a banner that hangs until a hard refresh.
    setBannerText(banner, 'active');
    setTimeout(() => dismissBanner(banner), CLASSIC_AUTO_DISMISS_MS);
    return;
  }

  let resolved = false;
  const timeoutHandle = setTimeout(() => {
    if (resolved) return;
    resolved = true;
    unsubscribe();
    setBannerText(banner, 'timeout');
    Sentry.captureMessage('Checkout entitlement-activation timeout', {
      level: 'warning',
      tags: { component: 'dodo-checkout', action: 'entitlement-timeout' },
    });
  }, EXTENDED_UNLOCK_TIMEOUT_MS);

  const unsubscribe = onEntitlementChange(() => {
    if (resolved) return;
    if (!isEntitled()) return;
    resolved = true;
    clearTimeout(timeoutHandle);
    setBannerText(banner, 'active');
    unsubscribe();
  });
}

function setBannerText(banner: HTMLElement, state: CheckoutSuccessBannerState): void {
  banner.setAttribute('data-entitlement-state', state);
  if (state === 'pending') {
    banner.textContent = 'Payment received! Unlocking your premium features…';
    return;
  }
  if (state === 'active') {
    banner.textContent = 'Premium activated — reloading…';
    return;
  }
  // timeout
  banner.innerHTML = '';
  const text = document.createElement('span');
  text.textContent = "Payment received. If features haven't unlocked, refresh the page.";
  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.textContent = 'Refresh';
  Object.assign(refreshBtn.style, {
    background: '#fff',
    color: '#16a34a',
    border: 'none',
    borderRadius: '4px',
    padding: '4px 12px',
    fontWeight: '600',
    fontSize: '12px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  });
  refreshBtn.addEventListener('click', () => window.location.reload());
  banner.appendChild(text);
  banner.appendChild(refreshBtn);
}

function dismissBanner(banner: HTMLElement): void {
  banner.style.transform = 'translateY(-100%)';
  banner.style.opacity = '0';
  setTimeout(() => banner.remove(), 400);
}
