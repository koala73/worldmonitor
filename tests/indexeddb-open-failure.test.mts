// Regression guard for Sentry WORLDMONITOR-1D1.
//
// Chrome rejects `indexedDB.open()` with `UnknownError: The user denied
// permission to access the database.` when site storage is blocked. `App.init`
// awaited `initDB()` directly, so that rejection failed the whole dashboard
// boot (reported as kind=boot_failure). The local database only holds
// baselines and playback snapshots, so a refused open must degrade like a
// missing `indexedDB` global, not stop the app.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

type FakeRequest = {
  result?: unknown;
  error?: unknown;
  onsuccess: null | (() => void);
  onerror: null | (() => void);
  onupgradeneeded: null | ((event: unknown) => void);
};

const originalIndexedDB = (globalThis as { indexedDB?: unknown }).indexedDB;

function installIndexedDB(open: () => FakeRequest): void {
  (globalThis as { indexedDB?: unknown }).indexedDB = { open };
}

function refusingOpen(): FakeRequest {
  const request: FakeRequest = { onsuccess: null, onerror: null, onupgradeneeded: null };
  queueMicrotask(() => {
    request.error = new DOMException('The user denied permission to access the database.', 'UnknownError');
    request.onerror?.();
  });
  return request;
}

async function freshStorage() {
  // A fresh module instance per test: storage.ts caches the open handle.
  return import(`../src/services/storage.ts?case=${Math.random()}`);
}

afterEach(() => {
  (globalThis as { indexedDB?: unknown }).indexedDB = originalIndexedDB;
});

describe('IndexedDB open refused by the browser', () => {
  it('initDB rejects with IndexedDBUnavailableError and keeps the browser error as cause', async () => {
    installIndexedDB(refusingOpen);
    const storage = await freshStorage();
    await assert.rejects(storage.initDB(), (err: unknown) => {
      assert.ok(err instanceof storage.IndexedDBUnavailableError);
      assert.equal((err as Error & { cause?: DOMException }).cause?.name, 'UnknownError');
      return true;
    });
  });

  it('a synchronous open() throw (sandboxed origin) is also reported as unavailable', async () => {
    installIndexedDB(() => {
      throw new DOMException('access denied for this origin', 'SecurityError');
    });
    const storage = await freshStorage();
    await assert.rejects(storage.initDB(), (err: unknown) => err instanceof storage.IndexedDBUnavailableError);
  });

  it('boot-time open degrades instead of rejecting', async () => {
    installIndexedDB(refusingOpen);
    const storage = await freshStorage();
    assert.equal(await storage.openStorageForBoot(), false);
  });

  it('reads degrade to empty and writes keep throwing the typed error', async () => {
    installIndexedDB(refusingOpen);
    const storage = await freshStorage();
    assert.equal(await storage.getBaseline('news:intel'), null);
    assert.deepEqual(await storage.getSnapshotTimestamps(), []);
    await assert.rejects(
      storage.updateBaseline('news:intel', 3),
      (err: unknown) => err instanceof storage.IndexedDBUnavailableError,
    );
  });

  it('positive control: a successful open resolves and boot reports storage available', async () => {
    const fakeDb = { onclose: null, objectStoreNames: { contains: () => true } };
    installIndexedDB(() => {
      const request: FakeRequest = { onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        request.result = fakeDb;
        request.onsuccess?.();
      });
      return request;
    });
    const storage = await freshStorage();
    assert.equal(await storage.initDB(), fakeDb);
    assert.equal(await storage.openStorageForBoot(), true);
  });

  it('positive control: a non-storage failure during boot open is not swallowed', async () => {
    installIndexedDB(() => {
      throw new TypeError('programming error');
    });
    const storage = await freshStorage();
    await assert.rejects(storage.openStorageForBoot(), TypeError);
  });
});
