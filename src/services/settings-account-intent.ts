/**
 * `/dashboard?settings=account`: open Settings on the Account page.
 *
 * Emails link here so a Pro Monthly subscriber lands on the Pro Yearly switch.
 * Account exists only for a signed-in session, and at boot Clerk has not
 * loaded yet (it loads on idle), so opening Settings straight from the URL
 * would land a signed-in subscriber on Display. The intent waits for the
 * session to settle instead:
 *
 *   signed in              open Account
 *   signed out             open sign-in once, then Account after sign-in
 *   build without sign-in  open Settings
 *
 * Capture strips the param (keeping utm_* and the rest) and persists the
 * intent, because the map URL sync rewrites the address bar about 250 ms
 * after boot and an OAuth sign-in returns to that rewritten URL.
 */

export const ACCOUNT_SETTINGS_PARAM = 'settings';
export const ACCOUNT_SETTINGS_VALUE = 'account';

const PENDING_ACCOUNT_SETTINGS_KEY = 'wm-pending-account-settings';
// Long enough to finish a sign-in, short enough that an abandoned sign-in
// does not open Settings on an unrelated later one.
export const PENDING_ACCOUNT_SETTINGS_TTL_MS = 15 * 60 * 1000;

type IntentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface AccountSettingsIntentDeps {
  getAuth: () => { isPending: boolean; userId: string | null };
  canSignIn: () => boolean;
  openAccount: () => void;
  openSettings: () => void;
  openSignIn: () => void;
  now?: () => number;
  storage?: IntentStorage | null;
}

export type AccountSettingsResume = 'none' | 'waiting' | 'sign-in' | 'opened';

export interface AccountSettingsIntent {
  /** Strip `?settings=account` from the URL and persist the intent. */
  capture(location?: Pick<Location, 'href'>, replaceUrl?: (url: string) => void): boolean;
  /** True while an intent from this load or a fresh stored one is waiting. */
  isPending(): boolean;
  /** Act on a waiting intent for the current session. Safe to call on every auth emission. */
  resume(): AccountSettingsResume;
}

function defaultStorage(): IntentStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function createAccountSettingsIntent(deps: AccountSettingsIntentDeps): AccountSettingsIntent {
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  const now = deps.now ?? Date.now;
  // Capture time on this load: the intent holds without storage, and expires with the same TTL.
  let capturedAt: number | null = null;
  let promptedSignIn = false;

  const clear = (): void => {
    capturedAt = null;
    try {
      storage?.removeItem(PENDING_ACCOUNT_SETTINGS_KEY);
    } catch {
      // Ignore storage failures.
    }
  };

  const storedFresh = (): boolean => {
    let raw: string | null = null;
    try {
      raw = storage?.getItem(PENDING_ACCOUNT_SETTINGS_KEY) ?? null;
    } catch {
      return false;
    }
    if (raw === null) return false;
    const savedAt = Number(raw);
    if (Number.isFinite(savedAt) && now() - savedAt <= PENDING_ACCOUNT_SETTINGS_TTL_MS) return true;
    clear();
    return false;
  };

  const capturedFresh = (): boolean => {
    if (capturedAt === null) return false;
    if (now() - capturedAt <= PENDING_ACCOUNT_SETTINGS_TTL_MS) return true;
    clear();
    return false;
  };

  const isPending = (): boolean => capturedFresh() || storedFresh();

  return {
    capture(location, replaceUrl) {
      const href = location?.href ?? (typeof window === 'undefined' ? '' : window.location.href);
      if (!href) return false;
      let url: URL;
      try {
        url = new URL(href);
      } catch {
        return false;
      }
      if (url.searchParams.get(ACCOUNT_SETTINGS_PARAM) !== ACCOUNT_SETTINGS_VALUE) return false;
      url.searchParams.delete(ACCOUNT_SETTINGS_PARAM);
      const replace = replaceUrl ?? ((next: string) => window.history.replaceState(window.history.state, '', next));
      try {
        replace(url.toString());
      } catch {
        // A refresh would capture again; harmless.
      }
      capturedAt = now();
      try {
        storage?.setItem(PENDING_ACCOUNT_SETTINGS_KEY, String(capturedAt));
      } catch {
        // Without storage the intent still holds for this load.
      }
      return true;
    },

    isPending,

    resume() {
      if (!isPending()) return 'none';
      const auth = deps.getAuth();
      if (auth.isPending) return 'waiting';
      if (auth.userId) {
        clear();
        deps.openAccount();
        return 'opened';
      }
      if (!deps.canSignIn()) {
        clear();
        deps.openSettings();
        return 'opened';
      }
      // Keep the intent for the sign-in that follows; prompt once per load so
      // later signed-out auth emissions do not reopen a dismissed sign-in.
      if (!promptedSignIn) {
        promptedSignIn = true;
        deps.openSignIn();
      }
      return 'sign-in';
    },
  };
}
