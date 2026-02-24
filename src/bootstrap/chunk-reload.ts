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
  const storage = options.storage ?? sessionStorage;
  const reload = options.reload ?? (() => window.location.reload());

  eventTarget.addEventListener(eventName, () => {
    if (storage.getItem(storageKey)) return;
    storage.setItem(storageKey, '1');
    reload();
  });

  return storageKey;
}

export function clearChunkReloadGuard(storageKey: string, storage: StorageLike = sessionStorage): void {
  storage.removeItem(storageKey);
}
