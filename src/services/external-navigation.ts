/**
 * Runtime-correct "send the user to this URL, outside the app".
 *
 * Desktop (Tauri) hands the URL to the OS browser through the `open_url` IPC
 * command. Navigating the WebView itself replaces the entire app with a
 * third-party page and leaves the user with no browser chrome to get back; for
 * payment pages it also runs 3DS/fraud checks inside an embedded WebView,
 * which is exactly the nesting that hung Dodo checkouts in #4449.
 *
 * Web keeps the popup-blocker dance: browsers only honour `window.open()`
 * inside a live user gesture, so a caller may reserve a blank tab
 * synchronously in its click handler (`prereserveExternalTab`) and pass the
 * handle here to be navigated once the async work resolves.
 *
 * The Rust side of `open_url` accepts `https://` only (plus `http://` for
 * localhost) and opens through the OS default handler, never a shell — see
 * `src-tauri/src/main.rs` and `src-tauri/open-url-safety.test.mjs`. The same
 * URL-scheme gate is checked here before any native or browser fallback so an
 * unsupported scheme cannot be reopened by `window.open`. It is exported
 * (`isOpenableExternalUrl`) so callers that cancel a click before delegating —
 * the anchor interceptor in `app/event-handlers.ts` — can gate on the SAME
 * predicate; a looser gate there turns every URL this module refuses into a
 * dead click.
 *
 * NOTE for anyone touching a `window.open` here: this module deliberately does
 * NOT pass `noopener`/`noreferrer`, because either one makes `window.open`
 * return null while still opening the tab, and every branch below reads that
 * handle to decide what happened. `openWindowWithHandle` severs `opener`
 * manually instead. See its comment before changing a feature string.
 */

import { enqueueSentryCall } from '@/bootstrap/sentry-defer';
import { isDesktopRuntime } from './desktop-runtime';
import { invokeTauri } from './tauri-bridge';

/**
 * Ceiling on the native round-trip. `invokeTauri` has no timeout of its own,
 * and an IPC call that never settles would strand every awaiting caller —
 * including `startCheckout`, whose `_checkoutInFlight` re-entrancy guard is
 * released only in a `finally`, so a hung open would silently no-op every
 * subsequent upgrade click until the app restarts. On web the equivalent path
 * navigated the tab away, so nothing survived to be stuck; desktop keeps
 * running, which is what makes the bound necessary here.
 */
const OPEN_URL_TIMEOUT_MS = 5_000;

/**
 * Schemes the native side accepts (`src-tauri/src/main.rs` -> `open_url`):
 * https anywhere, http only for localhost. Checked here too so a rejected URL
 * is not silently re-opened by the `window.open` fallback below — that would
 * hand the renderer a target the native allowlist had just refused.
 */
export function isOpenableExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:'
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/** Origin only — a billing-portal session URL is credential-bearing. */
function originForTelemetry(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return 'unparseable';
  }
}

function reportOpenFailure(url: string, reason: string): void {
  enqueueSentryCall((s) => s.captureMessage('[external-navigation] open_url failed', {
    level: 'warning',
    tags: { component: 'external-navigation', action: 'open_url', reason },
    // The URL itself is withheld: portal session URLs are bearer-like.
    extra: { origin: originForTelemetry(url), reason },
  }));
}

/** Distinguishes "the native side said no" from "it never answered". */
class OpenUrlTimeout extends Error {}

/**
 * Race the IPC call against a CANCELLABLE timer.
 *
 * `Promise.race` subscribes to every promise it is given, so a losing timer
 * rejection is already handled and never surfaces as an unhandled rejection —
 * but an uncleared timer still keeps a 5s handle alive per call, so it is
 * cleared on both paths.
 */
async function invokeOpenUrlBounded(url: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      invokeTauri<void>('open_url', { url }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new OpenUrlTimeout('open_url timed out')), OPEN_URL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * `window.open` that actually yields a handle.
 *
 * `noopener` — and `noreferrer`, which implies it — makes `window.open`
 * return `null` PER SPEC while still opening the tab. Every caller here
 * branches on the handle, so passing those features turned each success into
 * an apparent blocked popup: `prereserveExternalTab` never returned a tab,
 * the desktop fallback could only ever report `'failed'`, and the web branch
 * ran its same-tab `assign` on top of a tab it had just opened. Measured in
 * Chrome: `window.open(url, '_blank', 'noopener,noreferrer')` is `null` with
 * the tab present in the tab list.
 *
 * The opener link is severed manually instead, which is the only thing those
 * features were bought for here — every URL routed through this module is
 * first-party-initiated and scheme-gated above. The referrer degrades from
 * absent to origin-only, which is the platform default
 * (`strict-origin-when-cross-origin`) for cross-origin targets.
 */
function openWindowWithHandle(url: string): Window | null {
  const win = window.open(url, '_blank');
  if (win) {
    try {
      win.opener = null;
    } catch {
      // Cross-origin setter refused (older engines). The tab still opened,
      // and the handle is still the answer to "did it open?".
    }
  }
  return win;
}

/**
 * Reserve a blank tab SYNCHRONOUSLY inside a click handler so an async
 * external navigation can land in it without tripping the popup blocker.
 * Callers must call this before awaiting anything, then pass the handle to
 * `openExternalUrl`.
 *
 * Returns `null` on desktop: the URL leaves for the OS browser, so there is
 * no popup to pre-reserve, and a blank `window.open` inside the Tauri WebView
 * would strand an empty window behind the app.
 */
export function prereserveExternalTab(): Window | null {
  if (isDesktopRuntime()) return null;
  return openWindowWithHandle('');
}

/**
 * Where the URL actually went. Callers that tell the user something happened
 * ("checkout opened in your browser") must branch on this rather than assume
 * success — a swallowed failure claiming success is worse than no message.
 */
export type ExternalNavOutcome = 'native' | 'popup' | 'same-tab' | 'failed';

export interface OpenExternalUrlOptions {
  /**
   * Whether a blocked popup may fall back to navigating the CURRENT tab.
   *
   * Default `true`: for an upgrade CTA, losing the dashboard beats a dead
   * click. Pass `false` from any surface holding unsaved user input — the
   * runtime-config panels stage API keys in memory (`pendingSecrets`), and a
   * same-tab navigation discards them silently. Those callers get `'failed'`
   * and can surface it themselves.
   */
  sameTabFallback?: boolean;
}

export async function openExternalUrl(
  url: string | URL,
  preopened?: Window | null,
  options?: OpenExternalUrlOptions,
): Promise<ExternalNavOutcome> {
  const targetUrl = typeof url === 'string' ? url : url.toString();
  if (!isOpenableExternalUrl(targetUrl)) {
    reportOpenFailure(targetUrl, 'rejected-scheme');
    if (preopened && !preopened.closed) preopened.close();
    return 'failed';
  }

  if (isDesktopRuntime()) {
    // A pre-reserved tab is a web-only workaround. Close any handle a caller
    // reserved before it knew the runtime, so the OS browser doesn't come
    // forward over an orphaned blank WebView window.
    if (preopened && !preopened.closed) preopened.close();
    try {
      await invokeOpenUrlBounded(targetUrl);
      return 'native';
    } catch (err) {
      if (err instanceof OpenUrlTimeout) {
        // Deliberately NO window.open fallback here. The IPC call is not
        // cancellable, so a slow-but-alive `open_url` may still complete
        // after we gave up — falling back would open the URL twice, once in
        // a WebView and once in the OS browser. For a payment page that is
        // worse than a clean failure, and the caller can retry.
        reportOpenFailure(targetUrl, 'native-open-timeout');
        return 'failed';
      }
      // Bridge globals are not always present at first paint, so this path is
      // reachable in production — report it, because falling back to
      // `window.open` inside Tauri reproduces the very bug this module exists
      // to fix, and a silent reproduction is unfindable.
      reportOpenFailure(targetUrl, 'native-open-failed');
      return openWindowWithHandle(targetUrl) ? 'popup' : 'failed';
    }
  }

  if (preopened && !preopened.closed) {
    preopened.location.href = targetUrl;
    return 'popup';
  }
  const fresh = openWindowWithHandle(targetUrl);
  if (fresh) return 'popup';
  // Genuinely blocked, and no reserved tab. Same-tab navigation beats
  // silently doing nothing for an upgrade CTA — but not for a caller holding
  // unsaved input, which opts out and gets the failure instead.
  if (options?.sameTabFallback === false) {
    reportOpenFailure(targetUrl, 'popup-blocked');
    return 'failed';
  }
  window.location.assign(targetUrl);
  return 'same-tab';
}
