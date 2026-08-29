import type { AppContext, AppModule } from '@/app/app-context';
import { subscribeAuthState } from '@/services/auth-state';
import { getClerk } from '@/services/clerk';

/**
 * Eager shim that keeps the passkey offer OUT of the first-paint bundle.
 *
 * The offer cannot fire until someone signs in, and the overwhelming majority
 * of page loads never do — yet a static import pulled the controller, the
 * prompt component, and the passkey services into the `main` chunk, costing
 * ~12 KB on every first paint. This module is the small part that must be
 * eager; everything else loads on demand.
 *
 * Two things have to stay eager for the feature to remain correct:
 *
 *   1. **The arming observation.** The detector may only arm on an
 *      authoritative signed-out state (Clerk loaded, no session). If we waited
 *      for an idle callback to subscribe, a user who signs in quickly would be
 *      seen as already-signed-in with no prior signed-out observation, and
 *      would never be offered. Subscribing here costs one listener.
 *   2. **Nothing else.** The moment a signed-in transition arrives on an armed
 *      shim, the real controller is imported and takes over permanently.
 *
 * The handoff replays the transition: `subscribeAuthState` fires the callback
 * immediately on subscribe, so the controller sees the current session as soon
 * as it attaches and evaluates it the same way it would have live.
 */
export class PasskeyOfferBoot implements AppModule {
  private readonly ctx: AppContext;
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
    const clerk = getClerk() as { user?: { id?: string } | null } | null;
    // Clerk absent means the SDK has not loaded (or failed to). A user-null
    // reading then proves nothing about whether anyone is signed in, so it must
    // not arm — see the controller's own KTD3c note.
    if (!clerk) return;
    if (!clerk.user?.id) { this.armed = true; return; }
    // Signed in, and we saw them signed out first: this is a real sign-in, so
    // the offer is now plausible and the real controller is worth its bytes.
    if (this.armed) void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true;
    try {
      const { PasskeyOfferController } = await import('@/app/passkey-offer-controller');
      if (this.destroyed) return;
      // Stop shimming before the controller subscribes, so the two never race
      // on the same emission.
      this.unsubscribe?.();
      this.unsubscribe = null;
      const controller = new PasskeyOfferController(this.ctx, { preArmed: true });
      this.real = controller;
      controller.init();
    } catch {
      // A failed chunk fetch must not break the dashboard. The offer is a
      // nice-to-have; leave the shim disarmed rather than retrying forever.
    } finally {
      this.loading = false;
    }
  }
}
