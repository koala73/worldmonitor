import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  addTelegramWatchlistEntry,
  getTelegramWatchlistEntries,
  normalizeTelegramUsername,
  removeTelegramWatchlistEntry,
  setTelegramWatchlistEntries,
  subscribeTelegramWatchlistChange,
} from '../src/services/telegram-watchlist';

class MiniStorage {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}

const originalWindow = globalThis.window;
const originalLocalStorage = globalThis.localStorage;
const originalCustomEvent = globalThis.CustomEvent;

beforeEach(() => {
  const eventTarget = new EventTarget() as EventTarget & Window;
  globalThis.window = eventTarget;
  globalThis.localStorage = new MiniStorage() as Storage;
  globalThis.CustomEvent = class<T> extends Event {
    detail: T;

    constructor(type: string, init?: CustomEventInit<T>) {
      super(type);
      this.detail = init?.detail as T;
    }
  } as typeof CustomEvent;
});

afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.localStorage = originalLocalStorage;
  globalThis.CustomEvent = originalCustomEvent;
});

describe('telegram-watchlist', () => {
  it('normalizes handles and public Telegram URLs', () => {
    assert.equal(normalizeTelegramUsername('@Ukraine_News'), 'ukraine_news');
    assert.equal(normalizeTelegramUsername('https://t.me/Ukraine_News/'), 'ukraine_news');
    assert.equal(normalizeTelegramUsername('bad handle'), '');
  });

  it('stores deduped entries under telegram:watchlist:v1', () => {
    setTelegramWatchlistEntries([
      { username: '@ukraine_news', title: 'Ukraine News' },
      { username: 'ukraine_news', title: 'Duplicate' },
      { username: 'https://t.me/israelalerts' },
    ]);

    assert.deepEqual(getTelegramWatchlistEntries(), [
      { username: 'ukraine_news', title: 'Ukraine News' },
      { username: 'israelalerts' },
    ]);

    assert.equal(
      globalThis.localStorage.getItem('telegram:watchlist:v1'),
      JSON.stringify([
        { username: 'ukraine_news', title: 'Ukraine News' },
        { username: 'israelalerts' },
      ]),
    );
  });

  it('publishes watchlist change events for add and remove', () => {
    const snapshots: string[][] = [];
    const unsubscribe = subscribeTelegramWatchlistChange(entries => {
      snapshots.push(entries.map(entry => entry.username));
    });

    addTelegramWatchlistEntry({ username: '@ukraine_news', title: 'Ukraine News' });
    addTelegramWatchlistEntry({ username: 'israelalerts' });
    removeTelegramWatchlistEntry('@ukraine_news');
    unsubscribe();

    assert.deepEqual(snapshots, [
      ['ukraine_news'],
      ['ukraine_news', 'israelalerts'],
      ['israelalerts'],
    ]);
  });
});
