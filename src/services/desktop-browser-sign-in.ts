/**
 * Desktop Sign in through the system browser (#9396 follow-up). Rust's
 * `start_desktop_browser_sign_in` opens www.worldmonitor.app, waits for the
 * loopback redirect and exchanges the code for a Clerk ticket it keeps;
 * `finish_desktop_browser_sign_in` redeems that ticket through the relay. The
 * renderer never sees the verifier, code or ticket. Rust redeems the ticket
 * on a fresh client and adopts it only on success, so a failed or cancelled
 * attempt leaves an existing session signed in. See docs/plans/2026-10-19-desktop-system-browser-sign-in.md.
 */

export interface BrowserSignInOutcome {
  status: string;
  createdSessionId: string | null;
  identifier: string | null;
}

export interface WaitingActions {
  onCancel(): void;
  /** Cancel the browser flow and use the in-app card instead. */
  onInApp(): void;
}

export interface BrowserSignInDeps {
  fapiHost: string;
  start(fapiHost: string): Promise<void>;
  finish(): Promise<BrowserSignInOutcome>;
  cancel(): Promise<void>;
  reloadClient(): Promise<void>;
  setActive(sessionId: string): Promise<void>;
  notify(message: string): void;
  /** The in-WebView Clerk card, for steps that are not origin-bound. */
  openInApp(): void;
  /** Persistent "continue in your browser" UI; returns its dismiss function. */
  showWaiting(actions: WaitingActions): () => void;
}

export type BrowserSignInResult = 'signed_in' | 'fallback' | 'cancelled' | 'failed';

const TRY_AGAIN_SOON = 'Could not reach World Monitor. Try again in a moment.';
const FAILURE_MESSAGES: Record<string, string> = {
  timed_out: 'Sign-in timed out. Click Sign in to try again.',
  invalid_grant: 'Sign-in link expired. Click Sign in to try again.',
  sign_in_refused: 'This account cannot sign in. Contact support if this is unexpected.',
  service_unavailable: TRY_AGAIN_SOON,
  upstream_unavailable: TRY_AGAIN_SOON,
  network_failed: TRY_AGAIN_SOON,
};
/** The browser route is unusable here; the in-app card still works. */
const USE_IN_APP = new Set(['browser_failed', 'listener_failed', 'unsupported_host']);


function reasonOf(error: unknown): string {
  if (typeof error === 'string') return error;
  return error instanceof Error ? error.message : '';
}

export async function runDesktopBrowserSignIn(deps: BrowserSignInDeps): Promise<BrowserSignInResult> {
  const dismiss = deps.showWaiting({
    onCancel: () => { void deps.cancel(); },
    onInApp: () => {
      void deps.cancel();
      deps.openInApp();
    },
  });

  try {
    await deps.start(deps.fapiHost);
  } catch (error) {
    dismiss();
    const reason = reasonOf(error);
    if (reason === 'cancelled') return 'cancelled';
    if (reason === 'already_running') {
      deps.notify('Finish signing in in your browser.');
      return 'cancelled';
    }
    if (USE_IN_APP.has(reason)) {
      deps.notify(reason === 'unsupported_host'
        ? 'Sign in here instead.'
        : 'Could not open your browser. Sign in here instead.');
      deps.openInApp();
      return 'fallback';
    }
    deps.notify(FAILURE_MESSAGES[reason] ?? 'Sign-in did not finish. Click Sign in to try again.');
    return 'failed';
  }
  dismiss();

  let outcome: BrowserSignInOutcome;
  try {
    // Rust redeems on a fresh client and swaps it in only on success, so an
    // existing session survives any failure here.
    outcome = await deps.finish();
  } catch (error) {
    deps.notify(FAILURE_MESSAGES[reasonOf(error)] ?? 'Sign-in did not finish. Click Sign in to try again.');
    return 'failed';
  }

  if (outcome.status !== 'complete') {
    // e.g. needs_second_factor: the remaining step is not passkey-bound. The
    // reload lets the in-app card see the attempt Rust created.
    await deps.reloadClient();
    deps.notify('Finish signing in here.');
    deps.openInApp();
    return 'fallback';
  }
  if (!outcome.createdSessionId) {
    deps.notify('Sign-in did not finish. Click Sign in to try again.');
    return 'failed';
  }

  await deps.reloadClient();
  await deps.setActive(outcome.createdSessionId);
  deps.notify(outcome.identifier ? `Signed in as ${outcome.identifier}` : 'Signed in');
  return 'signed_in';
}

/**
 * One renderer attempt at a time, from the first click through sign-out,
 * redemption and activation. A second click while one runs would otherwise
 * clear the first attempt's pending ticket in Rust after it already signed
 * the user out, and replace its waiting bar.
 */
export function createSingleFlightSignIn(
  onBusy: () => void,
): (deps: BrowserSignInDeps) => Promise<BrowserSignInResult> {
  let running = false;
  return async (deps) => {
    if (running) {
      onBusy();
      return 'cancelled';
    }
    running = true;
    try {
      return await runDesktopBrowserSignIn(deps);
    } finally {
      running = false;
    }
  };
}
