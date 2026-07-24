/**
 * Pure decision core for Pro Activation Onboarding.
 *
 * A day-0 post-checkout activation interstitial for new Pro subscribers. It
 * opens right after the existing entitlement-unlock reload, driven off a
 * durable localStorage marker written at checkout return. This module owns
 * ALL of the decision logic: the mount flowchart, the record shapes and TTLs,
 * fire-once keying, the step model, the exit summary, the finish-setup chip,
 * and telemetry event selection.
 *
 * MUST stay a zero-import leaf (mirrors billing-state.ts): it is unit-tested
 * under `tsx --test` (no jsdom, no Vite globals) and — because the eager
 * dashboard code statically imports it — importing the product catalog here
 * would drag that checkout-only module into the main entry chunk and break the
 * eager-chunk budget. It COMPUTES records and decisions from explicit snapshot
 * inputs — callers perform every storage read/write (localStorage lives in the
 * panel-layout/UI units, never here).
 *
 * Plan identity is an allowlist against the two Pro product ids. The literals
 * are mirrored from config/products.generated.ts (DODO_PRODUCTS.PRO_MONTHLY /
 * PRO_ANNUAL) rather than imported — keeping the leaf import-free — and
 * tests/pro-activation-state.test.mts asserts them against the generated
 * catalog so any drift goes red. The repo product-id guard excludes this file
 * for the same reason (the drift-guard test provides the catalog-sync it wants).
 */

// ---------------------------------------------------------------------------
// Plan-identity allowlists (kept in sync by the drift-guard test)
// ---------------------------------------------------------------------------

/**
 * The only two product ids that grant Pro. Mirrors
 * `DODO_PRODUCTS.PRO_MONTHLY` / `PRO_ANNUAL` (kept in sync by the drift-guard
 * test). Anything else — api_starter, api_starter_annual, api_business,
 * enterprise, or an unknown id — is non-Pro and must never trigger onboarding.
 */
export const PRO_PRODUCT_IDS: readonly string[] = [
  'pdt_0Nbtt71uObulf7fGXhQup', // PRO_MONTHLY
  'pdt_0NbttMIfjLWC10jHQWYgJ', // PRO_ANNUAL
];

/** The entitlement plan keys that classify as Pro (productCatalog.ts). */
export const PRO_PLAN_KEYS: readonly string[] = ['pro_monthly', 'pro_annual'];

/** True when `productId` is one of the two Pro products. */
export function isProProductId(productId: string): boolean {
  return PRO_PRODUCT_IDS.includes(productId);
}

/** True when `planKey` is a Pro entitlement plan key. */
export function isProPlanKey(planKey: string): boolean {
  return PRO_PLAN_KEYS.includes(planKey);
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
   * The Clerk user id the checkout return was observed under, when a session
   * was already resolved at write time. ABSENT for an anonymous checkout return
   * (auth still settling) and for markers written before identity scoping —
   * both flow through the mount decision as legacy, un-scoped markers. When
   * present it binds the marker to one account so a shared browser cannot
   * onboard user B off user A's purchase (decideActivationMount, finding #6).
   */
  userId?: string;
  /** Epoch ms the marker was written. */
  createdAt: number;
}

/**
 * Build a marker record; omit `productId` entirely when the plan is unknown and
 * `userId` entirely when no session is resolved (anonymous checkout return).
 */
export function computePendingMarker(
  productId: string | null | undefined,
  userId: string | null | undefined,
  now: number,
): PendingOnboardingMarker {
  const marker: PendingOnboardingMarker = { createdAt: now };
  if (productId) marker.productId = productId;
  if (userId) marker.userId = userId;
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
  /**
   * The Clerk user id onboarding fired under, when known. Suppression already
   * scopes correctly by `subscriptionKey`, so the decision never reads this
   * field — it is retained for observability / future cross-account auditing
   * (finding #6). Absent for anonymous or legacy records.
   */
  userId?: string;
  /** Epoch ms the interstitial was shown. */
  shownAt: number;
}

/** Build a fire-once record for a subscription identity; omit `userId` when absent. */
export function computeFireOnceRecord(
  subscriptionKey: string,
  userId: string | null | undefined,
  now: number,
): FireOnceRecord {
  const record: FireOnceRecord = { subscriptionKey, shownAt: now };
  if (userId) record.userId = userId;
  return record;
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
  /** Provider subscription id — the preferred fire-once key. */
  id?: string | null;
  /** Epoch ms period start — the fire-once key fallback when id is absent. */
  currentPeriodStart?: number | null;
}

/**
 * Stable identity for fire-once keying: the subscription id, or a
 * `period:<start>` fallback so a re-subscribed customer (new period) re-onboards
 * even if the provider reuses an id. Returns null while the snapshot cannot
 * identify the subscription yet (still settling).
 */
export function deriveSubscriptionKey(sub: ActivationSubscriptionSnapshot | null): string | null {
  if (sub === null) return null;
  if (sub.id) return sub.id;
  if (sub.currentPeriodStart != null) return `period:${sub.currentPeriodStart}`;
  return null;
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
  /**
   * The currently signed-in Clerk user id, or null while auth is still settling
   * (or a genuinely anonymous session). Compared against `marker.userId` so a
   * shared browser never onboards one account off another's purchase (#6).
   */
  currentUserId: string | null;
  now: number;
}

/**
 * - `mount`  — open the interstitial; write a fire-once record keyed by
 *   `subscriptionKey`, then clear the pending marker.
 * - `keep`   — leave the marker in place and retry on a later evaluation
 *   (still settling: a snapshot has not loaded, or entitlement is not yet live).
 * - `clear`  — remove the marker without mounting (ineligible: non-Pro,
 *   expired, desktop, or already onboarded for this subscription).
 * - `none`   — no marker present; nothing to do.
 */
export type ActivationMountDecision =
  | { readonly action: 'mount'; readonly subscriptionKey: string }
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
  const { marker, entitlement, subscription, fireOnce, isDesktop, currentUserId, now } = input;

  if (marker === null) return { action: 'none' };
  if (isDesktop) return { action: 'clear' }; // web-only (R12); reap the inert marker
  if (isPendingMarkerExpired(marker, now)) return { action: 'clear' };

  // Cross-account identity gate (finding #6). A marker carrying a `userId` is
  // bound to that account. Placed AFTER the desktop/TTL reaps (an inert or
  // stale marker is cleared regardless of who is signed in) and BEFORE plan
  // classification (identity decides before eligibility). A marker WITHOUT a
  // userId is legacy/anonymous and flows through untouched.
  if (marker.userId !== undefined) {
    // Auth has not resolved yet — we cannot confirm the buyer is back. Keep the
    // marker and retry when a snapshot next changes (never clear on a settle).
    if (currentUserId === null) return { action: 'keep' };
    // A DIFFERENT account is signed in: this is someone else's purchase. Do NOT
    // mount (no cross-account onboarding) and do NOT clear (the buyer may sign
    // back in on this browser); the 7-day TTL reaps it if they never do.
    if (currentUserId !== marker.userId) return { action: 'none' };
  }

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

  return { action: 'mount', subscriptionKey };
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
  /** At least one enabled alert rule that produces a digest. */
  hasEnabledDigestRule: boolean;
  /** The user has tuned digestHour away from the default (their schedule). */
  hasTunedDigestHour: boolean;
  /** A web-push delivery channel already exists. */
  hasWebPushChannel: boolean;
  /** The user has already used a Pro power feature (custom widget / MCP). */
  hasUsedPowerFeature?: boolean;
}

function briefStep(config: ActivationExistingConfig): ActivationStep {
  // A brief is "already set up" only when an enabled digest rule AND a verified
  // channel to deliver it both exist. A rule with no verified channel is
  // undeliverable, so onboarding still offers to confirm delivery.
  const alreadyDone = config.hasEnabledDigestRule && config.hasVerifiedEmailChannel;
  if (alreadyDone) {
    return { id: 'brief', state: 'already-done', preservesSchedule: config.hasTunedDigestHour };
  }
  return { id: 'brief', state: 'confirmable' };
}

function alertsStep(caps: ActivationPlatformCapabilities, config: ActivationExistingConfig): ActivationStep {
  if (caps.pushPermission === 'denied') return { id: 'alerts', state: 'blocked' };
  if (config.hasWebPushChannel) return { id: 'alerts', state: 'already-done' };
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
  if (existing.hasEnabledDigestRule && existing.hasVerifiedEmailChannel) return null;
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

/** What actually happened to a step during the flow. */
export type ActivationStepOutcome = 'confirmed' | 'skipped' | 'done' | 'failed';

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
      return 'pending';
    case 'failed':
      return 'failed';
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

/** Versioned localStorage key for the finish-setup chip dismissal. */
export const FINISH_SETUP_CHIP_DISMISS_KEY = 'wm-pro-activation-chip-dismissed-v1';

/** How long a chip dismissal suppresses the finish-setup chip. */
export const FINISH_SETUP_CHIP_DISMISS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface FinishSetupChipDismissal {
  dismissedAt: number;
  /**
   * The Clerk user id the chip was dismissed under, when known. Scopes the
   * dismissal to one account so dismissing on user A's session does not
   * pre-suppress user B's chip on a shared browser (finding #13). Absent for
   * anonymous or legacy dismissals, which suppress for everyone.
   */
  userId?: string;
}

/** Build a chip-dismissal record; omit `userId` when no session is resolved. */
export function computeFinishSetupChipDismissal(
  userId: string | null | undefined,
  now: number,
): FinishSetupChipDismissal {
  const record: FinishSetupChipDismissal = { dismissedAt: now };
  if (userId) record.userId = userId;
  return record;
}

/**
 * Whether a chip dismissal still suppresses the chip for the current viewer.
 * TTL is the outer gate; identity refines it (finding #13):
 *   - no record, or past its TTL → NOT dismissed.
 *   - a legacy record (no `userId`) → dismissed for everyone (back-compat).
 *   - a scoped record + the SAME signed-in user → dismissed.
 *   - a scoped record + a DIFFERENT signed-in user → NOT dismissed (their chip
 *     is not bound by another account's dismissal).
 *   - a scoped record while auth is still settling (`currentUserId` null) →
 *     dismissed, so a fresh dismissal does not flash the chip pre-auth; it
 *     re-resolves once the user id loads and a mismatch reveals the chip.
 */
export function isChipDismissed(
  record: FinishSetupChipDismissal | null,
  currentUserId: string | null,
  now: number,
): boolean {
  if (record === null) return false;
  if (now - record.dismissedAt > FINISH_SETUP_CHIP_DISMISS_TTL_MS) return false;
  if (record.userId === undefined) return true; // legacy: suppress for all
  if (currentUserId === null) return true; // pre-auth: don't flash the chip
  return currentUserId === record.userId; // scoped: same account only
}

// ---------------------------------------------------------------------------
// Stored-record parsers. Raw string (from a caller's storage read) → validated
// record, or null for anything malformed or legacy so callers degrade to "no
// record" instead of throwing. Records are rebuilt field-by-field so junk keys
// never survive a parse. Storage I/O itself stays with callers — these take
// only strings, keeping the leaf import-free and node:test-testable.
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
  if (typeof obj.userId === 'string') marker.userId = obj.userId;
  return marker;
}

export function parseFireOnceRecord(raw: string | null): FireOnceRecord | null {
  const obj = parseJsonObject(raw);
  if (obj === null || typeof obj.subscriptionKey !== 'string' || typeof obj.shownAt !== 'number') {
    return null;
  }
  const record: FireOnceRecord = { subscriptionKey: obj.subscriptionKey, shownAt: obj.shownAt };
  if (typeof obj.userId === 'string') record.userId = obj.userId;
  return record;
}

export function parseChipDismissal(raw: string | null): FinishSetupChipDismissal | null {
  const obj = parseJsonObject(raw);
  if (obj === null || typeof obj.dismissedAt !== 'number') return null;
  const record: FinishSetupChipDismissal = { dismissedAt: obj.dismissedAt };
  if (typeof obj.userId === 'string') record.userId = obj.userId;
  return record;
}

/**
 * Whether to surface the persistent "finish setup" chip after the flow. Shows
 * when any step is left unfinished (skipped or failed) and the chip has not
 * been dismissed within its TTL; a fully completed flow (or a fresh dismissal)
 * shows nothing.
 */
export function shouldShowFinishSetupChip(
  results: readonly ActivationStepResult[],
  dismissal: FinishSetupChipDismissal | null,
  currentUserId: string | null,
  now: number,
): boolean {
  if (isChipDismissed(dismissal, currentUserId, now)) return false;
  return results.some((r) => r.outcome === 'skipped' || r.outcome === 'failed');
}

// ---------------------------------------------------------------------------
// Telemetry event selection (names only; wiring is a separate unit)
// ---------------------------------------------------------------------------

/** Stable kebab-case event names (mirrors the analytics.ts EVENTS catalog). */
export const ACTIVATION_EVENTS = {
  entered: 'pro-activation-entered',
  stepConfirmed: 'pro-activation-step-confirmed',
  stepSkipped: 'pro-activation-step-skipped',
  exit: 'pro-activation-exit',
} as const;

/**
 * The set of activation telemetry event names. This is the single naming
 * source: the analytics.ts EVENTS catalog and its `ProActivationEvent` union
 * mirror these literals, and the flow's `onEvent` hook is typed to it so a
 * rename here surfaces as a compile error at the analytics wiring site.
 */
export type ActivationEventName = (typeof ACTIVATION_EVENTS)[keyof typeof ACTIVATION_EVENTS];

/**
 * The per-step telemetry event for an outcome, or null when the outcome is not
 * a tracked user action: `done` (nothing to do, pre-configured) and `failed`
 * (surfaced via the exit summary, not a dedicated step event) both emit none.
 */
export function selectStepEvent(outcome: ActivationStepOutcome): string | null {
  switch (outcome) {
    case 'confirmed':
      return ACTIVATION_EVENTS.stepConfirmed;
    case 'skipped':
      return ACTIVATION_EVENTS.stepSkipped;
    case 'done':
    case 'failed':
      return null;
  }
}
