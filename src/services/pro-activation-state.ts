/**
 * Pure decision core for Pro Activation Onboarding.
 *
 * A day-0 post-checkout activation interstitial for new Pro subscribers. It
 * opens right after the existing entitlement-unlock reload, reached by one of
 * two mount paths: the durable localStorage marker written at checkout return,
 * or the markerless first-cycle backfill (`decideActivationMount` mounts
 * markerless for a live first-cycle Pro subscription). This module owns ALL of
 * the decision logic: the mount flowchart, the record shapes and TTLs,
 * fire-once keying, the step model, the exit summary, the finish-setup chip,
 * and telemetry event selection.
 *
 * MUST stay a zero-import leaf (mirrors billing-state.ts): it is unit-tested
 * under `tsx --test` (no jsdom, no Vite globals) and — because the eager
 * dashboard code statically imports it — importing the product catalog here
 * would drag that checkout-only module into the main entry chunk and break the
 * eager-chunk budget. It COMPUTES records and decisions from explicit snapshot
 * inputs. The fire-once record is the deliberate exception to pure input/output:
 * `readScopedFireOnceRecord`/`writeScopedFireOnceRecord` persist it here against
 * an INJECTED storage handle (so tests stay jsdom-free); every other storage
 * read/write still lives in the panel-layout/UI units.
 *
 * Plan identity is an allowlist against the Pro-family product ids. The
 * literals are mirrored from config/products.generated.ts (DODO_PRODUCTS
 * PRO_MONTHLY / PRO_ANNUAL / PRO_BUSINESS_*) rather than imported — keeping
 * the leaf import-free — and tests/pro-activation-state.test.mts asserts
 * them against the generated
 * catalog so any drift goes red. The repo product-id guard excludes this file
 * for the same reason (the drift-guard test provides the catalog-sync it wants).
 */

// ---------------------------------------------------------------------------
// Plan-identity allowlists (kept in sync by the drift-guard test)
// ---------------------------------------------------------------------------

/**
 * The only product ids that grant Pro. Mirrors `DODO_PRODUCTS.PRO_MONTHLY` /
 * `PRO_ANNUAL` / `PRO_BUSINESS_MONTHLY` / `PRO_BUSINESS_ANNUAL` (kept in sync
 * by the drift-guard test). Pro Business is a larger Pro and gets the same
 * day-0 activation (KTD9). Anything else — api_starter, api_starter_annual,
 * api_business, enterprise, or an unknown id — is non-Pro and must never
 * trigger onboarding.
 */
export const PRO_PRODUCT_IDS: readonly string[] = [
  'pdt_0Nbtt71uObulf7fGXhQup', // PRO_MONTHLY
  'pdt_0NbttMIfjLWC10jHQWYgJ', // PRO_ANNUAL
  'pdt_0NjyFDbhURh2oROgPIU3G', // PRO_BUSINESS_MONTHLY
  'pdt_0Nk072fxPUcHWivZRtlQW', // PRO_BUSINESS_ANNUAL
];

/** The entitlement plan keys that classify as Pro (productCatalog.ts). */
export const PRO_PLAN_KEYS: readonly string[] = [
  'pro_monthly',
  'pro_annual',
  'pro_business_monthly',
  'pro_business_annual',
];

/** True when `productId` is one of the Pro-family products. */
export function isProProductId(productId: string): boolean {
  return PRO_PRODUCT_IDS.includes(productId);
}

/** True when `planKey` is a Pro entitlement plan key. */
export function isProPlanKey(planKey: string): boolean {
  return PRO_PLAN_KEYS.includes(planKey);
}

/**
 * Stable, non-reversible-enough local account scope for activation records.
 * Clerk user ids must not be persisted in origin-readable storage. FNV-1a 64
 * keeps this leaf synchronous/import-free while producing an opaque key from
 * Clerk's high-entropy id. It is an account partition key, never authentication.
 */
export function deriveActivationAccountKey(userId: string | null | undefined): string | null {
  if (!userId) return null;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < userId.length; i += 1) {
    hash ^= BigInt(userId.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `acct:${hash.toString(36)}`;
}

// ---------------------------------------------------------------------------
// Pending-onboarding marker (KTD1): versioned localStorage key + TTL
// ---------------------------------------------------------------------------

/**
 * Versioned localStorage key for the pending-onboarding marker. Bump the
 * suffix (never mutate in place) to invalidate every stored marker when the
 * record shape changes — same convention as ProBanner's dismiss key.
 */
export const PENDING_MARKER_KEY = 'wm-pro-activation-pending-v1';

/**
 * How long a pending marker stays actionable. Onboarding normally fires in the
 * same session (right after the unlock reload), but the entitlement webhook can
 * lag; 7 days lets a subscriber who closes the tab still get onboarded on a
 * later visit (R2) without a stale marker lingering forever.
 */
export const PENDING_MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Written at checkout return. `productId` is the authoritative plan identity
 * when the checkout-attempt record is known; it is ABSENT for the /pro overlay
 * bridge success path, where identity falls back to the live entitlement
 * snapshot at read time (never a write-time frozen fallback).
 */
export interface PendingOnboardingMarker {
  productId?: string;
  /**
   * Opaque account partition key derived from the Clerk user id. ABSENT while
   * auth is settling; the controller binds it before a mount can proceed.
   */
  accountKey?: string;
  /** Epoch ms the marker was written. */
  createdAt: number;
}

/**
 * Build a marker record; omit `productId` entirely when the plan is unknown and
 * `accountKey` entirely when no session is resolved (anonymous checkout return).
 */
export function computePendingMarker(
  productId: string | null | undefined,
  accountKey: string | null | undefined,
  now: number,
): PendingOnboardingMarker {
  const marker: PendingOnboardingMarker = { createdAt: now };
  if (productId) marker.productId = productId;
  if (accountKey) marker.accountKey = accountKey;
  return marker;
}

/** True once a marker is older than its TTL (inclusive boundary stays fresh). */
export function isPendingMarkerExpired(marker: PendingOnboardingMarker, now: number): boolean {
  return now - marker.createdAt > PENDING_MARKER_TTL_MS;
}

// ---------------------------------------------------------------------------
// Fire-once record (KTD4): one onboarding per subscription identity
// ---------------------------------------------------------------------------

/** Versioned localStorage key for the fire-once record. */
export const FIRE_ONCE_KEY = 'wm-pro-activation-shown-v1';

/** Keep presentation history isolated per opaque account key on shared browsers. */
export function fireOnceStorageKey(accountKey: string): string {
  return `${FIRE_ONCE_KEY}:${accountKey}`;
}

type FireOnceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Read, validate, expire, and one-time migrate the current account's record.
 * Legacy unscoped state is claimed only when it names the current subscription;
 * otherwise it remains available for its actual account to migrate later.
 */
export function readScopedFireOnceRecord(
  storage: FireOnceStorage,
  accountKey: string | null,
  currentSubscriptionKey: string | null,
  now: number,
): FireOnceRecord | null {
  if (accountKey === null) return null;
  const scopedKey = fireOnceStorageKey(accountKey);
  try {
    let raw = storage.getItem(scopedKey);
    if (raw === null) {
      const legacyRaw = storage.getItem(FIRE_ONCE_KEY);
      const legacyRecord = parseFireOnceRecord(legacyRaw);
      if (
        legacyRecord &&
        currentSubscriptionKey !== null &&
        legacyRecord.subscriptionKey === currentSubscriptionKey
      ) {
        raw = JSON.stringify(legacyRecord);
        storage.setItem(scopedKey, raw);
        storage.removeItem(FIRE_ONCE_KEY);
      }
    }
    const record = parseFireOnceRecord(raw);
    if (record && !isFireOnceActive(record, now)) {
      storage.removeItem(scopedKey);
      return null;
    }
    if (record && raw !== JSON.stringify(record)) {
      storage.setItem(scopedKey, JSON.stringify(record));
    }
    return record;
  } catch {
    return null;
  }
}

/** Persist a record only for the current opaque account scope. */
export function writeScopedFireOnceRecord(
  storage: FireOnceStorage,
  accountKey: string,
  record: FireOnceRecord,
): boolean {
  try {
    storage.setItem(fireOnceStorageKey(accountKey), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/**
 * How long a fire-once record suppresses re-onboarding. Long enough to outlast
 * a subscription period so the SAME subscription is never re-offered, while a
 * genuinely new subscription (win-back) carries a new key and re-onboards
 * regardless. The TTL is a storage-hygiene bound, not a re-offer timer.
 */
export const FIRE_ONCE_TTL_MS = 400 * 24 * 60 * 60 * 1000;

export interface FireOnceRecord {
  /** Subscription identity onboarding was shown for (see deriveSubscriptionKey). */
  subscriptionKey: string;
  /** Epoch ms the interstitial was shown. */
  shownAt: number;
}

/** Build a fire-once record for an opaque subscription identity. */
export function computeFireOnceRecord(subscriptionKey: string, now: number): FireOnceRecord {
  return { subscriptionKey, shownAt: now };
}

/** True when a fire-once record exists and is still within its TTL. */
export function isFireOnceActive(
  record: FireOnceRecord | null,
  now: number,
): record is FireOnceRecord {
  return record !== null && now - record.shownAt <= FIRE_ONCE_TTL_MS;
}

// ---------------------------------------------------------------------------
// Snapshot inputs (mirror entitlements.ts / billing-state.ts shapes)
// ---------------------------------------------------------------------------

/** Minimal entitlement fields onboarding needs. `null` = not yet loaded. */
export interface ActivationEntitlementSnapshot {
  planKey: string;
  /** Epoch ms until which the entitlement grants access. */
  validUntil: number;
}

/** Minimal subscription fields for fire-once keying. `null` = not yet loaded. */
export interface ActivationSubscriptionSnapshot {
  /** Opaque server-side subscription document identity. */
  activationKey?: string | null;
  /** Plan identity used to fail closed on markerless non-Pro subscriptions. */
  planKey?: string | null;
  /** Current coverage end used to distinguish settling from expired coverage. */
  currentPeriodEnd?: number | null;
  /**
   * Server-derived markerless cohort candidate: first billing cycle and no
   * confirmed presentation. The atomic claim performs the final server-side
   * activation check. Missing fails closed during mixed deploys.
   */
  activationOnboardingEligible?: boolean | null;
}

/**
 * Stable opaque identity for fire-once keying. Returns null while a pre-update
 * subscription response omits the activation key (deploy skew / still settling).
 */
export function deriveSubscriptionKey(sub: ActivationSubscriptionSnapshot | null): string | null {
  return sub?.activationKey || null;
}

// ---------------------------------------------------------------------------
// Mount decision (KTD2 + KTD3): the flowchart, over explicit snapshots
// ---------------------------------------------------------------------------

export interface ActivationMountInput {
  /** The stored pending marker, or null when none is present. */
  marker: PendingOnboardingMarker | null;
  /** Live entitlement snapshot; null = not yet loaded (still settling). */
  entitlement: ActivationEntitlementSnapshot | null;
  /** Live subscription snapshot; null = not yet loaded (still settling). */
  subscription: ActivationSubscriptionSnapshot | null;
  /** The stored fire-once record, or null when none is present. */
  fireOnce: FireOnceRecord | null;
  /** Desktop (Tauri) runtime — onboarding is web-only (R12). */
  isDesktop: boolean;
  /** True until the authentication provider has resolved the current account. */
  authPending: boolean;
  /**
   * Opaque key for the currently signed-in account, or null while auth settles.
   * Compared against `marker.accountKey` without persisting a raw Clerk user id.
   */
  currentAccountKey: string | null;
  now: number;
}

/**
 * - `mount`  — open the interstitial; write a fire-once record keyed by
 *   `subscriptionKey`, then clear the pending marker.
 * - `keep`   — leave the marker in place and retry on a later evaluation
 *   (still settling: a snapshot has not loaded, or entitlement is not yet live).
 * - `clear`  — remove the marker without mounting (ineligible: non-Pro,
 *   expired, desktop, or already onboarded for this subscription).
 * - `none`   — the resolved account is outside the markerless cohort.
 */
export type ActivationMountDecision =
  | {
      readonly action: 'mount';
      readonly subscriptionKey: string;
      /** Markerless cohorts receive a strict last-mile activation re-check. */
      readonly onlyIfUnactivated: boolean;
    }
  | { readonly action: 'keep' }
  | { readonly action: 'clear' }
  | { readonly action: 'none' };

type PlanClassification = 'pro' | 'non-pro' | 'unknown';

/**
 * Read-time plan identity. The marker's `productId`, when present, is
 * authoritative — a non-Pro id (including any unknown id) is a decisive
 * non-Pro. With no `productId` (the /pro bridge path) identity comes from the
 * LIVE entitlement snapshot: Pro plan key → Pro; anything else → `unknown`
 * (keep, TTL-bounded), NEVER `non-pro`, so a pre-auth/pre-webhook `free`
 * snapshot cannot clear a real subscriber's marker mid-settle (the #5494 race).
 */
function classifyActivationPlan(
  marker: PendingOnboardingMarker,
  entitlement: ActivationEntitlementSnapshot | null,
): PlanClassification {
  if (marker.productId) {
    return isProProductId(marker.productId) ? 'pro' : 'non-pro';
  }
  if (entitlement === null) return 'unknown';
  return isProPlanKey(entitlement.planKey) ? 'pro' : 'unknown';
}

/** True when the entitlement snapshot confirms currently-live Pro access. */
function isEntitlementLive(entitlement: ActivationEntitlementSnapshot | null, now: number): boolean {
  return entitlement !== null && isProPlanKey(entitlement.planKey) && entitlement.validUntil >= now;
}

/**
 * The mount flowchart. Every "not yet loaded" input (entitlement OR
 * subscription) resolves to `keep`, never a denial — one snapshot missing is
 * "still settling", the exact race that shipped a bug in PR #5494.
 */
export function decideActivationMount(input: ActivationMountInput): ActivationMountDecision {
  const { marker, entitlement, subscription, fireOnce, isDesktop, currentAccountKey, now } = input;

  if (marker === null) {
    if (isDesktop) return { action: 'none' };
    if (input.authPending) return { action: 'keep' };
    if (currentAccountKey === null) return { action: 'none' };
    if (entitlement === null) return { action: 'keep' };
    if (subscription === null) {
      // A live Pro entitlement can briefly lead its subscription snapshot.
      // A resolved non-Pro entitlement with no subscription is a conclusive
      // free/non-subscriber result and must not leave global listeners armed.
      return isEntitlementLive(entitlement, now) ? { action: 'keep' } : { action: 'none' };
    }
    if (
      subscription.activationOnboardingEligible !== true ||
      !subscription.planKey ||
      !isProPlanKey(subscription.planKey) ||
      typeof subscription.currentPeriodEnd !== 'number' ||
      subscription.currentPeriodEnd < now
    ) {
      return { action: 'none' };
    }
    // The subscription query is already in the target cohort. If entitlement
    // has not caught up yet, preserve retryability instead of silently losing
    // the backfill opportunity during the same settle race as checkout.
    if (!isEntitlementLive(entitlement, now)) return { action: 'keep' };

    const subscriptionKey = deriveSubscriptionKey(subscription);
    if (subscriptionKey === null) return { action: 'keep' };
    if (isFireOnceActive(fireOnce, now) && fireOnce.subscriptionKey === subscriptionKey) {
      return { action: 'none' };
    }
    return { action: 'mount', subscriptionKey, onlyIfUnactivated: true };
  }
  if (isDesktop) return { action: 'clear' }; // web-only (R12); reap the inert marker
  if (isPendingMarkerExpired(marker, now)) return { action: 'clear' };

  // Cross-account identity gate. A marker carrying an `accountKey` is
  // bound to that account. Placed AFTER the desktop/TTL reaps (an inert or
  // stale marker is cleared regardless of who is signed in) and BEFORE plan
  // classification (identity decides before eligibility).
  if (marker.accountKey !== undefined) {
    // Auth has not resolved yet — we cannot confirm the buyer is back. Keep the
    // marker and retry when a snapshot next changes (never clear on a settle).
    if (currentAccountKey === null) return { action: 'keep' };
    // A DIFFERENT account is signed in: this is someone else's purchase. Do NOT
    // mount (no cross-account onboarding) and do NOT clear (the buyer may sign
    // back in on this browser); keep the decision retryable on auth changes.
    if (currentAccountKey !== marker.accountKey) return { action: 'keep' };
  }
  if (currentAccountKey === null) return { action: 'keep' };

  const plan = classifyActivationPlan(marker, entitlement);
  if (plan === 'non-pro') return { action: 'clear' };
  if (plan === 'unknown') return { action: 'keep' }; // cannot classify yet → retry

  // plan === 'pro'. Wait for the unlock to actually land before opening (R2).
  if (!isEntitlementLive(entitlement, now)) return { action: 'keep' };

  const subscriptionKey = deriveSubscriptionKey(subscription);
  if (subscriptionKey === null) return { action: 'keep' }; // subscription snapshot still settling

  if (isFireOnceActive(fireOnce, now) && fireOnce.subscriptionKey === subscriptionKey) {
    return { action: 'clear' }; // already onboarded THIS subscription (R3)
  }

  return { action: 'mount', subscriptionKey, onlyIfUnactivated: false };
}

// ---------------------------------------------------------------------------
// Cross-tab mount claim (finding #7): a short-lived localStorage lease so two
// tabs that both boot the same post-checkout marker do not each open the
// interstitial. The claiming tab writes its nonce, waits a beat, then re-reads:
// exactly one nonce survives the last-writer-wins settle, and only that tab
// proceeds. The in-tab `activationResolved` latch guards the single-tab case;
// this guards the multi-tab case. Best-effort — if storage is unavailable the
// lease simply does not engage and both tabs fall back to the local latch.
// ---------------------------------------------------------------------------

/** Versioned localStorage key for the cross-tab mount claim. */
export const MOUNT_CLAIM_KEY = 'wm-pro-activation-claim-v1';

/**
 * How long a mount claim is honored. Long enough to cover the read → write →
 * re-read settle a claiming tab waits through, short enough that a tab which
 * crashed mid-claim cannot wedge onboarding for the next boot.
 */
export const MOUNT_CLAIM_TTL_MS = 10_000;

/** Bounded retry schedule for transient strict-read/claim failures. */
export const ACTIVATION_FLOW_RETRY_DELAYS_MS = [
  2_000,
  4_000,
  8_000,
  16_000,
  30_000,
] as const;

export function activationFlowRetryDelay(attempt: number): number | null {
  return ACTIVATION_FLOW_RETRY_DELAYS_MS[attempt] ?? null;
}

export interface MountClaimRecord {
  /** Per-manager random nonce identifying the claiming tab. */
  nonce: string;
  /** Epoch ms the claim was written. */
  claimedAt: number;
}

/** Build a mount-claim record for a tab's nonce. */
export function computeMountClaim(nonce: string, now: number): MountClaimRecord {
  return { nonce, claimedAt: now };
}

export function parseMountClaim(raw: string | null): MountClaimRecord | null {
  const obj = parseJsonObject(raw);
  if (obj === null || typeof obj.nonce !== 'string' || typeof obj.claimedAt !== 'number') {
    return null;
  }
  return { nonce: obj.nonce, claimedAt: obj.claimedAt };
}

/**
 * True when a foreign, still-fresh claim blocks us from mounting: a record
 * exists, is within its TTL (inclusive boundary stays fresh), and was written
 * by a DIFFERENT tab. Our own claim, a lapsed (stale) claim, and no claim at
 * all are all non-blocking.
 */
export function isMountClaimBlocking(
  record: MountClaimRecord | null,
  ownNonce: string,
  now: number,
): boolean {
  if (record === null) return false;
  if (now - record.claimedAt > MOUNT_CLAIM_TTL_MS) return false; // lease lapsed
  return record.nonce !== ownNonce;
}

// ---------------------------------------------------------------------------
// Step model (R15/AE6): ordered [brief, alerts, power] with per-step state
// ---------------------------------------------------------------------------

export type ActivationStepId = 'brief' | 'alerts' | 'power';

/**
 * - `confirmable`  — offer the action; the user can complete it in-flow.
 * - `already-done` — pre-configured; render as done, never overwrite (AE6).
 * - `blocked`      — cannot proceed because a prerequisite permission is denied.
 * - `unavailable`  — the platform cannot support this step at all.
 */
export type ActivationStepState = 'confirmable' | 'already-done' | 'blocked' | 'unavailable';

export interface ActivationStep {
  readonly id: ActivationStepId;
  readonly state: ActivationStepState;
  /**
   * Brief-only: true when the user has tuned their digest hour, so the UI shows
   * and preserves their existing schedule rather than applying a default (AE6).
   */
  readonly preservesSchedule?: boolean;
}

export interface ActivationPlatformCapabilities {
  /** Whether the platform supports web push (Notification + PushManager). */
  webPushSupported: boolean;
  /** Current Notification.permission, when the platform exposes it. */
  pushPermission?: 'default' | 'granted' | 'denied';
}

export interface ActivationExistingConfig {
  /** A verified email delivery channel already exists. */
  hasVerifiedEmailChannel: boolean;
  /** The enabled current-variant rule includes the verified email channel. */
  hasEmailDelivery: boolean;
  /** The enabled current-variant alert rule produces a digest. */
  hasEnabledDigestRule: boolean;
  /** The user has tuned digestHour away from the default (their schedule). */
  hasTunedDigestHour: boolean;
  /** A web-push delivery channel already exists. */
  hasWebPushChannel: boolean;
  /** The enabled current-variant rule includes the verified web-push channel. */
  hasWebPushDelivery: boolean;
  /** The user has already used a Pro power feature (custom widget / MCP). */
  hasUsedPowerFeature?: boolean;
}

/**
 * True when any capability this flow exists to activate is already running.
 * Used only by the markerless first-cycle cohort: explicit checkout returns keep
 * the original once-per-subscription behavior and render existing steps as done.
 */
export function hasAnyActivatedProFunctionality(config: ActivationExistingConfig): boolean {
  return (
    config.hasEmailDelivery ||
    config.hasWebPushDelivery ||
    config.hasUsedPowerFeature === true
  );
}

function briefStep(config: ActivationExistingConfig): ActivationStep {
  // A brief is "already set up" only when an enabled digest rule AND a verified
  // channel to deliver it both exist. A rule with no verified channel is
  // undeliverable, so onboarding still offers to confirm delivery.
  const alreadyDone = config.hasEnabledDigestRule && config.hasEmailDelivery;
  if (alreadyDone) {
    return { id: 'brief', state: 'already-done', preservesSchedule: config.hasTunedDigestHour };
  }
  return { id: 'brief', state: 'confirmable' };
}

function alertsStep(caps: ActivationPlatformCapabilities, config: ActivationExistingConfig): ActivationStep {
  if (caps.pushPermission === 'denied') return { id: 'alerts', state: 'blocked' };
  if (config.hasWebPushDelivery) return { id: 'alerts', state: 'already-done' };
  return { id: 'alerts', state: 'confirmable' };
}

function powerStep(config: ActivationExistingConfig): ActivationStep {
  return { id: 'power', state: config.hasUsedPowerFeature ? 'already-done' : 'confirmable' };
}

/**
 * Ordered activation steps for the flow. The alerts step is OMITTED entirely
 * when web push is unsupported (R12-adjacent capability gate); every other step
 * is always present, rendering `already-done` for anything already configured.
 */
export function buildActivationSteps(
  caps: ActivationPlatformCapabilities,
  config: ActivationExistingConfig,
): readonly ActivationStep[] {
  const steps: ActivationStep[] = [briefStep(config)];
  if (caps.webPushSupported) steps.push(alertsStep(caps, config));
  steps.push(powerStep(config));
  return steps;
}

// ---------------------------------------------------------------------------
// Per-step write payloads (U4/U5): pure deltas the confirm handlers POST
// ---------------------------------------------------------------------------

/** The digest hour applied when a subscriber has not tuned their own (8:00). */
export const DEFAULT_DIGEST_HOUR = 8;

/**
 * The digest-schedule delta the brief step writes when a subscriber turns on
 * their morning brief. A zero-import leaf, so `digestMode` is a literal and the
 * caller adds `variant` / `channels` (which need imports). The payload ALWAYS
 * carries an explicit hour + timezone so the daily digest never rides the
 * sender's 8:00-UTC default.
 */
export interface BriefDigestPayload {
  readonly enabled: true;
  /**
   * Cadence fields are present only when CREATING a fresh rule. When an enabled
   * digest rule already exists (the subscriber has a weekly/twice_daily rule but
   * no verified email channel yet), they are omitted so the notification-config
   * write preserves the existing cadence instead of forcing it to daily — the
   * relay mutation guards every field with `!== undefined` (omit = preserve).
   */
  readonly digestMode?: 'daily';
  readonly digestHour?: number;
  readonly digestTimezone?: string;
}

/** Clamp an arbitrary hour input to a valid 0–23 integer, else the default. */
function normalizeDigestHour(hourLocal: number): number {
  return Number.isInteger(hourLocal) && hourLocal >= 0 && hourLocal <= 23
    ? hourLocal
    : DEFAULT_DIGEST_HOUR;
}

/**
 * Build the brief step's write payload, or `null` when the brief is already set
 * up (an enabled digest rule delivering to a verified channel) — a returning
 * subscriber's tuned config is never overwritten (R15/AE6). Mirrors the
 * `briefStep` already-done predicate so the confirm path and the step model
 * agree on when a write is reachable.
 */
export function buildBriefDigestPayload(
  existing: ActivationExistingConfig,
  hourLocal: number,
  ianaTimezone: string,
): BriefDigestPayload | null {
  if (existing.hasEnabledDigestRule && existing.hasEmailDelivery) return null;
  // An enabled digest rule already exists (just missing a verified email
  // channel): enable + let the caller add email, but omit the cadence fields so
  // a subscriber's existing weekly/twice_daily schedule is never overwritten
  // with daily. Only a fresh rule gets an explicit daily cadence.
  if (existing.hasEnabledDigestRule) return { enabled: true };
  return {
    enabled: true,
    digestMode: 'daily',
    digestHour: normalizeDigestHour(hourLocal),
    digestTimezone: ianaTimezone,
  };
}

/**
 * The alert-rule delta the alerts step writes after the web-push channel is
 * registered. Adds `web_push` to the delivery channels (set semantics). When no
 * enabled rule exists it seeds a critical-only rule; when one already exists
 * (e.g. the brief step just created a daily digest) it PATCHES channels only —
 * `sensitivity` is omitted so the existing cadence/sensitivity is preserved
 * (R15, never clobber). `channels` is `string[]` to keep the leaf import-free;
 * the caller casts to `ChannelType[]`.
 */
export interface CriticalAlertsPayload {
  readonly enabled: true;
  readonly channels: string[];
  readonly sensitivity?: 'critical';
}

export function buildCriticalAlertsPayload(
  existingChannels: readonly string[],
  hasEnabledRule: boolean,
): CriticalAlertsPayload {
  const channels = existingChannels.includes('web_push')
    ? [...existingChannels]
    : [...existingChannels, 'web_push'];
  return hasEnabledRule
    ? { enabled: true, channels }
    : { enabled: true, channels, sensitivity: 'critical' };
}

// ---------------------------------------------------------------------------
// Exit summary + finish-setup chip
// ---------------------------------------------------------------------------

/**
 * What actually happened to a step during the flow.
 *
 * `blocked` is deliberately distinct from `skipped` (#5617). Both keep the
 * aggregate `pending` status, but `blocked` says the BROWSER refused and lets
 * the UI render browser-specific recovery guidance (#5727). Collapsing the two
 * makes the push-permission-denial cohort unsizeable after the fact, and makes
 * "is re-prompting this account worth anything?" unanswerable (it never is,
 * once permission is `denied`). It is equally not `failed`: we never attempted
 * a write, so "we couldn't set this up" would be a false claim.
 */
export type ActivationStepOutcome = 'confirmed' | 'skipped' | 'blocked' | 'done' | 'failed';

/** R15 line status: distinct verified / pending / failed. */
export type ActivationSummaryStatus = 'verified' | 'pending' | 'failed';

export interface ActivationStepResult {
  readonly id: ActivationStepId;
  readonly outcome: ActivationStepOutcome;
}

export interface ActivationSummaryLine {
  readonly id: ActivationStepId;
  readonly outcome: ActivationStepOutcome;
  readonly status: ActivationSummaryStatus;
}

function outcomeStatus(outcome: ActivationStepOutcome): ActivationSummaryStatus {
  switch (outcome) {
    case 'confirmed':
    case 'done':
      return 'verified';
    case 'skipped':
      // A browser refusal is durably distinct (#5617) but keeps the `pending`
      // status, NOT `failed`: the summary renders `failed` as "we couldn't set
      // this up", which claims an attempt we were never allowed to make. Its
      // detail copy can still explain the browser block (#5727).
    case 'blocked':
      return 'pending';
    case 'failed':
      return 'failed';
  }
}

/**
 * The outcome a step resolves to when the flow advances past it without a
 * confirm. The shell reaches this from two directions — the blocked/unavailable
 * "Continue" button, and the implicit default for a step the user never acted
 * on (dismiss / Escape) — so it lives here as one pure seam: a denial recorded
 * through one path and a plain skip through the other would make `blockedSteps`
 * a biased sample of the exact cohort it exists to size (#5617).
 */
export function selectAdvanceOutcome(state: ActivationStepState): ActivationStepOutcome {
  switch (state) {
    case 'already-done':
      return 'done';
    case 'blocked':
      return 'blocked';
    case 'confirmable':
    // Unavailable is a platform gap, not a browser refusal: nothing was ever
    // offered or denied, so it stays an ordinary unfinished step.
    case 'unavailable':
      return 'skipped';
  }
}

/** Exit-summary lines, one per step result, in order (R15). */
export function buildExitSummary(
  results: readonly ActivationStepResult[],
): readonly ActivationSummaryLine[] {
  return results.map((r) => ({ id: r.id, outcome: r.outcome, status: outcomeStatus(r.outcome) }));
}

/** Overall disposition of a finished flow — the funnel-exit completion state. */
export type ActivationCompletion = 'complete' | 'partial' | 'none';

/**
 * Aggregate exit state for the funnel-exit telemetry event. The per-step
 * outcomes collapse into the three summary buckets (mirrors `outcomeStatus`),
 * and `completion` is `complete` when every step verified, `none` when none
 * did, and `partial` in between. Carries only counts — never a per-step or
 * billing identity — so it is safe to forward straight to analytics.
 */
export interface ActivationExitSummary {
  readonly completion: ActivationCompletion;
  /** Steps that ended verified (confirmed in-flow or already-done). */
  readonly verified: number;
  /** Steps left unfinished (skipped). */
  readonly pending: number;
  /** Steps whose write failed. */
  readonly failed: number;
  /** Total steps the flow presented. */
  readonly total: number;
}

/** Collapse ordered step results into the aggregate exit summary (funnel state). */
export function summarizeActivationExit(
  results: readonly ActivationStepResult[],
): ActivationExitSummary {
  let verified = 0;
  let pending = 0;
  let failed = 0;
  for (const r of results) {
    const status = outcomeStatus(r.outcome);
    if (status === 'verified') verified += 1;
    else if (status === 'pending') pending += 1;
    else failed += 1;
  }
  const total = results.length;
  // verified === 0 also covers the empty-flow case (0 === 0 total).
  const completion: ActivationCompletion =
    verified === 0 ? 'none' : verified === total ? 'complete' : 'partial';
  return { completion, verified, pending, failed, total };
}

/** Per-step outcome IDs, bucketed for the durable activation-outcome record (#5582). */
export interface ActivationOutcomeBuckets {
  /** Steps that ended verified -- confirmed in-flow or already-done. */
  readonly confirmedSteps: readonly ActivationStepId[];
  /** Steps the subscriber chose to leave unfinished. */
  readonly skippedSteps: readonly ActivationStepId[];
  /**
   * Steps the BROWSER refused (a denied notification permission). Its own
   * bucket rather than a widening of `skippedSteps` (#5617), so existing
   * consumers of the three original buckets keep their exact meaning.
   */
  readonly blockedSteps: readonly ActivationStepId[];
  /** Steps whose write was attempted and failed. */
  readonly failedSteps: readonly ActivationStepId[];
}

/**
 * Bucket step results by outcome for persistence, independent of the Umami exit
 * event. Every outcome is routed EXPLICITLY: the previous `else` catch-all
 * would have swallowed the new `blocked` outcome into `failedSteps`, silently
 * labelling a browser refusal as a failed write.
 */
export function buildActivationOutcomeBuckets(
  results: readonly ActivationStepResult[],
): ActivationOutcomeBuckets {
  const confirmedSteps: ActivationStepId[] = [];
  const skippedSteps: ActivationStepId[] = [];
  const blockedSteps: ActivationStepId[] = [];
  const failedSteps: ActivationStepId[] = [];
  for (const r of results) {
    switch (r.outcome) {
      case 'confirmed':
      case 'done':
        confirmedSteps.push(r.id);
        break;
      case 'skipped':
        skippedSteps.push(r.id);
        break;
      case 'blocked':
        blockedSteps.push(r.id);
        break;
      case 'failed':
        failedSteps.push(r.id);
        break;
    }
  }
  return { confirmedSteps, skippedSteps, blockedSteps, failedSteps };
}

/** Versioned localStorage key for the finish-setup chip dismissal. */
export const FINISH_SETUP_CHIP_DISMISS_KEY = 'wm-pro-activation-chip-dismissed-v1';

/** How long a chip dismissal suppresses the finish-setup chip. */
export const FINISH_SETUP_CHIP_DISMISS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface FinishSetupChipDismissal {
  dismissedAt: number;
  /**
   * Opaque account partition key. Scopes a dismissal without persisting the
   * Clerk user id in origin-readable storage.
   */
  accountKey?: string;
}

/** Build a chip-dismissal record; omit `accountKey` when no session is resolved. */
export function computeFinishSetupChipDismissal(
  accountKey: string | null | undefined,
  now: number,
): FinishSetupChipDismissal {
  const record: FinishSetupChipDismissal = { dismissedAt: now };
  if (accountKey) record.accountKey = accountKey;
  return record;
}

/**
 * Whether a chip dismissal still suppresses the chip for the current viewer.
 * TTL is the outer gate; identity refines it (finding #13):
 *   - no record, or past its TTL → NOT dismissed.
 *   - a legacy record (no `accountKey`) → dismissed for everyone (back-compat).
 *   - a scoped record + the SAME signed-in user → dismissed.
 *   - a scoped record + a DIFFERENT signed-in user → NOT dismissed (their chip
 *     is not bound by another account's dismissal).
 *   - a scoped record while auth is still settling (`currentAccountKey` null) →
 *     dismissed, so a fresh dismissal does not flash the chip pre-auth; it
 *     re-resolves once the user id loads and a mismatch reveals the chip.
 */
export function isChipDismissed(
  record: FinishSetupChipDismissal | null,
  currentAccountKey: string | null,
  now: number,
): boolean {
  if (record === null) return false;
  if (now - record.dismissedAt > FINISH_SETUP_CHIP_DISMISS_TTL_MS) return false;
  if (record.accountKey === undefined) return true; // legacy: suppress for all
  if (currentAccountKey === null) return true; // pre-auth: don't flash the chip
  return currentAccountKey === record.accountKey; // scoped: same account only
}

// ---------------------------------------------------------------------------
// Stored-record parsers. Raw string (from a caller's storage read) → validated
// record, or null for anything malformed so callers degrade to "no record"
// instead of throwing. Legacy raw user ids migrate to opaque account keys, and
// records are rebuilt field-by-field so junk keys never survive a parse.
// Storage I/O itself stays with callers — these take only strings, keeping the
// leaf import-free and node:test-testable.
// ---------------------------------------------------------------------------

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed JSON degrades to "no record".
  }
  return null;
}

export function parsePendingMarker(raw: string | null): PendingOnboardingMarker | null {
  const obj = parseJsonObject(raw);
  if (obj === null || typeof obj.createdAt !== 'number') return null;
  const marker: PendingOnboardingMarker = { createdAt: obj.createdAt };
  if (typeof obj.productId === 'string') marker.productId = obj.productId;
  if (typeof obj.accountKey === 'string') marker.accountKey = obj.accountKey;
  else if (typeof obj.userId === 'string') {
    marker.accountKey = deriveActivationAccountKey(obj.userId) ?? undefined;
  }
  return marker;
}

export function parseFireOnceRecord(raw: string | null): FireOnceRecord | null {
  const obj = parseJsonObject(raw);
  if (obj === null || typeof obj.subscriptionKey !== 'string' || typeof obj.shownAt !== 'number') {
    return null;
  }
  return { subscriptionKey: obj.subscriptionKey, shownAt: obj.shownAt };
}

export function parseChipDismissal(raw: string | null): FinishSetupChipDismissal | null {
  const obj = parseJsonObject(raw);
  if (obj === null || typeof obj.dismissedAt !== 'number') return null;
  const record: FinishSetupChipDismissal = { dismissedAt: obj.dismissedAt };
  if (typeof obj.accountKey === 'string') record.accountKey = obj.accountKey;
  else if (typeof obj.userId === 'string') {
    record.accountKey = deriveActivationAccountKey(obj.userId) ?? undefined;
  }
  return record;
}

/**
 * Whether to surface the persistent "finish setup" chip after the flow. Shows
 * when any step is left unfinished (skipped, blocked, or failed) and the chip
 * has not been dismissed within its TTL; a fully completed flow (or a fresh
 * dismissal) shows nothing. `blocked` counts as unfinished for the same reason
 * it reads as `pending`: splitting it out of `skippedSteps` (#5617) changed the
 * durable record, never what the subscriber sees.
 */
export function shouldShowFinishSetupChip(
  results: readonly ActivationStepResult[],
  dismissal: FinishSetupChipDismissal | null,
  currentAccountKey: string | null,
  now: number,
): boolean {
  if (isChipDismissed(dismissal, currentAccountKey, now)) return false;
  return results.some(
    (r) => r.outcome === 'skipped' || r.outcome === 'blocked' || r.outcome === 'failed',
  );
}

// ---------------------------------------------------------------------------
// Telemetry event selection (names only; wiring is a separate unit)
// ---------------------------------------------------------------------------

/** Stable kebab-case event names (mirrors the analytics.ts EVENTS catalog). */
export const ACTIVATION_EVENTS = {
  entered: 'pro-activation-entered',
  stepConfirmed: 'pro-activation-step-confirmed',
  stepSkipped: 'pro-activation-step-skipped',
  // A step the platform refused unrecoverably (a denied notification
  // permission). Without this event the denial cohort would be indistinguishable
  // on the live stream from users who chose to skip — the funnel would read a
  // browser block as disinterest. The durable counterpart is the `blocked`
  // outcome and its own `blockedSteps` bucket (#5617).
  stepBlocked: 'pro-activation-step-blocked',
  // #5600: a step whose write genuinely errored. Distinct from `stepBlocked`:
  // that one is the platform refusing, this one is our write failing. Without
  // it the only trace of a failure was a `stepSkipped` plus an aggregate count
  // on the exit event, so a day of broken day-0 activations read as user
  // disinterest.
  stepFailed: 'pro-activation-step-failed',
  exit: 'pro-activation-exit',
} as const;

/**
 * How an in-flow confirm resolved.
 *
 * `blocked` means the platform refused in a way a retry cannot fix — a denied
 * notification permission, which browsers never re-prompt for (#5609).
 *
 * `declined` means the USER walked away from a prompt without deciding (they
 * dismissed the notification permission dialog, leaving it `default`). A retry
 * still works, so the UI treats it like `failed`, but the funnel must not: it is
 * a user outcome, not our write erroring. Folding it into `failed` is what let a
 * dismissed prompt — the common case for the alerts step — land in the
 * `pro-activation-step-failed` metric added to catch systemic write failures
 * (#5600). Note `shouldReportPushSubscribeFailure` already excluded this state
 * from Sentry for exactly this reason; the funnel just did not agree.
 */
export type ActivationConfirmResult = 'verified' | 'failed' | 'blocked' | 'declined';

/**
 * The step outcome a confirm result reports as, or null when the result is
 * already reported through another channel.
 *
 * `blocked` maps to null on purpose: the shell fires its own `stepBlocked`
 * event via `onBlockStep`, so emitting a step event here too would count one
 * attempt twice — re-creating the mislabeled-funnel bug #5600 exists to fix,
 * just with a different pair of labels.
 */
export function selectConfirmOutcome(
  result: ActivationConfirmResult,
): ActivationStepOutcome | null {
  switch (result) {
    case 'verified':
      return 'confirmed';
    case 'failed':
      return 'failed';
    case 'blocked':
      // The shell fires its own stepBlocked via onBlockStep (#5609).
      return null;
    case 'declined':
      // A dismissed prompt is a user choice. The shell reports it as a skip when
      // the user moves on, so emitting a confirm-time event here would either
      // double-count it or mislabel it as our failure (#5600).
      return null;
  }
}

/**
 * Whether a failed `subscribeToPush` is worth reporting to Sentry.
 *
 * Only granted-then-failed is a real error. `denied` and `default` (the user
 * dismissed the prompt without choosing) are both the documented AE3 user
 * outcome and are the common case — reporting them would bury genuine failures
 * under permission noise (#5600).
 */
export function shouldReportPushSubscribeFailure(permission: string): boolean {
  return permission === 'granted';
}

/**
 * The set of activation telemetry event names. This is the single naming
 * source: the analytics.ts EVENTS catalog and its `ProActivationEvent` union
 * mirror these literals, and the flow's `onEvent` hook is typed to it so a
 * rename here surfaces as a compile error at the analytics wiring site.
 */
export type ActivationEventName = (typeof ACTIVATION_EVENTS)[keyof typeof ACTIVATION_EVENTS];

/**
 * The per-step telemetry event for an outcome, or null when the outcome is not
 * a tracked user action: only `done` (nothing to do, pre-configured) emits
 * none. `failed` has its own event since #5600 — folding it into the exit
 * summary alone is what let a systemic write failure look like a skip.
 * `blocked` keeps its OWN event — falling through to `stepSkipped` would
 * re-collapse the denial cohort into voluntary skips at the event level, the
 * exact gap the event was added to close (#5609).
 */
export function selectStepEvent(outcome: ActivationStepOutcome): ActivationEventName | null {
  switch (outcome) {
    case 'confirmed':
      return ACTIVATION_EVENTS.stepConfirmed;
    case 'skipped':
      return ACTIVATION_EVENTS.stepSkipped;
    case 'blocked':
      return ACTIVATION_EVENTS.stepBlocked;
    case 'failed':
      return ACTIVATION_EVENTS.stepFailed;
    case 'done':
      return null;
  }
}
