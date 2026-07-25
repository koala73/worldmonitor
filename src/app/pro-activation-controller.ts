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
  deriveActivationAccountKey,
  deriveSubscriptionKey,
  FIRE_ONCE_KEY,
  isFireOnceActive,
  isMountClaimBlocking,
  isProPlanKey,
  MOUNT_CLAIM_KEY,
  MOUNT_CLAIM_TTL_MS,
  parseFireOnceRecord,
  parseMountClaim,
  parsePendingMarker,
  PENDING_MARKER_KEY,
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

function readFireOnceRecord(now: number): FireOnceRecord | null {
  try {
    const raw = window.localStorage.getItem(FIRE_ONCE_KEY);
    const record = parseFireOnceRecord(raw);
    if (record && !isFireOnceActive(record, now)) {
      window.localStorage.removeItem(FIRE_ONCE_KEY);
      return null;
    }
    if (record && raw !== JSON.stringify(record)) writeFireOnceRecord(record);
    return record;
  } catch {
    return null;
  }
}

function writeFireOnceRecord(record: FireOnceRecord): boolean {
  try {
    window.localStorage.setItem(FIRE_ONCE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

function clearFireOnceRecord(): void {
  try {
    window.localStorage.removeItem(FIRE_ONCE_KEY);
  } catch {
    // Best-effort privacy cleanup for signed-out/expired records.
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
  return { activationKey: subscription.activationKey ?? null };
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
  private readonly mountNonce = generateMountClaimNonce();

  constructor(
    private readonly ctx: AppContext,
    private readonly options: ProActivationControllerOptions,
  ) {}

  init(): void {
    if (typeof window === 'undefined' || this.options.reloadPending) return;
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
    this.teardownRetry();
    this.cancelScheduledMount();
    this.clearClaimRetry();
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

    let fireOnce = readFireOnceRecord(now);
    if (!auth.isPending && auth.user === null && fireOnce) {
      clearFireOnceRecord();
      fireOnce = null;
    }

    const entitlement = toEntitlementSnapshot(getEntitlementState());
    const subscription = toSubscriptionSnapshot(getSubscription());
    const decision = decideActivationMount({
      marker,
      entitlement,
      subscription,
      fireOnce,
      isDesktop: this.ctx.isDesktopApp,
      currentAccountKey,
      now,
    });

    switch (decision.action) {
      case 'mount':
        if (auth.user) await this.mount(decision.subscriptionKey, auth.user.id, now);
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

  private async mount(subscriptionKey: string, expectedUserId: string, now: number): Promise<void> {
    if (getAuthState().user?.id !== expectedUserId) {
      this.armRetry();
      return;
    }
    const existingClaim = readMountClaim();
    if (isMountClaimBlocking(existingClaim, this.mountNonce, now)) {
      this.armRetry();
      this.scheduleClaimRetry(existingClaim, now);
      return;
    }

    writeMountClaim(computeMountClaim(this.mountNonce, now));
    await claimSettle();
    if (this.ctx.isDestroyed) return;
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

    // Mark the open attempt in-flight only after this tab owns the claim. A
    // loser remains retryable when the winning tab crashes and its lease
    // expires, while subscription/auth callbacks cannot double-open this tab.
    this.mounting = true;
    this.teardownRetry();
    this.clearClaimRetry();

    if (!(await this.openFlow(expectedUserId))) {
      this.mounting = false;
      clearMountClaimIfOwned(this.mountNonce);
      this.armRetry();
      return;
    }
    this.mounting = false;
    this.resolved = true;

    // Never consume the pending marker unless durable fire-once persistence
    // succeeded. Storage failures can then retry on a later boot.
    if (writeFireOnceRecord(computeFireOnceRecord(subscriptionKey, now))) {
      clearPendingMarker();
    }
    clearMountClaimIfOwned(this.mountNonce);
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
    const reEvaluate = (): void => {
      queueMicrotask(() => void this.evaluate());
    };
    this.retryUnsubscribers.push(onEntitlementChange(reEvaluate));
    this.retryUnsubscribers.push(onSubscriptionChange(reEvaluate));
    this.retryUnsubscribers.push(subscribeAuthState(reEvaluate));
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

  private async openFlow(expectedUserId: string): Promise<boolean> {
    const flowOptions = this.buildFlowOptions(expectedUserId);
    if (!flowOptions) return false;
    try {
      const module = await import('@/components/ProActivationInterstitial');
      return await module.openProActivationFlow(flowOptions);
    } catch (error) {
      console.warn('[pro-activation] failed to open activation flow', error);
      return false;
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
