import { findReloadBlockingModal, type ModalDocumentLike } from '@/utils/open-modal';

interface EventTargetLike {
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
}

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

/**
 * The document surface needed for the modal probe and the visibilitychange
 * retry trigger. Extends ModalDocumentLike so the fake cannot model a document
 * that answers visibilitychange but not the modal probe.
 */
interface DocumentTargetLike extends ModalDocumentLike {
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  visibilityState?: string;
}

interface ChunkReloadGuardOptions {
  eventTarget?: EventTargetLike;
  storage?: StorageLike;
  eventName?: string;
  reload?: () => void;
  documentTarget?: DocumentTargetLike;
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
  const documentTarget = options.documentTarget;

  /**
   * True when a vite:preloadError has been seen but a modal is blocking
   * the reload. The session key is NOT written until the reload actually
   * fires, so the one-shot guard is still available for the retry.
   */
  let pendingReload = false;

  /**
   * Probe the live DOM at the moment of the irreversible action. If a
   * blocking modal is open, remember the debt and return. On clear DOM,
   * burn the session key and reload.
   *
   * No document means no modal to protect — reload immediately.
   */
  const reloadOrDefer = (): void => {
    const blocker = documentTarget ? findReloadBlockingModal(documentTarget) : null;
    if (blocker !== null) {
      pendingReload = true;
      return;
    }
    pendingReload = false;
    storage.setItem(storageKey, '1');
    reload();
  };

  /**
   * Retry handler: fires on focus and visibilitychange. A no-op when no
   * reload is owed; otherwise re-probes the DOM and fires if clear.
   */
  const retryHandler = (): void => {
    if (!pendingReload) return;
    reloadOrDefer();
  };

  eventTarget.addEventListener(eventName, () => {
    if (storage.getItem(storageKey)) return;
    reloadOrDefer();
  });

  // Retry the deferred reload when the user returns to the tab.
  eventTarget.addEventListener('focus', retryHandler);

  if (documentTarget) {
    documentTarget.addEventListener('visibilitychange', () => {
      if (documentTarget.visibilityState === 'visible') retryHandler();
    });
  }

  return storageKey;
}

export function clearChunkReloadGuard(storageKey: string, storage?: StorageLike): void {
  (storage ?? getSafeSessionStorage()).removeItem(storageKey);
}
