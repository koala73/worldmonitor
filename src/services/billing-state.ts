/**
 * Pure billing UX state derivation (#4771).
 *
 * Turns the two reactive client snapshots (Convex subscription row +
 * entitlement row) into one explicit customer-facing billing state, so the
 * UI can distinguish "we are verifying your renewal" from "you are a free
 * user" instead of showing a generic Upgrade CTA to a paying customer whose
 * local renewal evidence went stale (missed/exhausted webhook).
 *
 * Server-side counterparts: the on-demand Dodo re-check (#4770/#5447) writes
 * `subscriptions.renewalVerificationState`, and the gateway/MCP already emit
 * the matching stable codes (`renewal_verification_pending/failed`,
 * `subscription_lapsed`) via `server/_shared/entitlement-check.ts`.
 *
 * MUST stay a zero-import leaf: it is unit-tested under `tsx --test`
 * (no jsdom, no Vite globals), and both services and components import it.
 */

export interface BillingSubscriptionSnapshot {
  status: 'active' | 'on_hold' | 'cancelled' | 'expired';
  /** Epoch ms end of the currently-paid period. */
  currentPeriodEnd: number;
  /** Cancelled, but the provider keeps the row `active` until currentPeriodEnd. */
  cancelAtPeriodEnd?: boolean;
  /** Verdict of the request-path renewal verification (#4770), if any. */
  renewalVerificationState?: 'pending' | 'failed' | 'lapsed' | null;
}

export interface BillingEntitlementSnapshot {
  planKey: string;
  /** Epoch ms until which the entitlement row grants access (0 = never). */
  validUntil: number;
}

export type BillingUxState =
  | 'free'
  | 'active'
  | 'on_hold'
  | 'renewal_verification_pending'
  | 'renewal_verification_failed'
  | 'lapsed';

/** Coverage-derived visual tone for a subscription row. See getSubscriptionStatusTone. */
export type BillingStatusTone = 'active' | 'attention' | 'ending' | 'ended' | 'unknown';

/**
 * Whether this row's status/period FIELDS say it covers `at`.
 *
 * NOT an access decision, and never safe as an entitlement gate. `active`
 * returns true regardless of `currentPeriodEnd`, so a row whose renewal
 * webhook was missed still "covers" here while `deriveBillingUxState`
 * correctly routes it to `renewal_verification_*`/`lapsed` — the exact case
 * this module was built for (#4770/#4771). `on_hold` and `cancelled` are both
 * bounded by the paid-through end. Anything deciding access must call
 * `deriveBillingUxState`; this only answers the narrower field-level question.
 *
 * Its purpose is to be the single shared spelling of that question, so the
 * cancelled-but-paid-through rule cannot be re-derived from status-string
 * intuition in one place and not another (#7315 — the settings panel had its
 * own inline ternary and painted a paid-through plan the same red as a dead
 * one). `deriveBillingUxState` and `getSubscriptionStatusTone` both read it.
 *
 * Mirrors `isCoveringAt` in convex/payments/subscriptionHelpers.ts: active,
 * on_hold-but-paid-through, or cancelled-but-paid-through. `expired` never
 * covers, whatever its period end. Boundary differs deliberately from the
 * server helper's `>`: the client keeps the inclusive `>=` this module has
 * always used, so a row landing exactly on `now` never blinks locked between
 * snapshots. That exception is recorded in CONCEPTS.md § Covering Subscription
 * — a later dedup of the two helpers has to preserve both boundaries rather
 * than picking one.
 */
export function isSubscriptionCoveringAt(
  sub: Pick<BillingSubscriptionSnapshot, 'status' | 'currentPeriodEnd'>,
  at: number,
): boolean {
  return (
    sub.status === 'active'
    || ((sub.status === 'on_hold' || sub.status === 'cancelled')
      && sub.currentPeriodEnd >= at)
  );
}

/**
 * How a subscription row should be *painted*, as a tone rather than a colour —
 * the palette stays in the component.
 *
 * Split from `deriveBillingUxState` on purpose: that answers "does access
 * work", which is the same `active` for a renewing plan and a cancelled one
 * still inside its paid window. The panel needs to tell those apart, because a
 * cancelled-but-paid-through plan IS ending — just not today (#7315).
 *
 * `unknown` is the explicit escape for a provider status this client does not
 * model yet. It exists so a new Dodo status cannot be swallowed into the
 * end-of-coverage tone and assert to an entitled user that their plan is dead.
 *
 * The `default` arm is a RUNTIME escape only. Left bare it would also silence
 * the compiler: widening the status union (convex/schema.ts keeps it to these
 * four) would then typecheck clean and ship as a permanently unexplained grey
 * card. The `never` assignment keeps the runtime fallback while making that
 * widening a build error, so a new status has to be given a tone deliberately.
 */
export function getSubscriptionStatusTone(
  sub: Pick<BillingSubscriptionSnapshot, 'status' | 'currentPeriodEnd' | 'cancelAtPeriodEnd'>,
  at: number,
): BillingStatusTone {
  switch (sub.status) {
    case 'active':
      return sub.cancelAtPeriodEnd ? 'ending' : 'active';
    case 'on_hold':
      return 'attention';
    case 'cancelled':
      return isSubscriptionCoveringAt(sub, at) ? 'ending' : 'ended';
    case 'expired':
      return 'ended';
    default: {
      const unhandled: never = sub.status;
      void unhandled;
      return 'unknown';
    }
  }
}

/**
 * Precedence, mirroring the affirmative-denial philosophy of panel gating
 * (never over-gate on missing data):
 *
 * 1. A paid-through `on_hold` surfaces — the payment-failed banner must show
 *    while the retry-window entitlement is still valid.
 * 2. A currently-valid paid entitlement means access works: `active`.
 * 3. No subscription row and no valid entitlement: plain `free`.
 * 4. An `active` subscription row without a valid entitlement is *stale paid
 *    evidence*: the verification verdict decides (`failed`/`lapsed`), an
 *    in-period row stays `active` (entitlement snapshot late/skipped), and a
 *    past-period row is `renewal_verification_pending` — reconciliation is
 *    queued (#4794) or in flight (#4770) even when no verdict is recorded yet.
 * 5. `cancelled` still inside its paid window keeps coverage (`active`) even
 *    when the entitlement snapshot is late — mirrors `isCoveringAt` in
 *    convex/payments/subscriptionHelpers.ts ("cancelled-but-paid-through").
 *    `on_hold`/`cancelled` past the window and `expired` (never covering, same
 *    helper) mean coverage ended — `lapsed`, not `free`, so copy can say
 *    "resubscribe".
 */
export function deriveBillingUxState(
  sub: BillingSubscriptionSnapshot | null,
  ent: BillingEntitlementSnapshot | null,
  now: number,
): BillingUxState {
  const entitledNow = ent !== null && ent.planKey !== 'free' && ent.validUntil >= now;
  if (!sub) return entitledNow ? 'active' : 'free';
  if (sub.status === 'on_hold' && isSubscriptionCoveringAt(sub, now)) return 'on_hold';
  if (entitledNow) return 'active';
  if (sub.status === 'active') {
    if (sub.renewalVerificationState === 'failed') return 'renewal_verification_failed';
    if (sub.renewalVerificationState === 'lapsed') return 'lapsed';
    if (sub.currentPeriodEnd >= now) return 'active';
    return 'renewal_verification_pending';
  }
  if (isSubscriptionCoveringAt(sub, now)) return 'active';
  return 'lapsed';
}

// Per-state sessionStorage dismissal keys. Distinct keys so dismissing the
// pending banner never suppresses a later failed banner. The bare
// 'pf-banner-dismissed' value predates #4771 and must stay unchanged so
// in-flight sessions keep their on_hold dismissal.
const ON_HOLD_DISMISS_KEY = 'pf-banner-dismissed';
const RENEWAL_PENDING_DISMISS_KEY = 'pf-banner-dismissed-renewal-pending';
const RENEWAL_FAILED_DISMISS_KEY = 'pf-banner-dismissed-renewal-failed';
const BILLING_EMAIL_BOUNCED_DISMISS_KEY = 'pf-banner-dismissed-billing-email-bounced';
// A bounce arriving mid-episode must re-surface a banner the user already
// dismissed, once: the combined banner gets its own key.
const BOUNCED_DISMISS_SUFFIX = '-bounced';

export interface BillingBannerAction {
  /** i18n key (components.billingState.*) for the button label. */
  labelKey: string;
  kind: 'billing-portal' | 'fix-billing-email';
}

export interface BillingBannerVariant {
  tone: 'error' | 'warning';
  /** i18n key (components.billingState.*) for the banner message. */
  messageKey: string;
  /** Buttons in render order; empty renders none. */
  actions: readonly BillingBannerAction[];
  /** sessionStorage key scoping manual dismissal to this banner. */
  dismissKey: string;
}

const UPDATE_PAYMENT: BillingBannerAction = {
  labelKey: 'components.billingState.updatePayment',
  kind: 'billing-portal',
};
const MANAGE_BILLING: BillingBannerAction = {
  labelKey: 'components.billingState.manageBilling',
  kind: 'billing-portal',
};
const FIX_BILLING_EMAIL: BillingBannerAction = {
  labelKey: 'components.billingState.fixBillingEmail',
  kind: 'fix-billing-email',
};

/**
 * Top-of-page banner per state, as i18n keys — the same
 * components.billingState.* strings the panel CTA uses, so the two surfaces
 * cannot drift and the banner localizes. `on_hold` must stay compatible with
 * the pre-#4771 payment-failure banner (issue #4771 requires it intact):
 * onHoldBannerMessage's English value is byte-identical to the previously
 * hardcoded copy, and the dismiss key is unchanged. `lapsed` intentionally
 * renders no persistent banner: the panel CTA carries the resubscribe
 * message, and a permanent banner for long-lapsed users would just be
 * nagware.
 */
const STATE_BANNERS: Partial<Record<BillingUxState, BillingBannerVariant>> = {
  on_hold: {
    tone: 'error',
    messageKey: 'components.billingState.onHoldBannerMessage',
    actions: [UPDATE_PAYMENT],
    dismissKey: ON_HOLD_DISMISS_KEY,
  },
  renewal_verification_pending: {
    tone: 'warning',
    messageKey: 'components.billingState.renewalPendingDesc',
    actions: [],
    dismissKey: RENEWAL_PENDING_DISMISS_KEY,
  },
  renewal_verification_failed: {
    tone: 'error',
    messageKey: 'components.billingState.renewalFailedDesc',
    actions: [MANAGE_BILLING],
    dismissKey: RENEWAL_FAILED_DISMISS_KEY,
  },
};

/** The message interpolates `{{email}}`; the component sets it as text. */
const BILLING_EMAIL_BOUNCED_BANNER: BillingBannerVariant = {
  tone: 'warning',
  messageKey: 'components.billingState.billingEmailBouncedMessage',
  actions: [FIX_BILLING_EMAIL],
  dismissKey: BILLING_EMAIL_BOUNCED_DISMISS_KEY,
};

/** Every dismissal key, for clearing when billing state recovers. */
export const BILLING_BANNER_DISMISS_KEYS: readonly string[] = [
  ...Object.values(STATE_BANNERS).flatMap((banner) => [
    banner.dismissKey,
    banner.dismissKey + BOUNCED_DISMISS_SUFFIX,
  ]),
  BILLING_EMAIL_BOUNCED_DISMISS_KEY,
];

/**
 * A hard-bounced billing address rides along on whatever banner the state
 * already shows (on_hold keeps its red banner and gains "Fix billing email"),
 * and gets its own amber banner for a plain `active` subscriber, who would
 * otherwise never learn their receipts and payment alerts go nowhere.
 */
export function getBillingBannerVariant(
  state: BillingUxState,
  billingEmailBounced = false,
): BillingBannerVariant | null {
  const base = STATE_BANNERS[state] ?? null;
  if (!billingEmailBounced) return base;
  if (base) {
    return {
      ...base,
      actions: [...base.actions, FIX_BILLING_EMAIL],
      dismissKey: base.dismissKey + BOUNCED_DISMISS_SUFFIX,
    };
  }
  return state === 'active' ? BILLING_EMAIL_BOUNCED_BANNER : null;
}

const BILLING_EMAIL_ERROR_KEYS: ReadonlyMap<string, string> = new Map([
  ['INVALID_EMAIL', 'components.billingState.billingEmailInvalid'],
  ['EMAIL_SUPPRESSED', 'components.billingState.billingEmailSuppressed'],
]);

/** Inline error copy for a failed billing-email save, by the action's structured error kind. */
export function getBillingEmailErrorKey(kind: string | null): string {
  return (kind !== null && BILLING_EMAIL_ERROR_KEYS.get(kind))
    || 'components.billingState.billingEmailUpdateFailed';
}

/**
 * Prefill for the repair form: the signed-in account's address when it is a
 * different mailbox from the one bouncing, otherwise nothing (offering the
 * dead address back would just re-submit the typo).
 */
export function suggestBillingEmail(bouncedEmail: string, signedInEmail: string): string {
  const suggestion = signedInEmail.trim();
  if (suggestion === '') return '';
  return suggestion.toLowerCase() === bouncedEmail.trim().toLowerCase() ? '' : suggestion;
}

export type BillingGateOverride =
  | 'payment_on_hold'
  | 'renewal_pending'
  | 'renewal_failed'
  | 'lapsed';

/**
 * Which billing-specific gate reason (if any) should replace the generic
 * FREE_TIER "Upgrade to Pro" CTA for a locked premium panel. Values mirror
 * the PanelGateReason string enum in panel-gating.ts (kept as plain strings
 * here so this module stays a leaf).
 */
export function getBillingGateOverride(state: BillingUxState): BillingGateOverride | null {
  switch (state) {
    case 'on_hold':
      return 'payment_on_hold';
    case 'renewal_verification_pending':
      return 'renewal_pending';
    case 'renewal_verification_failed':
      return 'renewal_failed';
    case 'lapsed':
      return 'lapsed';
    default:
      return null;
  }
}

/**
 * Build the pricing link used by returning subscribers. The plan key only
 * controls the pricing page's monthly/annual preference; checkout still
 * resolves the product from the live pricing catalog.
 */
export function getReactivationHref(planKey?: string | null): string {
  const planParam = planKey
    ? `?wm_reactivate_plan=${encodeURIComponent(planKey)}`
    : '';
  return `/pro${planParam}#pricing`;
}
