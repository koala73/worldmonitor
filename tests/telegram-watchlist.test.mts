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
    assert.equal(normalizeTelegramUsername('https://t.me/Ukraine_News/?ref=wm'), 'ukraine_news');
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

  it('throws and does not publish a false state when storage rejects a write', () => {
    setTelegramWatchlistEntries([{ username: 'existing_channel' }]);
    const stored = globalThis.localStorage.getItem('telegram:watchlist:v1');
    const snapshots: string[][] = [];
    const unsubscribe = subscribeTelegramWatchlistChange(entries => {
      snapshots.push(entries.map(entry => entry.username));
    });

    globalThis.localStorage = {
      getItem: () => stored,
      setItem: () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 1,
    };

    assert.throws(
      () => addTelegramWatchlistEntry({ username: 'another_channel' }),
      /Telegram watchlist could not be saved/,
    );
    assert.deepEqual(getTelegramWatchlistEntries(), [{ username: 'existing_channel' }]);
    assert.deepEqual(snapshots, []);
    unsubscribe();
  });

  it('publishes persisted changes from another browser tab', () => {
    const snapshots: string[][] = [];
    const unsubscribe = subscribeTelegramWatchlistChange(entries => {
      snapshots.push(entries.map(entry => entry.username));
    });
    globalThis.localStorage.setItem('telegram:watchlist:v1', JSON.stringify([
      { username: 'cross_tab_channel', title: 'Cross Tab' },
    ]));
    const event = new Event('storage');
    Object.defineProperty(event, 'key', { value: 'telegram:watchlist:v1' });
    globalThis.window.dispatchEvent(event);

    assert.deepEqual(snapshots, [['cross_tab_channel']]);
    unsubscribe();
    globalThis.window.dispatchEvent(event);
    assert.deepEqual(snapshots, [['cross_tab_channel']]);
  });

  it('caps persisted and returned entries at 20', () => {
    const entries = Array.from({ length: 25 }, (_, index) => ({
      username: `channel_${String(index).padStart(2, '0')}`,
    }));

    const stored = setTelegramWatchlistEntries(entries);

    assert.equal(stored.length, 20);
    assert.equal(getTelegramWatchlistEntries().length, 20);
    assert.equal(addTelegramWatchlistEntry({ username: 'channel_99' }).length, 20);
  });

  it('rejects an add at the cap instead of silently truncating it away', () => {
    const entries = Array.from({ length: 20 }, (_, index) => ({
      username: `channel_${String(index).padStart(2, '0')}`,
    }));
    setTelegramWatchlistEntries(entries);

    const after = addTelegramWatchlistEntry({ username: 'channel_99' });

    // A length check alone cannot tell "rejected" from "appended then
    // truncated" — both give 20. The appended entry was the one normalizeEntries
    // dropped, so the add reported success while doing nothing.
    assert.equal(after.length, 20);
    assert.ok(
      !after.some(entry => entry.username === 'channel_99'),
      'the over-cap entry must not be persisted',
    );
    assert.ok(
      !getTelegramWatchlistEntries().some(entry => entry.username === 'channel_99'),
    );
    // The existing roster must survive the rejected add untouched.
    assert.equal(after[0]?.username, 'channel_00');
    assert.equal(after[19]?.username, 'channel_19');
  });

  it('still updates the title when re-adding a channel already at the cap', () => {
    const entries = Array.from({ length: 20 }, (_, index) => ({
      username: `channel_${String(index).padStart(2, '0')}`,
    }));
    setTelegramWatchlistEntries(entries);

    const after = addTelegramWatchlistEntry({ username: 'channel_05', title: 'Renamed' });

    assert.equal(after.length, 20);
    assert.equal(after.find(entry => entry.username === 'channel_05')?.title, 'Renamed');
  });
});
