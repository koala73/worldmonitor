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

type ClerkInstance = Clerk;

const PUBLISHABLE_KEY = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_CLERK_PUBLISHABLE_KEY) as string | undefined;

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

  return isDark
    ? {
        variables: {
          colorBackground: '#0f0f0f',
          colorInputBackground: '#141414',
          colorInputText: '#e8e8e8',
          colorText: '#e8e8e8',
          colorTextSecondary: '#aaaaaa',
          colorPrimary: '#44ff88',
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
        variables: {
          colorBackground: '#ffffff',
          colorInputBackground: '#f8f9fa',
          colorInputText: '#1a1a1a',
          colorText: '#1a1a1a',
          colorTextSecondary: '#555555',
          colorPrimary: '#16a34a',
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
        afterSignOutUrl: getAfterSignOutUrl(),
      } as Parameters<typeof clerk.load>[0]);
      clerkInstance = clerk;
      attachPendingSubscribers();
    } catch (e) {
      loadPromise = null; // allow retry on next call
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

// Report a Clerk UI-open failure as a single handled Sentry event. Lazy
// import keeps @sentry/browser off this module's static graph (clerk.ts is
// imported by Node test files where the browser SDK is unwanted) and makes
// telemetry strictly best-effort — it must never throw into a click handler.
function captureClerkSurfaceFailure(action: string, err: unknown, reason: string): void {
  if (reason === 'clerk-load-failed' && typeof navigator !== 'undefined' && CN_INAPP_BROWSER_RE.test(navigator.userAgent)) return;
  void import('@sentry/browser')
    .then((Sentry) => {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { surface: 'clerk', action, reason },
      });
    })
    .catch(() => {});
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

function openClerkSurface(action: 'open-sign-in' | 'open-sign-up'): void {
  const open = action === 'open-sign-in'
    ? () => clerkInstance?.openSignIn({ appearance: getAppearance() })
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
  _cachedToken = null;
  _cachedTokenAt = 0;
  _tokenInflight = null;
  _tokenGen++;
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
  _tokenInflight = null;
  _tokenGen++;
}

/**
 * Get a bearer token for premium API requests.
 * Uses the 'convex' JWT template which includes the `plan` claim.
 * Returns null if no active session.
 *
 * Tokens are cached for 50s (Clerk tokens expire at 60s) with in-flight
 * deduplication to prevent concurrent panels from racing against Clerk.
 * A monotonic _tokenGen counter lets clearClerkTokenCache() invalidate
 * any mid-flight fetch whose result would otherwise paint the previous
 * user's JWT into the new session.
 */
let _cachedToken: string | null = null;
let _cachedTokenAt = 0;
let _tokenInflight: Promise<string | null> | null = null;
let _tokenGen = 0;
const TOKEN_CACHE_TTL_MS = 50_000;

export async function getClerkToken(): Promise<string | null> {
  if (_cachedToken && Date.now() - _cachedTokenAt < TOKEN_CACHE_TTL_MS) {
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
      const token = (await session.getToken({ template: 'convex' }).catch(() => null))
        ?? await session.getToken().catch(() => null);
      // If the session generation advanced while getToken() was in
      // flight, this JWT belongs to the previous user. Drop it on the
      // floor — do not cache, do not return.
      if (myGen !== _tokenGen) return null;
      if (token) {
        _cachedToken = token;
        _cachedTokenAt = Date.now();
      }
      return token;
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
export function mountUserButton(el: HTMLDivElement): () => void {
  if (!clerkInstance) {
    // Deferred-load path: the avatar widget asked to mount before Clerk
    // finished its idle-callback load. Trigger an immediate load and
    // mount once ready. Track unmount in a sentinel so an early
    // teardown still cancels.
    let cancelled = false;
    let realUnmount: (() => void) | null = null;
    void initClerk().then(() => {
      if (cancelled || !clerkInstance) return;
      clerkInstance.mountUserButton(el, {
        appearance: getAppearance(),
      });
      realUnmount = () => clerkInstance?.unmountUserButton(el);
    });
    return () => {
      cancelled = true;
      realUnmount?.();
    };
  }
  clerkInstance.mountUserButton(el, {
    appearance: getAppearance(),
  });
  return () => clerkInstance?.unmountUserButton(el);
}
