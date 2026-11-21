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

// A browser-initiated close — another tab's `versionchange`, iOS Safari
// killing IDB when the tab backgrounds, Chrome evicting the connection —
// rejects `database.transaction(...)` with `InvalidStateError`. The readonly
// path degraded that to `undefined`, `getBaseline` turned it into `null`, and
// `updateBaseline` read `null` as "no baseline yet" and rebuilt a one-sample
// entry. The write then opened a fresh connection and the put landed, so up to
// 30 days of counts were overwritten with a single sample, silently.
describe('IndexedDB connection closing during a baseline read', () => {
  type Store = {
    get: (key: string) => FakeRequest;
    put: (value: unknown) => FakeRequest;
  };

  function installClosingReads(existing: Record<string, unknown>) {
    const puts: unknown[] = [];
    const store: Store = {
      get(key) {
        const request: FakeRequest = { onsuccess: null, onerror: null, onupgradeneeded: null };
        queueMicrotask(() => { request.result = existing[key]; request.onsuccess?.(); });
        return request;
      },
      put(value) {
        puts.push(value);
        const request: FakeRequest = { onsuccess: null, onerror: null, onupgradeneeded: null };
        queueMicrotask(() => { request.onsuccess?.(); });
        return request;
      },
    };
    const fakeDb = {
      onclose: null,
      objectStoreNames: { contains: () => true },
      // Reads fail the way a closing connection fails; writes succeed, because
      // the failing read nulls the cached handle and the write reopens.
      transaction(_name: string, mode: string) {
        if (mode !== 'readwrite') {
          throw new DOMException('the connection is closing', 'InvalidStateError');
        }
        const tx = { oncomplete: null as null | (() => void), onerror: null, error: null,
          objectStore: () => store };
        queueMicrotask(() => tx.oncomplete?.());
        return tx;
      },
    };
    installIndexedDB(() => {
      const request: FakeRequest = { onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => { request.result = fakeDb; request.onsuccess?.(); });
      return request;
    });
    return { puts };
  }

  const thirtyDays = {
    key: 'news:intel',
    counts: Array.from({ length: 30 }, (_, i) => 100 + i),
    timestamps: Array.from({ length: 30 }, (_, i) => Date.now() - i * 60_000),
    avg7d: 110, avg30d: 114, lastUpdated: Date.now(),
  };

  it('updateBaseline refuses to write rather than rebuild from an unreadable baseline', async () => {
    const { puts } = installClosingReads({ 'news:intel': thirtyDays });
    const storage = await freshStorage();
    // Settle first, so the assertion that fails names the data loss rather
    // than the missing rejection.
    const outcome = await storage.updateBaseline('news:intel', 3)
      .then((entry: unknown) => ({ entry }), (err: unknown) => ({ err }));
    assert.deepEqual(puts, [], 'no sample may be written over history that could not be read');
    assert.ok(
      'err' in outcome && outcome.err instanceof storage.StorageReadUnavailableError,
      'an unreadable baseline must surface, not pass for a missing one',
    );
  });

  it('the degrading readers still degrade: absence is a default for playback', async () => {
    installClosingReads({});
    const storage = await freshStorage();
    assert.equal(await storage.getBaseline('news:intel'), null);
    assert.deepEqual(await storage.getSnapshotTimestamps(), []);
    assert.deepEqual(await storage.getSnapshots(), []);
  });
});

// Positive control: when the read works, updateBaseline still appends to the
// existing history rather than replacing it.
describe('baseline read-modify-write on a healthy connection', () => {
  it('appends the new sample to the stored counts', async () => {
    const stored: Record<string, unknown> = {
      'news:intel': {
        key: 'news:intel', counts: [10, 20], timestamps: [Date.now() - 2000, Date.now() - 1000],
        avg7d: 15, avg30d: 15, lastUpdated: Date.now() - 1000,
      },
    };
    const puts: unknown[] = [];
    const store = {
      get(key: string) {
        const request: FakeRequest = { onsuccess: null, onerror: null, onupgradeneeded: null };
        queueMicrotask(() => { request.result = stored[key]; request.onsuccess?.(); });
        return request;
      },
      put(value: unknown) {
        puts.push(value);
        const request: FakeRequest = { onsuccess: null, onerror: null, onupgradeneeded: null };
        queueMicrotask(() => { request.onsuccess?.(); });
        return request;
      },
    };
    const fakeDb = {
      onclose: null,
      objectStoreNames: { contains: () => true },
      transaction() {
        const tx = { oncomplete: null as null | (() => void), onerror: null, error: null,
          objectStore: () => store };
        queueMicrotask(() => tx.oncomplete?.());
        return tx;
      },
    };
    installIndexedDB(() => {
      const request: FakeRequest = { onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => { request.result = fakeDb; request.onsuccess?.(); });
      return request;
    });
    const storage = await freshStorage();
    const entry = await storage.updateBaseline('news:intel', 30);
    assert.deepEqual(entry.counts, [10, 20, 30]);
    assert.equal(puts.length, 1);
  });
});
