/**
 * Resume of a pending email-code sign-up after a reload.
 *
 * A new user leaves the app for the emailed code; any reload in that window
 * (ours or the OS's) destroys Clerk's modal. The attempt itself survives on
 * `clerk.client.signUp`, but `openSignUp()` restarts at the first card, whose
 * Continue creates a new attempt and sends a second email. This module reads
 * the surviving attempt, decides whether it can be resumed, and hands the
 * verify card back to the user on the same attempt id.
 */

import type { Clerk } from '@clerk/clerk-js';

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

export function readSignUpSnapshot(_signUp: ClerkSignUp | null | undefined): SignUpSnapshot {
  throw new Error('not implemented');
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

export function decideResume(_input: ResumeInput, _now: EpochMs): ResumeDecision {
  throw new Error('not implemented');
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

export function createSignUpResumeController(_ports: SignUpResumePorts): SignUpResumeController {
  throw new Error('not implemented');
}

export function installSignUpResume(_surface: ResumeSurface): SignUpResumeController {
  throw new Error('not implemented');
}
