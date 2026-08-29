/**
 * Clerk JS initialization and thin wrapper.
 *
 * The SDK + UI controller are loaded as UMD bundles from the Clerk Frontend API
 * via <script> tags (see `loadClerkUmd`) rather than bundled. The v6 default
 * `import('@clerk/clerk-js')` resolves to the headless RHC build, whose runtime
 * UI-chunk loader breaks once Vite bundles it ("Clerk was not loaded with Ui
 * components"). Loading clerk.browser.js + @clerk/ui's ui.browser.js standalone
 * lets each resolve its own chunk host, and keeps ~1.5 MB off the bundle and off
 * the critical path. Three triggers can start the load:
 *   1. `scheduleClerkLoad()` — requestIdleCallback after first paint (the
 *      default for the main-app boot path; called from auth-state.ts).
 *   2. User interaction — `openSignIn`/`openSignUp`/`mountUserButton` force
 *      an immediate load on first call.
 *   3. Anything that needs a JWT — `getClerkToken()` forces an immediate
 *      load via `initClerk()` (the mcp-grant page also uses this directly).
 *
 * `subscribeClerk()` queues callbacks issued before the SDK is loaded so
 * `subscribeAuthState()` keeps working across the deferred-load window —
 * once Clerk hydrates, queued callbacks are attached and fired once so any
 * cookie-backed signed-in session lights up the UI without a refresh.
 */

import type { Clerk } from '@clerk/clerk-js';
import { enqueueSentryCall } from '@/bootstrap/sentry-defer';
import { EULA_PATH, PRIVACY_PATH, absoluteLegalUrl } from '../../shared/legal';
import { WEB_APP_ORIGIN } from '@/config/web-origin';

type ClerkInstance = Clerk;
type ClerkSession = NonNullable<ClerkInstance['session']>;

function readPublishableKey(): string | undefined {
  try {
    return import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  } catch {
    return undefined;
  }
}

const PUBLISHABLE_KEY = readPublishableKey();

/**
 * True when a Clerk publishable key is configured. Used by surfaces that must
 * distinguish "auth still hydrating" from "Clerk will never load" (e.g. the
 * Pro banner deferral in #5728 — without this, `isPending` stays sticky when
 * the key is absent and free users would never see the upsell).
 */
export function isClerkAuthEnabled(): boolean {
  return Boolean(PUBLISHABLE_KEY);
}

let clerkInstance: ClerkInstance | null = null;
let loadPromise: Promise<void> | null = null;
let loadScheduled = false;
const pendingSubscribers: Array<() => void> = [];
const pendingSubscriberDetachers = new WeakMap<() => void, { detached: boolean }>();

const MONO_FONT = "'SF Mono', Monaco, 'Cascadia Code', 'Fira Code', 'DejaVu Sans Mono', monospace";

function getAppearance() {
  const isDark = typeof document !== 'undefined'
    ? document.documentElement.dataset.theme !== 'light'
    : true;

  // Both naming generations are listed for every color. The @clerk/ui v1
  // bundle (loaded at runtime via __internal_ClerkUICtor) parses ONLY the
  // new names -- colorForeground / colorInput / colorInputForeground /
  // colorMutedForeground -- and silently ignores the legacy v5 names, so
  // without the new names text falls back to light-dark() defaults that
  // resolve near-black (e.g. invisible OTP digits on the dark card). The
  // legacy names stay for clerk-js's own legacy components. Unknown keys
  // are ignored by either parser, so the union is safe.

  // Sign-up carries the same assent as checkout (#6976): with these set, Clerk
  // renders Terms/Privacy links in the auth card footer, so a user creating an
  // account is shown the documents rather than only bound by a browsewrap.
  // Absolute because the desktop WebView origin has no /docs (#5911).
  const layout = {
    // The EULA, not the Terms: sign-up should show the document that states
    // what the account is licensed to do (#6983). Clerk exposes one "terms"
    // slot; the EULA links the Terms from its section 2.
    termsPageUrl: absoluteLegalUrl(EULA_PATH, WEB_APP_ORIGIN),
    privacyPageUrl: absoluteLegalUrl(PRIVACY_PATH, WEB_APP_ORIGIN),
  };

  return isDark
    ? {
        layout,
        variables: {
          colorBackground: '#0f0f0f',
          colorInputBackground: '#141414',
          colorInput: '#141414',
          colorInputText: '#e8e8e8',
          colorInputForeground: '#e8e8e8',
          colorText: '#e8e8e8',
          colorForeground: '#e8e8e8',
          colorTextSecondary: '#aaaaaa',
          colorMutedForeground: '#aaaaaa',
          colorPrimary: '#44ff88',
          colorPrimaryForeground: '#000000',
          colorNeutral: '#e8e8e8',
          colorDanger: '#ff4444',
          borderRadius: '4px',
          fontFamily: MONO_FONT,
          fontFamilyButtons: MONO_FONT,
        },
        elements: {
          card: { backgroundColor: '#111111', border: '1px solid #2a2a2a', boxShadow: '0 8px 32px rgba(0,0,0,0.6)' },
          headerTitle: { color: '#e8e8e8' },
          headerSubtitle: { color: '#aaaaaa' },
          dividerLine: { backgroundColor: '#2a2a2a' },
          dividerText: { color: '#666666' },
          formButtonPrimary: { color: '#000000', fontWeight: '600' },
          footerActionLink: { color: '#44ff88' },
          identityPreviewEditButton: { color: '#44ff88' },
          formFieldLabel: { color: '#cccccc' },
          formFieldInput: { borderColor: '#2a2a2a' },
          socialButtonsBlockButton: { borderColor: '#2a2a2a', color: '#e8e8e8', backgroundColor: '#141414' },
          socialButtonsBlockButtonText: { color: '#e8e8e8' },
          modalCloseButton: { color: '#888888' },
        },
      }
    : {
        layout,
        variables: {
          colorBackground: '#ffffff',
          colorInputBackground: '#f8f9fa',
          colorInput: '#f8f9fa',
          colorInputText: '#1a1a1a',
          colorInputForeground: '#1a1a1a',
          colorText: '#1a1a1a',
          colorForeground: '#1a1a1a',
          colorTextSecondary: '#555555',
          colorMutedForeground: '#555555',
          colorPrimary: '#16a34a',
          colorPrimaryForeground: '#ffffff',
          colorNeutral: '#1a1a1a',
          colorDanger: '#dc2626',
          borderRadius: '4px',
          fontFamily: MONO_FONT,
          fontFamilyButtons: MONO_FONT,
        },
        elements: {
          card: { backgroundColor: '#ffffff', border: '1px solid #d4d4d4', boxShadow: '0 4px 24px rgba(0,0,0,0.12)' },
          formButtonPrimary: { color: '#ffffff', fontWeight: '600' },
          footerActionLink: { color: '#16a34a' },
          identityPreviewEditButton: { color: '#16a34a' },
          socialButtonsBlockButton: { borderColor: '#d4d4d4' },
        },
      };
}

function getAfterSignOutUrl(): string {
  // Pin the after-sign-out destination to the origin root rather than
  // `window.location.href`. The current page URL may carry stale checkout
  // params or transient session fragments that should not persist into a
  // signed-out state. Origin-root is also unambiguous in Tauri WKWebView.
  return new URL('/', window.location.origin).toString();
}

// Version of @clerk/clerk-js to load from the Frontend API, injected at build
// time from package.json so the runtime SDK always matches the @clerk/clerk-js
// types we compile against. See vite.config.ts `define`. The `typeof` guard
// keeps this module importable under Node test runners where the Vite define
// is absent (mirrors stale-bundle-check.ts's __BUILD_HASH__ handling).
const CLERK_JS_VERSION = typeof __CLERK_JS_VERSION__ !== 'undefined' ? __CLERK_JS_VERSION__ : '';

// @clerk/ui major paired with @clerk/clerk-js v6. The UI controller ships in a
// SEPARATE package from the (headless) SDK and is loaded from the same Frontend
// API; its UMD bundle exposes `window.__internal_ClerkUICtor`, which we pass to
// `clerk.load()`. Bump this alongside any @clerk/clerk-js MAJOR upgrade.
const CLERK_UI_VERSION = '1';

// The SDK UMD bundle, loaded with a `data-clerk-publishable-key` attribute,
// auto-creates a (not-yet-loaded) Clerk instance on `window.Clerk` — it exposes
// the instance, NOT a constructor. We then drive `.load()` ourselves so the
// clerkUICtor / appearance / afterSignOutUrl options apply.
function getClerkInstance(): ClerkInstance | undefined {
  return (window as unknown as { Clerk?: ClerkInstance }).Clerk;
}

// UI controller constructor published by @clerk/ui's UMD bundle (ui.browser.js).
function getClerkUICtor(): unknown {
  return (window as unknown as { __internal_ClerkUICtor?: unknown }).__internal_ClerkUICtor;
}

/**
 * Derive the Clerk Frontend API host from the publishable key. Clerk keys are
 * `pk_(live|test)_<base64("<frontend-api>$")>` and carry no secret, so the host
 * is recoverable client-side — this mirrors Clerk's own parsePublishableKey.
 * Returns '' when the key is malformed.
 */
function clerkFapiHost(publishableKey: string): string {
  const encoded = publishableKey.replace(/^pk_(live|test)_/, '');
  try {
    return atob(encoded).replace(/\$+$/, '');
  } catch {
    return '';
  }
}

let umdLoadPromise: Promise<void> | null = null;

/** Inject a <script> from the Frontend API and resolve on load. */
function injectScript(src: string, attrs?: Record<string, string>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    if (attrs) for (const [k, v] of Object.entries(attrs)) script.setAttribute(k, v);
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => {
      script.remove();
      reject(new Error(`[clerk] failed to load ${src}`));
    }, { once: true });
    document.head.appendChild(script);
  });
}

/**
 * Load the Clerk SDK + UI controller from the Frontend API via <script> tags.
 *
 * The @clerk/clerk-js v6 default export (`import`) is the RHC build: it resolves
 * its UI-component chunk host from `document.currentScript`, which Vite bundling
 * breaks — so the UI controller never attaches and `openSignIn()` throws "Clerk
 * was not loaded with Ui components". The fix loads, from the Frontend API:
 *   1. `clerk.browser.js` (headless SDK) with `data-clerk-publishable-key`, which
 *      bootstraps a not-yet-loaded instance on `window.Clerk`; and
 *   2. `ui.browser.js` (@clerk/ui), which publishes `window.__internal_ClerkUICtor`.
 * `initClerk()` then calls `clerk.load({ clerkUICtor })` to attach the UI. Both
 * scripts resolve their own chunk hosts (loaded standalone, not bundled). See the
 * clerk-auth-gotchas skill. Clears the cached promise on failure so a transient
 * network error doesn't permanently poison auth.
 */
function loadClerkUmd(publishableKey: string): Promise<void> {
  if (getClerkInstance() && getClerkUICtor()) return Promise.resolve();
  if (umdLoadPromise) return umdLoadPromise;
  umdLoadPromise = (async () => {
    const host = clerkFapiHost(publishableKey);
    if (!host) throw new Error('[clerk] cannot derive Frontend API host from publishable key');
    const base = `https://${host}/npm`;
    await Promise.all([
      getClerkUICtor()
        ? Promise.resolve()
        : injectScript(`${base}/@clerk/ui@${CLERK_UI_VERSION}/dist/ui.browser.js`),
      getClerkInstance()
        ? Promise.resolve()
        : injectScript(`${base}/@clerk/clerk-js@${CLERK_JS_VERSION}/dist/clerk.browser.js`, {
            'data-clerk-publishable-key': publishableKey,
          }),
    ]);
    if (!getClerkInstance()) throw new Error('[clerk] clerk.browser.js loaded but window.Clerk instance missing');
    if (!getClerkUICtor()) throw new Error('[clerk] ui.browser.js loaded but window.__internal_ClerkUICtor missing');
  })().catch((e) => {
    umdLoadPromise = null; // allow retry on next call
    throw e;
  });
  return umdLoadPromise;
}

/**
 * Force Clerk to load now. Call when the SDK is required synchronously
 * (mcp-grant page bootstrap, getClerkToken on first authenticated request).
 * Idempotent — repeated calls return the same in-flight promise.
 */
export async function initClerk(): Promise<void> {
  if (clerkInstance) return;
  if (loadPromise) return loadPromise;
  if (!PUBLISHABLE_KEY) {
    console.warn('[clerk] VITE_CLERK_PUBLISHABLE_KEY not set, auth disabled');
    return;
  }
  loadPromise = (async () => {
    try {
      await loadClerkUmd(PUBLISHABLE_KEY);
      const clerk = getClerkInstance();
      if (!clerk) throw new Error('[clerk] window.Clerk unavailable after load');
      // `clerkUICtor` is the UI controller from @clerk/ui — a runtime load()
      // option the public types don't surface, so cast the options object.
      await clerk.load({
        clerkUICtor: getClerkUICtor(),
        appearance: getAppearance(),
        localization: {
          userButton: {
            action__manageAccount: 'Profile & security',
          },
        },
        afterSignOutUrl: getAfterSignOutUrl(),
      } as Parameters<typeof clerk.load>[0]);
      clerkInstance = clerk;
      attachPendingSubscribers();
    } catch (e) {
      loadPromise = null; // allow retry on next call
      // Flip auth isPending → false for queued subscribers even though
      // clerkInstance stays null. Without this, surfaces that defer while
      // auth is pending (Pro banner #5728, AuthHeaderWidget skeletons)
      // hang forever on permanent load failures (blocked CDN, CN in-app
      // browsers). Leave the queue intact so a later successful retry can
      // still attachListener + re-fire with a real session.
      notifyPendingSubscribersOfHydrationFailure();
      throw e;
    }
  })();
  return loadPromise;
}

/**
 * Schedule Clerk to load off the critical path. Returns synchronously after
 * scheduling; the actual `await import('@clerk/clerk-js')` happens on
 * `requestIdleCallback` (or `load`+microtask as fallback). Callers that
 * later need the SDK synchronously can still `await initClerk()` — it will
 * either return the in-flight promise or kick off the load early.
 */
export function scheduleClerkLoad(): void {
  if (clerkInstance || loadPromise || loadScheduled) return;
  if (!PUBLISHABLE_KEY) return;
  if (typeof window === 'undefined') return;
  loadScheduled = true;

  const startLoad = (): void => {
    // initClerk's idempotency guard handles re-entry from a concurrent
    // force-load (e.g. the user clicked Sign In before the idle callback
    // fired). Swallow rejection here — initClerk's own callers see the
    // throw via the promise it returns. Reset `loadScheduled` on failure
    // so a future `scheduleClerkLoad()` (e.g. retry after recovery from
    // a transient network blip) is not silently blocked by the guard —
    // initClerk's catch clears `loadPromise` for the same reason.
    void initClerk().catch(() => {
      loadScheduled = false;
    });
  };

  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof ric === 'function') {
    ric(startLoad, { timeout: 4000 });
    return;
  }
  // Safari / older browsers: defer past `load`, then a microtask so we
  // don't piggyback the load handler itself.
  if (document.readyState === 'complete') {
    setTimeout(startLoad, 0);
  } else {
    window.addEventListener('load', () => setTimeout(startLoad, 0), { once: true });
  }
}

/** Drain the subscriber queue once the SDK is live. */
function attachPendingSubscribers(): void {
  if (!clerkInstance) return;
  const queued = pendingSubscribers.splice(0, pendingSubscribers.length);
  for (const cb of queued) {
    if (pendingSubscriberDetachers.get(cb)?.detached) continue;
    const off = clerkInstance.addListener(cb);
    activeListenerDetachers.set(cb, off);
    // Fire once so subscribers learn about a cookie-backed signed-in
    // session that was already present before Clerk finished loading.
    cb();
  }
}

/**
 * Fire queued pre-load subscribers without consuming the queue.
 * Used when initClerk fails so `subscribeAuthState` can snapshot
 * `{ user: null, isPending: false }` instead of leaving the whole app
 * stuck on the boot-default pending session.
 */
function notifyPendingSubscribersOfHydrationFailure(): void {
  for (const cb of pendingSubscribers) {
    if (pendingSubscriberDetachers.get(cb)?.detached) continue;
    try {
      cb();
    } catch {
      // One subscriber must not block the rest of the settle fan-out.
    }
  }
}

const activeListenerDetachers = new WeakMap<() => void, () => void>();

/** Get the initialized Clerk instance. Returns null if not loaded. */
export function getClerk(): ClerkInstance | null {
  return clerkInstance;
}

// Chinese in-app browsers (WeChat/Weibo/QQ/UC/Baidu) routinely block or
// time out script loads from Cloudflare-fronted third-party hosts like
// clerk.worldmonitor.app — a `clerk-load-failed` there is environmental
// (Great-Firewall-class), not actionable, and not a Clerk-CDN-outage
// signal (WORLDMONITOR-T7). A real CDN outage still alarms via every
// other browser, so the load-failure capture keeps its value.
const CN_INAPP_BROWSER_RE = /MicroMessenger|Weibo|QQBrowser|UCBrowser|baiduboxapp/i;

// Report a Clerk UI-open failure as a single handled Sentry event. The deferred
// Sentry queue keeps @sentry/browser behind the shared scheduler, and telemetry
// stays strictly best-effort — it must never throw into a click handler.
function captureClerkSurfaceFailure(action: string, err: unknown, reason: string): void {
  if (reason === 'clerk-load-failed' && typeof navigator !== 'undefined' && CN_INAPP_BROWSER_RE.test(navigator.userAgent)) return;
  enqueueSentryCall((Sentry) => {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { surface: 'clerk', action, reason },
    });
  });
}

function scheduleNextFrame(cb: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => cb());
  else setTimeout(cb, 50);
}

/**
 * Open a Clerk UI surface (sign-in / sign-up modal) with one retry.
 *
 * Clerk's `openSignIn` / `openSignUp` call an internal
 * `assertComponentsReady` that throws SYNCHRONOUSLY ("Clerk was not loaded
 * with Ui components") when the session layer loaded but the UI component
 * controller never attached — a `load()`-resolved-before-components-mounted
 * race, or the component bundle being blocked by an ad-blocker / CSP. Left
 * unguarded that throw escaped as an uncaught error on every Sign In /
 * Create Account click (WORLDMONITOR-SC / -SD: ~2.3k events / ~1k users).
 *
 * Retry once on the next frame to absorb the mount race; if it still fails,
 * report a single handled event so a genuine regression still alarms without
 * flooding Sentry. Deliberately does NOT reset `clerkInstance` — that would
 * orphan the active auth-state listeners (`attachPendingSubscribers` drains
 * its queue, so a fresh load can't re-attach them).
 *
 * Exported for testing — the retry/capture state machine, decoupled from
 * Clerk and the frame scheduler.
 */
export function runClerkSurfaceOpen(
  open: () => void,
  onPersistentFailure: (err: unknown) => void,
  scheduleRetry: (cb: () => void) => void = scheduleNextFrame,
): void {
  try {
    open();
  } catch {
    scheduleRetry(() => {
      try {
        open();
      } catch (err) {
        onPersistentFailure(err);
      }
    });
  }
}

function openLoadedClerkSignIn(): void {
  clerkInstance?.openSignIn({ appearance: getAppearance() });
}

function openClerkSurface(action: 'open-sign-in' | 'open-sign-up'): void {
  const open = action === 'open-sign-in'
    ? openLoadedClerkSignIn
    : () => clerkInstance?.openSignUp({ appearance: getAppearance() });
  // Distinct reasons so Sentry can tell the "components not attached" race
  // (the surface open threw) apart from a "Clerk bundle never loaded" failure
  // (initClerk rejected: dynamic-import 4xx/5xx, transient network) — querying
  // by `reason` must not mix the two or it dilutes the race alert signal.
  const onFail = (reason: string) => (err: unknown): void => {
    console.error(`[clerk] ${action} failed (${reason}):`, err);
    captureClerkSurfaceFailure(action, err, reason);
  };
  if (clerkInstance) {
    runClerkSurfaceOpen(open, onFail('ui-components-not-ready'));
    return;
  }
  // Deferred-load fast path: user clicked before the idle callback fired.
  // Force the load, then open once the SDK is live so the click never
  // silently no-ops.
  void initClerk()
    .then(() => runClerkSurfaceOpen(open, onFail('ui-components-not-ready')))
    .catch(onFail('clerk-load-failed'));
}

/** Open the Clerk sign-in modal. */
export function openSignIn(): void {
  openClerkSurface('open-sign-in');
}

export function isClerkReady(): boolean {
  return clerkInstance !== null;
}

/** True when Clerk's sign-in (or other auth) modal is already on screen. */
export function isClerkSignInOpen(): boolean {
  if (!clerkInstance || typeof document === 'undefined') return false;
  try {
    return Boolean(document.querySelector(
      '.cl-modalBackdrop, .cl-modal, [data-clerk-component="SignIn"]',
    ));
  } catch {
    return false;
  }
}

const CLERK_SIGN_IN_OPEN_WAIT_MS = 2000;
const CLERK_SURFACE_RETRY_TIMEOUT_MS = 50;

/**
 * Schedule a one-shot retry on the next animation frame when available, and
 * always on a timeout so a background tab that never paints still retries.
 */
function scheduleClerkSurfaceRetry(cb: () => void): void {
  let ran = false;
  const run = (): void => {
    if (ran) return;
    ran = true;
    cb();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  setTimeout(run, CLERK_SURFACE_RETRY_TIMEOUT_MS);
}

export interface WaitForClerkSurfaceOpenOptions {
  /** When set, success means this predicate is true, not merely that open() did not throw. */
  isOpen?: () => boolean;
  signal?: AbortSignal;
}

function abortClerkSurfaceWait(signal?: AbortSignal): never {
  signal?.throwIfAborted();
  throw new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Wait until a Clerk surface open succeeds, persistently fails, or the wait
 * cap elapses. Settlement must not depend on rAF-only scheduling. Exported
 * so tests can drive the dual scheduler and wait cap without a Clerk instance.
 *
 * When `isOpen` is provided, a non-throwing `open()` is not enough: the
 * waiter keeps polling until the surface is actually present or the cap
 * elapses. An abort signal rejects without treating the surface as opened.
 */
export function waitForClerkSurfaceOpen(
  open: () => void,
  waitCapMs = CLERK_SIGN_IN_OPEN_WAIT_MS,
  scheduleRetry: (cb: () => void) => void = scheduleClerkSurfaceRetry,
  options?: WaitForClerkSurfaceOpenOptions,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    let waitCap: ReturnType<typeof setTimeout> | undefined;
    let presencePoll: ReturnType<typeof setTimeout> | undefined;
    const signal = options?.signal;
    const isOpen = options?.isOpen;

    const cleanup = (): void => {
      if (waitCap !== undefined) clearTimeout(waitCap);
      if (presencePoll !== undefined) clearTimeout(presencePoll);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ok);
    };
    const failAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        abortClerkSurfaceWait(signal);
      } catch (error) {
        reject(error);
      }
    };
    const onAbort = (): void => {
      failAbort();
    };

    if (signal?.aborted) {
      failAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    const surfaceReady = (): boolean => !isOpen || isOpen();
    let opened = false;
    const tryFinishOpened = (): void => {
      if (settled || !opened) return;
      if (surfaceReady()) finish(true);
    };
    const pollForPresence = (): void => {
      if (settled || !isOpen || presencePoll !== undefined) return;
      presencePoll = setTimeout(() => {
        presencePoll = undefined;
        if (settled) return;
        if (signal?.aborted) {
          failAbort();
          return;
        }
        tryFinishOpened();
        if (!settled && opened) pollForPresence();
      }, CLERK_SURFACE_RETRY_TIMEOUT_MS);
    };

    waitCap = setTimeout(() => finish(false), waitCapMs);
    runClerkSurfaceOpen(
      () => {
        open();
        opened = true;
      },
      () => finish(false),
      (retryOpen) => {
        scheduleRetry(() => {
          if (settled) return;
          if (signal?.aborted) {
            failAbort();
            return;
          }
          retryOpen();
          tryFinishOpened();
          if (!settled && opened && isOpen) pollForPresence();
        });
      },
    );
    tryFinishOpened();
    if (!settled && opened && isOpen) pollForPresence();
  });
}

/**
 * Returns false when Clerk is disabled, failed to load, or the UI surface
 * could not attach.
 */
export async function openSignInAndWait(signal?: AbortSignal): Promise<boolean> {
  if (!isClerkAuthEnabled()) return false;
  try {
    await initClerk();
  } catch {
    return false;
  }
  if (signal?.aborted) abortClerkSurfaceWait(signal);
  if (!clerkInstance || typeof clerkInstance.openSignIn !== 'function') return false;
  return waitForClerkSurfaceOpen(
    openLoadedClerkSignIn,
    CLERK_SIGN_IN_OPEN_WAIT_MS,
    scheduleClerkSurfaceRetry,
    { isOpen: isClerkSignInOpen, signal },
  );
}

/**
 * Open the Clerk sign-up modal.
 *
 * No-op if Clerk is not loaded OR if sign-up is disabled in the Clerk
 * dashboard. Symmetric with openSignIn — used by the "Create account"
 * CTA in AuthHeaderWidget to make the register funnel an explicit
 * first-class action rather than hiding it behind Clerk's sign-in
 * footer link.
 */
export function openSignUp(): void {
  openClerkSurface('open-sign-up');
}

/**
 * Epoch ms of the current Clerk user's account creation, or null when
 * signed out. Read at the source rather than projected through
 * getCurrentClerkUser() so analytics can gate fresh-signup detection on
 * a timestamp without widening the UI projection.
 */
export function getClerkUserCreatedAt(): number | null {
  const user = clerkInstance?.user;
  const createdAt = user?.createdAt;
  if (!createdAt) return null;
  return createdAt instanceof Date ? createdAt.getTime() : Number(createdAt);
}

/** Sign out the current user. */
export async function signOut(): Promise<void> {
  clearClerkTokenCache();
  await clerkInstance?.signOut();
}

/**
 * Clear the cached Clerk token. Call when:
 *   - Convex signals a 401 via forceRefreshToken
 *   - The observed Clerk user changes (account switch / sign-out)
 *
 * Bumping _tokenGen invalidates any promise that was already awaiting
 * session.getToken() before the clear. When that promise resolves, its
 * closure compares its captured generation to the current one and
 * refuses to write the stale token into the cache or return it to its
 * (now detached) callers. Without the generation check, an A→B switch
 * mid-fetch would let the old promise land A's JWT as B's cache entry
 * and poison the next 50 seconds of requests.
 */
export function clearClerkTokenCache(): void {
  _cachedToken = null;
  _cachedTokenAt = 0;
  _cachedSession = null;
  _tokenInflight = null;
  _tokenGen++;
  _clerkClockState = { kind: 'uncalibrated' };
}

/**
 * Get a bearer token for premium API requests.
 * Uses the 'convex' JWT template which includes the `plan` claim.
 * Returns null if no active session.
 *
 * Tokens are cached with in-flight deduplication to prevent concurrent panels
 * from racing against Clerk, bounded by BOTH the flat TTL below and the token's
 * own `exp` (see shouldReuseCachedClerkToken — the TTL alone is not enough).
 * A monotonic _tokenGen counter lets clearClerkTokenCache() invalidate
 * any mid-flight fetch whose result would otherwise paint the previous
 * user's JWT into the new session.
 */
let _cachedToken: string | null = null;
let _cachedTokenAt = 0;
let _cachedSession: ClerkSession | null = null;
let _tokenInflight: Promise<string | null> | null = null;
let _tokenGen = 0;
// Positive means the client clock is behind the issuer clock. This is measured
// from a token fetched with skipCache so a stale Clerk token cannot masquerade
// as a clock offset. Keep the modes explicit: a trusted zero skew is different
// from an opaque token that can only use the legacy flat TTL.
type ClerkClockState =
  | { kind: 'uncalibrated' }
  | { kind: 'trusted'; skewMs: number }
  | { kind: 'opaque-ttl' }
  | { kind: 'retry-after'; atMs: number };

let _clerkClockState: ClerkClockState = { kind: 'uncalibrated' };
const TOKEN_CACHE_TTL_MS = 50_000;
const CLOCK_CALIBRATION_RETRY_BACKOFF_MS = 5_000;

/**
 * How long before a token's own `exp` we stop reusing it.
 *
 * `server/auth-session.ts` applies only a small, bounded `clockTolerance`.
 * This larger client-side margin keeps cache reuse and request flight time from
 * consuming that entire server-side allowance.
 */
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 10_000;

function clockSkewMsForReuse(state: ClerkClockState): number | null {
  if (state.kind === 'trusted') return state.skewMs;
  if (state.kind === 'opaque-ttl') return 0;
  return null;
}

function effectiveClerkNowMs(now: number, state: ClerkClockState): number {
  return now + (state.kind === 'trusted' ? state.skewMs : 0);
}

function canCacheClerkToken(state: ClerkClockState): boolean {
  return state.kind === 'trusted' || state.kind === 'opaque-ttl';
}

type ClerkTokenClaimsMs = { exp: number | null; iat: number | null };

function clerkTokenClaimsMs(token: string | null): ClerkTokenClaimsMs {
  const payload = token?.split('.')[1];
  if (!payload) return { exp: null, iat: null };
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(
      atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)),
    ) as Record<string, unknown>;
    const toEpochMs = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? value * 1_000 : null;
    return { exp: toEpochMs(claims.exp), iat: toEpochMs(claims.iat) };
  } catch {
    return { exp: null, iat: null };
  }
}

/**
 * The `exp` claim of a Clerk JWT as epoch ms, or null when it cannot be read.
 *
 * Null (rather than throwing, or assuming expiry) keeps an unreadable token on
 * the flat-TTL path — the behaviour that predates this function — so a Clerk
 * token-format change degrades to the old caching instead of signing everyone
 * out. Reading `exp` needs no signature check: the server is the authority, and
 * a forged `exp` can only make this client refresh sooner.
 */
export function clerkTokenExpiresAtMs(token: string | null): number | null {
  return clerkTokenClaimsMs(token).exp;
}

type ClerkTokenReuseInput = {
  token: string | null;
  cachedAt: number;
  now: number;
  /** Issuer time minus client time, measured from a fresh Clerk token. */
  clockSkewMs?: number | null;
};

function shouldReuseCachedClerkTokenWithExpiry(
  input: ClerkTokenReuseInput,
  expiresAt: number | null,
): boolean {
  const { token, cachedAt, now, clockSkewMs } = input;
  if (!token) return false;
  if (now - cachedAt >= TOKEN_CACHE_TTL_MS) return false;
  if (expiresAt === null) return true;
  const effectiveNow = now + (
    typeof clockSkewMs === 'number' && Number.isFinite(clockSkewMs) ? clockSkewMs : 0
  );
  return effectiveNow < expiresAt - TOKEN_EXPIRY_SAFETY_MARGIN_MS;
}

/**
 * Whether the cached token can still sign a request. Both bounds must hold.
 *
 * The TTL alone was the bug (Sentry WORLDMONITOR-XR/XQ, and the May–July 2026
 * WORLDMONITOR-QK ramp): Clerk's `getToken()` is stale-while-revalidate —
 * within 15s of expiry it returns the CACHED token immediately and refreshes
 * in the background — so the premise this cache was built on ("Clerk tokens
 * expire at 60s", i.e. every token arrives fresh) does not hold. Stamping a
 * token that had 12s left with a flat 50s TTL left ~38s in which every request
 * it signed came back 401, healing only when the TTL lapsed. Which Sentry
 * bucket a leftover lands in depends on how dead it is by the time the edge
 * sees it — three outcomes, not two; see Two-Verifier Seam in CONCEPTS.md.
 * Still inside `exp` and rejected by Convex is QK; past `exp` but inside the
 * edge's `clockTolerance` also reaches Convex, and is kept out of QK by the
 * capture skip rather than by any edge 401; only past `exp` AND past that
 * tolerance is refused at the edge (XR/XQ).
 *
 * The TTL is still enforced on top: it is what bounds how long a session that
 * was revoked but not yet expired keeps working.
 */
export function shouldReuseCachedClerkToken(input: ClerkTokenReuseInput): boolean {
  return shouldReuseCachedClerkTokenWithExpiry(input, clerkTokenExpiresAtMs(input.token));
}

type ClerkTokenFetchResult = {
  token: string | null;
  unavailable: boolean;
};

async function fetchClerkToken(session: ClerkSession, skipCache = false): Promise<ClerkTokenFetchResult> {
  const cacheOptions = skipCache ? { skipCache: true } : {};
  let firstRequestSucceeded = false;
  try {
    const token = await session.getToken({ template: 'convex', ...cacheOptions });
    firstRequestSucceeded = true;
    if (token) return { token, unavailable: false };
  } catch { /* Try the standard session token below. */ }
  try {
    return { token: await session.getToken(cacheOptions), unavailable: false };
  } catch {
    return { token: null, unavailable: !firstRequestSucceeded };
  }
}

export async function getClerkToken(): Promise<string | null> {
  const now = Date.now();
  const clockState = _clerkClockState;
  const calibrationBackoffActive = clockState.kind !== 'retry-after'
    || now < clockState.atMs;
  const clockSkewMs = clockSkewMsForReuse(clockState);
  if (clerkInstance?.session === _cachedSession
    && clockSkewMs !== null
    && calibrationBackoffActive
    && shouldReuseCachedClerkToken({
      token: _cachedToken,
      cachedAt: _cachedTokenAt,
      now,
      clockSkewMs,
    })) {
    return _cachedToken;
  }
  if (_tokenInflight) return _tokenInflight;

  const myGen = _tokenGen;
  const promise: Promise<string | null> = (async () => {
    if (!clerkInstance && PUBLISHABLE_KEY) {
      try { await initClerk(); } catch { /* Clerk load failed, proceed with null */ }
    }
    // If a session invalidation fired during initClerk(), abandon.
    if (myGen !== _tokenGen) return null;
    const session = clerkInstance?.session;
    if (!session) {
      console.warn(`[clerk] getClerkToken: no session (clerkInstance=${!!clerkInstance}, user=${!!clerkInstance?.user})`);
      return null;
    }
    try {
      // Try the 'convex' template first (includes plan claim for faster server-side checks).
      // Fall back to the standard session token if the template isn't configured in Clerk.
      const initial = await fetchClerkToken(session);
      let token = initial.token;
      const firstFetchedAt = Date.now();
      let refreshUnavailable = false;
      let nextClockState = _clerkClockState;
      let tokenClaims = clerkTokenClaimsMs(token);
      const tokenNeedsRefresh = token && !shouldReuseCachedClerkTokenWithExpiry({
        token,
        cachedAt: firstFetchedAt,
        now: firstFetchedAt,
        clockSkewMs: clockSkewMsForReuse(nextClockState),
      }, tokenClaims.exp);
      const shouldRetryCalibration = nextClockState.kind === 'retry-after'
        && firstFetchedAt >= nextClockState.atMs;
      const calibrationBackoffActive = nextClockState.kind === 'retry-after'
        && !shouldRetryCalibration;
      const shouldCalibrateClock = token !== null && tokenClaims.iat !== null
        && (nextClockState.kind === 'uncalibrated'
          || nextClockState.kind === 'opaque-ttl'
          || shouldRetryCalibration);
      if (shouldRetryCalibration && tokenClaims.iat === null) {
        // Opaque/legacy tokens cannot provide a better clock sample.
        nextClockState = { kind: 'uncalibrated' };
      }
      // A first token cannot establish clock offset safely: it may be an older
      // stale-while-revalidate value whose age is indistinguishable from a fast
      // client clock. Force one fresh token so its iat is an issuer-time sample.
      if (token && ((tokenNeedsRefresh === true && !calibrationBackoffActive) || shouldCalibrateClock)) {
        // Clerk may return a near-expiry cached token while refreshing it in the
        // background. The initiating caller must not receive that stale token:
        // force one server refresh, then accept only a token outside the margin.
        const refreshed = await fetchClerkToken(session, true);
        if (refreshed.token) {
          // A successful fresh response is authoritative for both the token
          // and the issuer/client clock relationship.
          token = refreshed.token;
          tokenClaims = clerkTokenClaimsMs(refreshed.token);
          nextClockState = tokenClaims.iat === null
            ? { kind: 'opaque-ttl' }
            : { kind: 'trusted', skewMs: tokenClaims.iat - Date.now() };
        } else {
          // A failed forced refresh is distinct from a successful refresh that
          // still returns a near-expiry token. Preserve #5933's bounded fallback
          // when a trusted clock sample already exists; without one, returning
          // the original JWT could admit a near-expiry token on a slow client.
          refreshUnavailable = refreshed.unavailable;
          if (shouldCalibrateClock) {
            // Without a trusted sample, the local clock cannot safely decide
            // whether a JWT is still inside the server-side expiry margin.
            // Fail closed until a later bounded retry can calibrate it.
            nextClockState = {
              kind: 'retry-after',
              atMs: Date.now() + CLOCK_CALIBRATION_RETRY_BACKOFF_MS,
            };
          }
        }
      }
      if (nextClockState.kind === 'retry-after' && !shouldRetryCalibration
        && tokenClaims.iat !== null) {
        // A JWT remains unsafe to return while calibration is backed off.
        token = null;
      }
      // Opaque/legacy tokens have no issuer clock to sample. Preserve the
      // pre-existing flat-TTL behavior rather than adding an extra fetch that
      // cannot improve the expiry decision.
      if (token && nextClockState.kind === 'uncalibrated' && !shouldCalibrateClock
        && tokenNeedsRefresh !== true) {
        nextClockState = { kind: 'opaque-ttl' };
      }
      // If the session generation advanced while getToken() was in
      // flight, this JWT belongs to the previous user. Drop it on the
      // floor — do not cache, do not return.
      if (myGen !== _tokenGen || clerkInstance?.session !== session) return null;
      if (token === null && nextClockState.kind === 'retry-after') {
        _cachedToken = null;
        _cachedTokenAt = 0;
        _cachedSession = null;
      }
      _clerkClockState = nextClockState;
      const fetchedAt = Date.now();
      if (shouldReuseCachedClerkTokenWithExpiry({
        token,
        cachedAt: fetchedAt,
        now: fetchedAt,
        clockSkewMs: clockSkewMsForReuse(nextClockState),
      }, tokenClaims.exp)) {
        // Cache only after a trusted clock sample exists, or after the opaque
        // token path has explicitly opted back into the legacy flat TTL.
        if (canCacheClerkToken(nextClockState)) {
          _cachedToken = token;
          _cachedTokenAt = fetchedAt;
          _cachedSession = session;
        }
        return token;
      }
      // Deliberately uncached: serving a near-expiry token for the full TTL is
      // the stacked-cache defect this function was rewritten to fix, so the next
      // caller must go back to Clerk once it is reachable again.
      if (refreshUnavailable) {
        const expiresAt = clerkTokenExpiresAtMs(token);
        if (expiresAt === null || effectiveClerkNowMs(fetchedAt, nextClockState) < expiresAt) return token;
      }
      return null;
    } catch {
      return null;
    } finally {
      // Only clear _tokenInflight if we are still the current generation.
      // If clearClerkTokenCache() fired during our await it has already
      // nulled _tokenInflight AND bumped _tokenGen; a newer caller may
      // have assigned a fresh promise that we must not clobber.
      if (myGen === _tokenGen) _tokenInflight = null;
    }
  })();
  _tokenInflight = promise;
  return promise;
}

export function __setClerkInstanceForTests(instance: ClerkInstance | null): void {
  clerkInstance = instance;
  clearClerkTokenCache();
}


/** Get current Clerk user metadata. Returns null if signed out. */
export function getCurrentClerkUser(): { id: string; name: string; email: string; image: string | null; plan: 'free' | 'pro' } | null {
  const user = clerkInstance?.user;
  if (!user) return null;
  const plan = (user.publicMetadata as Record<string, unknown>)?.plan;
  return {
    id: user.id,
    name: user.fullName ?? user.firstName ?? 'User',
    email: user.primaryEmailAddress?.emailAddress ?? '',
    image: user.imageUrl ?? null,
    plan: plan === 'pro' ? 'pro' : 'free',
  };
}

/**
 * Subscribe to Clerk auth state changes.
 * Returns unsubscribe function.
 *
 * Callbacks issued before the SDK has finished its deferred load are
 * queued and attached once it does (and fired once at attach time so
 * a cookie-backed session becomes visible without a refresh). The
 * returned detacher works whether the SDK ever loads or not.
 */
export function subscribeClerk(callback: () => void): () => void {
  if (clerkInstance) return clerkInstance.addListener(callback);
  const handle = { detached: false };
  pendingSubscriberDetachers.set(callback, handle);
  pendingSubscribers.push(callback);
  return () => {
    handle.detached = true;
    const i = pendingSubscribers.indexOf(callback);
    if (i >= 0) pendingSubscribers.splice(i, 1);
    const realDetach = activeListenerDetachers.get(callback);
    if (realDetach) {
      realDetach();
      activeListenerDetachers.delete(callback);
    }
  };
}

/**
 * Mount Clerk's UserButton component into a DOM element.
 * Returns an unmount function.
 */
export interface UserButtonMenuActions {
  onBillingClick?: () => void;
  onSettingsClick?: () => void;
}

type UserButtonProps = NonNullable<Parameters<ClerkInstance['mountUserButton']>[1]>;
type CustomMenuItem = NonNullable<UserButtonProps['customMenuItems']>[number];
type MenuIconKind = 'billing' | 'settings';

function mountMenuIcon(el: HTMLDivElement, kind: MenuIconKind): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const paths = kind === 'billing'
    ? [
        'M3 6h18v12H3z',
        'M3 10h18',
        'M7 15h3',
      ]
    : [
        'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
        'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z',
      ];
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  el.replaceChildren(svg);
}

export function createAccountMenuItems(actions: UserButtonMenuActions): CustomMenuItem[] {
  const items: CustomMenuItem[] = [];
  if (actions.onBillingClick) {
    items.push({
      label: 'Plan & billing',
      onClick: actions.onBillingClick,
      mountIcon: (el) => mountMenuIcon(el, 'billing'),
      unmountIcon: (el) => el?.replaceChildren(),
    });
  }
  if (actions.onSettingsClick) {
    items.push({
      label: 'Settings',
      onClick: actions.onSettingsClick,
      mountIcon: (el) => mountMenuIcon(el, 'settings'),
      unmountIcon: (el) => el?.replaceChildren(),
    });
  }
  return items;
}

function getUserButtonProps(actions: UserButtonMenuActions): UserButtonProps {
  return {
    appearance: getAppearance(),
    customMenuItems: createAccountMenuItems(actions),
  };
}

export function mountUserButton(
  el: HTMLDivElement,
  actions: UserButtonMenuActions = {},
): () => void {
  if (!clerkInstance) {
    // Deferred-load path: the avatar widget asked to mount before Clerk
    // finished its idle-callback load. Trigger an immediate load and
    // mount once ready. Track unmount in a sentinel so an early
    // teardown still cancels.
    let cancelled = false;
    let realUnmount: (() => void) | null = null;
    void initClerk().then(() => {
      if (cancelled || !clerkInstance) return;
      clerkInstance.mountUserButton(el, getUserButtonProps(actions));
      realUnmount = () => clerkInstance?.unmountUserButton(el);
    });
    return () => {
      cancelled = true;
      realUnmount?.();
    };
  }
  clerkInstance.mountUserButton(el, getUserButtonProps(actions));
  return () => clerkInstance?.unmountUserButton(el);
}
