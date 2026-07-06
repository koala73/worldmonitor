/**
 * Checkout orchestration service (vanilla TS dashboard).
 *
 * ACTIVE FLOW — redirect mode (#4449): `startCheckout(productId)` creates a Dodo
 * checkout session via the Convex createCheckout action and then navigates the
 * top window to Dodo's HOSTED checkout (`window.location.assign`). The overlay
 * iframe could not host Dodo's nested 3DS/fraud stack, so card payments hung at
 * "Processing…"; redirect runs 3DS/fraud unconstrained and #4447 returns the
 * buyer to `/dashboard?wm_checkout=return` to reconcile.
 *
 * DORMANT — the Dodo overlay SDK machinery below (ensureCheckoutOverlayInitialized,
 * the onEvent handler, the entitlement watchdog, openCheckout) is no longer on
 * any live path (openCheckout has zero callers) and is kept pending removal. Do
 * NOT assume the overlay is the checkout path when reading the handlers below.
 *
 * UI code calls startCheckout(productId) -- everything else is internal.
 */

import { enqueueSentryCall } from '@/bootstrap/sentry-defer';
import type { CheckoutEvent } from 'dodopayments-checkout';
import { openBillingPortal, prereserveBillingPortalTab } from './billing';
import { getCurrentClerkUser, getClerkToken, openSignIn } from './clerk';
import { subscribeAuthState } from './auth-state';
import { saveCheckoutAttempt, clearCheckoutAttempt } from './checkout-attempt';
import { safeHostedCheckoutUrl } from './hosted-checkout-url';
import {
  classifyHttpCheckoutError,
  classifySyntheticCheckoutError,
  classifyThrownCheckoutError,
  parseCheckoutErrorBody,
  snapshotUpstreamResponse,
  type CheckoutError,
  type CheckoutErrorCode,
  type UpstreamSnapshot,
} from './checkout-errors';
import { showCheckoutErrorToast } from './checkout-error-toast';
import { decideNoUserPathOutcome } from './checkout-no-user-policy';
import { shouldSkipSentryForAction } from './checkout-sentry-policy';
import { isEntitled, onEntitlementChange } from './entitlements';
import {
  CLASSIC_AUTO_DISMISS_MS,
  EXTENDED_UNLOCK_TIMEOUT_MS,
  maskEmail,
  type CheckoutSuccessBannerState,
} from './checkout-banner-state';
import { loadActiveReferral } from './referral-capture';
import { trackCheckoutStart } from './analytics';
import { showDuplicateSubscriptionDialog } from './checkout-duplicate-dialog';
import { showCheckoutPendingDialog } from './checkout-pending-dialog';
import { resolvePlanDisplayName } from './checkout-plan-names';
import { createEntitlementWatchdog, type EntitlementWatchdog } from './entitlement-watchdog';
import { buildDashboardCheckoutReturnUrl } from './checkout-return-url';
import { saveAnonClaimToken } from './anonymous-identity-storage';

export {
  EXTENDED_UNLOCK_TIMEOUT_MS,
  maskEmail,
  type CheckoutSuccessBannerState,
} from './checkout-banner-state';

export {
  saveCheckoutAttempt,
  loadCheckoutAttempt,
  clearCheckoutAttempt,
  type CheckoutAttempt,
  type CheckoutAttemptClearReason,
} from './checkout-attempt';

const CHECKOUT_PRODUCT_PARAM = 'checkoutProduct';
const CHECKOUT_REFERRAL_PARAM = 'checkoutReferral';
const CHECKOUT_DISCOUNT_PARAM = 'checkoutDiscount';
const PENDING_CHECKOUT_KEY = 'wm-pending-checkout';
const POST_CHECKOUT_FLAG_KEY = 'wm-post-checkout';
const APP_CHECKOUT_BASE_URL = 'https://worldmonitor.app/dashboard';

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
  /**
   * Unix-ms when this intent was saved. Stale intents (closed Clerk
   * modal without signing in, then hours later another sign-in for
   * unrelated reasons) must not auto-resume checkout — the user's
   * intent to buy has expired. Loaders apply PENDING_INTENT_TTL_MS
   * and discard anything older.
   */
  savedAt?: number;
}

/**
 * Max age of a saved pending-checkout intent before auto-resume is
 * suppressed. 15 minutes covers a typical sign-in round-trip (read
 * the dialog, switch to password manager, go through verification)
 * without leaking into the "unrelated sign-in much later" case that
 * previously fired a stale checkout. Matches the "user walked away
 * from the flow" threshold — longer than that and we treat a later
 * sign-in as unrelated.
 */
const PENDING_INTENT_TTL_MS = 15 * 60 * 1000;

// Overlay lifecycle state. The two init flags below have DIFFERENT reset
// semantics — keep them distinct or the #4387 double-Initialize bug returns:
//   - `initialized`: UI/overlay session lifecycle. RESET to false in
//     destroyCheckoutOverlay() so a remount re-runs ensureCheckoutOverlayInitialized.
//   - `dodoPaymentsInitialized` (below): SDK singleton guard. NEVER reset.
//     DodoPayments.Initialize must run exactly once per page load (it registers
//     a page-lifetime postMessage listener); the per-session event handler is
//     swapped via `currentCheckoutEventHandler`, never by re-Initializing.
let initialized = false;
let checkoutOverlayGeneration = 0;
let overlayInitPromise: Promise<void> | null = null;
let dodoPayments: (typeof import('dodopayments-checkout'))['DodoPayments'] | null = null;
let dodoPaymentsPromise: Promise<(typeof import('dodopayments-checkout'))['DodoPayments']> | null = null;
let dodoPaymentsInitialized = false;
let currentCheckoutEventHandler: ((event: CheckoutEvent) => void) | null = null;
let onSuccessCallback: (() => void) | null = null;
let _resetOverlaySession: (() => void) | null = null;
let _watchersInitialized = false;
let _escapeHandler: ((e: KeyboardEvent) => void) | null = null;

async function loadDodoPayments(): Promise<(typeof import('dodopayments-checkout'))['DodoPayments']> {
  if (dodoPayments) return dodoPayments;
  if (!dodoPaymentsPromise) {
    dodoPaymentsPromise = import('dodopayments-checkout')
      .then((mod) => {
        dodoPayments = mod.DodoPayments;
        return mod.DodoPayments;
      })
      .catch((error) => {
        dodoPaymentsPromise = null;
        throw error;
      });
  }
  return dodoPaymentsPromise;
}

/**
 * Entitlement watchdog tuning (mirrors pro-test/src/services/checkout.ts).
 *
 * Dodo's overlay can navigate to `/status/{id}/wallet-return` after a
 * successful payment (observed on subscription-trial `amount=0` flows)
 * and never emit `checkout.status` or `checkout.redirect_requested`.
 * Prior PRs assumed Dodo would emit SOMETHING; the wallet-return path
 * emits nothing. Watchdog polls our own entitlement endpoint so the
 * post-checkout cleanup runs from the webhook regardless of what
 * Dodo's iframe does. See docs/plans/2026-04-23-002-*-plan.md.
 */
const WATCHDOG_INTERVAL_MS = 3_000;
const WATCHDOG_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Dodo's hosted overlay has been observed to deadlock: the in-iframe X
 * button hits `GET /api/checkout/sessions/{id}/payment-link` → 404 →
 * unhandled rejection in their React code → Maximum-update-depth render
 * loop. When that happens, the `checkout.closed` postMessage never
 * escapes their iframe, so our onEvent handler can't clean up and the
 * user is trapped on the overlay. `DodoPayments.Checkout.close()`
 * removes the iframe at the merchant-SDK level and works even when the
 * inner overlay is frozen — it's the only safety net available since
 * CheckoutOptions has no onCancel/dismissBehavior hook (SDK 1.8.0).
 */
function safeCloseOverlay(): void {
  try {
    if (dodoPayments?.Checkout.isOpen?.()) {
      dodoPayments.Checkout.close();
    }
  } catch {
    // Swallow — the overlay is already gone or the SDK is mid-teardown.
  }
}

/**
 * Register the checkout success callback. The Dodo overlay SDK itself is
 * initialized lazily on first checkout open (see ensureCheckoutOverlayInitialized)
 * so it stays off the startup path — this call no longer initializes anything.
 */
export function registerCheckoutSuccessCallback(onSuccess?: () => void): void {
  if (onSuccess) {
    onSuccessCallback = onSuccess;
  }
}

async function ensureCheckoutOverlayInitialized(): Promise<void> {
  if (initialized) return;
  if (overlayInitPromise) return overlayInitPromise;

  const generation = checkoutOverlayGeneration;

  const thisInitPromise = (async () => {
    const DodoPayments = await loadDodoPayments();
    if (generation !== checkoutOverlayGeneration) {
      throw new Error('Checkout overlay initialization cancelled');
    }

    const env = import.meta.env.VITE_DODO_ENVIRONMENT;

    // `successFired` must be scoped per-overlay-session, NOT module.
    // Previously this was `let _successFired = false;` at module scope,
    // which leaked state across sessions: if a user's success path ran
    // and then a later `openCheckout` call re-entered the overlay, the
    // stale `true` made the close handler skip the pending-intent clear,
    // leaving PENDING_CHECKOUT_KEY populated for a silent auto-retry.
    // DodoPayments.Initialize is registered once per page load; its stable
    // onEvent callback forwards into this per-session handler. ONE session's
    // state must reset when a new overlay opens, so destroy/reopen replaces
    // the forwarded handler without registering a second SDK handler.
    // `openCheckout` resets these per-session flags by invoking the
    // module-level `_resetOverlaySession` closure assigned just below.
    let successFired = false;
    let navigationFired = false;
    let watchdog: EntitlementWatchdog | null = null;

    const stopWatchdog = (): void => {
      watchdog?.stop();
      watchdog = null;
    };

    _resetOverlaySession = () => {
      successFired = false;
      navigationFired = false;
      stopWatchdog();
    };

    // Shared terminal-success side effects (run ONCE per overlay session).
    // Called from: `checkout.status=succeeded` (event path), the
    // watchdog when entitlement flips to pro (fallback path), and the
    // watchdog-free `checkout.redirect_requested` handler when it arrives
    // before status (rare but possible per docs). The `successFired` flag
    // makes subsequent callers no-op, preserving prior single-fire semantics.
    //
    // The entitlement watcher in panel-layout.ts owns the free→pro reload
    // (REQUIRES_SKIP_INITIAL_SNAPSHOT_BEHAVIOR; see mirror marker in
    // panel-layout.ts) — this block does NOT reload or navigate on its own.
    const runTerminalSuccessSideEffects = (reason: 'event-status' | 'event-redirect' | 'watchdog'): void => {
      if (successFired) return;
      successFired = true;
      stopWatchdog();

      enqueueSentryCall((s) => s.addBreadcrumb({
        category: 'checkout',
        message: `terminal success (${reason})`,
        level: 'info',
        data: { reason },
      }));
      if (reason === 'watchdog') {
        // Counter-signal so Dodo's wallet-return deadlock prevalence is
        // measurable in Sentry. `info` level, not `error`, per
        // feedback_sentry_level_expected_user_states.
        enqueueSentryCall((s) => s.captureMessage('Dodo wallet-return deadlock — watchdog resolved', {
          level: 'info',
          tags: { component: 'dodo-checkout', code: 'watchdog_resolved' },
        }));
      }

      try {
        onSuccessCallback?.();
      } catch (err) {
        console.error('[checkout] onSuccessCallback threw:', err);
        enqueueSentryCall((s) => s.captureException(err, {
          tags: { component: 'dodo-checkout', action: 'on-success' },
        }));
      }
      // Terminal success: clear both keys. LAST_CHECKOUT_ATTEMPT_KEY
      // is no longer needed (no retry context required); PENDING is
      // cleared to avoid auto-opening the overlay on the reload.
      clearCheckoutAttempt('success');
      clearPendingCheckoutIntent();
      // Session flag so the reloaded page seeds the entitlement transition
      // detector as post-checkout — see comment block preserved from the
      // original inlined handler below for the full rationale.
      markPostCheckout();
    };

    const startWatchdog = (): void => {
      if (watchdog !== null || successFired) return;
      watchdog = createEntitlementWatchdog(
        {
          endpoint: '/api/me/entitlement',
          intervalMs: WATCHDOG_INTERVAL_MS,
          timeoutMs: WATCHDOG_TIMEOUT_MS,
        },
        {
          getToken: getClerkToken,
          fetch: (input, init) => fetch(input, init),
          setInterval: (cb, ms) => window.setInterval(cb, ms),
          clearInterval: (id) => window.clearInterval(id),
          now: () => Date.now(),
          onPro: () => {
            runTerminalSuccessSideEffects('watchdog');
            // Close the stuck overlay so the entitlement watcher's reload
            // is not hidden behind Dodo's "payment successful" page.
            safeCloseOverlay();
          },
        },
      );
      watchdog.start();
    };

    currentCheckoutEventHandler = (event: CheckoutEvent) => {
      switch (event.event_type) {
        case 'checkout.opened':
          // Arm the watchdog at the earliest safe moment. HAR 2026-04-23
          // confirms `checkout.opened` fires on both the happy path AND
          // the wallet-return deadlock path; terminal events do not.
          startWatchdog();
          break;
        case 'checkout.status': {
          // Docs-documented shape is ONLY `event.data.message.status` —
          // the prior top-level `event.data.status` read was a guess
          // against an older SDK version and most likely never matched.
          // (overlay-checkout.mdx / inline-checkout.mdx, SDK >= 0.109.2).
          //
          // Reload ownership: the entitlement watcher in panel-layout.ts
          // is the SINGLE reload source (fires on free→pro transition).
          // We no longer schedule a belt-and-braces setTimeout reload
          // here — that competed with the watcher and made "still
          // unlocking" UX impossible because the banner was guaranteed
          // to be wiped at 3s regardless of webhook latency.
          //
          // REQUIRES_SKIP_INITIAL_SNAPSHOT_BEHAVIOR — the watcher's
          // first-snapshot seeding depends on PR #3163 (merged
          // 2026-04-18) having fixed the swallow-first-snapshot bug.
          // If that PR is ever reverted or its behavior regresses,
          // tests in tests/entitlement-transition.test.mts will fail
          // (specifically "simulates the incident sequence" case); see
          // the mirror marker in panel-layout.ts.
          const rawData = event.data as Record<string, unknown> | undefined;
          const status = (rawData?.message as Record<string, unknown> | undefined)?.status;
          if (status === 'succeeded') {
            runTerminalSuccessSideEffects('event-status');
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
          stopWatchdog();
          if (!successFired) {
            clearPendingCheckoutIntent();
          }
          break;
        case 'checkout.redirect_requested': {
          // With `manualRedirect: true` (below), Dodo's SDK hands the
          // final navigation to the merchant via this event. Dodo's own
          // redirect path (manualRedirect:false) has been observed to
          // fail on Safari with an orphaned about:blank tab; we follow
          // the docs-prescribed handler instead.
          // (overlay-checkout.mdx: "Redirect the customer manually".)
          //
          // On the happy path both `checkout.status=succeeded` and
          // `checkout.redirect_requested` fire — status runs the
          // markPostCheckout + cleanup side effects, redirect navigates
          // away. When only redirect_requested fires (no prior status),
          // we run the side effects here so the post-checkout flag is
          // set before we navigate.
          const redirectTo = (event.data?.message as Record<string, unknown> | undefined)?.redirect_to as string | undefined;
          if (!successFired) runTerminalSuccessSideEffects('event-redirect');
          if (redirectTo && !navigationFired) {
            navigationFired = true;
            window.location.href = redirectTo;
          }
          break;
        }
        case 'checkout.error':
          console.error('[checkout] Overlay error:', event.data?.message);
          enqueueSentryCall((s) => s.captureMessage(`Dodo checkout overlay error: ${event.data?.message || 'unknown'}`, { level: 'error', tags: { component: 'dodo-checkout' } }));
          // Release the user if their overlay surfaces an error. The
          // deadlock bug (payment-link 404 + render loop) never reaches
          // this branch — it traps inside their iframe — but any error
          // that DOES escape should not leave a broken overlay mounted.
          stopWatchdog();
          safeCloseOverlay();
          break;
      }
    };

    if (!dodoPaymentsInitialized) {
      DodoPayments.Initialize({
        mode: env === 'live_mode' ? 'live' : 'test',
        displayType: 'overlay',
        onEvent: (event: CheckoutEvent) => currentCheckoutEventHandler?.(event),
      });
      dodoPaymentsInitialized = true;
    }

    _escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dodoPayments?.Checkout.isOpen?.()) {
        safeCloseOverlay();
      }
    };
    window.addEventListener('keydown', _escapeHandler);

    initialized = true;
  })();

  overlayInitPromise = thisInitPromise;

  try {
    await thisInitPromise;
  } finally {
    if (overlayInitPromise === thisInitPromise) {
      overlayInitPromise = null;
    }
  }
}

/**
 * Destroy the checkout overlay — resets initialized flag and clears the
 * stored success callback so a new layout can register its own callback.
 */
export function destroyCheckoutOverlay(): void {
  checkoutOverlayGeneration += 1;
  // Stop any in-flight watchdog BEFORE we drop references. If the layout
  // unmounts mid-checkout, the watchdog's setInterval would otherwise
  // keep running inside the closed-over scope and, on entitlement flip,
  // fire side effects (clearCheckoutAttempt, clearPendingCheckoutIntent,
  // markPostCheckout, safeCloseOverlay) against a subsequent session's
  // state. _resetOverlaySession is the only accessor for that closure's
  // stopWatchdog.
  _resetOverlaySession?.();
  _resetOverlaySession = null;
  currentCheckoutEventHandler = null;
  // Tear down the Dodo iframe itself. The SDK registers ONE page-lifetime
  // message listener at Initialize and never removes it on close(); an iframe
  // left mounted by a destroy-mid-checkout would otherwise (a) make the next
  // openCheckout's Checkout.open() a silent no-op (the SDK ignores open() while
  // an iframe already exists, so the reopened overlay never appears) and
  // (b) emit a late terminal event from the orphaned iframe into the NEXT
  // session's handler via the stable onEvent forwarder. The handler is nulled
  // first so this teardown can't re-enter session cleanup — we intentionally
  // preserve PENDING_CHECKOUT_KEY for auto-resume after a remount.
  safeCloseOverlay();
  initialized = false;
  overlayInitPromise = null;
  onSuccessCallback = null;
  if (_escapeHandler) {
    window.removeEventListener('keydown', _escapeHandler);
    _escapeHandler = null;
  }
}

function loadPendingCheckoutIntent(): PendingCheckoutIntent | null {
  try {
    const raw = sessionStorage.getItem(PENDING_CHECKOUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingCheckoutIntent;
    // TTL gate: reject-and-clear anything older than PENDING_INTENT_TTL_MS.
    // Covers the "user closed Clerk modal without signing in, signed in
    // hours later for an unrelated reason" leak. No savedAt means it's
    // a pre-TTL intent from a prior session — treat as expired too.
    if (typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > PENDING_INTENT_TTL_MS) {
      clearPendingCheckoutIntent();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function savePendingCheckoutIntent(intent: PendingCheckoutIntent): void {
  try {
    // Stamp savedAt at write time so the TTL gate in the loader has
    // something to check. Caller's own savedAt (if any) is preserved
    // in case they want to record an earlier timestamp.
    const stamped: PendingCheckoutIntent = {
      ...intent,
      savedAt: intent.savedAt ?? Date.now(),
    };
    sessionStorage.setItem(PENDING_CHECKOUT_KEY, JSON.stringify(stamped));
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
    { fallbackToPricingPage: false, analyticsSurface: 'dashboard-resume' },
  );
  if (success) clearPendingCheckoutIntent();
  return success;
}

/**
 * Open the Dodo checkout overlay for a given checkout URL.
 * Lazily initializes the SDK if not already done.
 */
export async function openCheckout(checkoutUrl: string): Promise<void> {
  await ensureCheckoutOverlayInitialized();
  // Reset the per-session successFired flag so a prior session's
  // terminal state can't leak into this one. (The flag lives in a
  // closure inside ensureCheckoutOverlayInitialized's event handler; this resets
  // it.)
  _resetOverlaySession?.();

  const DodoPayments = dodoPayments;
  if (!DodoPayments) {
    throw new Error('Checkout overlay SDK is unavailable after initialization');
  }

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
  options?: { discountCode?: string; referralCode?: string; bypassPendingGuard?: boolean },
  behavior?: { fallbackToPricingPage?: boolean; analyticsSurface?: 'dashboard' | 'dashboard-resume' },
): Promise<boolean> {
  if (_checkoutInFlight) return false;
  const fallbackToPricingPage = behavior?.fallbackToPricingPage ?? true;

  const user = getCurrentClerkUser();
  // Funnel (#4931): every dashboard upgrade CTA routes through here, so one
  // call site covers them all. Fires before the no-user branch so signed-out
  // intent clicks are counted (flagged authed:false). The post-sign-in
  // auto-resume passes 'dashboard-resume' so a signed-out conversion isn't
  // read as two independent attempts.
  trackCheckoutStart(productId, Boolean(user), behavior?.analyticsSurface ?? 'dashboard');
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
      });
      openSignIn();
    }
    return false;
  }

  _checkoutInFlight = true;
  _resetOverlaySession?.();
  // Fall back to the stored referral when the caller doesn't pass one.
  // A dashboard-origin upgrade click has no ref in hand — it arrives
  // from a locked-panel CTA or the Manage Billing surface — but the
  // visitor may have landed on /pro via `?ref=<code>` earlier in this
  // session or within the 7-day TTL on another tab. loadActiveReferral
  // returns null (and clears) on stale records, so this is safe to
  // call unconditionally.
  const effectiveReferral = options?.referralCode ?? loadActiveReferral() ?? undefined;
  // Record the attempt BEFORE the network call so the failure-retry
  // banner has context even if every subsequent step fails (timeout,
  // user closes tab before Dodo redirects, SDK crashes, etc.).
  saveCheckoutAttempt({
    productId,
    referralCode: effectiveReferral,
    discountCode: options?.discountCode,
    startedAt: Date.now(),
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
        returnUrl: buildDashboardCheckoutReturnUrl(window.location.origin),
        discountCode: options?.discountCode,
        referralCode: effectiveReferral,
        // #4438: only set when the user confirmed "start a new checkout anyway"
        // from the pending-payment dialog. Skips the backend pending guard.
        ...(options?.bypassPendingGuard ? { bypassPendingGuard: true } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      // Read body as text FIRST so we can both snapshot it for Sentry
      // (Cloudflare / Vercel deployment-protection 403s are HTML, not
      // JSON — the old `resp.json().catch(() => ({}))` swallowed the
      // smoking-gun page) AND still attempt structured-body parsing
      // for our own JSON error envelopes. WORLDMONITOR-RN.
      const rawText = await resp.text().catch(() => '');
      const upstream = snapshotUpstreamResponse(resp, rawText);
      // parseCheckoutErrorBody returns {} for invalid JSON AND for valid
      // JSON that isn't a plain object (null / array / primitive), making
      // the implicit "body is CheckoutErrorBody-shaped" contract true at
      // runtime — defensive against future consumers that don't add their
      // own optional chaining. Greptile P2 review of PR #3894.
      const body = parseCheckoutErrorBody(rawText);
      const error = classifyHttpCheckoutError(resp.status, body);
      reportCheckoutError(error, { productId, action: 'http-error' }, undefined, upstream);
      // 409 duplicate-subscription — confirm with the user BEFORE
      // navigating to the billing portal. Previously the portal opened
      // silently in a new tab, which was disorienting for users who
      // didn't know they already had a subscription. Dialog content
      // uses only the whitelisted plan name (NEVER the raw server
      // `message` or `displayName` string) per PR-3's taxonomy rule.
      if (error.code === 'duplicate_subscription') {
        clearPendingCheckoutIntent();
        clearCheckoutAttempt('duplicate');
        const planKey = body?.subscription?.planKey;
        const planDisplayName = resolvePlanDisplayName(planKey);
        showDuplicateSubscriptionDialog({
          planDisplayName,
          onConfirm: () => {
            // Pre-reserve the tab SYNCHRONOUSLY in the click handler
            // before the async work; popup blockers otherwise suppress
            // the window.open that would land inside openBillingPortal
            // after the Convex action round-trip. /pro side was fixed
            // in this PR; the main-app dashboard path needs the same
            // fix.
            const reservedWin = prereserveBillingPortalTab();
            void openBillingPortal(reservedWin);
          },
          onDismiss: () => { /* user stays on the dashboard */ },
        });
        return false;
      }
      // 409 payment-in-progress (#4438) — a recent same-tier 3DS payment is
      // still pending. Confirm BEFORE starting a duplicate: the pending one may
      // still be completing. Do NOT clear the attempt (the flow is recoverable —
      // unlike the duplicate-subscription path). On confirm, re-invoke with
      // bypassPendingGuard so the backend skips this guard and the redirect
      // proceeds. Dialog content uses only the whitelisted plan name.
      if (error.code === 'payment_in_progress') {
        const pendingPlanKey = body?.pendingPayment?.planKey;
        const planDisplayName = resolvePlanDisplayName(pendingPlanKey);
        showCheckoutPendingDialog({
          planDisplayName,
          onConfirm: () => {
            void startCheckout(
              productId,
              { ...options, bypassPendingGuard: true },
              behavior,
            );
          },
          onDismiss: () => { /* user stays put; pending payment may still complete */ },
        });
        return false;
      }
      // 401 from /api/create-checkout means the Clerk session we sent
      // is invalid or expired. A toast alone is a dead end — the user
      // needs to re-auth to retry. Save the intent and reopen sign-in
      // inline so the post-auth Clerk listener can auto-resume the
      // exact checkout without manual re-click.
      //
      // 403 is intentionally NOT routed here. Neither api/create-checkout.ts
      // nor the Convex /relay/create-checkout handler ever emits 403 —
      // observed 403s on this route originate above our function
      // (Cloudflare Bot Fight Mode on datacenter IPs, Vercel Deployment
      // Protection, a client-side proxy/extension, etc.). 403 maps to
      // service_unavailable + retryable=true in the classifier so the
      // user sees retry-friendly copy; reopening sign-in wouldn't help.
      // The `upstream` snapshot captured above identifies which layer
      // emitted it (WORLDMONITOR-RN).
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
    if (typeof result?.anonymous_claim_token === 'string' && result.anonymous_claim_token.length > 0) {
      saveAnonClaimToken(result.anonymous_claim_token);
    }
    // #4449: navigate the top window to Dodo's HOSTED checkout instead of
    // opening the overlay iframe. The overlay cannot host Dodo's nested 3DS/
    // fraud stack (Hyperswitch → Airwallex → Sardine): our Permissions-Policy
    // plus the Dodo SDK's own iframe `allow` attribute block the device sensors
    // it needs two frames deep, so card payments requiring 3DS hung forever at
    // "Processing…" (HAR-confirmed — see #4449/#4450). Dodo documents redirect
    // as the primary flow; 3DS/fraud run unconstrained top-level and #4447
    // returns the customer to /dashboard?wm_checkout=return to reconcile. The
    // overlay machinery (openCheckout / ensureCheckoutOverlayInitialized / the
    // event handler / watchdog) is left dormant pending removal.
    const hostedCheckoutUrl = safeHostedCheckoutUrl(result?.checkout_url);
    if (hostedCheckoutUrl) {
      window.location.assign(hostedCheckoutUrl);
      return true;
    }
    // 200 OK but no usable checkout_url — missing, or an untrusted/unparseable
    // origin rejected by safeHostedCheckoutUrl — is a server contract violation
    // (the edge relayer returned success but the payload is unusable). Used
    // to silently `return false` — the user saw nothing happen and the
    // bug was invisible in Sentry. Classify as service_unavailable
    // (closest accurate user-facing copy) and tag action so engineers
    // can filter this specific contract violation in Sentry. httpStatus
    // stays 200 — we want the actual status the server returned, not a
    // synthetic 5xx that would mask the real anomaly.
    const missingUrlError: CheckoutError = {
      code: 'service_unavailable',
      userMessage: 'Checkout is temporarily unavailable. Please try again in a moment.',
      serverMessage: 'Server returned 200 without a usable checkout_url',
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
  upstream?: UpstreamSnapshot,
): void {
  const level: SentryLevel = INFO_LEVEL_CODES.has(error.code) ? 'info' : 'error';
  const payload = {
    level,
    tags: {
      component: 'dodo-checkout',
      action: context.action,
      code: error.code,
      // Promote cf-ray and server to tags so they're filterable in the
      // Sentry UI without opening the event. cf-ray presence alone is
      // definitive for Cloudflare emission. WORLDMONITOR-RN.
      ...(upstream?.cfRay ? { cfRay: upstream.cfRay } : {}),
      ...(upstream?.server ? { upstreamServer: upstream.server } : {}),
    },
    extra: {
      productId: context.productId,
      httpStatus: error.httpStatus,
      serverMessage: error.serverMessage,
      ...(upstream ? { upstream } : {}),
    },
  };
  if (!shouldSkipSentryForAction(context.action)) {
    if (caught) {
      enqueueSentryCall((s) => s.captureException(caught, payload));
    } else {
      enqueueSentryCall((s) => s.captureMessage(`Checkout error: ${error.code}`, payload));
    }
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
// Module-scoped cleanup for the currently-mounted success banner.
// When `showCheckoutSuccess` is called a second time before the first
// resolves (e.g., Dodo has historically double-fired checkout.status
// — see docs/plans/2026-04-18-001-fix-pro-activation-race-*), this
// tears down the prior banner's entitlement subscription + timeout
// before mounting the new one. Without this, the prior `onEntitlementChange`
// listener stays in the Set with a closure over a detached DOM node,
// firing on every future entitlement update for the page lifetime.
let _currentBannerCleanup: (() => void) | null = null;

export function showCheckoutSuccess(
  options?: { waitForEntitlement?: boolean; email?: string | null },
): void {
  _currentBannerCleanup?.();
  _currentBannerCleanup = null;

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

  // Resolve email lazily. Clerk/auth-state is hydrated asynchronously
  // in App bootstrap (src/App.ts) AFTER PanelLayoutManager mounts, so
  // `getAuthState().user?.email` read synchronously at the call site
  // is usually null on post-reload returns. Wrap the reference in a
  // mutable container that later transitions can re-read, and
  // subscribe to auth-state once to update the banner text when email
  // hydrates.
  let currentMaskedEmail = maskEmail(options?.email);
  let unsubscribeAuth: (() => void) | null = null;
  let emailPollInterval: ReturnType<typeof setInterval> | null = null;
  let currentState: CheckoutSuccessBannerState = 'pending';

  const applyEmail = (raw: string | null | undefined): boolean => {
    const next = maskEmail(raw ?? null);
    if (next && next !== currentMaskedEmail) {
      currentMaskedEmail = next;
      setBannerText(banner, currentState, currentMaskedEmail);
      stopEmailWatchers();
      return true;
    }
    return false;
  };
  const stopEmailWatchers = (): void => {
    unsubscribeAuth?.();
    unsubscribeAuth = null;
    if (emailPollInterval) {
      clearInterval(emailPollInterval);
      emailPollInterval = null;
    }
  };

  if (!currentMaskedEmail) {
    // Two fallbacks needed. (1) subscribeAuthState should fire when Clerk
    // hydrates — but auth-state.ts subscribes to clerkInstance at the
    // moment subscribeAuthState is called; if showCheckoutSuccess runs
    // BEFORE initClerk() resolves, clerkInstance is null and
    // subscribeClerk returns a no-op unsubscribe. Nothing re-emits after
    // Clerk hydrates. (2) Polling getCurrentClerkUser() directly every
    // 500ms catches the late hydration regardless of auth-state's
    // subscription timing. Both stop as soon as we get a valid email.
    unsubscribeAuth = subscribeAuthState((state) => {
      applyEmail(state.user?.email);
    });
    const POLL_MS = 500;
    const POLL_BUDGET_MS = 15_000;
    const pollStart = Date.now();
    emailPollInterval = setInterval(() => {
      if (Date.now() - pollStart > POLL_BUDGET_MS) {
        if (emailPollInterval) { clearInterval(emailPollInterval); emailPollInterval = null; }
        return;
      }
      applyEmail(getCurrentClerkUser()?.email);
    }, POLL_MS);
  }
  setBannerText(banner, 'pending', currentMaskedEmail);
  document.body.appendChild(banner);

  requestAnimationFrame(() => {
    banner.style.transform = 'translateY(0)';
    banner.style.opacity = '1';
  });

  if (!options?.waitForEntitlement) {
    setTimeout(() => {
      stopEmailWatchers();
      dismissBanner(banner);
    }, CLASSIC_AUTO_DISMISS_MS);
    return;
  }

  // If the user is already entitled when the banner fires (PR-4 merged
  // the inline check — PR-3276's P1 #251 deleted the one-line
  // computeInitialBannerState helper as an identity function, so the
  // check is now direct). Auto-dismiss via CLASSIC_AUTO_DISMISS_MS
  // (PR-4 fix for the fast-path hang). PR-11 adds email-banner +
  // email-watcher cleanup so the stop callback doesn't leak into the
  // tab's lifetime when this fast-path fires with a backfill sub active.
  if (isEntitled()) {
    currentState = 'active';
    setBannerText(banner, 'active', currentMaskedEmail);
    setTimeout(() => {
      stopEmailWatchers();
      dismissBanner(banner);
    }, CLASSIC_AUTO_DISMISS_MS);
    return;
  }

  let resolved = false;
  const timeoutHandle = setTimeout(() => {
    if (resolved) return;
    resolved = true;
    unsubscribe();
    stopEmailWatchers();
    _currentBannerCleanup = null;
    currentState = 'timeout';
    setBannerText(banner, 'timeout', currentMaskedEmail);
    enqueueSentryCall((s) => s.captureMessage('Checkout entitlement-activation timeout', {
      level: 'warning',
      tags: { component: 'dodo-checkout', action: 'entitlement-timeout' },
    }));
  }, EXTENDED_UNLOCK_TIMEOUT_MS);

  const unsubscribe = onEntitlementChange(() => {
    if (resolved) return;
    if (!isEntitled()) return;
    resolved = true;
    clearTimeout(timeoutHandle);
    unsubscribe();
    stopEmailWatchers();
    _currentBannerCleanup = null;
    currentState = 'active';
    setBannerText(banner, 'active', currentMaskedEmail);
  });

  // Register cleanup so a re-entrant showCheckoutSuccess call (e.g. a
  // double-fire of `checkout.status=succeeded`) tears down this
  // banner's listener + timer before mounting a replacement.
  _currentBannerCleanup = () => {
    if (resolved) return;
    resolved = true;
    clearTimeout(timeoutHandle);
    unsubscribe();
  };
}

function setBannerText(
  banner: HTMLElement,
  state: CheckoutSuccessBannerState,
  maskedEmail: string | null,
): void {
  banner.setAttribute('data-entitlement-state', state);
  if (state === 'pending') {
    banner.textContent = maskedEmail
      ? `Payment received! Receipt sent to ${maskedEmail}. Unlocking your premium features…`
      : 'Payment received! Unlocking your premium features…';
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
