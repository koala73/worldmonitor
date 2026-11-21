import { subscribeAuthState } from './auth-state';
import { getEntitlementState, isEntitled, onEntitlementChange } from './entitlements';
import { safeStorageRemove, safeStorageSet } from '@/utils/safe-storage';
import { DESKTOP_CLOUD_ACCESS_HINT_KEY as CLOUD_ACCESS_HINT_KEY, hasDesktopCloudAccessHint } from './desktop-cloud-access-hint';

/**
 * The credential a desktop request carries to the cloud through the sidecar.
 * Cloud data on desktop is a Pro feature: an entitled, signed-in user sends the
 * same Clerk bearer a Pro browser sends, and anyone else sends nothing (#9396).
 *
 * The entitlement cannot arrive before the first data wave: App.init loads
 * bootstrap before it starts auth, and Convex reports the plan only after
 * Clerk restores the session. A desktop whose last verified entitlement was
 * Pro therefore asks Clerk for the session token directly, which starts the
 * Clerk load at once, until this launch's own entitlement snapshot decides.
 * A desktop that gains Pro mid-session reloads once instead.
 */
export const DESKTOP_CLOUD_TOKEN_WAIT_MS = 8_000;
const RELOADED_SESSION_KEY = 'wm-desktop-cloud-reloaded';

let sentWithoutCredential = false;

function mayUseCloud(): boolean {
  if (isEntitled()) return true;
  // A snapshot from this launch is authoritative. Before it lands, trust the
  // last verified one.
  return getEntitlementState() === null && hasDesktopCloudAccessHint();
}

async function sessionToken(): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { getClerkToken } = await import('./clerk');
    return await Promise.race([
      getClerkToken(),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), DESKTOP_CLOUD_TOKEN_WAIT_MS); }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function getDesktopCloudAuthorization(): Promise<string | null> {
  const token = mayUseCloud() ? await sessionToken() : null;
  if (token) return `Bearer ${token}`;
  sentWithoutCredential = true;
  return null;
}

/**
 * Keeps the launch hint in step with the account and reloads once when cloud
 * access arrives after requests already went out without it.
 */
export function watchDesktopCloudAccess(reload: () => void): () => void {
  let hadAccess = isEntitled();
  const unsubscribeEntitlement = onEntitlementChange((state) => {
    const access = isEntitled();
    if (access) safeStorageSet(CLOUD_ACCESS_HINT_KEY, '1');
    // The auth handoff publishes null while it rebinds; that is not an answer.
    else if (state !== null) safeStorageRemove(CLOUD_ACCESS_HINT_KEY);
    if (access && !hadAccess && sentWithoutCredential && sessionStorageGet(RELOADED_SESSION_KEY) !== '1') {
      sessionStorageSet(RELOADED_SESSION_KEY, '1');
      reload();
    }
    hadAccess = access;
  });
  const unsubscribeAuth = subscribeAuthState((session) => {
    if (!session.isPending && session.user === null) safeStorageRemove(CLOUD_ACCESS_HINT_KEY);
  });
  return () => {
    unsubscribeEntitlement();
    unsubscribeAuth();
  };
}

function sessionStorageGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function sessionStorageSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Without session storage the reload guard is per page; the hint still
    // gives the reloaded page the credential.
  }
}
