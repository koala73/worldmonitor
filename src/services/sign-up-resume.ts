/**
 * Resume of a pending email-code sign-up after a reload.
 *
 * A new user leaves the app for the emailed code; any reload in that window
 * (ours or the OS's) destroys Clerk's modal. The attempt itself survives on
 * `clerk.client.signUp`, but `openSignUp()` restarts at the first card, whose
 * Continue creates a new attempt and sends a second email. This module reads
 * the surviving attempt, decides whether it can be resumed, and hands the
 * verify card back to the user on the same attempt id.
 *
 * Two triggers, both explicit. `hydration` is the first Clerk emission after
 * load; it resumes only a live code, because a page load must never send an
 * unsolicited email to someone who abandoned. `user` is a Create-account click;
 * an expired code is resent first so the card's "code sent" subtitle is true.
 */

import type { Clerk } from '@clerk/clerk-js';
import {
  getClerk,
  isClerkSignInOpen,
  registerSignUpResumeHook,
  subscribeClerk,
} from '@/services/clerk';
import {
  markSignUpResumed,
  trackSignUpResumeDismissed,
  trackSignUpResumed,
  trackSignUpStarted,
} from '@/services/analytics';
import { safeStorageGet, safeStorageSet } from '@/utils/safe-storage';

export type ClerkSignUp = NonNullable<Clerk['client']>['signUp'];

/** Epoch milliseconds. Branded so a Date or a seconds value cannot slip in. */
export type EpochMs = number & { readonly __brand: 'EpochMs' };

/** Clerk sign-up attempt id (`sua_...`). Branded: never compared to a user id. */
export type SignUpAttemptId = string & { readonly __brand: 'SignUpAttemptId' };

export const asEpochMs = (ms: number): EpochMs => ms as EpochMs;
export const asSignUpAttemptId = (id: string): SignUpAttemptId => id as SignUpAttemptId;

/** A code this close to `expireAt` is treated as expired: the user still has to type it. */
export const CODE_EXPIRY_MARGIN_MS = 15_000;

export type SignUpSnapshot =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'pending';
      readonly id: SignUpAttemptId;
      readonly email: string;
      readonly strategy: string | null;
      readonly emailUnverified: boolean;
      readonly codeExpiresAt: EpochMs | null;
      readonly abandonAt: EpochMs | null;
    }
  | { readonly kind: 'complete'; readonly id: SignUpAttemptId };

/** The only function that touches a Clerk resource type. */
export function readSignUpSnapshot(signUp: ClerkSignUp | null | undefined): SignUpSnapshot {
  if (!signUp?.id || signUp.status === null || signUp.status === 'abandoned') return { kind: 'none' };
  const id = asSignUpAttemptId(signUp.id);
  if (signUp.status === 'complete') return { kind: 'complete', id };
  const verification = signUp.verifications.emailAddress;
  return {
    kind: 'pending',
    id,
    email: signUp.emailAddress ?? '',
    strategy: verification.strategy,
    emailUnverified: signUp.unverifiedFields.includes('email_address') && verification.status === 'unverified',
    codeExpiresAt: verification.expireAt ? asEpochMs(verification.expireAt.getTime()) : null,
    abandonAt: signUp.abandonAt === null ? null : asEpochMs(signUp.abandonAt),
  };
}

export interface ResumeInput {
  readonly signUp: SignUpSnapshot;
  readonly signedIn: boolean;
  readonly dismissedAttemptId: SignUpAttemptId | null;
  readonly clerkModalOpen: boolean;
}

export type ResumeDecision =
  | {
      readonly kind: 'none';
      readonly reason:
        | 'no-attempt'
        | 'complete'
        | 'signed-in'
        | 'not-email-code'
        | 'email-already-verified'
        | 'abandoned'
        | 'dismissed'
        | 'clerk-modal-open';
    }
  | {
      readonly kind: 'resume';
      readonly attemptId: SignUpAttemptId;
      readonly email: string;
      readonly code: 'live' | 'expired';
    };

/**
 * Pure predicate. Liveness is judged by Clerk's own deadlines only: a null
 * `abandonAt` is alive, and no local time budget is layered on top.
 */
export function decideResume(input: ResumeInput, now: EpochMs): ResumeDecision {
  if (input.signedIn) return { kind: 'none', reason: 'signed-in' };
  const { signUp } = input;
  if (signUp.kind === 'none') return { kind: 'none', reason: 'no-attempt' };
  if (signUp.kind === 'complete') return { kind: 'none', reason: 'complete' };
  if (signUp.strategy !== 'email_code') return { kind: 'none', reason: 'not-email-code' };
  if (!signUp.emailUnverified) return { kind: 'none', reason: 'email-already-verified' };
  if (signUp.abandonAt !== null && signUp.abandonAt <= now) return { kind: 'none', reason: 'abandoned' };
  if (input.dismissedAttemptId === signUp.id) return { kind: 'none', reason: 'dismissed' };
  if (input.clerkModalOpen) return { kind: 'none', reason: 'clerk-modal-open' };
  const expired = signUp.codeExpiresAt !== null && signUp.codeExpiresAt - now <= CODE_EXPIRY_MARGIN_MS;
  return { kind: 'resume', attemptId: signUp.id, email: signUp.email, code: expired ? 'expired' : 'live' };
}

export type ResumeTrigger = 'hydration' | 'user';

export interface ResumeMarkers {
  claimStarted: (id: SignUpAttemptId) => boolean;
  dismissed: (id: SignUpAttemptId) => boolean;
  markDismissed: (id: SignUpAttemptId) => void;
  markResumed: () => void;
}

export interface ResumeSurface {
  open: (attempt: { attemptId: SignUpAttemptId; email: string }, onDismiss: () => void) => void;
  close: () => void;
  isOpen: () => boolean;
}

export interface FunnelTracker {
  started: () => void;
  resumed: (props: { trigger: ResumeTrigger; code: 'live' | 'expired'; sinceBootMs: number }) => void;
  dismissed: () => void;
}

export interface SignUpResumePorts {
  readonly now: () => EpochMs;
  readonly sinceBootMs: () => number;
  readonly readSnapshot: () => { signUp: SignUpSnapshot; signedIn: boolean } | null;
  readonly clerkModalOpen: () => boolean;
  readonly markers: ResumeMarkers;
  readonly surface: ResumeSurface;
  readonly resendCode: () => Promise<void>;
  readonly track: FunnelTracker;
}

export interface SignUpResumeController {
  onClerkEmission: (first: boolean) => void;
  /**
   * Called by `openSignUp()`. True means the resume surface took the click.
   * `fallback` opens Clerk's own modal when a resend fails after the click
   * was taken.
   */
  resumeOnUserIntent: (fallback: () => void) => boolean;
}

export function createSignUpResumeController(ports: SignUpResumePorts): SignUpResumeController {
  const decide = (): ResumeDecision => {
    const snap = ports.readSnapshot();
    if (!snap) return { kind: 'none', reason: 'no-attempt' };
    const dismissedAttemptId = snap.signUp.kind === 'pending' && ports.markers.dismissed(snap.signUp.id)
      ? snap.signUp.id
      : null;
    return decideResume({ ...snap, dismissedAttemptId, clerkModalOpen: ports.clerkModalOpen() }, ports.now());
  };

  const open = (decision: Extract<ResumeDecision, { kind: 'resume' }>, trigger: ResumeTrigger, onResendFailed: () => void): void => {
    if (ports.surface.isOpen()) return;
    const mount = (): void => {
      ports.markers.markResumed();
      ports.track.resumed({ trigger, code: decision.code, sinceBootMs: ports.sinceBootMs() });
      ports.surface.open(decision, () => {
        ports.markers.markDismissed(decision.attemptId);
        ports.track.dismissed();
      });
    };
    if (decision.code === 'live') {
      mount();
      return;
    }
    void ports.resendCode().then(mount, onResendFailed);
  };

  return {
    onClerkEmission(first) {
      const snap = ports.readSnapshot();
      if (snap?.signUp.kind === 'pending' && ports.markers.claimStarted(snap.signUp.id)) ports.track.started();
      if (snap?.signedIn && ports.surface.isOpen()) ports.surface.close();
      if (!first) return;
      const decision = decide();
      if (decision.kind === 'resume' && decision.code === 'live') open(decision, 'hydration', () => {});
    },
    resumeOnUserIntent(fallback) {
      const decision = decide();
      if (decision.kind !== 'resume') return false;
      open(decision, 'user', fallback);
      return true;
    },
  };
}

const STARTED_KEY_PREFIX = 'wm-signup-started:';
const DISMISSED_KEY_PREFIX = 'wm-signup-dismissed:';

/**
 * Production wiring. Subscribes through the queued Clerk listener path, so no
 * boot-time force-load is added: the decision runs when Clerk's idle load
 * lands. `sinceBootMs` on the resumed event measures whether a boot hint
 * would earn its place.
 */
export function installSignUpResume(surface: ResumeSurface): SignUpResumeController {
  const controller = createSignUpResumeController({
    now: () => asEpochMs(Date.now()),
    sinceBootMs: () => Math.round(performance.now()),
    readSnapshot: () => {
      const clerk = getClerk();
      if (!clerk) return null;
      return { signUp: readSignUpSnapshot(clerk.client?.signUp), signedIn: clerk.user !== null && clerk.user !== undefined };
    },
    clerkModalOpen: isClerkSignInOpen,
    markers: {
      claimStarted: (id) => {
        if (safeStorageGet(STARTED_KEY_PREFIX + id) === '1') return false;
        safeStorageSet(STARTED_KEY_PREFIX + id, '1');
        return true;
      },
      dismissed: (id) => safeStorageGet(DISMISSED_KEY_PREFIX + id) === '1',
      markDismissed: (id) => safeStorageSet(DISMISSED_KEY_PREFIX + id, '1'),
      markResumed: markSignUpResumed,
    },
    surface,
    resendCode: async () => {
      const signUp = getClerk()?.client?.signUp;
      if (!signUp) throw new Error('clerk not loaded');
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
    },
    track: {
      started: trackSignUpStarted,
      resumed: trackSignUpResumed,
      dismissed: trackSignUpResumeDismissed,
    },
  });

  let first = true;
  subscribeClerk(() => {
    controller.onClerkEmission(first);
    first = false;
  });
  registerSignUpResumeHook(controller.resumeOnUserIntent);
  return controller;
}
