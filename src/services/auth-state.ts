import * as Sentry from '@sentry/browser';
import { getCurrentClerkUser, scheduleClerkLoad, subscribeClerk } from './clerk';

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
    Sentry.setUser(null);
    return { user: null, isPending: false };
  }
  Sentry.setUser({ id: cu.id });
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
 * load via `scheduleClerkLoad()` (idle-callback after first paint) and
 * snapshot the session as signed-out for now. When Clerk finishes
 * loading, the subscribeClerk pending-callback queue (see clerk.ts)
 * fires the listener registered below with the real session — cookie-
 * backed signed-in users light up the UI without a refresh.
 */
export async function initAuthState(): Promise<void> {
  scheduleClerkLoad();
  _currentSession = snapshotSession();
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
