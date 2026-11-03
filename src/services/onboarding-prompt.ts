/**
 * One onboarding prompt per page load (KTD6): the Pro activation interstitial,
 * then the mission picker for brand-new desktop visitors, then the About-you
 * card. This module decides whether the About-you card may open, and carries
 * the activation controller's decision to it.
 *
 * Imports only the pure questionnaire module, so `tsx --test` can load it
 * without Vite or the DOM.
 */
import {
  ABOUT_YOU_KEY_QUESTIONS,
  ABOUT_YOU_QUESTION_ORDER,
  type AboutYouQuestionId,
} from '../../shared/audience-profile';

/** Mirrors the return value of Convex `audienceProfile:getStatus`. */
export interface AboutYouStatus {
  status: 'due' | 'answered' | 'skipped';
  answers: Partial<Record<AboutYouQuestionId, string>>;
  keyQuestionsComplete: boolean;
  returnDue: boolean;
}

export type ActivationPromptDecision = 'will-open' | 'not-due' | 'unknown';

export interface AboutYouPromptInput {
  signedIn: boolean;
  /** `null` when the status could not be read: abstain. */
  status: AboutYouStatus | null;
  activation: ActivationPromptDecision;
  missionPickerDue: boolean;
  modalOpen: boolean;
}

export type AboutYouPromptDecision =
  | { kind: 'none' }
  | { kind: 'about-you'; mode: 'full' | 'return'; questions: AboutYouQuestionId[] };

export function decideAboutYouPrompt(input: AboutYouPromptInput): AboutYouPromptDecision {
  const { signedIn, status, activation, missionPickerDue, modalOpen } = input;
  if (!signedIn || status === null) return { kind: 'none' };
  // Anything short of a definite "activation is not opening" abstains.
  if (activation !== 'not-due' || missionPickerDue || modalOpen) return { kind: 'none' };
  if (status.status === 'due') return { kind: 'about-you', mode: 'full', questions: [...ABOUT_YOU_QUESTION_ORDER] };
  if (status.status === 'answered' && status.returnDue) {
    const empty = ABOUT_YOU_KEY_QUESTIONS.filter((id) => status.answers[id] === undefined);
    if (empty.length > 0) return { kind: 'about-you', mode: 'return', questions: empty };
  }
  return { kind: 'none' };
}

let activationDecision: Exclude<ActivationPromptDecision, 'unknown'> | null = null;
let waiters: Array<(decision: Exclude<ActivationPromptDecision, 'unknown'>) => void> = [];

/** Called by the Pro activation controller once it knows whether it opens. */
export function reportActivationPromptDecision(decision: Exclude<ActivationPromptDecision, 'unknown'>): void {
  activationDecision = decision;
  const pending = waiters;
  waiters = [];
  for (const resolve of pending) resolve(decision);
}

/** The activation decision, or `unknown` when none arrives within `timeoutMs`. */
export function waitForActivationPromptDecision(timeoutMs: number): Promise<ActivationPromptDecision> {
  if (activationDecision !== null) return Promise.resolve(activationDecision);
  return new Promise((resolve) => {
    const waiter = (decision: Exclude<ActivationPromptDecision, 'unknown'>): void => {
      clearTimeout(timer);
      resolve(decision);
    };
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== waiter);
      resolve('unknown');
    }, timeoutMs);
    waiters.push(waiter);
  });
}

export function _resetActivationPromptDecisionForTests(): void {
  activationDecision = null;
  waiters = [];
}

/** The part of a mounted prompt the account binding touches. */
export interface AccountBoundPrompt {
  readonly isConnected: boolean;
  remove(): void;
}

/** The auth snapshot shape the binding reads. */
export interface PromptAuthSnapshot {
  user: { id: string } | null;
  isPending: boolean;
}

/**
 * Keep a prompt tied to the account it was opened for. Its callbacks write
 * against `userId`, so after sign-out or an account switch every save would be
 * rejected; the prompt is removed instead (not skipped: the original account
 * never answered). Returns a dispose for teardown.
 */
export function bindPromptToAccount(
  prompt: AccountBoundPrompt,
  userId: string,
  subscribe: (listener: (state: PromptAuthSnapshot) => void) => () => void,
): () => void {
  let unsubscribe: (() => void) | null = null;
  let done = false;
  const stop = (): void => {
    done = true;
    unsubscribe?.();
    unsubscribe = null;
  };
  unsubscribe = subscribe((state) => {
    if (done) return;
    if (!prompt.isConnected) {
      stop();
      return;
    }
    if (state.isPending || state.user?.id === userId) return;
    prompt.remove();
    stop();
  });
  // A subscribe that fires synchronously may have finished before it returned.
  if (done) {
    unsubscribe?.();
    unsubscribe = null;
  }
  return () => {
    if (prompt.isConnected) prompt.remove();
    stop();
  };
}

/**
 * The About-you card and the passkey offer are both non-modal bottom-corner
 * surfaces, so `isModalOpen` sees neither. On mobile they share the area above
 * the tab bar, and the passkey offer sits on top. Each one treats the other as
 * blocking: the passkey offer defers or hides until the card closes, and the
 * card abstains for this load when an offer is present. A hidden offer still
 * counts, because it restores itself when its overlay closes.
 *
 * The card id is repeated rather than imported: services must not import
 * components. `tests/dom/passkey-offer-controller-overlay-retry.test.mts` mounts
 * the card by `ABOUT_YOU_CARD_ID`, so drift fails that test.
 */
export interface PromptProbeDocument {
  querySelector: (selector: string) => unknown;
}

export function isAboutYouCardPresent(doc: PromptProbeDocument): boolean {
  return doc.querySelector('#wm-about-you-card') != null;
}

export function isPasskeyOfferPresent(doc: PromptProbeDocument): boolean {
  return doc.querySelector('.passkey-offer-prompt') != null;
}
