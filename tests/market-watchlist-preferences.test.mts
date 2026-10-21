import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  MARKET_CATALOG_SELECTION_STORAGE_KEY,
  MARKET_WATCHLIST_EVENT,
  MARKET_WATCHLIST_STORAGE_KEY,
  resetMarketWatchlistPreferences,
  setMarketWatchlistPreferences,
} from '../src/services/market-watchlist.ts';

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');

let values: Map<string, string>;
let events: Array<{ type: string; detail: unknown }>;

beforeEach(() => {
  values = new Map();
  events = [];
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dispatchEvent: (event: { type: string; detail: unknown }) => events.push(event) },
  });
  Object.defineProperty(globalThis, 'CustomEvent', {
    configurable: true,
    value: class {
      type: string;
      detail: unknown;
      constructor(type: string, init: { detail: unknown }) {
        this.type = type;
        this.detail = init.detail;
      }
    },
  });
});

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: unknown }).window;
  if (originalCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', originalCustomEvent);
  else delete (globalThis as { CustomEvent?: unknown }).CustomEvent;
});

describe('atomic market watchlist preferences', () => {
  it('persists catalog and custom layers with one change event', () => {
    setMarketWatchlistPreferences({
      catalogSelection: ['SAP', 'AAPL', 'SAP'],
      entries: [{ symbol: ' PLTR ', name: ' Palantir ' }],
    });

    assert.equal(values.get(MARKET_CATALOG_SELECTION_STORAGE_KEY), '["SAP","AAPL"]');
    assert.equal(values.get(MARKET_WATCHLIST_STORAGE_KEY), '[{"symbol":"PLTR","name":"Palantir"}]');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, MARKET_WATCHLIST_EVENT);
  });

  it('clears both layers with one coherent reset event', () => {
    values.set(MARKET_CATALOG_SELECTION_STORAGE_KEY, '["SAP"]');
    values.set(MARKET_WATCHLIST_STORAGE_KEY, '[{"symbol":"PLTR"}]');

    resetMarketWatchlistPreferences();

    assert.equal(values.has(MARKET_CATALOG_SELECTION_STORAGE_KEY), false);
    assert.equal(values.has(MARKET_WATCHLIST_STORAGE_KEY), false);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]?.detail, { entries: [], catalogSelection: null });
  });
});
