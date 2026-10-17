/**
 * `localStorage` accessors that survive a browser without usable storage.
 *
 * Two distinct failure shapes. Android WebView with DOM storage disabled
 * exposes `localStorage` as NULL, so the call itself is a TypeError
 * (WORLDMONITOR-122). Sandboxed iframes and blocked cookies make the property
 * THROW on access, and a full disk makes the write throw. `typeof localStorage
 * !== 'undefined'` guards against neither, because `typeof null` is `'object'`.
 *
 * The try/catch is what makes every shape safe. The optional chain is there
 * because on an affected device null is a permanent steady state rather than an
 * error, and branching beats throwing and catching on every single access.
 *
 * Reads degrade to "key absent" and writes to a no-op, so callers treat storage
 * as best-effort rather than branching on availability. These are for small
 * flags. A caller storing anything big enough to hit the quota wants
 * `saveToStorage` from `@/utils`, which reports via `markStorageQuotaExceeded`.
 */

export function safeStorageGet(key: string): string | null {
  try {
    return localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function safeStorageSet(key: string, value: string): void {
  try {
    localStorage?.setItem(key, value);
  } catch {
    /* storage unavailable or full */
  }
}

export function safeStorageRemove(key: string): void {
  try {
    localStorage?.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

/**
 * The storage object, or `null` when it cannot be reached at all.
 *
 * Retrieving the handle has to be its own guarded step, separate from the
 * write. Both broken shapes have to end up as `null` here — the NULL property
 * and the property whose GETTER throws — because the checked writers below owe
 * their caller a different answer for "there is no store" (`true`, nothing
 * durable disagrees) than for "the store rejected this write" (`false`). With
 * the handle read inside the write's own `try`, a throwing getter fell into the
 * write's catch and reported a rejection, so on a sandboxed iframe or with
 * cookies blocked every cloud-pref write looked rejected and sign-in
 * terminated in an error state on every load (#7833 review, second round).
 */
function storageHandle(): Storage | null {
  try {
    return localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether storage is reachable at all right now.
 *
 * For the callers that must tell "storage is empty" apart from "storage is
 * unusable". Most callers should not need this — degrading to "key absent" is
 * the whole point of the accessors above — but a caller whose UI reports
 * SUCCESS does: settings export handed the user an empty file and a green
 * "Exported" toast on a browser where nothing could be read (#7833 review).
 */
export function isStorageAvailable(): boolean {
  try {
    return !!localStorage;
  } catch {
    return false;
  }
}

/**
 * Like `safeStorageSet`, but reports whether the value actually landed.
 *
 * Swallowing every failure is right for a best-effort flag and WRONG for a
 * caller that goes on to record durable state describing what it just wrote.
 * Cloud-prefs applies a downloaded blob and then advances the local sync
 * version; when a `QuotaExceededError` silently dropped one of those writes the
 * version advanced anyway, so the next upload posted the STALE local value back
 * over good cloud data. That is silent data loss, and it is why this variant
 * exists (#7833 review).
 *
 * Returns `false` ONLY when a usable store rejected the write. A browser with
 * no usable storage at all returns `true`: nothing was written, but nothing
 * durable disagrees either — the version marker the caller writes next is
 * equally inert, so the profile simply re-reconciles from scratch next load.
 * The dangerous case is precisely the mixed one, where the small marker fits
 * and the large value does not.
 */
export function safeStorageSetChecked(key: string, value: string): boolean {
  const store = storageHandle();
  if (store === null) return true;
  try {
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** `safeStorageRemove` with the same landed/not-landed report as above. */
export function safeStorageRemoveChecked(key: string): boolean {
  const store = storageHandle();
  if (store === null) return true;
  try {
    store.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Like `safeStorageGet`, but distinguishes "key absent" from "read failed".
 *
 * Degrading a failed read to `null` is right for a flag with a default and
 * WRONG for a caller that treats absence as intent. Cloud-prefs builds its
 * upload blob by reading each synced key and omitting the nulls; a throwing
 * read therefore looked like "the user cleared this", and the next upload
 * replaced the server blob and DELETED the unread preference from the cloud.
 * The raw read this replaced threw and aborted the upload (#7833 review).
 */
export function safeStorageGetChecked(key: string): { ok: boolean; value: string | null } {
  const store = storageHandle();
  if (store === null) return { ok: false, value: null };
  try {
    return { ok: true, value: store.getItem(key) };
  } catch {
    return { ok: false, value: null };
  }
}

/**
 * Every key/value pair in storage, or `ok: false` when reading them failed.
 *
 * For the caller that must not report success over a partial read. A handle can
 * exist while enumeration or an individual `getItem` throws, so
 * `isStorageAvailable()` is not enough on its own: settings export checked
 * availability, then built its payload from the degrading accessors, and
 * produced an empty file the UI still announced as a successful backup — the
 * exact outcome that check was added to prevent (#7833 review).
 *
 * The whole enumeration runs inside one `try`, so a throw part-way through
 * reports failure rather than silently truncating.
 */
export function safeStorageSnapshot(): { ok: boolean; entries: Array<[string, string]> } {
  const store = storageHandle();
  if (store === null) return { ok: false, entries: [] };
  try {
    const entries: Array<[string, string]> = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key === null) continue;
      const value = store.getItem(key);
      if (value !== null) entries.push([key, value]);
    }
    return { ok: true, entries };
  } catch {
    return { ok: false, entries: [] };
  }
}

/**
 * Every key currently in storage, or `[]` when storage is unusable.
 *
 * Snapshotting up front is deliberate: `localStorage.key(i)` is index-based
 * over a live collection, so a caller that removes while iterating shifts the
 * indices under itself and silently skips keys. Both callers here scan for a
 * prefix and then delete or read the matches, which is exactly that shape.
 */
export function safeStorageKeys(): string[] {
  try {
    if (!localStorage) return [];
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}
