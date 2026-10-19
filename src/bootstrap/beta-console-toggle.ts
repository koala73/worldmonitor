import { findReloadBlockingModal, type ModalDocumentLike } from '@/utils/open-modal';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/utils/safe-storage';

export const BETA_MODE_STORAGE_KEY = 'worldmonitor-beta-mode';

export interface BetaConsoleToggleDeps {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  reload(): void;
  log(message: string): void;
  /** Where open overlays are looked up; null means there is none to protect. */
  document: ModalDocumentLike | null;
}

function browserDeps(): BetaConsoleToggleDeps {
  // The injectable reload binding, as in sw-update and stale-bundle-check. The
  // setter below is the caller, and it consults findReloadBlockingModal first.
  const reload = (): void => location.reload();
  return {
    get: safeStorageGet,
    set: safeStorageSet,
    remove: safeStorageRemove,
    reload,
    log(message: string) {
      console.log(message);
    },
    document: typeof document === 'undefined' ? null : document,
  };
}

export function installBetaConsoleToggle(
  target: object,
  deps: BetaConsoleToggleDeps = browserDeps(),
): void {
  try {
    if (Object.getOwnPropertyDescriptor(target, 'beta')) return;
    Object.defineProperty(target, 'beta', {
      configurable: true,
      get() {
        const on = deps.get(BETA_MODE_STORAGE_KEY) === 'true';
        deps.log(`[Beta] ${on ? 'ON' : 'OFF'}`);
        return on;
      },
      set(v: boolean) {
        if (v) deps.set(BETA_MODE_STORAGE_KEY, 'true');
        else deps.remove(BETA_MODE_STORAGE_KEY);
        // A reload over an open sign-up form or other blocking overlay destroys
        // it (#8577). The flag is saved either way; it applies on the next load.
        const blocker = deps.document ? findReloadBlockingModal(deps.document) : null;
        if (blocker !== null) {
          deps.log(`[Beta] saved; not reloading while ${blocker.label} is open. Reload the page to apply.`);
          return;
        }
        deps.reload();
      },
    });
  } catch {
    return;
  }
}
