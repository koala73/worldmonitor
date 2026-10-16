import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/utils/safe-storage';

export const BETA_MODE_STORAGE_KEY = 'worldmonitor-beta-mode';

export interface BetaConsoleToggleDeps {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  reload(): void;
  log(message: string): void;
}

function browserDeps(): BetaConsoleToggleDeps {
  return {
    get: safeStorageGet,
    set: safeStorageSet,
    remove: safeStorageRemove,
    reload() {
      location.reload();
    },
    log(message: string) {
      console.log(message);
    },
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
        deps.reload();
      },
    });
  } catch {
    return;
  }
}
