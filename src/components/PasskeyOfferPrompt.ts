import { t } from '@/services/i18n';

/**
 * The post-sign-in "save a passkey?" card.
 *
 * Purely presentational: it renders five states and reports two intents. It
 * knows nothing about auth, storage, or analytics — the controller owns every
 * decision about whether this should exist at all.
 *
 * Two accessibility choices here are deliberate and easy to get wrong:
 *
 *   - **A labelled region, not a dialog.** `role="dialog"` without a focus trap
 *     and without moving focus tells assistive technology the user entered a
 *     dialog, and then nothing does. This is a non-modal notification with
 *     actions, so it is a labelled `<aside>`.
 *   - **`aria-live` on dedicated nodes, never on the card.** A live region
 *     wrapping the whole interactive card re-announces the buttons and body
 *     copy on every state change. Two separate, initially-empty nodes each
 *     receive one sentence, so exactly the change is announced. They are split
 *     because their audiences differ: the arrival sentence restates the body
 *     copy and is screen-reader only, while the status sentence is state
 *     feedback nobody can infer from looking and is painted.
 *
 * Its styling follows `.update-toast`, the house pattern for an elevated
 * notification with an action. The generic surface/border/accent tokens are the
 * wrong choice here — `--accent` is `#fff` in the dark theme, which rendered
 * the primary button as white text on white.
 */

/** The five states the card can be in. Terminal timing differs by state. */
export type PasskeyPromptState = 'offered' | 'busy' | 'succeeded' | 'retryable' | 'failed';

export interface PasskeyOfferPromptOptions {
  onAccept: () => void;
  onDismiss: () => void;
}

export class PasskeyOfferPrompt {
  private readonly root: HTMLElement;
  /** Screen-reader-only arrival sentence. Never painted. */
  private readonly announce: HTMLElement;
  private readonly status: HTMLElement;
  private readonly acceptBtn: HTMLButtonElement;
  private readonly dismissBtn: HTMLButtonElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly onAccept: () => void;
  private readonly onDismiss: () => void;
  private state: PasskeyPromptState = 'offered';
  /** The control focused immediately before hiding — not at mount. */
  private focusBeforeHide: HTMLElement | null = null;
  private announceFrame: number | null = null;

  constructor(options: PasskeyOfferPromptOptions) {
    this.onAccept = options.onAccept;
    this.onDismiss = options.onDismiss;

    this.root = document.createElement('aside');
    this.root.className = 'passkey-offer-prompt';
    this.root.setAttribute('aria-label', t('components.passkeyOffer.title'));

    const title = document.createElement('p');
    title.className = 'passkey-offer-title';
    title.textContent = t('components.passkeyOffer.title');

    const body = document.createElement('p');
    body.className = 'passkey-offer-body';
    body.textContent = t('components.passkeyOffer.body');

    // Two live regions, because the two announcements have different audiences.
    //
    // The arrival sentence restates the body copy, so painting it put two
    // sentences saying the same thing on one small card. It is screen-reader
    // only. The status sentence is genuine state feedback nobody can infer from
    // looking, so it is visible.
    //
    // Both start empty: an empty live region announces nothing, so arrival is
    // written on the next frame (see `announceOnMount`) — several screen
    // readers only announce mutations to a region that was already present.
    this.announce = document.createElement('p');
    this.announce.className = 'passkey-offer-announce';
    this.announce.setAttribute('aria-live', 'polite');

    this.status = document.createElement('p');
    this.status.className = 'passkey-offer-status';
    this.status.setAttribute('aria-live', 'polite');

    const actions = document.createElement('div');
    actions.className = 'passkey-offer-actions';

    this.acceptBtn = document.createElement('button');
    this.acceptBtn.type = 'button';
    this.acceptBtn.className = 'passkey-offer-accept';
    this.acceptBtn.textContent = t('components.passkeyOffer.accept');
    this.acceptBtn.addEventListener('click', this.handleAccept);

    this.dismissBtn = document.createElement('button');
    this.dismissBtn.type = 'button';
    this.dismissBtn.className = 'passkey-offer-dismiss';
    this.dismissBtn.textContent = t('components.passkeyOffer.dismiss');
    this.dismissBtn.addEventListener('click', this.handleDismiss);

    this.closeBtn = document.createElement('button');
    this.closeBtn.type = 'button';
    this.closeBtn.className = 'passkey-offer-close';
    this.closeBtn.setAttribute('aria-label', t('components.passkeyOffer.close'));
    this.closeBtn.textContent = '×';
    this.closeBtn.addEventListener('click', this.handleDismiss);

    actions.append(this.dismissBtn, this.acceptBtn);
    this.root.append(this.closeBtn, title, body, this.announce, this.status, actions);
  }

  /** The element to insert. The caller owns where it goes. */
  getElement(): HTMLElement {
    return this.root;
  }

  /** Current state — exposed for the controller's own branching, not for tests to drive. */
  getState(): PasskeyPromptState {
    return this.state;
  }

  /**
   * Write the arrival sentence into the live region.
   *
   * Call after the card is in the document, on a later frame — writing in the
   * same tick as the insertion is unreliable.
   */
  announceOnMount(schedule: (cb: () => void) => number = requestAnimationFrame): void {
    this.announceFrame = schedule(() => {
      this.announceFrame = null;
      if (this.state === 'offered' && !this.root.hidden) {
        this.announce.textContent = t('components.passkeyOffer.announce');
      }
    });
  }

  /** Move to a state, updating copy, disabled-ness, and the live region. */
  setState(next: PasskeyPromptState): void {
    this.state = next;
    const busy = next === 'busy';
    // Accept is live only where another attempt makes sense. `busy` blocks a
    // double-tap mid-ceremony; the two TERMINAL states block it for different
    // reasons: during the success linger a second tap would run a duplicate
    // ceremony and double-fire `created`, and a `failed` verdict is by
    // definition non-retryable on this device, so re-enabling it invites an
    // unbounded retry loop against a device that cannot succeed.
    this.acceptBtn.disabled = busy || next === 'succeeded' || next === 'failed';
    // Dismiss stays available in terminal states — the user must be able to
    // close a failure they have read.
    this.dismissBtn.disabled = busy;
    if (busy) this.root.setAttribute('aria-busy', 'true');
    else this.root.removeAttribute('aria-busy');

    this.root.dataset.state = next;
    // The arrival sentence is stale the moment a state exists. Clearing it
    // announces nothing (an empty region is silent) but stops a screen reader
    // reading "save a passkey to sign in faster" back alongside "passkey saved".
    this.announce.textContent = '';
    this.status.textContent = statusTextFor(next);
  }

  /**
   * Remove the card from BOTH the visual and accessibility trees.
   *
   * `hidden` rather than a class, so it is genuinely gone from the a11y tree —
   * visual concealment alone would leave it announced but unreachable beneath a
   * focus trap, which is the worst available outcome.
   */
  hide(): void {
    if (this.root.hidden) return;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    this.focusBeforeHide = this.root.contains(active) ? (active as HTMLElement) : null;
    this.root.hidden = true;
  }

  /**
   * Restore after an overlay closes.
   *
   * Clears the status node before re-showing so an outcome the user already
   * heard is not re-announced, then re-writes the pending sentence. Focus
   * returns only when nothing else has claimed it — if the user moved on while
   * the overlay was up, leave them there.
   */
  restore(schedule: (cb: () => void) => number = requestAnimationFrame): void {
    if (!this.root.hidden) return;
    this.status.textContent = '';
    this.root.hidden = false;
    const pending = statusTextFor(this.state);
    if (pending) schedule(() => { this.status.textContent = pending; });
    else if (this.state === 'offered' && !this.announce.textContent && this.announceFrame === null) {
      this.announceOnMount(schedule);
    }

    const target = this.focusBeforeHide;
    this.focusBeforeHide = null;
    if (!target || !target.isConnected) return;
    if ((target as HTMLButtonElement).disabled) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    target.focus();
  }

  /** Remove from the DOM and drop every listener. */
  destroy(): void {
    if (this.announceFrame !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.announceFrame);
    }
    this.announceFrame = null;
    this.acceptBtn.removeEventListener('click', this.handleAccept);
    this.dismissBtn.removeEventListener('click', this.handleDismiss);
    this.closeBtn.removeEventListener('click', this.handleDismiss);
    this.root.remove();
  }

  private readonly handleAccept = (): void => {
    // Belt-and-braces alongside the disabled attribute: a synthetic click or a
    // stale listener must not start a second ceremony either.
    if (this.state !== 'offered' && this.state !== 'retryable') return;
    this.onAccept();
  };

  private readonly handleDismiss = (): void => {
    if (this.state === 'busy') return;
    this.onDismiss();
  };
}

/** The sentence the live region carries for each state. `offered` stays empty until announced. */
function statusTextFor(state: PasskeyPromptState): string {
  switch (state) {
    case 'busy': return t('components.passkeyOffer.busy');
    case 'succeeded': return t('components.passkeyOffer.succeeded');
    case 'retryable': return t('components.passkeyOffer.retryable');
    case 'failed': return t('components.passkeyOffer.failed');
    default: return '';
  }
}
