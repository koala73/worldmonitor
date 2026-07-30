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

/**
 * Claim and verify a new one-shot marker before allowing navigation.
 *
 * This is deliberately fail-closed: sessionStorage can throw in restricted
 * browsing modes. In that case panel gating still updates in place, but the
 * app must not perform an automatic reload that it cannot prove will be
 * suppressed after the next boot.
 */
function persistNewGuard(storage: StorageLike | undefined, accountId: string): boolean {
  const key = guardKey(accountId);
  if (!storage || !key) return false;

  // A failed read is not evidence that the marker is absent. Do not retry the
  // read inside this navigation attempt: a later successful read of an
  // existing marker must never be mistaken for a newly persisted marker.
  try {
    if (storage.getItem(key) === '1') return false;
  } catch {
    return false;
  }

  try {
    storage.setItem(key, '1');
  } catch {
    return false;
  }

  try {
    return storage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function createEntitlementReloadController(
  options: EntitlementReloadControllerOptions = {},
): { handleSnapshot(entitled: boolean | null, accountId?: string | null): boolean } {
  const storage = options.storage ?? getSessionStorage();
  const reload = options.reload ?? (() => window.location.reload());
  const lastEntitledByAccount = new Map<string, boolean>();
  let checkoutSeedAvailable = options.returnedFromCheckout === true;

  return {
    handleSnapshot(entitled, accountId = null) {
      // Gating is the primary unlock path and must run even when navigation is
      // suppressed. Calling it before reload also leaves the page usable if
      // the browser refuses the navigation.
      options.onSnapshot?.();

      // resetEntitlementState() publishes null during auth handoff. It is an
      // unavailable snapshot, not evidence of a free plan, so it must not turn
      // an existing Pro user's first real snapshot into a false free→Pro edge.
      // The checkout-return false seed is intentionally preserved as well.
      if (entitled === null || !accountId) return false;

      const hasAccountSnapshot = lastEntitledByAccount.has(accountId);
      const lastEntitled = hasAccountSnapshot
        ? lastEntitledByAccount.get(accountId)!
        : checkoutSeedAvailable
          ? false
          : null;
      if (!hasAccountSnapshot && checkoutSeedAvailable) {
        checkoutSeedAvailable = false;
      }

      const isUnlockTransition = shouldReloadOnEntitlementChange(lastEntitled, entitled);
      lastEntitledByAccount.set(accountId, entitled);

      if (!isUnlockTransition) return false;
      if (!persistNewGuard(storage, accountId)) return false;

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
