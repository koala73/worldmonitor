import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createRenewableEnergyService,
  RENEWABLE_DATA_CACHE_KEY,
  RENEWABLE_DATA_STALE_CEILING_MS,
} from '../src/services/renewable-energy-data.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

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

function canonicalRenewableData() {
  return {
    globalPercentage: 42,
    globalYear: 2024,
    historicalData: [
      { year: 2022, value: 38 },
      { year: 2023, value: 40 },
      { year: 2024, value: 42 },
    ],
    regions: [
      { code: 'EUU', name: 'European Union', percentage: 50, year: 2024 },
    ],
  };
}

function legacyHardcodedSnapshot() {
  return {
    globalPercentage: 29.6,
    globalYear: 2022,
    historicalData: [{ year: 2022, value: 29.6 }],
    regions: [
      { code: 'LCN', name: 'Latin America & Caribbean', percentage: 58.1, year: 2022 },
    ],
  };
}

function createTestService(
  breakerName: string,
  fetchImpl: typeof globalThis.fetch,
  persistCache = false,
) {
  return createRenewableEnergyService({
    breakerName,
    persistCache,
    getHydrated: () => undefined,
    fetchImpl,
  });
}

async function flushPersistence(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

const originalGlobals = {
  localStorage: snapshotGlobal('localStorage'),
  window: snapshotGlobal('window'),
};
const originalNow = Date.now;
const originalWarn = console.warn;
const originalError = console.error;

let storage: MemoryStorage;
let now: number;

beforeEach(() => {
  storage = new MemoryStorage();
  now = Date.UTC(2026, 6, 24, 12, 0, 0);
  Date.now = () => now;
  defineGlobal('localStorage', storage);
  delete (globalThis as Record<string, unknown>).window;
  console.warn = () => {};
  console.error = () => {};
});

afterEach(() => {
  Date.now = originalNow;
  restoreGlobal('localStorage', originalGlobals.localStorage);
  restoreGlobal('window', originalGlobals.window);
  console.warn = originalWarn;
  console.error = originalError;
});

describe('renewable energy last-known-good recovery (#5497)', () => {
  it('stores a validated canonical response and reports it as live', async () => {
    const breakerName = 'Renewable Test Live';
    const service = createTestService(breakerName, async () =>
      new Response(JSON.stringify({
        data: { renewableEnergy: canonicalRenewableData() },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }), true);

    const result = await service.fetch();
    await flushPersistence();

    assert.deepEqual(result, {
      data: canonicalRenewableData(),
      state: 'live',
      cachedAt: null,
    });
    assert.ok(
      storage.getItem(`worldmonitor-persistent-cache:breaker:${breakerName}:${RENEWABLE_DATA_CACHE_KEY}`),
      'validated World Bank data must be persisted under the versioned cache key',
    );
  });

  it('serves bounded last-known-good data when a stale refresh fails', async () => {
    let refreshCalls = 0;
    let online = true;
    const cachedAt = now;
    const service = createTestService('Renewable Test Recovery', async () => {
      refreshCalls++;
      if (!online) throw new Error('simulated bootstrap outage');
      return new Response(JSON.stringify({
        data: { renewableEnergy: canonicalRenewableData() },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await service.fetch();

    now += 2 * 60 * 60 * 1000;
    online = false;

    const result = await service.fetch();
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual(result, {
      data: canonicalRenewableData(),
      state: 'cached',
      cachedAt,
    });
    assert.equal(refreshCalls, 2, 'stale last-known-good data must still trigger a refresh attempt');
  });

  it('stops serving in-memory last-known-good data after the seven-day ceiling', async () => {
    let refreshCalls = 0;
    let online = true;
    const service = createTestService('Renewable Test Long-Lived', async () => {
      refreshCalls++;
      if (!online) throw new Error('simulated bootstrap outage');
      return new Response(JSON.stringify({
        data: { renewableEnergy: canonicalRenewableData() },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await service.fetch();

    now += RENEWABLE_DATA_STALE_CEILING_MS + 1;
    online = false;

    const result = await service.fetch();
    await flushPersistence();

    assert.deepEqual(result, {
      data: null,
      state: 'unavailable',
      cachedAt: null,
    });
    assert.equal(refreshCalls, 2, 'the expired snapshot must still trigger a refresh attempt');
  });

  it('fails closed when no last-known-good data exists', async () => {
    const service = createTestService('Renewable Test Empty', async () => {
      throw new Error('simulated bootstrap outage');
    });

    const result = await service.fetch();

    assert.deepEqual(result, {
      data: null,
      state: 'unavailable',
      cachedAt: null,
    });
  });

  it('does not reuse the legacy cache key that may contain the hardcoded snapshot', async () => {
    const breakerName = 'Renewable Test Legacy';
    const legacyKey = `breaker:${breakerName}`;
    storage.setItem(
      `worldmonitor-persistent-cache:${legacyKey}`,
      JSON.stringify({
        key: legacyKey,
        updatedAt: now,
        data: legacyHardcodedSnapshot(),
      }),
    );
    const service = createTestService(breakerName, async () => {
      throw new Error('simulated bootstrap outage');
    }, true);

    const result = await service.fetch();

    assert.equal(result.data, null);
    assert.equal(result.state, 'unavailable');
  });

  it('rejects last-known-good data outside the seven-day ceiling', async () => {
    const breakerName = 'Renewable Test Expired';
    const seedService = createTestService(breakerName, async () =>
      new Response(JSON.stringify({
        data: { renewableEnergy: canonicalRenewableData() },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }), true);
    await seedService.fetch();
    await flushPersistence();

    now += RENEWABLE_DATA_STALE_CEILING_MS + 1;
    const recoveryService = createTestService(breakerName, async () => {
      throw new Error('simulated bootstrap outage');
    }, true);

    const result = await recoveryService.fetch();

    assert.deepEqual(result, {
      data: null,
      state: 'unavailable',
      cachedAt: null,
    });
  });

  it('does not cache malformed bootstrap payloads', async () => {
    const breakerName = 'Renewable Test Malformed';
    const service = createTestService(breakerName, async () =>
      new Response(JSON.stringify({
        data: {
          renewableEnergy: {
            globalPercentage: 142,
            globalYear: 2024,
            historicalData: [],
            regions: [],
          },
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }), true);

    const result = await service.fetch();
    await flushPersistence();

    assert.equal(result.data, null);
    assert.equal(
      storage.getItem(`worldmonitor-persistent-cache:breaker:${breakerName}:${RENEWABLE_DATA_CACHE_KEY}`),
      null,
    );
  });

  it('only allows live canonical observations to trigger happy-variant milestones', () => {
    const dataLoader = readFileSync(resolve(root, 'src/app/data-loader.ts'), 'utf8');
    assert.match(
      dataLoader,
      /SITE_VARIANT === 'happy'\s*&&\s*result\.state === 'live'\s*&&\s*result\.data\?\.globalPercentage/,
    );
    assert.match(dataLoader, /renewablePercent:\s*result\.data\.globalPercentage/);
  });
});
