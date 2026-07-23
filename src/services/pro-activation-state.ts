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
 * under `tsx --test` (no jsdom, no Vite globals) and both services and
 * components import it. It COMPUTES records and decisions from explicit
 * snapshot inputs — callers perform every storage read/write (localStorage
 * lives in the panel-layout/UI units, never here).
 *
 * Plan identity is an allowlist against the two Pro product ids
 * (config/products.generated.ts DODO_PRODUCTS.PRO_MONTHLY / PRO_ANNUAL) and
 * the two Pro plan keys (convex/config/productCatalog.ts). The constants are
 * mirrored here to keep the leaf import-free; tests/pro-activation-state.test.mts
 * asserts PRO_PRODUCT_IDS against the generated catalog so drift goes red.
 */

// ---------------------------------------------------------------------------
// Plan-identity allowlists (kept in sync by the drift-guard test)
// ---------------------------------------------------------------------------

/**
 * The only two product ids that grant Pro. Mirrors
 * `DODO_PRODUCTS.PRO_MONTHLY` / `PRO_ANNUAL`. Anything else — api_starter,
 * api_starter_annual, api_business, enterprise, or an unknown id — is non-Pro
 * and must never trigger onboarding.
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
  /** Epoch ms the marker was written. */
  createdAt: number;
}

/** Build a marker record; omit `productId` entirely when the plan is unknown. */
export function computePendingMarker(
  productId: string | null | undefined,
  now: number,
): PendingOnboardingMarker {
  return productId ? { productId, createdAt: now } : { createdAt: now };
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
  /** Epoch ms the interstitial was shown. */
  shownAt: number;
}

/** Build a fire-once record for a subscription identity. */
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
  const { marker, entitlement, subscription, fireOnce, isDesktop, now } = input;

  if (marker === null) return { action: 'none' };
  if (isDesktop) return { action: 'clear' }; // web-only (R12); reap the inert marker
  if (isPendingMarkerExpired(marker, now)) return { action: 'clear' };

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
  readonly digestMode: 'daily';
  readonly digestHour: number;
  readonly digestTimezone: string;
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
}

/** Build a chip-dismissal record. */
export function computeFinishSetupChipDismissal(now: number): FinishSetupChipDismissal {
  return { dismissedAt: now };
}

/** True when a chip dismissal exists and is still within its TTL. */
export function isChipDismissed(record: FinishSetupChipDismissal | null, now: number): boolean {
  return record !== null && now - record.dismissedAt <= FINISH_SETUP_CHIP_DISMISS_TTL_MS;
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
  now: number,
): boolean {
  if (isChipDismissed(dismissal, now)) return false;
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
