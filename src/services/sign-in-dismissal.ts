/**
 * Notice when a sign-in modal goes away without the page moving on.
 *
 * Clerk's `openSignIn()` has no close callback, and a dismissed modal does not
 * reliably emit through `addListener`: the 2026-10-19 report was a passkey
 * prompt interrupted by a password-manager overlay, after which the modal closed
 * with the sign-in attempt parked at `needs_first_factor` and no session. A page
 * that only waits for a session then waits forever.
 *
 * This watches the modal's presence instead. It reports `never_opened` when the
 * modal does not mount within `openTimeoutMs`, and `closed` once a modal that
 * did mount has stayed gone for `settleMs`. The grace exists because Clerk
 * closes the modal and activates the session as separate steps; the caller still
 * decides whether a report means a cancel by checking whether a completed
 * sign-in already moved the page on.
 *
 * Zero imports so `tsx --test` can drive it with a fake clock.
 */

export type SignInDismissalReason = 'closed' | 'never_opened';

export interface SignInDismissalClock {
  now(): number;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SignInDismissalOptions {
  isOpen: () => boolean;
  onDismissed: (reason: SignInDismissalReason) => void;
  openTimeoutMs?: number;
  settleMs?: number;
  pollMs?: number;
  clock?: SignInDismissalClock;
}

export interface SignInDismissalWatch {
  cancel(): void;
}

export const SIGN_IN_OPEN_TIMEOUT_MS = 10_000;
export const SIGN_IN_DISMISS_SETTLE_MS = 750;
export const SIGN_IN_DISMISS_POLL_MS = 200;

const realClock: SignInDismissalClock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function watchSignInDismissal(options: SignInDismissalOptions): SignInDismissalWatch {
  const {
    isOpen,
    onDismissed,
    openTimeoutMs = SIGN_IN_OPEN_TIMEOUT_MS,
    settleMs = SIGN_IN_DISMISS_SETTLE_MS,
    pollMs = SIGN_IN_DISMISS_POLL_MS,
    clock = realClock,
  } = options;

  const startedAt = clock.now();
  let seenOpen = false;
  let closedAt: number | null = null;
  let handle: unknown = null;
  let done = false;

  const finish = (reason: SignInDismissalReason): void => {
    done = true;
    handle = null;
    onDismissed(reason);
  };

  const tick = (): void => {
    handle = null;
    if (done) return;
    const now = clock.now();
    if (isOpen()) {
      seenOpen = true;
      closedAt = null;
    } else if (!seenOpen) {
      if (now - startedAt >= openTimeoutMs) {
        finish('never_opened');
        return;
      }
    } else {
      closedAt ??= now;
      if (now - closedAt >= settleMs) {
        finish('closed');
        return;
      }
    }
    handle = clock.setTimeout(tick, pollMs);
  };

  handle = clock.setTimeout(tick, pollMs);

  return {
    cancel(): void {
      done = true;
      if (handle !== null) clock.clearTimeout(handle);
      handle = null;
    },
  };
}
