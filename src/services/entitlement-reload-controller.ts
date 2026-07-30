import { shouldReloadOnEntitlementChange } from './entitlements';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface EntitlementReloadControllerOptions {
  returnedFromCheckout?: boolean;
  storage?: StorageLike;
  reload?: () => void;
  onSnapshot?: () => void;
}

const ENTITLEMENT_RELOAD_GUARD_PREFIX = 'wm-entitlement-reload-account:v1:';

function getSessionStorage(): StorageLike | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

function guardKey(accountId: string): string | null {
  if (accountId.length === 0 || accountId.length > 256) return null;
  return `${ENTITLEMENT_RELOAD_GUARD_PREFIX}${accountId}`;
}

function hasGuard(storage: StorageLike | undefined, accountId: string): boolean {
  const key = guardKey(accountId);
  if (!storage || !key) return false;
  try {
    return storage.getItem(key) === '1';
  } catch {
    return false;
  }
}

/**
 * Persist and verify the one-shot marker before allowing navigation.
 *
 * This is deliberately fail-closed: sessionStorage can throw in restricted
 * browsing modes. In that case panel gating still updates in place, but the
 * app must not perform an automatic reload that it cannot prove will be
 * suppressed after the next boot.
 */
function persistGuard(storage: StorageLike | undefined, accountId: string): boolean {
  const key = guardKey(accountId);
  if (!storage || !key) return false;
  if (hasGuard(storage, accountId)) return true;
  try {
    storage.setItem(key, '1');
  } catch {
    return false;
  }
  return hasGuard(storage, accountId);
}

export function createEntitlementReloadController(
  options: EntitlementReloadControllerOptions = {},
): { handleSnapshot(entitled: boolean, accountId?: string | null): boolean } {
  const storage = options.storage ?? getSessionStorage();
  const reload = options.reload ?? (() => window.location.reload());
  let lastEntitled: boolean | null = options.returnedFromCheckout ? false : null;

  return {
    handleSnapshot(entitled, accountId = null) {
      const isUnlockTransition = shouldReloadOnEntitlementChange(lastEntitled, entitled);
      lastEntitled = entitled;

      // Gating is the primary unlock path and must run even when navigation is
      // suppressed. Calling it before reload also leaves the page usable if
      // the browser refuses the navigation.
      options.onSnapshot?.();

      if (!isUnlockTransition || !accountId) return false;
      if (hasGuard(storage, accountId)) return false;
      if (!persistGuard(storage, accountId)) return false;

      try {
        reload();
        return true;
      } catch (err) {
        console.warn('[entitlements] Automatic unlock reload failed; panels were unlocked in place:', err);
        return false;
      }
    },
  };
}
