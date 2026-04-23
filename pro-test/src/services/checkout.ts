/**
 * Checkout service for the /pro marketing page.
 *
 * Handles: Clerk sign-in → edge endpoint → Dodo overlay.
 * No Convex client needed — the edge endpoint handles relay.
 */

import * as Sentry from '@sentry/react';
import type { Clerk } from '@clerk/clerk-js';
import type { CheckoutEvent } from 'dodopayments-checkout';

const API_BASE = 'https://api.worldmonitor.app/api';
const DODO_PORTAL_FALLBACK_URL = 'https://customer.dodopayments.com';
const ACTIVE_SUBSCRIPTION_EXISTS = 'ACTIVE_SUBSCRIPTION_EXISTS';

const MONO_FONT = "'SF Mono', Monaco, 'Cascadia Code', 'Fira Code', monospace";

import {
  parseCheckoutIntentFromSearch,
  stripCheckoutIntentFromSearch,
  buildCheckoutReturnUrl,
} from './checkout-intent-url';

let clerk: InstanceType<typeof Clerk> | null = null;
let checkoutInFlight = false;
let clerkLoadPromise: Promise<InstanceType<typeof Clerk>> | null = null;

/**
 * Phase machine for the checkout flow. Only `creating_checkout` drives
 * UI lock state. `awaiting_auth` is intentionally not exposed — while
 * the Clerk modal is open the pricing section is covered by the modal
 * backdrop, so a service-level UI signal for that window adds no user-
 * visible value and creates lifecycle-recovery problems (watchdogs,
 * DOM polling, false-positive focus events). Keeping the pricing page
 * idle during auth means cancellation needs no recovery path — the UI
 * is already in the right state.
 *
 *   idle:               no checkout in progress; all CTAs clickable
 *   creating_checkout:  post-auth, inside doCheckout's try/finally;
 *                       the clicked tier's CTA shows spinner, siblings
 *                       stay clickable (any click simply updates intent)
 */
export type CheckoutPhase =
  | { kind: 'idle' }
  | { kind: 'creating_checkout'; productId: string };

let _phase: CheckoutPhase = { kind: 'idle' };
const phaseSubscribers = new Set<(phase: CheckoutPhase) => void>();

function setPhase(phase: CheckoutPhase): void {
  _phase = phase;
  for (const cb of phaseSubscribers) {
    try { cb(phase); } catch (err) { console.error('[checkout] phase subscriber threw:', err); }
  }
}

export function subscribeCheckoutPhase(cb: (phase: CheckoutPhase) => void): () => void {
  phaseSubscribers.add(cb);
  cb(_phase);
  return () => { phaseSubscribers.delete(cb); };
}

export async function ensureClerk(): Promise<InstanceType<typeof Clerk>> {
  if (clerk) return clerk;
  if (clerkLoadPromise) return clerkLoadPromise;
  clerkLoadPromise = _loadClerk().catch((err) => {
    clerkLoadPromise = null;
    throw err;
  });
  return clerkLoadPromise;
}

async function _loadClerk(): Promise<InstanceType<typeof Clerk>> {
  const { Clerk: C } = await import('@clerk/clerk-js');
  const key = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (!key) throw new Error('VITE_CLERK_PUBLISHABLE_KEY not set');
  const instance = new C(key);
  await instance.load({
    appearance: {
      variables: {
        colorBackground: '#0f0f0f',
        colorInputBackground: '#141414',
        colorInputText: '#e8e8e8',
        colorText: '#e8e8e8',
        colorTextSecondary: '#aaaaaa',
        colorPrimary: '#44ff88',
        colorNeutral: '#e8e8e8',
        colorDanger: '#ff4444',
        borderRadius: '4px',
        fontFamily: MONO_FONT,
        fontFamilyButtons: MONO_FONT,
      },
      elements: {
        card: { backgroundColor: '#111111', border: '1px solid #2a2a2a', boxShadow: '0 8px 32px rgba(0,0,0,0.6)' },
        formButtonPrimary: { color: '#000000', fontWeight: '600' },
        footerActionLink: { color: '#44ff88' },
        socialButtonsBlockButton: { borderColor: '#2a2a2a', color: '#e8e8e8', backgroundColor: '#141414' },
      },
    },
  });

  // Only publish the instance after load() succeeds, so a failed load
  // doesn't wedge ensureClerk()'s `if (clerk) return clerk;` short-circuit
  // and bypass the retry path.
  clerk = instance;

  // NO addListener-based auto-resume. That was the source of the
  // surprise-purchase bug: any sign-in event (checkout-initiated OR
  // generic "Sign In" CTA on /pro) would fire the listener; with
  // module-scoped pendingProductId the stale intent from a dismissed
  // checkout modal would run when the user signed in later for
  // unrelated reasons.
  //
  // Intent is bound to the specific sign-in attempt via Clerk's
  // afterSignInUrl / afterSignUpUrl (see startCheckout). On dismissal
  // there's no redirect; only successful sign-in FROM OUR openSignIn
  // call navigates to a URL carrying the intent params. Generic sign-
  // in paths don't set these URLs, so they can't trigger resume.
  return clerk;
}

export function initOverlay(onSuccess?: () => void): void {
  import('dodopayments-checkout').then(({ DodoPayments }) => {
    const env = import.meta.env.VITE_DODO_ENVIRONMENT;
    DodoPayments.Initialize({
      mode: env === 'live_mode' ? 'live' : 'test',
      displayType: 'overlay',
      onEvent: (event: CheckoutEvent) => {
        // Breadcrumb every event — when a user reports "stuck on spinner
        // after paying" we need the event log to tell whether we got
        // `checkout.status=succeeded`, only `checkout.closed`, or
        // nothing at all. Sentry picks up console.* via integration.
        //
        // Only log known-safe fields (event_type, status). Dodo's
        // event.data can include customer PII (email, billing address,
        // payment_id) depending on event type, and anything logged here
        // lands in Sentry breadcrumbs via the console integration.
        const data = event.data as Record<string, unknown> | undefined;
        const msg = data?.message as Record<string, unknown> | undefined;
        const status = msg?.status as string | undefined;
        console.info('[checkout] dodo event', event.event_type,
          status !== undefined ? { status } : undefined);

        // Dodo's documented `manualRedirect: true` flow emits TWO events
        // on terminal success: `checkout.status` for UI updates, and
        // `checkout.redirect_requested` carrying the URL WE must navigate
        // to. The SDK explicitly hands navigation to the merchant in this
        // mode — ignoring `checkout.redirect_requested` is what stranded
        // users after paying (docs: overlay-checkout.mdx, inline-checkout.mdx).
        //
        // Status shape is ONLY `event.data.message.status` per docs — the
        // legacy top-level `event.data.status` read was a guess against
        // an older SDK version and most likely never matched.
        if (event.event_type === 'checkout.status' && status === 'succeeded') {
          onSuccess?.();
        }
        if (event.event_type === 'checkout.redirect_requested') {
          const redirectTo = msg?.redirect_to as string | undefined;
          // Dodo builds redirect_to from the return_url we sent, appending
          // payment_id/subscription_id/status/license_key/email per
          // changelog v1.84.0. Our return_url carries `?wm_checkout=success`
          // so the dashboard bridge (src/services/checkout-return.ts) fires
          // regardless of Dodo's appended params.
          window.location.href = redirectTo || 'https://worldmonitor.app/?wm_checkout=success';
        }
        if (event.event_type === 'checkout.link_expired') {
          // Not user-blocking — log-only for now; follow-up if Sentry
          // shows volume.
          Sentry.captureMessage('Dodo checkout link expired', {
            level: 'info',
            tags: { surface: 'pro-marketing', code: 'link_expired' },
          });
        }
      },
    });
  }).catch((err) => {
    console.error('[checkout] Failed to load Dodo overlay SDK:', err);
  });
}

export async function startCheckout(
  productId: string,
  options?: { referralCode?: string; discountCode?: string },
): Promise<boolean> {
  if (checkoutInFlight) return false;

  let c: InstanceType<typeof Clerk>;
  try {
    c = await ensureClerk();
  } catch (err) {
    console.error('[checkout] Failed to load Clerk:', err);
    Sentry.captureException(err, { tags: { surface: 'pro-marketing', action: 'load-clerk' } });
    return false;
  }

  if (!c.user) {
    // Intent travels via afterSignInUrl / afterSignUpUrl — bound to
    // THIS specific openSignIn call. On successful sign-in, Clerk
    // navigates to the returnUrl which carries the checkout intent
    // in its query string; tryResumeCheckoutFromUrl picks it up on
    // page load. On dismissal, Clerk performs no navigation, so no
    // resume. Other /pro sign-in paths don't set these URLs, so they
    // can't trigger surprise purchases.
    const returnUrl = buildCheckoutReturnUrl(window.location.href, productId, options);
    try {
      c.openSignIn({ afterSignInUrl: returnUrl, afterSignUpUrl: returnUrl });
    } catch (err) {
      console.error('[checkout] Failed to open sign in:', err);
      Sentry.captureException(err, { tags: { surface: 'pro-marketing', action: 'checkout-sign-in' } });
    }
    return false;
  }

  return doCheckout(productId, options ?? {});
}

export async function tryResumeCheckoutFromUrl(): Promise<boolean> {
  const intent = parseCheckoutIntentFromSearch(window.location.search);
  if (!intent) return false;

  // Strip BEFORE any await so a fast reload sees the clean URL.
  const cleanSearch = stripCheckoutIntentFromSearch(window.location.search);
  const cleanUrl = window.location.pathname + cleanSearch + window.location.hash;
  window.history.replaceState({}, '', cleanUrl);

  let c: InstanceType<typeof Clerk>;
  try {
    c = await ensureClerk();
  } catch {
    return false;
  }
  if (!c.user) return false;
  const { productId, referralCode, discountCode } = intent;
  return doCheckout(productId, { referralCode, discountCode });
}

async function doCheckout(
  productId: string,
  options: { referralCode?: string; discountCode?: string },
): Promise<boolean> {
  if (checkoutInFlight) return false;
  checkoutInFlight = true;
  // Phase transitions to creating_checkout ONLY here, not in
  // startCheckout's no-user branch. This narrow window (post-auth,
  // edge call + Dodo SDK import + overlay open) is the only time the
  // pricing page is visible AND the checkout is mid-work, so it's the
  // only time the clicked CTA should show a spinner.
  setPhase({ kind: 'creating_checkout', productId });

  // Best-effort visual bridge between Clerk modal close and Dodo
  // overlay paint. Covers two common sources of blank-screen feel:
  //   1. Auto-resume after sign-in fires doCheckout synchronously; the
  //      Clerk modal's close animation leaves a visual void until the
  //      Dodo overlay paints, which requires a lazy SDK import and an
  //      /api/create-checkout round-trip.
  //   2. Direct click from an already-signed-in user still incurs the
  //      SDK lazy-load + network latency before the overlay appears.
  // Unmount is best-effort — the Dodo SDK exposes no "overlay visible"
  // event, so `DodoPayments.Checkout.open()` returning is the closest
  // proxy we have. A 10s safety fallback shows a toast instead of
  // leaving the interstitial wedged if the SDK or network hangs.
  try {
    // Mount INSIDE try so any future code added before `mountCheckout-
    // Interstitial()` throwing can't leak the overlay (the previous
    // layout put the mount above the try, which was brittle to
    // refactors).
    mountCheckoutInterstitial();
    const token = await getAuthToken();
    if (!token) {
      console.error('[checkout] No auth token after retry');
      return false;
    }

    const resp = await fetch(`${API_BASE}/create-checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        productId,
        returnUrl: 'https://worldmonitor.app/?wm_checkout=success',
        discountCode: options.discountCode,
        referralCode: options.referralCode,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      console.error('[checkout] Edge error:', resp.status, err);
      if (resp.status === 409 && err?.error === ACTIVE_SUBSCRIPTION_EXISTS) {
        // Confirm with the user before taking them to the portal.
        // Uses the whitelisted plan name ONLY — raw server message is
        // logged to Sentry above but never rendered. Dialog is inline
        // here (no shared component with main app — /pro is a separate
        // build). Same semantics: confirm → new-tab portal, dismiss →
        // stay in place.
        //
        // Token is re-fetched inside onConfirm rather than captured
        // from this closure: Clerk tokens expire in ~60s and the user
        // may spend longer than that reading the dialog before clicking.
        // Using a stale `token` would 401 at /customer-portal.
        const planKey = err?.subscription?.planKey;
        showProDuplicateSubscriptionDialog({
          planDisplayName: resolveProPlanDisplayName(planKey),
          onConfirm: async () => {
            // Pre-open the tab SYNCHRONOUSLY inside the click handler
            // BEFORE any await so the popup blocker treats it as a
            // genuine user-gesture open. If we waited until after
            // getAuthToken() + the portal fetch, browsers would
            // suppress the window.open() because the user gesture was
            // already consumed.
            const reservedWin = prereserveBillingPortalTab();
            const freshToken = await getAuthToken();
            if (!freshToken) {
              console.error('[checkout] No token available for billing portal');
              if (reservedWin && !reservedWin.closed) reservedWin.close();
              return;
            }
            void openBillingPortal(freshToken, reservedWin);
          },
          onDismiss: () => { /* stay on /pro */ },
        });
        Sentry.captureMessage('Duplicate subscription checkout attempt', {
          level: 'info',
          tags: { surface: 'pro-marketing', code: 'duplicate_subscription' },
          extra: { serverMessage: err?.message },
        });
      }
      return false;
    }

    const result = await resp.json();
    if (!result?.checkout_url) {
      console.error('[checkout] No checkout_url in response');
      return false;
    }

    const { DodoPayments } = await import('dodopayments-checkout');
    DodoPayments.Checkout.open({
      checkoutUrl: result.checkout_url,
      options: {
        // manualRedirect: true — Dodo emits `checkout.redirect_requested`
        // with the final redirect URL and the MERCHANT performs the
        // navigation. Reverting PR #3298's `false`: that mode disables
        // both `checkout.status` and `checkout.redirect_requested` events
        // (docs: "only when manualRedirect is enabled") and depends on
        // the SDK's internal redirect, which fails for Safari users
        // (stuck on a spinner with an orphaned about:blank tab). The
        // correct flow per docs is manualRedirect:true + a
        // checkout.redirect_requested handler — see onEvent above.
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

    return true;
  } catch (err) {
    console.error('[checkout] Failed:', err);
    return false;
  } finally {
    checkoutInFlight = false;
    unmountCheckoutInterstitial();
    setPhase({ kind: 'idle' });
  }
}

const INTERSTITIAL_ID = 'wm-checkout-interstitial';
const INTERSTITIAL_SAFETY_MS = 10_000;
let interstitialSafetyTimer: ReturnType<typeof setTimeout> | null = null;

function mountCheckoutInterstitial(): void {
  if (document.getElementById(INTERSTITIAL_ID)) return;

  const overlay = document.createElement('div');
  overlay.id = INTERSTITIAL_ID;
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'polite');
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '99990',
    background: 'rgba(10, 10, 10, 0.82)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '16px',
    color: '#e8e8e8',
    fontSize: '14px',
    fontFamily: "'SF Mono', Monaco, 'Cascadia Code', 'Fira Code', monospace",
    transition: 'opacity 0.2s ease',
    opacity: '0',
  });
  overlay.innerHTML = `
    <div style="width:36px;height:36px;border:3px solid rgba(68,255,136,0.2);border-top-color:#44ff88;border-radius:50%;animation:wm-checkout-spin 0.8s linear infinite;"></div>
    <div>Opening checkout…</div>
    <style>@keyframes wm-checkout-spin { to { transform: rotate(360deg); } }</style>
  `;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => { overlay.style.opacity = '1'; });

  interstitialSafetyTimer = setTimeout(() => {
    unmountCheckoutInterstitial();
    showCheckoutLoadingToast();
  }, INTERSTITIAL_SAFETY_MS);
}

function unmountCheckoutInterstitial(): void {
  if (interstitialSafetyTimer) {
    clearTimeout(interstitialSafetyTimer);
    interstitialSafetyTimer = null;
  }
  // If the 10s safety timer already fired, the overlay was swapped for
  // a "Still loading…" toast. Once the checkout settles (success,
  // failure, or user-close), that toast is stale — actively remove it
  // so the user isn't staring at a false in-progress indicator after
  // Dodo has already opened or the request has errored.
  const toast = document.getElementById('wm-checkout-loading-toast');
  if (toast) toast.remove();

  const overlay = document.getElementById(INTERSTITIAL_ID);
  if (!overlay) return;
  overlay.style.opacity = '0';
  setTimeout(() => overlay.remove(), 200);
}

function showCheckoutLoadingToast(): void {
  const id = 'wm-checkout-loading-toast';
  if (document.getElementById(id)) return;
  const toast = document.createElement('div');
  toast.id = id;
  toast.setAttribute('role', 'alert');
  Object.assign(toast.style, {
    position: 'fixed',
    top: '20px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: '99995',
    background: 'rgba(20, 20, 20, 0.95)',
    color: '#e8e8e8',
    padding: '10px 18px',
    borderRadius: '6px',
    border: '1px solid #2a2a2a',
    fontSize: '13px',
    fontFamily: "'SF Mono', Monaco, 'Cascadia Code', 'Fira Code', monospace",
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
  });
  toast.textContent = 'Still loading, please wait…';
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5_000);
}

async function getAuthToken(): Promise<string | null> {
  let token = await clerk?.session?.getToken({ template: 'convex' }).catch(() => null)
    ?? await clerk?.session?.getToken().catch(() => null);
  if (!token) {
    await new Promise((r) => setTimeout(r, 2000));
    token = await clerk?.session?.getToken({ template: 'convex' }).catch(() => null)
      ?? await clerk?.session?.getToken().catch(() => null);
  }
  return token;
}

/**
 * Pre-open a blank popup window at click-time so the async
 * `openBillingPortal` below can navigate into it without tripping the
 * popup blocker. Browsers only trust `window.open()` calls that happen
 * synchronously inside a user-gesture handler; once we `await` a fetch,
 * the gesture has been spent and `window.open('https://...')` gets
 * blocked. Callers MUST call this synchronously in the click handler
 * BEFORE awaiting anything, then pass the returned handle to
 * `openBillingPortal`.
 */
function prereserveBillingPortalTab(): Window | null {
  return window.open('', '_blank', 'noopener,noreferrer');
}

async function openBillingPortal(token: string, preopened?: Window | null): Promise<void> {
  // Opens in a new tab to match the main-app surface — the /pro page
  // shouldn't disappear underneath the user when they acknowledge
  // "yes, take me to the portal."
  const reservedWin = preopened ?? null;
  const navigate = (url: string): void => {
    if (reservedWin && !reservedWin.closed) {
      reservedWin.location.href = url;
    } else {
      // Fallback: no pre-opened tab (direct call path, or browser
      // already blocked the pre-open). Try to open fresh; if that
      // ALSO gets blocked, fall back to same-tab navigation as a last
      // resort so the user isn't stranded.
      const fresh = window.open(url, '_blank', 'noopener,noreferrer');
      if (!fresh) window.location.assign(url);
    }
  };

  try {
    const resp = await fetch(`${API_BASE}/customer-portal`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(15_000),
    });

    const result = await resp.json().catch(() => ({}));
    const url = typeof result?.portal_url === 'string'
      ? result.portal_url
      : DODO_PORTAL_FALLBACK_URL;

    if (!resp.ok) {
      console.error('[checkout] Customer portal error:', resp.status, result);
    }

    navigate(url);
  } catch (err) {
    console.error('[checkout] Failed to open billing portal:', err);
    navigate(DODO_PORTAL_FALLBACK_URL);
  }
}

// ---------------------------------------------------------------------------
// Duplicate-subscription dialog (inline to /pro — separate build from main app)
// ---------------------------------------------------------------------------

const PRO_PLAN_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  pro_monthly: 'Pro Monthly',
  pro_annual: 'Pro Annual',
  api_starter: 'API Starter',
  api_business: 'API Business',
};

function resolveProPlanDisplayName(planKey: unknown): string {
  if (typeof planKey !== 'string' || planKey.length === 0) return 'Pro';
  return PRO_PLAN_DISPLAY_NAMES[planKey] ?? 'Pro';
}

interface ProDuplicateDialogOptions {
  planDisplayName: string;
  onConfirm: () => void;
  onDismiss: () => void;
}

const PRO_DUP_DIALOG_ID = 'wm-pro-duplicate-subscription-dialog';

function showProDuplicateSubscriptionDialog(options: ProDuplicateDialogOptions): void {
  if (document.getElementById(PRO_DUP_DIALOG_ID)) return;

  const backdrop = document.createElement('div');
  backdrop.id = PRO_DUP_DIALOG_ID;
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  Object.assign(backdrop.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '99990',
    background: 'rgba(10, 10, 10, 0.72)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
  });

  const card = document.createElement('div');
  Object.assign(card.style, {
    background: '#141414',
    border: '1px solid #2a2a2a',
    borderRadius: '8px',
    padding: '20px 22px',
    maxWidth: '440px',
    width: '100%',
    color: '#e8e8e8',
    fontFamily: "'SF Mono', Monaco, 'Cascadia Code', 'Fira Code', monospace",
    boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
  });

  card.innerHTML = `
    <h2 style="font-size:16px;font-weight:600;margin:0 0 10px 0;color:#fff;">Subscription already active</h2>
    <p style="font-size:13px;line-height:1.5;margin:0 0 18px 0;color:#c8c8c8;">
      Your account already has an active ${escapeHtml(options.planDisplayName)} subscription. Open the billing portal to manage it — you won't be charged twice.
    </p>
    <div style="display:flex;justify-content:flex-end;gap:10px;">
      <button id="${PRO_DUP_DIALOG_ID}-dismiss" type="button" style="background:transparent;color:#aaa;border:1px solid #2a2a2a;border-radius:4px;padding:8px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;">Dismiss</button>
      <button id="${PRO_DUP_DIALOG_ID}-confirm" type="button" style="background:#44ff88;color:#0a0a0a;border:none;border-radius:4px;padding:8px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;">Open billing portal</button>
    </div>
  `;

  backdrop.appendChild(card);
  // MUST append to document BEFORE attaching listeners via getElementById,
  // otherwise the ID lookups return null and the buttons are dead.
  document.body.appendChild(backdrop);

  let resolved = false;
  const keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') dismiss();
  };
  const close = () => {
    document.removeEventListener('keydown', keyHandler, true);
    backdrop.remove();
  };
  const dismiss = () => {
    if (resolved) return;
    resolved = true;
    close();
    options.onDismiss();
  };

  document.getElementById(`${PRO_DUP_DIALOG_ID}-confirm`)?.addEventListener('click', () => {
    if (resolved) return;
    resolved = true;
    close();
    options.onConfirm();
  });
  document.getElementById(`${PRO_DUP_DIALOG_ID}-dismiss`)?.addEventListener('click', dismiss);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) dismiss(); });
  document.addEventListener('keydown', keyHandler, true);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] ?? c));
}
