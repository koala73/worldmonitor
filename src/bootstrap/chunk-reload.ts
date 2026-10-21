interface EventTargetLike {
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
}

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

interface ChunkReloadGuardOptions {
  eventTarget?: EventTargetLike;
  storage?: StorageLike;
  eventName?: string;
  reload?: () => void;
}

const memorySessionStorage = new Map<string, string>();

function getSafeSessionStorage(): StorageLike {
  let browserStorage: StorageLike | undefined;
  try {
    browserStorage = window.sessionStorage;
  } catch {
    // Storage access can throw in sandboxed frames or when cookies are blocked.
  }

  return {
    getItem(key) {
      try {
        const stored = browserStorage?.getItem(key);
        if (stored !== null && stored !== undefined) return stored;
      } catch {
        // Fall through to the in-memory one-shot guard.
      }
      return memorySessionStorage.get(key) ?? null;
    },
    setItem(key, value) {
      try {
        browserStorage?.setItem(key, value);
        if (browserStorage) {
          memorySessionStorage.delete(key);
          return;
        }
      } catch {
        // Preserve one-shot behavior for read-only or otherwise blocked storage.
      }
      memorySessionStorage.set(key, value);
    },
    removeItem(key) {
      try {
        browserStorage?.removeItem(key);
      } catch {
        // The in-memory guard still needs to be cleared below.
      }
      memorySessionStorage.delete(key);
    },
  };
}

export function buildChunkReloadStorageKey(version: string): string {
  return `wm-chunk-reload:${version}`;
}

export function installChunkReloadGuard(
  version: string,
  options: ChunkReloadGuardOptions = {}
): string {
  const storageKey = buildChunkReloadStorageKey(version);
  const eventName = options.eventName ?? 'vite:preloadError';
  const eventTarget = options.eventTarget ?? window;
  const storage = options.storage ?? getSafeSessionStorage();
  const reload = options.reload ?? (() => window.location.reload());

  eventTarget.addEventListener(eventName, () => {
    if (storage.getItem(storageKey)) return;
    storage.setItem(storageKey, '1');
    reload();
  });

  return storageKey;
}

export function clearChunkReloadGuard(storageKey: string, storage?: StorageLike): void {
  (storage ?? getSafeSessionStorage()).removeItem(storageKey);
}
