import type { AppContext, AppModule } from '@/app/app-context';
import { PasskeyOfferPrompt } from '@/components/PasskeyOfferPrompt';
import {
  trackPasskeyOfferAccepted,
  trackPasskeyOfferCreated,
  trackPasskeyOfferDismissed,
  trackPasskeyOfferFailed,
  trackPasskeyOfferShown,
} from '@/services/analytics';
import { subscribeAuthState } from '@/services/auth-state';
import { getClerk } from '@/services/clerk';
import {
  type AccountOfferReader,
  accountOfferCapReached,
  createOfferMemory,
  derivePasskeyAccountKey,
  hasBeenOffered,
  type OfferMemory,
  type OfferStorage,
  recordOffered,
  safeLocalStorage,
  shouldOfferPasskey,
} from '@/services/passkey-offer-state';
import {
  type AccountOfferReservation,
  reserveAccountOffer,
} from '@/services/passkey-offer-reservation';
import {
  createPasskey,
  hasPlatformAuthenticator,
  isPasskeyEnvironmentEligible,
  isPasskeySessionReady,
  type PasskeyOutcome,
  readPasskeyEnvironmentFacts,
  readPasskeySessionFacts,
} from '@/services/passkeys';
import { isModalOpen } from '@/utils/open-modal';
import { recordPasskeyOfferReason } from '@/utils/passkey-offer-trace';

/**
 * Drives the post-sign-in passkey offer.
 *
 * Owns the four things the leaf services deliberately do not: deciding that a
 * sign-in actually happened, keeping overlay arbitration live, cancelling stale
 * work across account switches, and emitting the funnel.
 *
 * The gate sequence lives in `evaluatePasskeyOffer` below — a pure-ish function
 * over injected effects, so the ordering and the cancellation rules are
 * testable without a browser, a Clerk instance, or a real clock.
 */

// ---------------------------------------------------------------------------
// The captured identity tuple
// ---------------------------------------------------------------------------

/**
 * What "still the same situation" means across an await.
 *
 * An account key alone is not enough: the SAME account can gain a
 * `currentTask`, lose `isSignedIn`, or be issued a different session, and each
 * makes the offer inappropriate while the identity is unchanged. The session id
 * is what distinguishes two sessions for one account — the Pro activation
 * precedent derives its key from pending-state plus account identity and
 * cannot.
 */
export interface PasskeyIdentity {
  accountKey: string | null;
  sessionId: string | null;
  ready: boolean;
}

/** Two identities match when account, session, and readiness all agree. */
export function identityMatches(a: PasskeyIdentity, b: PasskeyIdentity): boolean {
  return a.accountKey === b.accountKey && a.sessionId === b.sessionId && a.ready === b.ready;
}

// ---------------------------------------------------------------------------
// The gate sequence (testable core)
// ---------------------------------------------------------------------------

/** Every effect the evaluation needs, injected so the ordering is testable. */
export interface PasskeyEvaluationDeps {
  /** Has an authoritative signed-out state been observed this page life? */
  armed: () => boolean;
  readEnvironment: () => { isDesktopApp: boolean; inIframe: boolean; hasPublicKeyCredential: boolean };
  readIdentity: () => PasskeyIdentity;
  /** Offered on THIS device before. */
  alreadyOffered: (accountKey: string | null) => boolean;
  /** Lifetime account cap spent. */
  capReached: () => boolean;
  /** Async, and deliberately last among the capability checks. */
  platformAuthenticator: () => Promise<boolean>;
  blockedByOverlay: () => boolean;
  /** Defer one frame so Clerk's sign-in modal finishes unmounting. */
  deferFrame: () => Promise<void>;
  /** Claim this evaluation. Returns false when another already won. */
  claim: () => boolean;
  /** Atomically reserve one of the account's lifetime offer slots. */
  reserveAccountOffer: () => Promise<AccountOfferReservation>;
  /** Whether the controller that started this work is still alive. */
  stillActive: () => boolean;
  mount: (identity: PasskeyIdentity, hiddenByOverlay: boolean) => void;
}

/** Why an evaluation did not mount. `mounted` is the only success. */
export type PasskeyEvaluationResult =
  | 'mounted'
  | 'not-armed'
  | 'not-ready'
  | 'ineligible-environment'
  | 'already-offered'
  | 'offer-cap-reached'
  | 'offer-reservation-unavailable'
  | 'no-platform-authenticator'
  | 'blocked-by-overlay'
  | 'superseded';

/**
 * Run the gates in order and mount when they all pass.
 *
 * Ordering is behavioural, not cosmetic. Every synchronous gate runs before the
 * async platform-authenticator probe, so the common ineligible paths never
 * touch it — AE5 asserts that a desktop environment never probes at all.
 *
 * `superseded` is the cancellation path: the identity changed across an await,
 * or another evaluation claimed the mount first. It is distinct from every
 * other result because it must leave the ledger untouched — a yielded or
 * cancelled offer has not been spent.
 */
export async function evaluatePasskeyOffer(deps: PasskeyEvaluationDeps): Promise<PasskeyEvaluationResult> {
  if (!deps.armed()) return 'not-armed';

  const identity = deps.readIdentity();
  if (!identity.ready || identity.accountKey === null) return 'not-ready';

  const env = deps.readEnvironment();
  if (!isPasskeyEnvironmentEligible(env)) return 'ineligible-environment';

  const offeredHere = deps.alreadyOffered(identity.accountKey);
  if (!shouldOfferPasskey({
    environmentEligible: true,
    sessionReady: true,
    alreadyOffered: offeredHere,
    capReached: deps.capReached(),
  })) {
    return offeredHere ? 'already-offered' : 'offer-cap-reached';
  }

  // Overlay check BEFORE the frame defer, and again after — an overlay can open
  // inside the deferred frame itself.
  if (deps.blockedByOverlay()) return 'blocked-by-overlay';

  if (!await deps.platformAuthenticator()) return 'no-platform-authenticator';
  if (!identityMatches(deps.readIdentity(), identity)) return 'superseded';

  await deps.deferFrame();
  if (!identityMatches(deps.readIdentity(), identity)) return 'superseded';
  if (deps.blockedByOverlay()) return 'blocked-by-overlay';

  // Re-read both suppression tiers. A sibling tab can write the device ledger,
  // and a sibling device can update Clerk's terminal cap mirror during either
  // async boundary above.
  if (deps.alreadyOffered(identity.accountKey)) return 'already-offered';
  if (deps.capReached()) return 'offer-cap-reached';

  // Single-flight. Clerk can emit twice for one session during a deferred
  // probe; without this, two emissions produce two mounts, two ledger writes,
  // and two `shown` events.
  if (!deps.claim()) return 'superseded';

  const reservation = await deps.reserveAccountOffer();
  if (reservation === 'cap-reached') return 'offer-cap-reached';
  if (reservation === 'unavailable') return 'offer-reservation-unavailable';
  if (!deps.stillActive()) return 'superseded';

  // The reservation belongs to the authenticated account at request time. Do
  // not mount if this page moved to another identity while the request ran.
  if (!identityMatches(deps.readIdentity(), identity)) return 'superseded';

  deps.mount(identity, deps.blockedByOverlay());
  return 'mounted';
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

const BROADCAST_CHANNEL = 'wm-passkey-offer';
/** How long the success confirmation stays before the card leaves. */
const SUCCESS_LINGER_MS = 2600;

export interface PasskeyOfferControllerOptions {
  storage?: OfferStorage;
  /**
   * The eager boot shim already observed an authoritative signed-out state and
   * handed off on a real sign-in, so re-deriving it here would lose the arming
   * and drop the very offer the handoff exists to deliver.
   */
  preArmed?: boolean;
  /** Injected in tests; production uses rAF. */
  scheduleFrame?: (cb: () => void) => void;
}

export class PasskeyOfferController implements AppModule {
  private readonly ctx: AppContext;
  private readonly storage: OfferStorage | null;
  private readonly memory: OfferMemory = createOfferMemory();
  private readonly scheduleFrame: (cb: () => void) => void;

  private unsubscribeAuth: (() => void) | null = null;
  private observer: MutationObserver | null = null;
  private channel: BroadcastChannel | null = null;
  /** Measures the cached-mode banner so the card can sit above it. */
  private bannerResizeObserver: ResizeObserver | null = null;
  private observedBanner: Element | null = null;

  /**
   * Whether this controller may evaluate at all.
   *
   * It no longer means "a sign-in transition happened". The boot shim decides
   * reach now, and it hands off for a returning session too, so it constructs
   * this controller `preArmed`. What remains here is the guard for a controller
   * constructed directly: an authoritative signed-out state, where "signed out"
   * must be vouched for by the SDK, because a failed Clerk load deliberately
   * publishes `{user: null, isPending: false}` — byte-identical to a real
   * signed-out session — while keeping subscribers queued for a retry.
   *
   * Repeat suppression does NOT rest on this flag. It rests on the three ledger
   * tiers, the durable one of which is account-scoped and server-backed.
   */
  private armed: boolean;
  private prompt: PasskeyOfferPrompt | null = null;
  private mountedIdentity: PasskeyIdentity | null = null;
  private acceptedThisMount = false;
  private evaluationEpoch = 0;
  private claimedEpoch = -1;
  private destroyed = false;
  private successTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set when an outcome resolves while the card is hidden behind an overlay. */
  private pendingOutcome: PasskeyOutcome | null = null;
  /**
   * An evaluation that an overlay blocked BEFORE it could mount.
   *
   * Without this the feature is dead for the common case: Clerk's own sign-in
   * modal matches the shared modal predicate (`.cl-modalBackdrop`), and the
   * auth emission arrives while it is still on screen. The evaluation returns
   * `blocked-by-overlay`, and nothing else ever re-triggers — the auth listener
   * will not fire again for that session, and the overlay observer used to bail
   * out whenever no prompt was mounted. An eligible user signed in and was
   * simply never offered.
   */
  private evaluationDeferredByOverlay = false;

  constructor(ctx: AppContext, options: PasskeyOfferControllerOptions = {}) {
    this.ctx = ctx;
    this.storage = options.storage ?? safeLocalStorage();
    this.scheduleFrame = options.scheduleFrame
      ?? ((cb) => { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cb); else setTimeout(cb, 16); });
    this.armed = options.preArmed === true;
  }

  init(): void {
    this.destroyed = false;
    this.unsubscribeAuth = subscribeAuthState(() => { void this.onAuthChange(); });
    this.observeOverlays();
    this.syncBannerHeight();
    this.openChannel();
  }

  destroy(): void {
    this.destroyed = true;
    this.evaluationEpoch += 1;
    this.unsubscribeAuth?.();
    this.unsubscribeAuth = null;
    this.observer?.disconnect();
    this.observer = null;
    this.bannerResizeObserver?.disconnect();
    this.bannerResizeObserver = null;
    this.observedBanner = null;
    this.setBannerHeight(0);
    try { this.channel?.close(); } catch { /* already closed, or unsupported */ }
    this.channel = null;
    if (this.successTimer !== null) clearTimeout(this.successTimer);
    this.successTimer = null;
    this.teardownPrompt();
  }

  // -- auth -----------------------------------------------------------------

  private async onAuthChange(): Promise<void> {
    if (this.destroyed) return;
    const identity = this.readIdentity();

    // Arm only on a signed-out state the SDK itself vouches for.
    if (isClerkLoaded() && identity.accountKey === null) {
      this.armed = true;
      this.teardownPrompt();
      return;
    }

    // A mounted prompt belongs to one identity. When it changes, tear the card
    // down but leave the ledger record and already-emitted events alone — they
    // were true when they happened, and the mount already spent the offer.
    if (this.mountedIdentity && !identityMatches(identity, this.mountedIdentity)) {
      this.teardownPrompt();
    }
    if (this.prompt) return;

    this.evaluationEpoch += 1;
    const epoch = this.evaluationEpoch;
    const result = await evaluatePasskeyOffer({
      armed: () => this.armed,
      readEnvironment: () => readPasskeyEnvironmentFacts(this.ctx.isDesktopApp),
      readIdentity: () => this.readIdentity(),
      // NOT gated on a non-null handle: when localStorage throws on access
      // `storage` is null, and gating here would discard the in-memory tier
      // that is the entire fallback (KTD3d).
      alreadyOffered: (key) => hasBeenOffered(this.storage, this.memory, key),
      // Re-read at evaluation time rather than at construction: a sibling
      // device may have spent the cap after this page loaded.
      capReached: () => accountOfferCapReached(getClerk()?.user as AccountOfferReader | null),
      platformAuthenticator: () => hasPlatformAuthenticator(),
      blockedByOverlay: () => this.blockedByOverlay(),
      deferFrame: () => new Promise<void>((resolve) => this.scheduleFrame(() => resolve())),
      claim: () => {
        if (epoch !== this.evaluationEpoch || this.claimedEpoch !== -1) return false;
        this.claimedEpoch = epoch;
        return true;
      },
      reserveAccountOffer: () => reserveAccountOffer(),
      stillActive: () => !this.destroyed,
      mount: (id, hiddenByOverlay) => this.mountPrompt(id, hiddenByOverlay),
    });
    const ownedClaim = this.claimedEpoch === epoch;
    if (ownedClaim) this.claimedEpoch = -1;
    // Every result is a member of the closed trace vocabulary, so the gate that
    // stopped the offer is recoverable in one console read instead of inferred
    // from a later snapshot.
    recordPasskeyOfferReason(result);
    // Come back when the overlay goes away. Every other non-mount result is
    // genuinely terminal for this emission.
    this.evaluationDeferredByOverlay = result === 'blocked-by-overlay';
    if (
      ownedClaim
      && epoch !== this.evaluationEpoch
      && !this.destroyed
      && !this.prompt
      && !identityMatches(this.readIdentity(), identity)
    ) {
      void this.onAuthChange();
    }
  }

  private readIdentity(): PasskeyIdentity {
    const facts = readPasskeySessionFacts();
    const clerk = getClerk() as unknown as { user?: { id?: string } | null; session?: { id?: string } | null } | null;
    return {
      accountKey: derivePasskeyAccountKey(clerk?.user?.id ?? null),
      sessionId: clerk?.session?.id ?? null,
      ready: isPasskeySessionReady(facts),
    };
  }

  // -- prompt lifecycle -----------------------------------------------------

  private mountPrompt(identity: PasskeyIdentity, hiddenByOverlay: boolean): void {
    const prompt = new PasskeyOfferPrompt({
      onAccept: () => { void this.onAccept(); },
      onDismiss: () => this.onDismiss(),
    });
    this.prompt = prompt;
    this.mountedIdentity = identity;
    this.acceptedThisMount = false;
    document.body.appendChild(prompt.getElement());
    if (hiddenByOverlay) prompt.hide();
    prompt.announceOnMount();

    // The account slot was reserved before mount. Record the device at MOUNT,
    // not at answer, so closing the tab with the card open does not re-offer.
    recordOffered(this.storage, this.memory, identity.accountKey);
    this.broadcastMounted(identity.accountKey);
    trackPasskeyOfferShown();
  }

  private teardownPrompt(): void {
    if (this.successTimer !== null) { clearTimeout(this.successTimer); this.successTimer = null; }
    this.prompt?.destroy();
    this.prompt = null;
    this.mountedIdentity = null;
    this.acceptedThisMount = false;
    this.pendingOutcome = null;
    this.evaluationDeferredByOverlay = false;
  }

  private async onAccept(): Promise<void> {
    const prompt = this.prompt;
    const expected = this.mountedIdentity;
    if (!prompt || !expected) return;

    // Once per mounted offer, not once per tap: a retry after a cancelled
    // ceremony must not read as a second accept against one creation.
    if (!this.acceptedThisMount) {
      this.acceptedThisMount = true;
      trackPasskeyOfferAccepted();
    }
    prompt.setState('busy');

    // Revalidate immediately before the credential write — a mismatch here
    // would create a passkey on the wrong account.
    if (!identityMatches(this.readIdentity(), expected)) { this.teardownPrompt(); return; }

    const outcome = await createPasskey();

    // And again after it settles: a long ceremony can outlive its session.
    if (this.prompt !== prompt) return;
    if (!identityMatches(this.readIdentity(), expected)) { this.teardownPrompt(); return; }

    this.applyOutcome(outcome);
  }

  /** Route an outcome, holding it if the card is hidden behind an overlay. */
  private applyOutcome(outcome: PasskeyOutcome): void {
    const prompt = this.prompt;
    if (!prompt) return;
    if (this.isHidden()) { this.pendingOutcome = outcome; return; }
    this.pendingOutcome = null;

    if (outcome === 'created') {
      prompt.setState('succeeded');
      trackPasskeyOfferCreated();
      // Announce, then leave — the confirmation is the point of this state.
      this.successTimer = setTimeout(() => { this.successTimer = null; this.teardownPrompt(); }, SUCCESS_LINGER_MS);
      return;
    }
    if (outcome === 'failed') {
      prompt.setState('failed');
      // Coarse, closed vocabulary — never a raw Clerk string, which can carry
      // account detail. Only the `failed` class reaches here (KTD5).
      trackPasskeyOfferFailed('device-unsupported');
      return;
    }
    // Retryable emits nothing: the user is still deciding, not done.
    prompt.setState('retryable');
  }

  private onDismiss(): void {
    // A terminal failure already reported itself. Emitting `dismissed` here too
    // would inflate the dismissal guardrail with our own bugs.
    if (this.prompt?.getState() !== 'failed') trackPasskeyOfferDismissed();
    this.teardownPrompt();
  }

  // -- overlay arbitration --------------------------------------------------

  private observeOverlays(): void {
    if (typeof MutationObserver !== 'function' || typeof document === 'undefined') return;
    this.observer = new MutationObserver(() => {
      this.syncOverlayState();
      // App.ts creates, removes, and RECREATES the cached-mode banner, so its
      // element identity changes; re-bind on every mutation batch.
      this.syncBannerHeight();
    });
    // `childList` alone misses Settings, which opens by toggling a class on an
    // already-connected node. The attribute filter keeps a subtree observer cheap.
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    });
  }

  private blockedByOverlay(): boolean {
    if (typeof document === 'undefined') return false;
    return isModalOpen(document);
  }

  /** Hide behind an overlay, restore when it closes. Never unmount — the offer is spent. */
  private syncOverlayState(): void {
    const prompt = this.prompt;
    if (!prompt) {
      // Nothing mounted. If an overlay is what stopped us mounting, retry now
      // that it has closed — this is the path that makes the offer survive
      // Clerk's own sign-in modal.
      if (this.evaluationDeferredByOverlay && !this.blockedByOverlay()) {
        this.evaluationDeferredByOverlay = false;
        void this.onAuthChange();
      }
      return;
    }
    if (this.blockedByOverlay()) { prompt.hide(); return; }
    if (!this.isHidden()) return;
    prompt.restore();
    const held = this.pendingOutcome;
    if (held !== null) { this.pendingOutcome = null; this.applyOutcome(held); }
  }

  /**
   * Keep `--wm-bottom-banner` equal to the cached-mode banner's rendered height.
   *
   * Two custom properties rather than one, because the banner cannot offset
   * itself: `--wm-bottom-base` is the tab bar plus safe-area inset, and the card
   * sits above base + banner. Nothing wrote this property before, so it stayed
   * at its `0px` default and the card rendered straight on top of a banner that
   * wraps to two or three lines on a narrow viewport.
   */
  private syncBannerHeight(): void {
    if (typeof document === 'undefined') return;
    const banner = document.querySelector('.cached-mode-banner');
    // Identity unchanged → nothing to do. Deliberately does NOT re-measure:
    // this runs from a body-wide MutationObserver on a dashboard that mutates
    // constantly, and getBoundingClientRect() forces a synchronous layout. A
    // measurement per mutation batch is a real per-frame cost for no benefit —
    // the ResizeObserver below already reports every height change.
    if (banner === this.observedBanner) return;
    this.bannerResizeObserver?.disconnect();
    this.observedBanner = banner;
    if (!banner) {
      // Removed: reset, or the card floats above a gap that is no longer there.
      this.setBannerHeight(0);
      return;
    }
    this.setBannerHeight(banner.getBoundingClientRect().height);
    if (typeof ResizeObserver !== 'function') return;
    this.bannerResizeObserver = new ResizeObserver((entries) => {
      const rect = entries[0]?.target.getBoundingClientRect();
      if (rect) this.setBannerHeight(rect.height);
    });
    this.bannerResizeObserver.observe(banner);
  }

  private setBannerHeight(px: number): void {
    if (typeof document === 'undefined') return;
    document.documentElement.style.setProperty('--wm-bottom-banner', `${Math.round(px)}px`);
  }

  private isHidden(): boolean {
    return this.prompt?.getElement().hidden === true;
  }

  // -- cross-tab ------------------------------------------------------------

  private openChannel(): void {
    if (typeof BroadcastChannel !== 'function') return;
    try {
      this.channel = new BroadcastChannel(BROADCAST_CHANNEL);
      this.channel.onmessage = (event: MessageEvent) => {
        const key = (event.data as { accountKey?: unknown } | null)?.accountKey;
        // Account-keyed: an unqualified "someone mounted" would silence a
        // sibling tab signed into a DIFFERENT account.
        if (typeof key !== 'string') return;
        // Record it locally so this tab's next evaluation sees the sibling's
        // mount. A tab that already has the card up keeps it — the broadcast
        // prevents a duplicate, it does not retract one.
        recordOffered(this.storage, this.memory, key);
      };
    } catch { this.channel = null; }
  }

  private broadcastMounted(accountKey: string | null): void {
    if (!accountKey) return;
    try { this.channel?.postMessage({ accountKey }); } catch { /* channel closed */ }
  }
}

/** Whether the Clerk SDK is loaded — the authority behind an "authoritative" signed-out state. */
function isClerkLoaded(): boolean {
  return getClerk() !== null;
}
