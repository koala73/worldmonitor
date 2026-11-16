/**
 * Analytics-only watcher for the Clerk auth modal opened by a signed-out
 * checkout click. Clerk has no close callback, so this observes the DOM and
 * reports a close that happened without a sign-in. It must never drive the
 * checkout phase machine, CTA state or toasts (see CheckoutPhase).
 */

// Same selector as isClerkSignInOpen in src/services/clerk.ts, plus SignUp.
// Copied, not imported: that module pulls in the dashboard's Clerk loader.
export const AUTH_MODAL_SELECTOR =
  '.cl-modalBackdrop, .cl-modal, [data-clerk-component="SignIn"], [data-clerk-component="SignUp"]';
export const AUTH_CODE_STEP_SELECTOR = '.cl-otpCodeField, input[autocomplete="one-time-code"]';

const APPEAR_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_MS = 30 * 60_000;

let stopActive: (() => void) | null = null;

export function watchAuthModalDismissal(opts: {
  isSignedIn: () => boolean;
  onDismissed: (info: { reachedCodeStep: boolean }) => void;
  maxMs?: number;
}): () => void {
  stopActive?.();
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined' || !document.body) {
    return () => {};
  }

  let open = false;
  let reachedCodeStep = false;
  let stopped = false;
  const timers: ReturnType<typeof setTimeout>[] = [];

  const observer = new MutationObserver(() => check());
  const stop = () => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    for (const timer of timers) clearTimeout(timer);
    window.removeEventListener('pagehide', stop);
    if (stopActive === stop) stopActive = null;
  };

  function check(): void {
    if (stopped) return;
    try {
      const modalPresent = document.querySelector(AUTH_MODAL_SELECTOR) !== null;
      if (modalPresent) {
        open = true;
        if (!reachedCodeStep && document.querySelector(AUTH_CODE_STEP_SELECTOR)) reachedCodeStep = true;
        return;
      }
      if (!open) return;
      stop();
      if (!opts.isSignedIn()) opts.onDismissed({ reachedCodeStep });
    } catch {
      stop();
    }
  }

  stopActive = stop;
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('pagehide', stop);
  timers.push(setTimeout(() => { if (!open) stop(); }, APPEAR_TIMEOUT_MS));
  timers.push(setTimeout(stop, opts.maxMs ?? DEFAULT_MAX_MS));
  check();
  return stop;
}
