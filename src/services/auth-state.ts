import { enqueueSentryCall } from '@/bootstrap/sentry-defer';
import {
  getCurrentClerkUser,
  isClerkAuthEnabled,
  scheduleClerkLoad,
  subscribeClerk,
} from './clerk';

/** Minimal user profile exposed to UI components. */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  role: 'free' | 'pro';
}

/** Simplified auth session state for UI consumption. */
export interface AuthSession {
  user: AuthUser | null;
  isPending: boolean;
}

let _currentSession: AuthSession = { user: null, isPending: true };

function snapshotSession(): AuthSession {
  const cu = getCurrentClerkUser();
  if (!cu) {
    enqueueSentryCall((s) => s.setUser(null));
    return { user: null, isPending: false };
  }
  enqueueSentryCall((s) => s.setUser({ id: cu.id }));
  return {
    user: {
      id: cu.id,
      name: cu.name,
      email: cu.email,
      image: cu.image,
      role: cu.plan,
    },
    isPending: false,
  };
}

/**
 * Initialize auth state. Call once at app startup before UI subscribes.
 *
 * Does NOT await `initClerk()` — the @clerk/clerk-js bundle is ~2.98 MB
 * and 96% unused on first paint, so awaiting it here would block the
 * App.init() chain (panel layout, data fetches, etc.) on a load that
 * isn't needed until the user reaches for auth. Instead, schedule the
 * load via `scheduleClerkLoad()` (idle-callback after first paint).
 *
 * When Clerk is configured, leaves `_currentSession` at the module-level
 * default `{ user: null, isPending: true }` — calling `snapshotSession()`
 * before the deferred SDK load would make a cookie-backed signed-in user look
 * anonymously settled for up to 4 s. The pending-callback queue in clerk.ts
 * fires the subscribeAuthState listener as soon as Clerk loads, snapshots the
 * real session, and flips `isPending` to `false`.
 *
 * When Clerk is not configured, no authenticated session can appear. Settle
 * immediately as anonymous instead of leaving every auth consumer pending
 * until its own fallback timer expires.
 */
export async function initAuthState(): Promise<void> {
  if (!isClerkAuthEnabled()) {
    _currentSession = snapshotSession();
    return;
  }
  scheduleClerkLoad();
}

/**
 * Subscribe to reactive auth state changes.
 * @returns Unsubscribe function.
 */
export function subscribeAuthState(callback: (state: AuthSession) => void): () => void {
  // Emit current state immediately
  callback(_currentSession);

  return subscribeClerk(() => {
    _currentSession = snapshotSession();
    callback(_currentSession);
  });
}

/**
 * Synchronous snapshot of current auth state.
 */
export function getAuthState(): AuthSession {
  return _currentSession;
}
