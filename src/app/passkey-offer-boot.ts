import type { AppContext, AppModule } from '@/app/app-context';
import { subscribeAuthState } from '@/services/auth-state';
import { getClerk } from '@/services/clerk';
import {
  accountOfferCapReached,
  createOfferMemory,
  derivePasskeyAccountKey,
  hasBeenOffered,
  type OfferMemory,
  type OfferStorage,
  safeLocalStorage,
} from '@/services/passkey-offer-state';
import { recordPasskeyOfferReason } from '@/utils/passkey-offer-trace';

/**
 * Eager shim that keeps the passkey offer OUT of the first-paint bundle.
 *
 * A static import pulled the controller, the prompt component, and the passkey
 * services into the `main` chunk, costing ~12 KB on every first paint. This
 * module is the small part that must be eager; everything else loads on demand.
 *
 * It also owns the reach decision, because that decision is what determines
 * whether the chunk is worth fetching at all.
 */

// ---------------------------------------------------------------------------
// The load decision (pure, testable)
// ---------------------------------------------------------------------------

/** Everything the decision reads, resolved by the caller. */
export interface BootDecisionInput {
  /** Has the Clerk SDK loaded? A user-null reading is meaningless without it. */
  clerkLoaded: boolean;
  accountKey: string | null;
  /** An authoritative signed-out state was seen earlier this page life. */
  armed: boolean;
  /** Offered on THIS device before. Local, origin-scoped, best effort. */
  offeredLocally: boolean;
  /** Lifetime account cap spent. Durable, server-backed, the nag backstop. */
  capReached: boolean;
}

/**
 * What the shim does with one auth emission.
 *
 * The two `load-*` members differ only in how the user arrived; both hand off
 * to the same controller. Keeping them distinct is what makes the trace able to
 * answer "was this a fresh sign-in or a returning session?" without a second
 * signal.
 */
export type BootDecision =
  | 'clerk-absent'
  | 'signed-out-observed'
  | 'already-offered'
  | 'offer-cap-reached'
  | 'load-sign-in'
  | 'load-returning-session';

/** Whether a decision means "fetch the controller chunk". */
export function decisionLoads(decision: BootDecision): boolean {
  return decision === 'load-sign-in' || decision === 'load-returning-session';
}

/**
 * Decide from injected facts alone.
 *
 * Ordering is behavioural. Both suppressions run BEFORE either load branch, so
 * someone who will not be offered never pays for the dynamic import. That keeps
 * the first-paint saving intact even though returning sessions are eligible.
 *
 * The device record is checked before the cap because it is the primary
 * suppression and the common answer; the cap is the backstop for a browser that
 * cannot keep a device record at all.
 *
 * Note what is NOT here: the account's passkey count. An account-wide count
 * says nothing about whether a credential is usable on THIS browser, and gating
 * on it left people with a Mac passkey unable to be offered one on Windows.
 */
export function decideBootAction(input: BootDecisionInput): BootDecision {
  // A user-null reading while the SDK is absent proves nothing about whether
  // anyone is signed in, so it must not arm.
  if (!input.clerkLoaded) return 'clerk-absent';
  if (input.accountKey === null) return 'signed-out-observed';
  if (input.offeredLocally) return 'already-offered';
  if (input.capReached) return 'offer-cap-reached';
  return input.armed ? 'load-sign-in' : 'load-returning-session';
}

// ---------------------------------------------------------------------------
// The shim
// ---------------------------------------------------------------------------

/** A Clerk user, read through the narrow slice this shim needs. */
type ShimUser = {
  id?: string;
  unsafeMetadata?: Record<string, unknown> | null;
} | null;

export class PasskeyOfferBoot implements AppModule {
  private readonly ctx: AppContext;
  private readonly storage: OfferStorage | null = safeLocalStorage();
  private readonly memory: OfferMemory = createOfferMemory();
  private unsubscribe: (() => void) | null = null;
  /** An authoritative signed-out state has been observed this page life. */
  private armed = false;
  private loading = false;
  private destroyed = false;
  private real: AppModule | null = null;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  init(): void {
    // Eagerly, not on idle: a user who signs in quickly would otherwise be seen
    // as already-signed-in with no prior signed-out observation. That still
    // yields an offer now, but it would be recorded as a returning session and
    // arrive a beat later than the sign-in it belongs to.
    this.unsubscribe = subscribeAuthState(() => this.onAuthChange());
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.real?.destroy();
    this.real = null;
  }

  private onAuthChange(): void {
    if (this.real || this.loading || this.destroyed) return;
    const user = (getClerk() as { user?: ShimUser } | null)?.user ?? null;
    const accountKey = derivePasskeyAccountKey(user?.id ?? null);

    const decision = decideBootAction({
      clerkLoaded: getClerk() !== null,
      accountKey,
      armed: this.armed,
      // NOT gated on a non-null handle: when localStorage throws on access
      // `storage` is null, and gating here would discard the in-memory tier.
      offeredLocally: hasBeenOffered(this.storage, this.memory, accountKey),
      capReached: accountOfferCapReached(user),
    });

    recordPasskeyOfferReason(decision);
    if (decision === 'signed-out-observed') this.armed = true;
    if (decisionLoads(decision)) void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true;
    recordPasskeyOfferReason('import-started');
    try {
      const { PasskeyOfferController } = await import('@/app/passkey-offer-controller');
      if (this.destroyed) return;
      // Stop shimming before the controller subscribes, so the two never race
      // on the same emission.
      this.unsubscribe?.();
      this.unsubscribe = null;
      // The shim already ran every gate the controller's arming guard exists to
      // enforce, so re-deriving it there would drop the very offer this handoff
      // delivers.
      const controller = new PasskeyOfferController(this.ctx, { preArmed: true });
      this.real = controller;
      controller.init();
    } catch {
      // A failed chunk fetch must not break the dashboard. The offer is a
      // nice-to-have; leave the shim disarmed rather than retrying forever.
      recordPasskeyOfferReason('import-failed');
    } finally {
      this.loading = false;
    }
  }
}
