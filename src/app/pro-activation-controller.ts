import type { AppContext, AppModule } from '@/app/app-context';
import type { ProActivationFlowOptions } from '@/components/ProActivationInterstitial';
import { trackProActivation } from '@/services/analytics';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import {
  getSubscription,
  onSubscriptionChange,
  type SubscriptionInfo,
} from '@/services/billing';
import {
  getEntitlementState,
  onEntitlementChange,
  type EntitlementState,
} from '@/services/entitlements';
import {
  computeFireOnceRecord,
  computeMountClaim,
  computePendingMarker,
  decideActivationMount,
  activationFlowRetryDelay,
  deriveActivationAccountKey,
  deriveSubscriptionKey,
  isFireOnceActive,
  isMountClaimBlocking,
  isProPlanKey,
  MOUNT_CLAIM_KEY,
  MOUNT_CLAIM_TTL_MS,
  parseMountClaim,
  parsePendingMarker,
  PENDING_MARKER_KEY,
  readScopedFireOnceRecord,
  writeScopedFireOnceRecord,
  type ActivationEntitlementSnapshot,
  type ActivationSubscriptionSnapshot,
  type FireOnceRecord,
  type MountClaimRecord,
  type PendingOnboardingMarker,
} from '@/services/pro-activation-state';

const MOUNT_CLAIM_SETTLE_MS = 75;
const MOUNT_CLAIM_RETRY_GRACE_MS = 25;

function readPendingMarker(): PendingOnboardingMarker | null {
  try {
    const raw = window.localStorage.getItem(PENDING_MARKER_KEY);
    const marker = parsePendingMarker(raw);
    if (marker && raw !== JSON.stringify(marker)) writePendingMarker(marker);
    return marker;
  } catch {
    return null;
  }
}

function writePendingMarker(marker: PendingOnboardingMarker): boolean {
  try {
    window.localStorage.setItem(PENDING_MARKER_KEY, JSON.stringify(marker));
    return true;
  } catch {
    return false;
  }
}

function clearPendingMarker(): void {
  try {
    window.localStorage.removeItem(PENDING_MARKER_KEY);
  } catch {
    // A stale marker is reaped by its TTL.
  }
}

function readMountClaim(): MountClaimRecord | null {
  try {
    return parseMountClaim(window.localStorage.getItem(MOUNT_CLAIM_KEY));
  } catch {
    return null;
  }
}

function writeMountClaim(record: MountClaimRecord): void {
  try {
    window.localStorage.setItem(MOUNT_CLAIM_KEY, JSON.stringify(record));
  } catch {
    // Storage-disabled browsers fall back to the in-tab latch.
  }
}

function clearMountClaim(): void {
  try {
    window.localStorage.removeItem(MOUNT_CLAIM_KEY);
  } catch {
    // The claim self-expires.
  }
}

function clearMountClaimIfOwned(nonce: string): void {
  if (readMountClaim()?.nonce === nonce) clearMountClaim();
}

function claimSettle(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, MOUNT_CLAIM_SETTLE_MS));
}

function generateMountClaimNonce(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through.
  }
  return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function toEntitlementSnapshot(
  state: EntitlementState | null,
): ActivationEntitlementSnapshot | null {
  if (state === null) return null;
  return { planKey: state.planKey, validUntil: state.validUntil };
}

function toSubscriptionSnapshot(
  subscription: SubscriptionInfo | null,
): ActivationSubscriptionSnapshot | null {
  if (subscription === null) return null;
  return {
    activationKey: subscription.activationKey ?? null,
    planKey: subscription.planKey,
    currentPeriodEnd: subscription.currentPeriodEnd,
    activationOnboardingEligible: subscription.activationOnboardingEligible ?? null,
  };
}

/** Write the durable checkout-return marker without persisting a Clerk user id. */
export function markProActivationPending(productId: string | null, now = Date.now()): void {
  const accountKey = deriveActivationAccountKey(getAuthState().user?.id);
  writePendingMarker(computePendingMarker(productId, accountKey, now));
}

export interface ProActivationControllerOptions {
  /** Checkout-return boot reloads immediately; evaluate only on the next boot. */
  reloadPending: boolean;
  /** Panel-owned surface opener that cannot be implemented outside the layout. */
  openAiAnalyst: () => void;
}

type ChipDecision = 'show' | 'wait' | 'hide';

/**
 * Owns the activation boot/storage/retry lifecycle. PanelLayoutManager only
 * creates, starts, and destroys this controller.
 */
export class ProActivationController implements AppModule {
  private resolved = false;
  private mounting = false;
  private retryArmed = false;
  private retryUnsubscribers: Array<() => void> = [];
  private mountIdleHandle: number | null = null;
  private mountTimeoutHandle: number | null = null;
  private claimRetryHandle: number | null = null;
  private flowRetryHandle: number | null = null;
  private flowRetryAttempts = 0;
  private authUnsubscribe: (() => void) | null = null;
  private authStateKey: string | null = null;
  private authGeneration = 0;
  private readonly mountNonce = generateMountClaimNonce();

  constructor(
    private readonly ctx: AppContext,
    private readonly options: ProActivationControllerOptions,
  ) {}

  init(): void {
    if (typeof window === 'undefined' || this.options.reloadPending) return;
    this.authStateKey = this.activationAuthStateKey();
    let initialAuthEmission = true;
    this.authUnsubscribe = subscribeAuthState(() => {
      const nextAuthStateKey = this.activationAuthStateKey();
      if (initialAuthEmission) {
        initialAuthEmission = false;
        this.authStateKey = nextAuthStateKey;
        return;
      }
      if (nextAuthStateKey === this.authStateKey) {
        if (!this.resolved && !this.mounting) queueMicrotask(() => void this.evaluate());
        return;
      }
      this.authStateKey = nextAuthStateKey;
      this.resetForAuthTransition();
    });

    const run = (): void => {
      this.mountIdleHandle = null;
      this.mountTimeoutHandle = null;
      if (!this.ctx.isDestroyed) void this.evaluate();
    };
    const idle = (window as typeof window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
    }).requestIdleCallback;
    if (typeof idle === 'function') this.mountIdleHandle = idle(run, { timeout: 2000 });
    else this.mountTimeoutHandle = window.setTimeout(run, 800);
  }

  destroy(): void {
    this.authGeneration += 1;
    this.authUnsubscribe?.();
    this.authUnsubscribe = null;
    this.teardownRetry();
    this.cancelScheduledMount();
    this.clearClaimRetry();
    this.clearFlowRetry();
  }

  private activationAuthStateKey(): string {
    const auth = getAuthState();
    if (auth.isPending) return 'pending';
    return deriveActivationAccountKey(auth.user?.id) ?? 'signed-out';
  }

  private resetForAuthTransition(): void {
    this.authGeneration += 1;
    this.resolved = false;
    this.teardownRetry();
    this.clearClaimRetry();
    this.clearFlowRetry();
    clearMountClaimIfOwned(this.mountNonce);
    queueMicrotask(() => {
      if (!this.ctx.isDestroyed) void this.evaluate();
    });
  }

  private async evaluate(): Promise<void> {
    if (this.resolved || this.mounting || this.ctx.isDestroyed) return;

    const now = Date.now();
    const auth = getAuthState();
    const currentAccountKey = deriveActivationAccountKey(auth.user?.id);
    let marker = readPendingMarker();
    if (marker && !marker.accountKey && currentAccountKey) {
      marker = { ...marker, accountKey: currentAccountKey };
      writePendingMarker(marker);
    }

    const entitlement = toEntitlementSnapshot(getEntitlementState());
    const subscription = toSubscriptionSnapshot(getSubscription());
    const currentSubscriptionKey = deriveSubscriptionKey(subscription);
    const fireOnce = readScopedFireOnceRecord(
      window.localStorage,
      currentAccountKey,
      currentSubscriptionKey,
      now,
    );
    const decision = decideActivationMount({
      marker,
      entitlement,
      subscription,
      fireOnce,
      isDesktop: this.ctx.isDesktopApp,
      authPending: auth.isPending,
      currentAccountKey,
      now,
    });

    switch (decision.action) {
      case 'mount':
        if (auth.user) {
          await this.mount(
            decision.subscriptionKey,
            auth.user.id,
            now,
            decision.onlyIfUnactivated,
          );
        }
        else this.armRetry();
        return;
      case 'clear':
        clearPendingMarker();
        this.finishWithChip(fireOnce, entitlement, subscription, auth.isPending, auth.user?.id ?? null, now);
        return;
      case 'none':
        this.finishWithChip(fireOnce, entitlement, subscription, auth.isPending, auth.user?.id ?? null, now);
        return;
      case 'keep':
        this.armRetry();
        return;
    }
  }

  private async mount(
    subscriptionKey: string,
    expectedUserId: string,
    now: number,
    onlyIfUnactivated: boolean,
  ): Promise<void> {
    const authGeneration = this.authGeneration;
    if (getAuthState().user?.id !== expectedUserId) {
      this.armRetry();
      return;
    }
    // Claim settlement awaits a timer. Hold a local single-flight latch before
    // that await so synchronous auth/subscription listener replays cannot start
    // a second mount attempt in this tab. The try/finally guarantees the latch
    // releases on every exit path, including an unexpected throw.
    this.mounting = true;
    try {
      const existingClaim = readMountClaim();
      if (isMountClaimBlocking(existingClaim, this.mountNonce, now)) {
        this.armRetry();
        this.scheduleClaimRetry(existingClaim, now);
        return;
      }

      writeMountClaim(computeMountClaim(this.mountNonce, now));
      await claimSettle();
      if (this.abortIfStale(authGeneration)) return;
      if (getAuthState().user?.id !== expectedUserId) {
        clearMountClaimIfOwned(this.mountNonce);
        this.armRetry();
        return;
      }

      const settledClaim = readMountClaim();
      const settledAt = Date.now();
      if (isMountClaimBlocking(settledClaim, this.mountNonce, settledAt)) {
        this.armRetry();
        this.scheduleClaimRetry(settledClaim, settledAt);
        return;
      }

      // This tab owns the cross-tab claim. A loser remains retryable when the
      // winner crashes and its lease expires.
      this.teardownRetry();
      this.clearClaimRetry();

      const openResult = await this.openFlow(
        expectedUserId,
        subscriptionKey,
        onlyIfUnactivated,
        () => !this.ctx.isDestroyed && authGeneration === this.authGeneration,
      );
      if (this.abortIfStale(authGeneration)) return;
      if (openResult === 'not-eligible') {
        this.resolved = true;
        this.clearFlowRetry();
        clearMountClaimIfOwned(this.mountNonce);
        return;
      }
      if (openResult !== 'opened') {
        clearMountClaimIfOwned(this.mountNonce);
        this.scheduleFlowRetry();
        return;
      }
      this.resolved = true;
      this.clearFlowRetry();

      // Never consume the pending marker unless durable fire-once persistence
      // succeeded. Storage failures can then retry on a later boot.
      const accountKey = deriveActivationAccountKey(expectedUserId);
      if (
        accountKey &&
        writeScopedFireOnceRecord(
          window.localStorage,
          accountKey,
          computeFireOnceRecord(subscriptionKey, now),
        )
      ) {
        clearPendingMarker();
      }
      clearMountClaimIfOwned(this.mountNonce);
    } finally {
      this.mounting = false;
    }
  }

  /**
   * True (and cleaned up) once this in-flight mount attempt is no longer
   * relevant — the tab was destroyed, or a newer auth generation (sign-out,
   * account switch) superseded it. Also releases the cross-tab claim and, for
   * a live tab, schedules a fresh evaluate() so the superseding attempt isn't
   * stranded waiting on a claim this attempt still held.
   */
  private abortIfStale(authGeneration: number): boolean {
    if (!this.ctx.isDestroyed && authGeneration === this.authGeneration) return false;
    clearMountClaimIfOwned(this.mountNonce);
    if (!this.ctx.isDestroyed) queueMicrotask(() => void this.evaluate());
    return true;
  }

  private finishWithChip(
    fireOnce: FireOnceRecord | null,
    entitlement: ActivationEntitlementSnapshot | null,
    subscription: ActivationSubscriptionSnapshot | null,
    authPending: boolean,
    userId: string | null,
    now: number,
  ): void {
    const decision = this.chipDecision(
      fireOnce,
      entitlement,
      subscription,
      authPending,
      userId,
      now,
    );
    if (decision === 'wait') {
      this.armRetry();
      return;
    }

    this.resolved = true;
    this.teardownRetry();
    this.clearClaimRetry();
    this.clearFlowRetry();
    if (decision !== 'show') return;

    const flowOptions = this.buildFlowOptions();
    if (!flowOptions) return;
    void import('@/components/ProActivationChip')
      .then((module) => module.maybeShowFinishSetupChip(flowOptions))
      .catch((error) => console.warn('[pro-activation] finish-setup chip failed to load', error));
  }

  private chipDecision(
    fireOnce: FireOnceRecord | null,
    entitlement: ActivationEntitlementSnapshot | null,
    subscription: ActivationSubscriptionSnapshot | null,
    authPending: boolean,
    userId: string | null,
    now: number,
  ): ChipDecision {
    if (this.ctx.isDesktopApp || !isFireOnceActive(fireOnce, now)) return 'hide';
    if (authPending || entitlement === null || subscription === null) return 'wait';
    if (userId === null) return 'hide';
    if (!isProPlanKey(entitlement.planKey) || entitlement.validUntil < now) return 'hide';
    const subscriptionKey = deriveSubscriptionKey(subscription);
    if (subscriptionKey === null) return 'wait';
    return subscriptionKey === fireOnce.subscriptionKey ? 'show' : 'hide';
  }

  private armRetry(): void {
    if (this.retryArmed || this.resolved) return;
    this.retryArmed = true;
    // Both listener services replay their current snapshot SYNCHRONOUSLY on
    // subscribe when state is already loaded. armRetry is only called right
    // after an evaluate() consumed that exact snapshot, so the replay is
    // always redundant — swallow the first invocation per registration or the
    // exhaustion fallback in scheduleFlowRetry() would instantly re-trigger
    // evaluate() and recreate the retry loop it was meant to stop.
    const skipSyncReplay = (cb: () => void): (() => void) => {
      let first = true;
      return () => {
        if (first) {
          first = false;
          return;
        }
        cb();
      };
    };
    const reEvaluate = (): void => {
      queueMicrotask(() => void this.evaluate());
    };
    this.retryUnsubscribers.push(onEntitlementChange(skipSyncReplay(reEvaluate)));
    this.retryUnsubscribers.push(onSubscriptionChange(skipSyncReplay(reEvaluate)));
  }

  private teardownRetry(): void {
    for (const unsubscribe of this.retryUnsubscribers) {
      try {
        unsubscribe();
      } catch {
        // Listener registry removal is best-effort during teardown.
      }
    }
    this.retryUnsubscribers = [];
    this.retryArmed = false;
  }

  private scheduleClaimRetry(claim: MountClaimRecord | null, now: number): void {
    this.clearClaimRetry();
    const remaining = claim
      ? Math.max(0, MOUNT_CLAIM_TTL_MS - (now - claim.claimedAt))
      : MOUNT_CLAIM_TTL_MS;
    this.claimRetryHandle = window.setTimeout(() => {
      this.claimRetryHandle = null;
      void this.evaluate();
    }, remaining + MOUNT_CLAIM_RETRY_GRACE_MS);
  }

  private clearClaimRetry(): void {
    if (this.claimRetryHandle === null) return;
    window.clearTimeout(this.claimRetryHandle);
    this.claimRetryHandle = null;
  }

  private scheduleFlowRetry(): void {
    this.teardownRetry();
    this.clearFlowRetry(false);
    const delay = activationFlowRetryDelay(this.flowRetryAttempts);
    if (delay === null) {
      // The bounded backoff schedule is exhausted. Stop hammering with a
      // timer, but stay unresolved and fall back to the same passive
      // entitlement/subscription listeners used elsewhere in this file, so an
      // external signal (e.g. the outage that caused the failures clearing)
      // can still retrigger evaluate() later in the session. A fresh trigger
      // gets its own full backoff schedule rather than an immediate re-give-up.
      this.flowRetryAttempts = 0;
      this.armRetry();
      return;
    }
    this.flowRetryAttempts += 1;
    this.flowRetryHandle = window.setTimeout(() => {
      this.flowRetryHandle = null;
      void this.evaluate();
    }, delay);
  }

  private clearFlowRetry(resetAttempts = true): void {
    if (this.flowRetryHandle !== null) {
      window.clearTimeout(this.flowRetryHandle);
      this.flowRetryHandle = null;
    }
    if (resetAttempts) this.flowRetryAttempts = 0;
  }

  private cancelScheduledMount(): void {
    if (this.mountIdleHandle !== null) {
      const cancelIdle = window.cancelIdleCallback as ((handle: number) => void) | undefined;
      cancelIdle?.(this.mountIdleHandle);
      this.mountIdleHandle = null;
    }
    if (this.mountTimeoutHandle !== null) {
      window.clearTimeout(this.mountTimeoutHandle);
      this.mountTimeoutHandle = null;
    }
  }

  private async openFlow(
    expectedUserId: string,
    subscriptionKey: string,
    onlyIfUnactivated: boolean,
    isStillValid: () => boolean,
  ): Promise<'opened' | 'not-eligible' | 'retry'> {
    const flowOptions = this.buildFlowOptions(expectedUserId);
    if (!flowOptions) return 'retry';
    try {
      const module = await import('@/components/ProActivationInterstitial');
      const result = await module.openProActivationFlow({
        ...flowOptions,
        onlyIfUnactivated,
        expectedActivationKey: onlyIfUnactivated ? subscriptionKey : undefined,
        activationClaimNonce: onlyIfUnactivated ? this.mountNonce : undefined,
      });
      // The interstitial may already be rendered by this point (opened
      // synchronously inside openProActivationFlow before it resolves). If
      // this tab was destroyed or superseded while that was in flight, close
      // it rather than leaving an orphaned overlay wired to a dead context.
      if (!isStillValid()) {
        module.closeProActivationInterstitial();
        return 'retry';
      }
      return result;
    } catch (error) {
      console.warn('[pro-activation] failed to open activation flow', error);
      return 'retry';
    }
  }

  private buildFlowOptions(expectedUserId?: string): ProActivationFlowOptions | null {
    const user = getAuthState().user;
    if (!user || (expectedUserId && user.id !== expectedUserId)) return null;
    const ctx = this.ctx;
    return {
      accountUserId: user.id,
      accountEmail: user.email,
      openApiKeys: () => ctx.unifiedSettings?.open('api-keys'),
      openChannelSettings: () => ctx.unifiedSettings?.open('notifications'),
      openWidgetBuilder: () =>
        ctx.container.dispatchEvent(new CustomEvent('wm:open-widget-creator', { detail: {} })),
      openAiAnalyst: this.options.openAiAnalyst,
      onEvent: (event, stepId, exit) =>
        trackProActivation(event, {
          planKey: getEntitlementState()?.planKey ?? null,
          step: stepId,
          completion: exit?.completion,
          verified: exit?.verified,
          pending: exit?.pending,
          failed: exit?.failed,
          total: exit?.total,
        }),
    };
  }
}
