/**
 * Regression for #6781 / audit R22: `hydratePersistentCache` used to write
 * `this.lastDataState = { mode: 'unavailable', timestamp: entry.updatedAt, ... }`
 * when a persisted entry was past `cacheTtlMs` but still within the 24h
 * persistent-stale ceiling. That combo — `unavailable` mode paired with a
 * non-null timestamp — is one no other producer in this file emits; every
 * other `unavailable` write (constructor default, cooldown path, final
 * catch block) pairs it with `timestamp: null`.
 *
 * The write was provably dead: `hydratePersistentCache` only ever runs from
 * inside `execute()` (before its cache re-read), and `execute()`
 * unconditionally recomputes `lastDataState` synchronously afterward, with
 * no `await` in between that could let an external `getDataState()` call
 * observe the hydrate write. This test exercises the private hydrate method
 * directly (bypassing `execute()`'s masking) to pin down that the method
 * itself no longer leaves behind that odd state — independent of whether
 * any caller can currently observe it.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const CIRCUIT_BREAKER_URL = pathToFileURL(
  resolve(root, 'src/utils/circuit-breaker.ts'),
).href;

type StorageSnapshot = {
  exists: boolean;
  value: unknown;
};

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function snapshotGlobal(name: string): StorageSnapshot {
  return {
    exists: Object.prototype.hasOwnProperty.call(globalThis, name),
    value: (globalThis as Record<string, unknown>)[name],
  };
}

function restoreGlobal(name: string, snapshot: StorageSnapshot): void {
  if (snapshot.exists) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: snapshot.value,
    });
    return;
  }
  delete (globalThis as Record<string, unknown>)[name];
}

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

const originalGlobals = {
  localStorage: snapshotGlobal('localStorage'),
  window: snapshotGlobal('window'),
};

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  defineGlobal('localStorage', storage);
  delete (globalThis as Record<string, unknown>).window;
});

afterEach(() => {
  restoreGlobal('localStorage', originalGlobals.localStorage);
  restoreGlobal('window', originalGlobals.window);
});

describe('CircuitBreaker — hydratePersistentCache lastDataState (#6781 / audit R22)', () => {
  it('hydrating a stale-but-within-ceiling persisted entry does not report {mode: unavailable, timestamp: non-null}', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-hydrate-state`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      const breakerName = 'Hydrate State Test';
      const cacheTtlMs = 1_000;
      // Past cacheTtlMs but comfortably within the 24h persistent ceiling.
      const updatedAt = Date.now() - (cacheTtlMs + 5_000);

      storage.setItem(
        `worldmonitor-persistent-cache:breaker:${breakerName}`,
        JSON.stringify({
          key: `breaker:${breakerName}`,
          updatedAt,
          data: { value: 'persisted' },
        }),
      );

      const breaker = createCircuitBreaker({
        name: breakerName,
        cacheTtlMs,
        persistCache: true,
      });

      // Exercise the private hydrate path directly. execute() always
      // recomputes lastDataState synchronously right after calling this, so
      // the hydrate write can never surface through execute()/getDataState()
      // in practice — but the method itself must not leave behind a state
      // combo no other producer emits.
      await (breaker as unknown as {
        hydratePersistentCache: (cacheKey: string) => Promise<void>;
      }).hydratePersistentCache('__default__');

      const state = breaker.getDataState();
      assert.ok(
        !(state.mode === 'unavailable' && state.timestamp !== null),
        `hydrate must not leave lastDataState as {mode: 'unavailable', timestamp: non-null}; got ${JSON.stringify(state)}`,
      );
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('in-memory cache is still restored from the persisted entry (hydrate keeps its cache-restore side effect)', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-hydrate-cache-restore`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      const breakerName = 'Hydrate Cache Restore Test';
      const cacheTtlMs = 1_000;
      const updatedAt = Date.now() - (cacheTtlMs + 5_000);

      storage.setItem(
        `worldmonitor-persistent-cache:breaker:${breakerName}`,
        JSON.stringify({
          key: `breaker:${breakerName}`,
          updatedAt,
          data: { value: 'persisted' },
        }),
      );

      const breaker = createCircuitBreaker({
        name: breakerName,
        cacheTtlMs,
        persistCache: true,
      });

      await (breaker as unknown as {
        hydratePersistentCache: (cacheKey: string) => Promise<void>;
      }).hydratePersistentCache('__default__');

      assert.deepEqual(
        breaker.getCachedOrDefault({ value: 'fallback' }),
        { value: 'persisted' },
        'hydrate must still restore the persisted entry into the in-memory cache',
      );
    } finally {
      clearAllCircuitBreakers();
    }
  });
});
