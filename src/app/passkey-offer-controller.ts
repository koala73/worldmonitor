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
  createOfferMemory,
  derivePasskeyAccountKey,
  hasBeenOffered,
  type OfferMemory,
  type OfferStorage,
  recordOffered,
  shouldOfferPasskey,
} from '@/services/passkey-offer-state';
import {
  countPasskeys,
  createPasskey,
  hasPlatformAuthenticator,
  isPasskeyEnvironmentEligible,
  isPasskeySessionReady,
  type PasskeyOutcome,
  readPasskeyEnvironmentFacts,
  readPasskeySessionFacts,
} from '@/services/passkeys';
import { isModalOpen } from '@/utils/open-modal';

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
  isDesktopApp: boolean;
  readEnvironment: () => { isDesktopApp: boolean; inIframe: boolean; hasPublicKeyCredential: boolean };
  readIdentity: () => PasskeyIdentity;
  passkeyCount: () => number;
  alreadyOffered: (accountKey: string | null) => boolean;
  /** Async, and deliberately last among the capability checks. */
  platformAuthenticator: () => Promise<boolean>;
  blockedByOverlay: () => boolean;
  /** Defer one frame so Clerk's sign-in modal finishes unmounting. */
  deferFrame: () => Promise<void>;
  /** Claim this evaluation. Returns false when another already won. */
  claim: () => boolean;
  mount: (identity: PasskeyIdentity) => void;
}

/** Why an evaluation did not mount. `mounted` is the only success. */
export type PasskeyEvaluationResult =
  | 'mounted'
  | 'not-armed'
  | 'not-ready'
  | 'ineligible-environment'
  | 'already-has-passkey'
  | 'already-offered'
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

  if (!shouldOfferPasskey({
    environmentEligible: true,
    sessionReady: true,
    existingPasskeyCount: deps.passkeyCount(),
    alreadyOffered: deps.alreadyOffered(identity.accountKey),
  })) {
    return deps.passkeyCount() > 0 ? 'already-has-passkey' : 'already-offered';
  }

  // Overlay check BEFORE the frame defer, and again after — an overlay can open
  // inside the deferred frame itself.
  if (deps.blockedByOverlay()) return 'blocked-by-overlay';

  if (!await deps.platformAuthenticator()) return 'no-platform-authenticator';
  if (!identityMatches(deps.readIdentity(), identity)) return 'superseded';

  await deps.deferFrame();
  if (!identityMatches(deps.readIdentity(), identity)) return 'superseded';
  if (deps.blockedByOverlay()) return 'blocked-by-overlay';

  // Re-read both ledger tiers: a sibling tab may have written between the probe
  // and here, and its broadcast may have landed during the deferred frame.
  if (deps.alreadyOffered(identity.accountKey)) return 'already-offered';

  // Single-flight. Clerk can emit twice for one session during a deferred
  // probe; without this, two emissions produce two mounts, two ledger writes,
  // and two `shown` events.
  if (!deps.claim()) return 'superseded';

  deps.mount(identity);
  return 'mounted';
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

const BROADCAST_CHANNEL = 'wm-passkey-offer';
/** How long the success confirmation stays before the card leaves. */
const SUCCESS_LINGER_MS = 2600;

/** Coarse, closed reason vocabulary for the failure event. Never a Clerk string. */
function failureReason(outcome: PasskeyOutcome): string {
  return outcome === 'failed' ? 'device-unsupported' : 'unknown';
}

export interface PasskeyOfferControllerOptions {
  storage?: OfferStorage;
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

  /**
   * Whether an authoritative signed-out state has been seen this page life.
   *
   * This is the whole cookie-hydration guard. Auth state starts
   * `{ user: null, isPending: true }` and becomes a user when an existing
   * cookie hydrates, so a naive null-to-user detector fires on EVERY page load
   * for an already-signed-in user. And "signed out" must be authoritative:
   * a failed Clerk SDK load deliberately publishes `{user: null, isPending:
   * false}` — byte-identical to a real signed-out session — while keeping
   * subscribers queued for a retry.
   */
  private armed = false;
  private prompt: PasskeyOfferPrompt | null = null;
  private mountedIdentity: PasskeyIdentity | null = null;
  private acceptedThisMount = false;
  private evaluationEpoch = 0;
  private claimedEpoch = -1;
  private successTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set when an outcome resolves while the card is hidden behind an overlay. */
  private pendingOutcome: PasskeyOutcome | null = null;

  constructor(ctx: AppContext, options: PasskeyOfferControllerOptions = {}) {
    this.ctx = ctx;
    this.storage = options.storage ?? safeLocalStorage();
    this.scheduleFrame = options.scheduleFrame
      ?? ((cb) => { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cb); else setTimeout(cb, 16); });
  }

  init(): void {
    this.unsubscribeAuth = subscribeAuthState(() => { void this.onAuthChange(); });
    this.observeOverlays();
    this.openChannel();
  }

  destroy(): void {
    this.unsubscribeAuth?.();
    this.unsubscribeAuth = null;
    this.observer?.disconnect();
    this.observer = null;
    try { this.channel?.close(); } catch { /* already closed, or unsupported */ }
    this.channel = null;
    if (this.successTimer !== null) clearTimeout(this.successTimer);
    this.successTimer = null;
    this.teardownPrompt();
  }

  // -- auth -----------------------------------------------------------------

  private async onAuthChange(): Promise<void> {
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
    await evaluatePasskeyOffer({
      armed: () => this.armed,
      isDesktopApp: this.ctx.isDesktopApp,
      readEnvironment: () => readPasskeyEnvironmentFacts(this.ctx.isDesktopApp),
      readIdentity: () => this.readIdentity(),
      passkeyCount: () => countPasskeys(getClerk()?.user as { passkeys?: unknown } | null),
      alreadyOffered: (key) => this.storage !== null && hasBeenOffered(this.storage, this.memory, key),
      platformAuthenticator: () => hasPlatformAuthenticator(),
      blockedByOverlay: () => this.blockedByOverlay(),
      deferFrame: () => new Promise<void>((resolve) => this.scheduleFrame(() => resolve())),
      claim: () => {
        if (epoch !== this.evaluationEpoch || this.claimedEpoch === epoch) return false;
        this.claimedEpoch = epoch;
        return true;
      },
      mount: (id) => this.mountPrompt(id),
    });
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

  private mountPrompt(identity: PasskeyIdentity): void {
    const prompt = new PasskeyOfferPrompt({
      onAccept: () => { void this.onAccept(); },
      onDismiss: () => this.onDismiss(),
    });
    this.prompt = prompt;
    this.mountedIdentity = identity;
    this.acceptedThisMount = false;
    document.body.appendChild(prompt.getElement());
    prompt.announceOnMount();

    // The offer is spent at MOUNT, not at answer — otherwise closing the tab
    // with the card open earns a second offer.
    if (this.storage) recordOffered(this.storage, this.memory, identity.accountKey);
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
      trackPasskeyOfferFailed(failureReason(outcome));
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
    this.observer = new MutationObserver(() => this.syncOverlayState());
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
    if (!prompt) return;
    if (this.blockedByOverlay()) { prompt.hide(); return; }
    if (!this.isHidden()) return;
    prompt.restore();
    const held = this.pendingOutcome;
    if (held !== null) { this.pendingOutcome = null; this.applyOutcome(held); }
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
        if (this.storage) recordOffered(this.storage, this.memory, key);
        if (this.mountedIdentity?.accountKey === key) return;
      };
    } catch { this.channel = null; }
  }

  private broadcastMounted(accountKey: string | null): void {
    if (!accountKey) return;
    try { this.channel?.postMessage({ accountKey }); } catch { /* channel closed */ }
  }
}

/** `localStorage` when reachable. Null in private modes that throw on access. */
function safeLocalStorage(): OfferStorage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** Whether the Clerk SDK is loaded — the authority behind an "authoritative" signed-out state. */
function isClerkLoaded(): boolean {
  return getClerk() !== null;
}
