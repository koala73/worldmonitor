/**
 * Checkout service for the /pro marketing page.
 *
 * ACTIVE FLOW (#4449): Clerk sign-in → edge endpoint → top-level redirect to
 * Dodo's HOSTED checkout (`window.location.assign`). The overlay iframe could
 * not host Dodo's nested 3DS/fraud stack (it hung at "Processing…"), so we
 * navigate full-page; the buyer returns to the dashboard via the guarded
 * `?wm_checkout=return` contract. The dormant overlay SDK machinery
 * (`initOverlay`, its onEvent handler, and the entitlement watchdog it was
 * the sole caller of) was removed in #7222, along with this bundle's
 * `dodopayments-checkout` dependency — the hosted redirect needs no SDK.
 * No Convex client needed — the edge endpoint handles relay.
 */

import * as Sentry from '@sentry/react';
import { ensureClerk, type LoadedClerk } from './clerk';
export { ensureClerk } from './clerk';

const API_BASE = 'https://api.worldmonitor.app/api';
const DODO_PORTAL_FALLBACK_URL = 'https://customer.dodopayments.com';
const ACTIVE_SUBSCRIPTION_EXISTS = 'ACTIVE_SUBSCRIPTION_EXISTS';
const PAYMENT_IN_PROGRESS = 'PAYMENT_IN_PROGRESS';

import {
  parseCheckoutIntentFromSearch,
  stripCheckoutIntentFromSearch,
  buildCheckoutReturnUrl,
} from './checkout-intent-url';
import {
  createDefaultCheckoutTransportDeps,
  postCreateCheckout,
} from './checkout-transport';
import { createTimeoutSignal } from './timeout-signal';
import {
  checkoutRetryAtMs,
  checkoutRetryRemainingSeconds,
  parseCheckoutRetryAfterSeconds,
} from './checkout-rate-limit';
import { DASHBOARD_CHECKOUT_RETURN_URL } from '../routes';
import fallbackTiers from '../generated/tiers.json';
import {
  getContentAttributionForAnalytics,
  withContentAttribution,
} from '../../../shared/content-attribution';

let checkoutInFlight = false;

/**
 * Funnel events via the raw Umami tracker (#4931). The tracker script is
 * `async` and typically loads AFTER the mount-time auto-resume runs, so a
 * fire-and-forget call would silently drop the only signed-in resume event
 * (#4934 round-4 F3). Events queue until window.umami exists and flush via
 * a short poll (500ms × 60 ≈ 30s, then give up — blocked tracker).
 * Analytics must never break checkout, hence the try/catch everywhere.
 */
const FUNNEL_QUEUE_LIMIT = 20;
const FUNNEL_FLUSH_INTERVAL_MS = 500;
const FUNNEL_FLUSH_MAX_ATTEMPTS = 60;
const pendingFunnelEvents: Array<{ event: string; data?: Record<string, unknown> }> = [];
let funnelFlushTimer: number | null = null;

/**
 * Same-origin handoff for checkout-start events that would otherwise die
 * with the page (#4934 round-5): the fast signed-in/resume path continues
 * straight into doCheckout's top-level redirect to Dodo, unloading the
 * page before the flush poll ever runs. Queued checkout-start events are
 * mirrored into sessionStorage (per-tab, survives the Dodo round-trip)
 * and the dashboard replays them on the return landing — see
 * replayPendingProFunnelEvents in src/services/analytics.ts, which
 * re-validates every field against closed vocabularies before tracking.
 * Cleared here the moment a local flush delivers, so no double-replay.
 */
const PRO_FUNNEL_PENDING_KEY = 'wm-pro-funnel-pending';
const PRO_FUNNEL_PERSIST_LIMIT = 10;

function persistFunnelEventForReplay(event: string, data?: Record<string, unknown>): void {
  if (event !== 'checkout-start') return;
  try {
    const raw = window.sessionStorage.getItem(PRO_FUNNEL_PENDING_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const items = Array.isArray(parsed) ? parsed : [];
    items.push({ event, data });
    while (items.length > PRO_FUNNEL_PERSIST_LIMIT) items.shift();
    window.sessionStorage.setItem(PRO_FUNNEL_PENDING_KEY, JSON.stringify(items));
  } catch {
    /* storage unavailable — replay just won't be possible */
  }
}

function clearPersistedFunnelEvents(): void {
  try {
    window.sessionStorage.removeItem(PRO_FUNNEL_PENDING_KEY);
  } catch {
    /* no-op */
  }
}

function getUmami(): { track: (event: string, data?: Record<string, unknown>) => void } | undefined {
  try {
    return (window as Window & {
      umami?: { track: (event: string, data?: Record<string, unknown>) => void };
    }).umami;
  } catch {
    return undefined;
  }
}

function flushPendingFunnelEvents(): boolean {
  const umami = getUmami();
  if (!umami) return false;
  for (const item of pendingFunnelEvents.splice(0, pendingFunnelEvents.length)) {
    try { umami.track(item.event, item.data); } catch { /* tracker threw — drop */ }
  }
  // Everything queued has now reached the tracker — drop the sessionStorage
  // mirror so the dashboard return doesn't replay a delivered event.
  clearPersistedFunnelEvents();
  return true;
}

function trackFunnelEvent(event: string, data?: Record<string, unknown>): void {
  const enrichedData = withContentAttribution(data, getContentAttributionForAnalytics());
  try {
    const umami = getUmami();
    if (umami) {
      umami.track(event, enrichedData);
      return;
    }
    if (pendingFunnelEvents.length >= FUNNEL_QUEUE_LIMIT) pendingFunnelEvents.shift();
    pendingFunnelEvents.push({ event, data: enrichedData });
    persistFunnelEventForReplay(event, enrichedData);
    if (funnelFlushTimer === null) {
      let attempts = 0;
      funnelFlushTimer = window.setInterval(() => {
        attempts += 1;
        const flushed = flushPendingFunnelEvents();
        if ((flushed || attempts >= FUNNEL_FLUSH_MAX_ATTEMPTS) && funnelFlushTimer !== null) {
          window.clearInterval(funnelFlushTimer);
          funnelFlushTimer = null;
        }
      }, FUNNEL_FLUSH_INTERVAL_MS);
    }
  } catch {
    /* no-op — analytics can never break checkout */
  }
}

/** Record the first /pro pageview reached through a content handoff. */
export function trackContentHandoff(): void {
  if (!getContentAttributionForAnalytics()) return;
  trackFunnelEvent('content-handoff');
}

/**
 * Closed product-id vocabulary for analytics (#4934 round-4 F2): the
 * resume path replays wm_checkout_product straight from the URL, so a
 * crafted value must not inject unbounded cardinality into Umami. Unknown
 * ids collapse to 'unknown'; checkout itself still receives the raw id
 * (backend validates). tiers.json is generated from the catalog, so the
 * allowlist is exactly the purchasable set for this build.
 */
const KNOWN_PRODUCT_IDS: ReadonlySet<string> = new Set(
  (fallbackTiers as Array<{ monthlyProductId?: string; annualProductId?: string }>)
    .flatMap((tier) => [tier.monthlyProductId, tier.annualProductId])
    .filter((id): id is string => typeof id === 'string' && id.length > 0),
);

function bucketProductIdForAnalytics(productId: string): string {
  return KNOWN_PRODUCT_IDS.has(productId) ? productId : 'unknown';
}

/**
 * Phase machine for the checkout flow. `creating_checkout` drives the clicked
 * CTA spinner; `rate_limited` disables every paid CTA until Retry-After
 * expires. `awaiting_auth` is intentionally not exposed — while
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
 *   rate_limited:       provider cooldown; every paid CTA stays disabled
 *                       until retryAtMs and no checkout request is sent
 */
export type CheckoutPhase =
  | { kind: 'idle' }
  | { kind: 'creating_checkout'; productId: string }
  | { kind: 'rate_limited'; retryAtMs: number };

let _phase: CheckoutPhase = { kind: 'idle' };
const phaseSubscribers = new Set<(phase: CheckoutPhase) => void>();
let checkoutRateLimitTimer: number | null = null;

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

function currentCheckoutRateLimitSeconds(): number {
  if (_phase.kind !== 'rate_limited') return 0;
  return checkoutRetryRemainingSeconds(Date.now(), _phase.retryAtMs);
}

function activateCheckoutRateLimit(retryAfterHeader: string | null): number {
  const retryAfterSeconds = parseCheckoutRetryAfterSeconds(retryAfterHeader);
  const retryAtMs = checkoutRetryAtMs(Date.now(), retryAfterSeconds);
  if (checkoutRateLimitTimer) window.clearTimeout(checkoutRateLimitTimer);
  setPhase({ kind: 'rate_limited', retryAtMs });
  checkoutRateLimitTimer = window.setTimeout(() => {
    checkoutRateLimitTimer = null;
    if (_phase.kind === 'rate_limited' && currentCheckoutRateLimitSeconds() === 0) {
      setPhase({ kind: 'idle' });
    }
  }, retryAfterSeconds * 1_000);
  showCheckoutRateLimitToast(retryAfterSeconds);
  return retryAfterSeconds;
}

// Synchronous whole-start re-entrancy guard (#4934 round-4 F4):
// `checkoutInFlight` is only set inside doCheckout, AFTER the awaited
// ensureClerk() — rapid double-clicks both pass the entry check and
// double-fire checkout-start (checkout itself stays single: doCheckout
// re-checks the flag). This flag is set before any await and cleared
// when startCheckout settles.
let startCheckoutEntryInFlight = false;

export async function startCheckout(
  productId: string,
  options?: {
    referralCode?: string;
    discountCode?: string;
    attributionSource?: string;
    bypassPendingGuard?: boolean;
  },
): Promise<boolean> {
  if (checkoutInFlight) return false;
  if (startCheckoutEntryInFlight) return false;
  startCheckoutEntryInFlight = true;
  try {
    return await startCheckoutInner(productId, options);
  } finally {
    startCheckoutEntryInFlight = false;
  }
}

async function startCheckoutInner(
  productId: string,
  options?: {
    referralCode?: string;
    discountCode?: string;
    attributionSource?: string;
    bypassPendingGuard?: boolean;
  },
): Promise<boolean> {
  let c: LoadedClerk;
  try {
    c = await ensureClerk();
  } catch (err) {
    console.error('[checkout] Failed to load Clerk:', err);
    Sentry.captureException(err, { tags: { surface: 'pro-marketing', action: 'load-clerk' } });
    return false;
  }

  // Funnel (#4931): every /pro pricing CTA routes through here. authed:false
  // marks intent clicks that detour through the Clerk sign-in modal first.
  trackFunnelEvent('checkout-start', {
    productId: bucketProductIdForAnalytics(productId),
    surface: 'pro-page',
    authed: Boolean(c.user),
  });

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

  let c: LoadedClerk;
  try {
    c = await ensureClerk();
  } catch {
    return false;
  }
  if (!c.user) return false;
  const { productId, referralCode, discountCode, attributionSource } = intent;
  // Funnel (#4931): post-sign-in auto-resume — the pre-auth click already
  // fired checkout-start{authed:false}; this marks the resumed attempt.
  // productId is URL-derived here — bucketed for analytics (round-4 F2).
  trackFunnelEvent('checkout-start', { productId: bucketProductIdForAnalytics(productId), surface: 'pro-resume', authed: true });
  return doCheckout(productId, { referralCode, discountCode, attributionSource });
}

async function doCheckout(
  productId: string,
  options: {
    referralCode?: string;
    discountCode?: string;
    attributionSource?: string;
    bypassPendingGuard?: boolean;
  },
): Promise<boolean> {
  const cooldownSeconds = currentCheckoutRateLimitSeconds();
  if (cooldownSeconds > 0) {
    showCheckoutRateLimitToast(cooldownSeconds);
    return false;
  }
  if (_phase.kind === 'rate_limited') setPhase({ kind: 'idle' });
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

    // Transient CF/origin 502s on this POST are retried once with an
    // Idempotency-Key (server dedupes replays — api/_idempotency.ts).
    // WORLDMONITOR-Q4: without this, every transient was a lost checkout.
    const resp = await postCreateCheckout(createDefaultCheckoutTransportDeps(), {
      url: `${API_BASE}/create-checkout`,
      token,
      payload: {
        productId,
        // #4449 review: use the GUARDED return contract, not the bare
        // `?wm_checkout=success` marker. With hosted redirect now the primary
        // flow, Dodo sends the buyer to this URL for EVERY outcome (success,
        // failure, cancel, pending) — `?wm_checkout=success` would false-succeed
        // a failed/pending/no-ID return. `?wm_checkout=return` only reconciles
        // success against authoritative Dodo evidence. See checkout-return.ts.
        returnUrl: DASHBOARD_CHECKOUT_RETURN_URL,
        discountCode: options.discountCode,
        referralCode: options.referralCode,
        attributionSource: options.attributionSource,
        // #4438: only set when the user confirmed "start a new checkout anyway"
        // from the pending-payment dialog. Skips the backend pending guard.
        ...(options.bypassPendingGuard ? { bypassPendingGuard: true } : {}),
      },
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      console.error('[checkout] Edge error:', resp.status, err);
      if (resp.status === 429) {
        const retryAfterSeconds = activateCheckoutRateLimit(
          resp.headers.get('Retry-After'),
        );
        Sentry.captureMessage('Checkout temporarily rate limited', {
          level: 'info',
          tags: { surface: 'pro-marketing', code: 'rate_limited' },
          extra: { retryAfterSeconds },
        });
      } else if (resp.status === 409 && err?.error === ACTIVE_SUBSCRIPTION_EXISTS) {
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
          // Picks the guided cancel-then-rebuy copy for the Pro → Pro Business
          // pairing; every other pairing keeps the portal line.
          targetProductId: productId,
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
      } else if (resp.status === 409 && err?.error === PAYMENT_IN_PROGRESS) {
        // #4438: a recent same-tier 3DS payment is still pending. Confirm before
        // stacking a duplicate — the pending one may still be completing. On
        // confirm, re-run with bypassPendingGuard so the backend skips the guard
        // and the redirect proceeds. Inline dialog (no shared component — /pro is
        // a separate build); whitelisted plan name only, raw message to Sentry.
        const planKey = err?.pendingPayment?.planKey;
        showProPendingPaymentDialog({
          planDisplayName: resolveProPlanDisplayName(planKey),
          onConfirm: () => {
            void doCheckout(productId, { ...options, bypassPendingGuard: true });
          },
          onDismiss: () => { /* stay on /pro; pending payment may still complete */ },
        });
        Sentry.captureMessage('Pending-payment checkout attempt', {
          level: 'info',
          tags: { surface: 'pro-marketing', code: 'payment_in_progress' },
          extra: { serverMessage: err?.message },
        });
      }
      return false;
    }

    const result = await resp.json();
    const hostedCheckoutUrl = safeHostedCheckoutUrl(result?.checkout_url);
    if (!hostedCheckoutUrl) {
      // 200 OK but no usable checkout_url (missing, or an untrusted/unparseable
      // origin rejected by safeHostedCheckoutUrl). Report to Sentry for parity
      // with the dashboard's missing-checkout-url path — otherwise this
      // server-contract violation is invisible (was console.error only).
      console.error('[checkout] No usable checkout_url in response');
      Sentry.captureMessage('Checkout returned 200 without a usable checkout_url', {
        level: 'error',
        tags: { surface: 'pro-marketing', code: 'missing_checkout_url' },
      });
      return false;
    }

    // #4449: navigate the top window to Dodo's HOSTED checkout instead of the
    // overlay iframe. The overlay cannot host Dodo's nested 3DS/fraud stack
    // (Hyperswitch → Airwallex → Sardine) — the device sensors it needs are
    // blocked two frames deep, so card payments requiring 3DS hung forever at
    // "Processing…" (HAR-confirmed; see #4449/#4450). Dodo documents redirect as
    // the primary flow. The overlay Initialize/onEvent machinery above is left
    // dormant pending removal.
    window.location.assign(hostedCheckoutUrl);

    return true;
  } catch (err) {
    console.error('[checkout] Failed:', err);
    return false;
  } finally {
    checkoutInFlight = false;
    unmountCheckoutInterstitial();
    if (_phase.kind === 'creating_checkout') setPhase({ kind: 'idle' });
  }
}

// Dodo's hosted-checkout origins. Redirect mode (#4449) navigates the top
// window to the hosted checkout, so validate the server-provided `checkout_url`
// before `window.location.assign` (open-redirect guard against an unexpected
// origin / `javascript:` URL).
const HOSTED_CHECKOUT_HOSTS = new Set([
  'checkout.dodopayments.com',
  'test.checkout.dodopayments.com',
]);

function safeHostedCheckoutUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    if (!HOSTED_CHECKOUT_HOSTS.has(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
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

function showCheckoutRateLimitToast(retryAfterSeconds: number): void {
  const id = 'wm-checkout-rate-limit-toast';
  document.getElementById(id)?.remove();
  const toast = document.createElement('div');
  toast.id = id;
  toast.setAttribute('role', 'alert');
  Object.assign(toast.style, {
    position: 'fixed',
    top: '20px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: '99995',
    background: 'rgba(127, 29, 29, 0.97)',
    color: '#fff',
    padding: '10px 18px',
    borderRadius: '6px',
    border: '1px solid rgba(248, 113, 113, 0.55)',
    fontSize: '13px',
    fontFamily: "'SF Mono', Monaco, 'Cascadia Code', 'Fira Code', monospace",
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
  });
  toast.textContent = `Checkout is temporarily rate limited. Try again in ${retryAfterSeconds} ${
    retryAfterSeconds === 1 ? 'second' : 'seconds'
  }.`;
  document.body.appendChild(toast);
  window.setTimeout(
    () => toast.remove(),
    Math.min(retryAfterSeconds * 1_000, 10_000),
  );
}

async function getAuthToken(): Promise<string | null> {
  const c = await ensureClerk().catch(() => null);
  if (!c) return null;

  let token = await c.session?.getToken({ template: 'convex' }).catch(() => null)
    ?? await c.session?.getToken().catch(() => null);
  if (!token) {
    await new Promise((r) => setTimeout(r, 2000));
    token = await c.session?.getToken({ template: 'convex' }).catch(() => null)
      ?? await c.session?.getToken().catch(() => null);
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
      signal: createTimeoutSignal(15_000),
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
  pro_business_monthly: 'Pro Business Monthly',
  pro_business_annual: 'Pro Business Annual',
  api_starter: 'API Starter',
  api_business: 'API Business',
};

function resolveProPlanDisplayName(planKey: unknown): string {
  if (typeof planKey !== 'string' || planKey.length === 0) return 'Pro';
  return PRO_PLAN_DISPLAY_NAMES[planKey] ?? 'Pro';
}

/**
 * Pro Business product ids, read from the same generated tier data as
 * KNOWN_PRODUCT_IDS rather than hardcoded — the set is empty until the tier is
 * published, which is also when a Pro Business checkout becomes reachable from
 * /pro. Blocking a Pro subscriber's Pro Business checkout is the one 409 the
 * billing portal cannot resolve (separate Dodo products, not an updatable
 * collection), so it gets guided cancel-then-rebuy copy instead.
 */
const PRO_BUSINESS_PRODUCT_IDS: ReadonlySet<string> = new Set(
  (fallbackTiers as Array<{ name?: string; monthlyProductId?: string; annualProductId?: string }>)
    .filter((tier) => tier.name === 'Pro Business')
    .flatMap((tier) => [tier.monthlyProductId, tier.annualProductId])
    .filter((id): id is string => typeof id === 'string' && id.length > 0),
);

interface ProDuplicateDialogOptions {
  planDisplayName: string;
  /** Product the blocked checkout was for — selects the copy variant. */
  targetProductId?: string;
  onConfirm: () => void;
  onDismiss: () => void;
}

/** Mirrors src/services/checkout-duplicate-dialog.ts — keep the copy in sync. */
function proDuplicateBodyHtml(options: ProDuplicateDialogOptions): string {
  const plan = escapeHtml(options.planDisplayName);
  if (options.targetProductId !== undefined && PRO_BUSINESS_PRODUCT_IDS.has(options.targetProductId)) {
    return `Your account already has an active ${plan} subscription. Pro Business is a separate plan, so the upgrade takes two steps: cancel ${plan} in the billing portal, then start the Pro Business checkout again — you don't have to wait for your current term to end. Your ${plan} access continues until the term you've already paid for runs out, and Pro Business starts a new billing cycle as soon as you buy it. Need a hand? Email <a href="mailto:support@worldmonitor.app" style="color:#44ff88;">support@worldmonitor.app</a>.`;
  }
  return `Your account already has an active ${plan} subscription. Open the billing portal to manage it — you won't be charged twice.`;
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
      ${proDuplicateBodyHtml(options)}
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

// Pending-payment dialog (inline to /pro — separate build from main app). Same
// shape + styling as the duplicate-subscription dialog; different copy + action
// (#4438). Confirm → start a new checkout with the pending guard bypassed.
const PRO_PENDING_DIALOG_ID = 'wm-pro-pending-payment-dialog';

function showProPendingPaymentDialog(options: ProDuplicateDialogOptions): void {
  if (document.getElementById(PRO_PENDING_DIALOG_ID)) return;

  const backdrop = document.createElement('div');
  backdrop.id = PRO_PENDING_DIALOG_ID;
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-labelledby', `${PRO_PENDING_DIALOG_ID}-title`);
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
    <h2 id="${PRO_PENDING_DIALOG_ID}-title" style="font-size:16px;font-weight:600;margin:0 0 10px 0;color:#fff;">Payment in progress</h2>
    <p style="font-size:13px;line-height:1.5;margin:0 0 18px 0;color:#c8c8c8;">
      You have a ${escapeHtml(options.planDisplayName)} payment in progress. It may still be completing — if it does and you're charged twice, contact support and we'll refund the duplicate. Start a new checkout anyway?
    </p>
    <div style="display:flex;justify-content:flex-end;gap:10px;">
      <button id="${PRO_PENDING_DIALOG_ID}-dismiss" type="button" style="background:transparent;color:#aaa;border:1px solid #2a2a2a;border-radius:4px;padding:8px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;">Cancel</button>
      <button id="${PRO_PENDING_DIALOG_ID}-confirm" type="button" style="background:#44ff88;color:#0a0a0a;border:none;border-radius:4px;padding:8px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;">Start new checkout</button>
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

  document.getElementById(`${PRO_PENDING_DIALOG_ID}-confirm`)?.addEventListener('click', () => {
    if (resolved) return;
    resolved = true;
    close();
    options.onConfirm();
  });
  document.getElementById(`${PRO_PENDING_DIALOG_ID}-dismiss`)?.addEventListener('click', dismiss);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) dismiss(); });
  document.addEventListener('keydown', keyHandler, true);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] ?? c));
}
