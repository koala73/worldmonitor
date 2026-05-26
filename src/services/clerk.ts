/**
 * Clerk JS initialization and thin wrapper.
 *
 * Uses dynamic import so the module is safe to import in Node.js test
 * environments where @clerk/clerk-js (browser-only) is not available.
 */

import type { Clerk } from '@clerk/clerk-js';

type ClerkInstance = Clerk;

const PUBLISHABLE_KEY = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_CLERK_PUBLISHABLE_KEY) as string | undefined;

let clerkInstance: ClerkInstance | null = null;
let loadPromise: Promise<void> | null = null;

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

/** Initialize Clerk. Call once at app startup. */
export async function initClerk(): Promise<void> {
  if (clerkInstance) return;
  if (loadPromise) return loadPromise;
  if (!PUBLISHABLE_KEY) {
    console.warn('[clerk] VITE_CLERK_PUBLISHABLE_KEY not set, auth disabled');
    return;
  }
  loadPromise = (async () => {
    try {
      const { Clerk } = await import('@clerk/clerk-js');
      const clerk = new Clerk(PUBLISHABLE_KEY);
      await clerk.load({ appearance: getAppearance() });
      clerkInstance = clerk;
    } catch (e) {
      loadPromise = null; // allow retry on next call
      throw e;
    }
  })();
  return loadPromise;
}

/** Get the initialized Clerk instance. Returns null if not loaded. */
export function getClerk(): ClerkInstance | null {
  return clerkInstance;
}

/** Open the Clerk sign-in modal. */
export function openSignIn(): void {
  clerkInstance?.openSignIn({ appearance: getAppearance() });
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
  clerkInstance?.openSignUp({ appearance: getAppearance() });
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
 */
export function subscribeClerk(callback: () => void): () => void {
  if (!clerkInstance) return () => {};
  return clerkInstance.addListener(callback);
}

/**
 * Mount Clerk's UserButton component into a DOM element.
 * Returns an unmount function.
 */
export function mountUserButton(el: HTMLDivElement): () => void {
  if (!clerkInstance) return () => {};
  // Pin the after-sign-out destination to the origin root rather than
  // `window.location.href`. The current page URL may carry stale
  // checkout params (e.g., a subscription_id/status query that
  // handleCheckoutReturn hasn't cleaned yet at sign-out time) or
  // transient session fragments that shouldn't persist into a
  // signed-out state. Origin-root is unambiguous and identical on
  // Tauri desktop (same absolute URL resolves correctly in WKWebView).
  clerkInstance.mountUserButton(el, {
    afterSignOutUrl: new URL('/', window.location.origin).toString(),
    appearance: getAppearance(),
  });
  return () => clerkInstance?.unmountUserButton(el);
}
