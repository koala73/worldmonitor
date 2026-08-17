/**
 * Frontend billing service with reactive ConvexClient subscription.
 *
 * Uses the shared ConvexClient singleton from convex-client.ts to avoid
 * duplicate WebSocket connections. Subscribes to real-time subscription
 * updates via Convex WebSocket. Falls back gracefully when VITE_CONVEX_URL
 * is not configured or ConvexClient is unavailable.
 *
 * Follows the same lazy reactive pattern as entitlements.ts.
 */

import { enqueueSentryCall } from '@/bootstrap/sentry-defer';
import {
  getConvexClient,
  getConvexApi,
  waitForConvexAuthForUser,
} from './convex-client';
import { getCurrentClerkUser } from './clerk';
import {
  assertAccountStillCurrent,
  isAccountStillCurrent,
  settleAccountOperation,
} from './account-operation';
import { extractBillingErrorKind } from './_billing-error';
import { openExternalUrl, prereserveExternalTab } from './external-navigation';
import type { Id } from '../../convex/_generated/dataModel';

export interface SubscriptionInfo {
  // Opaque Convex subscription-row identity for Pro Activation fire-once
  // keying. Optional across a mixed frontend/backend deploy; onboarding waits
  // for the updated response instead of persisting a provider billing id.
  activationKey?: string;
  // Server-derived markerless Pro Activation candidate: this subscription is
  // in its first billing cycle and has not already presented the flow. The
  // atomic claim re-checks delivery/API/MCP activation at mount time. Optional
  // across mixed frontend/backend deploys; missing fails closed.
  activationOnboardingEligible?: boolean;
  planKey: string;
  displayName: string;
  status: 'active' | 'on_hold' | 'cancelled' | 'expired';
  currentPeriodEnd: number; // epoch ms, renewal date
  // #4771: verdict of the request-path renewal verification (#4770), null
  // when no verification episode is recorded. Drives the billing-aware
  // gating copy in billing-state.ts.
  renewalVerificationState: 'pending' | 'failed' | 'lapsed' | null;
}

// Module-level state
let currentSubscription: SubscriptionInfo | null = null;
let subscriptionLoaded = false;
const listeners = new Set<(sub: SubscriptionInfo | null) => void>();
let initialized = false;
let unsubscribeConvex: (() => void) | null = null;

// Convex/Clerk bootstrap rarely rejects with a non-Error value (undefined, null, string).
// Sentry serializes those as synthetic `Error: undefined` with zero frames — uninvestigable.
// Normalize to a real Error carrying the offending value both in the message (for log/search)
// and as `cause` (for Sentry's structured display) so events remain debuggable (WORLDMONITOR-ND).
function normalizeCaughtError(action: string, err: unknown): Error {
  if (err instanceof Error) return err;
  const rendered = err === undefined ? 'undefined' : String(err);
  const wrapped = new Error(`[billing] ${action} threw non-Error: ${rendered}`);
  // Attach the original thrown value as `cause` so Sentry shows it as structured data.
  // Assigned post-construction because tsconfig target=ES2020 lacks ErrorOptions typing;
  // Sentry and modern browsers read the property either way.
  (wrapped as Error & { cause?: unknown }).cause = err;
  return wrapped;
}

function requireSignedInUserId(action: string): string {
  const userId = getCurrentClerkUser()?.id;
  if (!userId) throw new Error(`Sign in to ${action}.`);
  return userId;
}

async function requireCurrentConvexUser(
  userId: string,
  action: string,
): Promise<void> {
  if (!await waitForConvexAuthForUser(userId)) {
    throw new Error(`Account changed while ${action}. Try again.`);
  }
  assertAccountStillCurrent(userId, action);
}

/**
 * Initialize the subscription watch for the authenticated user.
 * Idempotent -- calling multiple times is a no-op after the first.
 * Failures are logged but never thrown (dashboard must not break).
 */
export async function initSubscriptionWatch(
  _userId?: string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const isExpectedAccount = (): boolean => (
    isCurrent() && (_userId === undefined || getCurrentClerkUser()?.id === _userId)
  );
  if (initialized || !isExpectedAccount()) return;

  try {
    const client = await getConvexClient();
    if (!client) {
      console.warn('[billing] No VITE_CONVEX_URL -- skipping subscription watch');
      return;
    }

    const api = await getConvexApi();
    if (!api) {
      console.warn('[billing] Could not load Convex API -- skipping subscription watch');
      return;
    }
    if (!isExpectedAccount()) return;

    unsubscribeConvex = client.onUpdate(
      api.payments.billing.getSubscriptionForUser,
      {},
      (result: SubscriptionInfo | null) => {
        if (!isExpectedAccount()) return;
        currentSubscription = result;
        subscriptionLoaded = true;
        for (const cb of listeners) cb(result);
      },
      (err: Error) => {
        if (!isExpectedAccount()) return;
        console.warn('[billing] Subscription query error:', err.message);
        // Clear stale cached value so getSubscription() returns null (not old plan).
        currentSubscription = null;
        subscriptionLoaded = true;
        for (const cb of listeners) cb(null);
      },
    );

    initialized = true;
  } catch (err) {
    console.error('[billing] Failed to initialize subscription watch:', err);
    // Do not rethrow -- billing service failure must not break the dashboard
    const initErr = normalizeCaughtError('initSubscriptionWatch', err);
    enqueueSentryCall((s) => s.captureException(
      initErr,
      { tags: { component: 'dodo-billing', action: 'initSubscriptionWatch' } },
    ));
  }
}

/**
 * Register a callback for subscription changes.
 * If subscription state is already available, the callback fires immediately.
 * Returns an unsubscribe function.
 */
export function onSubscriptionChange(
  cb: (sub: SubscriptionInfo | null) => void,
): () => void {
  listeners.add(cb);

  // Late subscribers get the current value immediately (including null if loaded)
  if (subscriptionLoaded) {
    cb(currentSubscription);
  }

  return () => {
    listeners.delete(cb);
  };
}

/**
 * Tear down the subscription watch. Call from PanelLayout.destroy() for cleanup.
 */
export function destroySubscriptionWatch(): void {
  if (unsubscribeConvex) {
    unsubscribeConvex();
    unsubscribeConvex = null;
  }
  initialized = false;
  subscriptionLoaded = false;
  currentSubscription = null;
  // Keep listeners intact — PanelLayout registers them once and expects them
  // to survive auth transitions. Only the Convex transport is torn down.
}

/**
 * Returns the current subscription info, or null if not yet loaded.
 */
export function getSubscription(): SubscriptionInfo | null {
  return currentSubscription;
}

/**
 * Whether the subscription watch has produced a value at least once (including
 * a legitimate `null` — no row, or a query error). Callers use this to tell an
 * unresolved watch apart from a settled "no subscription": `getSubscription()`
 * returns `null` in both cases, but only the settled null means the user truly
 * has no own subscription row (e.g. a Business Pro grant invitee).
 */
export function isSubscriptionLoaded(): boolean {
  return subscriptionLoaded;
}

export type ProActivationClaimOutcome =
  | 'claimed'
  | 'not_eligible'
  | 'already_presented'
  | 'already_claimed';

/**
 * Atomically re-check server-side activation state and reserve one markerless
 * presentation across devices.
 */
export async function claimProActivationPresentation(
  activationKey: string,
  claimNonce: string,
): Promise<ProActivationClaimOutcome> {
  const userId = requireSignedInUserId('claim Pro activation');
  const client = await getConvexClient();
  const api = await getConvexApi();
  if (!client || !api) throw new Error('Convex unavailable');
  await requireCurrentConvexUser(userId, 'claiming Pro activation');
  const result = await settleAccountOperation(
    userId,
    'claiming Pro activation',
    () => client.mutation(
      (api as any).payments.billing.claimProActivationPresentation,
      { activationKey, claimNonce },
    ),
  ) as { status: ProActivationClaimOutcome };
  assertAccountStillCurrent(userId, 'claiming Pro activation');
  return result.status;
}

/** Mark a successful markerless claim as visibly presented. */
export async function confirmProActivationPresentation(
  activationKey: string,
  claimNonce: string,
): Promise<boolean> {
  const userId = requireSignedInUserId('confirm Pro activation');
  const client = await getConvexClient();
  const api = await getConvexApi();
  if (!client || !api) throw new Error('Convex unavailable');
  await requireCurrentConvexUser(userId, 'confirming Pro activation');
  return settleAccountOperation(
    userId,
    'confirming Pro activation',
    () => client.mutation(
      (api as any).payments.billing.confirmProActivationPresentation,
      { activationKey, claimNonce, outcomeTrackingVersion: 1 },
    ) as Promise<boolean>,
  );
}

export type ProActivationDay0Outcome =
  | 'opened'
  | 'already_recorded'
  | 'not_eligible'
  | 'superseded';

/**
 * Open the day-0 (post-checkout) activation record (#5621).
 *
 * Not a lease: the welcome interstitial opens regardless of this call, which
 * exists only so the day-0 cohort has a server-side row instead of having to
 * be reconstructed from Umami sessions. `already_recorded` means an earlier
 * session already finalized this subscription's row, so outcome writes from
 * this one are expected to be rejected. `superseded` means a newer unfinished
 * session already owns the row, so this delayed opener must drop its snapshots.
 */
export async function openProActivationDay0Presentation(
  activationKey: string,
  claimNonce: string,
  sessionStartedAt: number,
): Promise<ProActivationDay0Outcome> {
  const userId = requireSignedInUserId('open Pro activation');
  const client = await getConvexClient();
  const api = await getConvexApi();
  if (!client || !api) throw new Error('Convex unavailable');
  await requireCurrentConvexUser(userId, 'opening Pro activation');
  const result = await settleAccountOperation(
    userId,
    'opening Pro activation',
    () => client.mutation(
      (api as any).payments.billing.openProActivationDay0Presentation,
      { activationKey, claimNonce, sessionStartedAt },
    ),
  ) as { status: ProActivationDay0Outcome };
  assertAccountStillCurrent(userId, 'opening Pro activation');
  return result.status;
}

export type ProActivationOutcomeStepId = 'brief' | 'alerts' | 'power';

export interface ProActivationOutcomeSnapshot {
  /** Absent = the markerless retro backfill's row (#5621). */
  cohort?: 'day0';
  confirmedSteps: ProActivationOutcomeStepId[];
  skippedSteps: ProActivationOutcomeStepId[];
  /**
   * Steps the browser refused (a denied notification permission). Its own
   * bucket, not a widening of `skippedSteps` (#5617): without it, a denial is
   * byte-identical to a voluntary skip in the persisted record, so the
   * push-denial cohort cannot be sized after the fact. The mutation accepts it
   * as optional for mixed deploys; this client always sends it.
   */
  blockedSteps: ProActivationOutcomeStepId[];
  failedSteps: ProActivationOutcomeStepId[];
  revision: number;
  finalized: boolean;
}

/**
 * Persist one monotonic activation-outcome snapshot. The flow keeps this
 * best-effort and non-blocking, but errors propagate here so its bounded retry
 * loop can distinguish a transport failure from a server-side rejection.
 */
export async function recordProActivationOutcome(
  activationKey: string,
  claimNonce: string,
  outcome: ProActivationOutcomeSnapshot,
): Promise<boolean> {
  const userId = requireSignedInUserId('record Pro activation');
  const client = await getConvexClient();
  const api = await getConvexApi();
  if (!client || !api) throw new Error('Convex unavailable');
  await requireCurrentConvexUser(userId, 'recording Pro activation');
  return settleAccountOperation(
    userId,
    'recording Pro activation',
    () => client.mutation(
      (api as any).payments.billing.recordProActivationOutcome,
      { activationKey, claimNonce, ...outcome },
    ) as Promise<boolean>,
  );
}

const DODO_PORTAL_FALLBACK_URL = 'https://customer.dodopayments.com';

/**
 * Open the Dodo Customer Portal in a new tab.
 *
 * Calls the Convex getCustomerPortalUrl action to get a personalized portal
 * session URL. Falls back to the generic Dodo customer portal on error.
 * Returns the URL that was opened (useful for agent/programmatic callers).
 */
/**
 * Pre-reserve a blank popup tab SYNCHRONOUSLY inside a click handler so
 * the async openBillingPortal() below can navigate into it without
 * tripping the popup blocker. Browsers only trust window.open() calls
 * that happen inside a user-gesture stack; after any await, the gesture
 * is spent and window.open() returns null (blocked). Callers MUST call
 * this synchronously BEFORE awaiting anything, then pass the returned
 * handle into openBillingPortal.
 *
 * Returns null on desktop, where the portal opens in the OS browser and
 * there is no popup to reserve (#5911).
 */
export function prereserveBillingPortalTab(): Window | null {
  return prereserveExternalTab();
}

export type OpenBillingPortalOutcome =
  | { outcome: 'opened'; url: string }
  /**
   * The portal session exists but nothing opened — the native handoff failed
   * and the browser fallback was blocked too. Distinct from `opened` because
   * a caller with a toast surface must not point the user at a window that
   * was never created (#6137).
   */
  | { outcome: 'open-failed'; url: string }
  | { outcome: 'no-customer' }
  | { outcome: 'account-changed' };

export async function openBillingPortal(
  preopened?: Window | null,
): Promise<OpenBillingPortalOutcome> {
  const reservedWin = preopened ?? null;
  // Desktop routes the portal to the OS browser via `open_url` instead of
  // navigating the WebView, which would replace the whole app with Dodo's
  // portal and strand the user with no chrome to get back (#5911).
  const navigate = async (url: string): Promise<OpenBillingPortalOutcome> => {
    // Branch on the outcome rather than assuming success. `openExternalUrl`
    // documents this as its contract: a swallowed failure that still claims
    // "opened" is worse than no message, because the caller then tells the
    // user to look at a window that does not exist.
    const navOutcome = await openExternalUrl(url, reservedWin);
    return navOutcome === 'failed'
      ? { outcome: 'open-failed', url }
      : { outcome: 'opened', url };
  };

  // NO_CUSTOMER means the user is entitled (comp grant, recently-restored
  // sub, or sub state where Dodo already purged the customer row) but no
  // Dodo customer record exists to open a portal session for. Navigating
  // them to the generic Dodo portal (`customer.dodopayments.com`) is
  // actively misleading — that portal won't recognise them. Close the
  // pre-reserved tab and return a typed outcome so callers with an
  // in-app toast surface (UnifiedSettings) can tell the user what
  // happened. Callers that don't handle the outcome silently drop the
  // pre-reserved tab — still better UX than landing in a stranger's
  // portal. WORLDMONITOR-R5.
  const closeReserved = (): void => {
    if (reservedWin && !reservedWin.closed) reservedWin.close();
  };

  const userId = getCurrentClerkUser()?.id;
  if (!userId) return navigate(DODO_PORTAL_FALLBACK_URL);

  try {
    const client = await getConvexClient();
    assertAccountStillCurrent(userId, 'opening the billing portal');
    if (!client) {
      return await navigate(DODO_PORTAL_FALLBACK_URL);
    }

    const api = await getConvexApi();
    assertAccountStillCurrent(userId, 'opening the billing portal');
    if (!api) {
      return await navigate(DODO_PORTAL_FALLBACK_URL);
    }

    await requireCurrentConvexUser(userId, 'opening the billing portal');
    const result = await settleAccountOperation(
      userId,
      'opening the billing portal',
      () => client.action(api.payments.billing.getCustomerPortalUrl, {}),
    );
    assertAccountStillCurrent(userId, 'opening the billing portal');
    const url = (result?.portal_url as string | undefined) ?? DODO_PORTAL_FALLBACK_URL;
    // `return await` is load-bearing inside this try: `try { return p }` never
    // routes p's rejection to the catch below, so without it a throw from the
    // now-async navigate escapes openBillingPortal entirely — and two callers
    // invoke it as bare `void openBillingPortal(...)` with no .catch.
    return await navigate(url);
  } catch (err) {
    if (!isAccountStillCurrent(userId)) {
      closeReserved();
      return { outcome: 'account-changed' };
    }
    // Convex object-data ConvexError surfaces `err.data.kind` reliably on the
    // wire; string-data and plain-Error throws arrive as
    // `[Request ID: X] Server Error` with `err.data === undefined`. Read kind
    // and split severity: NO_CUSTOMER is EXPECTED for entitled users who
    // have no Dodo customer row, so it shouldn't drown real config/SDK bugs
    // in error-level alerts. Anything else (DODO_API_KEY_MISSING, Dodo SDK
    // throw, network failure, unknown shape) stays at the default `error`
    // level. WORLDMONITOR-R5.
    const kind = extractBillingErrorKind(err);
    const isNoCustomer = kind === 'NO_CUSTOMER';
    const level: 'warning' | 'error' = isNoCustomer ? 'warning' : 'error';
    const log = level === 'warning' ? console.warn : console.error;
    log('[billing] Failed to get customer portal URL:', err);
    const portalErr = normalizeCaughtError('openBillingPortal', err);
    const portalTags = {
      component: 'dodo-billing',
      action: 'openBillingPortal',
      ...(kind ? { billing_error_kind: kind } : {}),
    };
    enqueueSentryCall((s) => s.captureException(portalErr, { tags: portalTags, level }));
    if (isNoCustomer) {
      closeReserved();
      return { outcome: 'no-customer' };
    }
    return navigate(DODO_PORTAL_FALLBACK_URL);
  }
}

// ---------------------------------------------------------------------------
// Business Pro seat management (#4634/#4635)
// ---------------------------------------------------------------------------

export interface BusinessSeat {
  grantId: string;
  inviteeEmail: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  createdAt: number;
  acceptedAt: number | null;
  expiresAt: number;
}

export interface ListBusinessSeatsResult {
  businessSubscriptionId: string | null;
  ownerDomain: string | null;
  ownerIsCorporateDomain: boolean;
  seats: BusinessSeat[];
}

/** List the caller's Business Pro seats. Only the owner sees their own grants. */
export async function listBusinessSeats(): Promise<ListBusinessSeatsResult> {
  const userId = getCurrentClerkUser()?.id;
  if (!userId) {
    return { businessSubscriptionId: null, ownerDomain: null, ownerIsCorporateDomain: false, seats: [] };
  }
  const client = await getConvexClient();
  const api = await getConvexApi();
  if (!client || !api) {
    return { businessSubscriptionId: null, ownerDomain: null, ownerIsCorporateDomain: false, seats: [] };
  }
  if (!await waitForConvexAuthForUser(userId)) {
    assertAccountStillCurrent(userId, 'loading Business Pro seats');
    throw new Error('Authentication unavailable while loading Business Pro seats. Try again.');
  }
  return settleAccountOperation(
    userId,
    'loading Business Pro seats',
    () => client.query(api.payments.businessSeats.listSeats, {}),
  );
}

/** Invite up to 4 same-domain teammates to Business Pro seats. */
export async function inviteBusinessSeats(emails: string[]): Promise<{
  invited: Array<{ email: string; grantId: string; status: 'created' | 'already_pending' | 'already_accepted' }>;
}> {
  const userId = requireSignedInUserId('invite Business Pro seats');
  const client = await getConvexClient();
  const api = await getConvexApi();
  if (!client || !api) throw new Error('Convex unavailable');
  await requireCurrentConvexUser(userId, 'inviting Business Pro seats');
  return settleAccountOperation(
    userId,
    'inviting Business Pro seats',
    () => client.mutation(api.payments.businessSeats.inviteSeats, { emails }),
  );
}

/** Remove a Business Pro seat (owner-only). */
export async function removeBusinessSeat(
  grantId: string,
): Promise<{ ok: true; status: 'revoked' | 'already_inactive' }> {
  const userId = requireSignedInUserId('remove a Business Pro seat');
  const client = await getConvexClient();
  const api = await getConvexApi();
  if (!client || !api) throw new Error('Convex unavailable');
  await requireCurrentConvexUser(userId, 'removing a Business Pro seat');
  return settleAccountOperation(
    userId,
    'removing a Business Pro seat',
    () => client.mutation(
      api.payments.businessSeats.removeSeat,
      { grantId: grantId as Id<'businessProGrants'> },
    ),
  );
}

/** Accept a Business Pro seat invite using the token from the email link. */
export async function acceptBusinessInvite(grantId: string, token: string): Promise<void> {
  const userId = requireSignedInUserId('accept a Business Pro seat invite');
  const client = await getConvexClient();
  const api = await getConvexApi();
  if (!client || !api) throw new Error('Convex unavailable');
  await requireCurrentConvexUser(userId, 'accepting a Business Pro seat invite');
  await settleAccountOperation(
    userId,
    'accepting a Business Pro seat invite',
    () => client.mutation(
      api.payments.businessSeats.acceptBusinessInvite,
      { grantId: grantId as Id<'businessProGrants'>, token },
    ),
  );
}
