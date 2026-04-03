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

/** Sign out the current user. */
export async function signOut(): Promise<void> {
  _cachedToken = null;
  _cachedTokenAt = 0;
  await clerkInstance?.signOut();
}

/** Clear the cached Clerk token (call when Convex signals a 401 via forceRefreshToken). */
export function clearClerkTokenCache(): void {
  _cachedToken = null;
  _cachedTokenAt = 0;
}

/**
 * Get a bearer token for premium API requests.
 * Uses the 'convex' JWT template which includes the `plan` claim.
 * Returns null if no active session.
 *
 * Tokens are cached for 50s (Clerk tokens expire at 60s) with in-flight
 * deduplication to prevent concurrent panels from racing against Clerk.
 */
let _cachedToken: string | null = null;
let _cachedTokenAt = 0;
let _tokenInflight: Promise<string | null> | null = null;
const TOKEN_CACHE_TTL_MS = 50_000;

export async function getClerkToken(): Promise<string | null> {
  if (_cachedToken && Date.now() - _cachedTokenAt < TOKEN_CACHE_TTL_MS) {
    return _cachedToken;
  }
  if (_tokenInflight) return _tokenInflight;

  _tokenInflight = (async () => {
    const session = clerkInstance?.session;
    if (!session) {
      console.warn(`[clerk] getClerkToken: no session (clerkInstance=${!!clerkInstance}, user=${!!clerkInstance?.user})`);
      _tokenInflight = null;
      return null;
    }
    try {
      // Try the 'convex' template first (includes plan claim for faster server-side checks).
      // Fall back to the standard session token if the template isn't configured in Clerk.
      const token = (await session.getToken({ template: 'convex' }).catch(() => null))
        ?? await session.getToken().catch(() => null);
      if (token) {
        _cachedToken = token;
        _cachedTokenAt = Date.now();
      }
      return token;
    } catch {
      return null;
    } finally {
      _tokenInflight = null;
    }
  })();
  return _tokenInflight;
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
  clerkInstance.mountUserButton(el, {
    afterSignOutUrl: window.location.href,
    appearance: getAppearance(),
  });
  return () => clerkInstance?.unmountUserButton(el);
}
