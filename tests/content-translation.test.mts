import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  getCachedContentTranslation,
  resetContentTranslationCacheForTests,
  shouldTranslateContent,
  translateContentText,
} from '../src/services/content-translation.ts';

class FakeStorage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.values.has(key) ? this.values.get(key) ?? null : null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

let fakeStorage: FakeStorage;

const originalLocalStorage = {
  exists: Object.prototype.hasOwnProperty.call(globalThis, 'localStorage'),
  value: globalThis.localStorage,
};

beforeEach(() => {
  fakeStorage = new FakeStorage();
  globalThis.localStorage = fakeStorage as unknown as Storage;
  resetContentTranslationCacheForTests();
});

afterEach(() => {
  resetContentTranslationCacheForTests();
  if (originalLocalStorage.exists) {
    globalThis.localStorage = originalLocalStorage.value;
    return;
  }
  delete globalThis.localStorage;
});

describe('content translation helpers', () => {
  it('only auto-translates when target language is non-English and differs from source', () => {
    assert.equal(shouldTranslateContent('en', 'fr'), false);
    assert.equal(shouldTranslateContent('fr', 'fr'), false);
    assert.equal(shouldTranslateContent('fr-PT', 'fr-FR'), false);
    assert.equal(shouldTranslateContent('pt', 'en'), true);
    assert.equal(shouldTranslateContent('es', undefined), true);
  });

  it('caches successful translations and reuses them on subsequent calls', async () => {
    let calls = 0;
    const translator = async (input: string, lang: string): Promise<string> => {
      calls += 1;
      return `${lang}:${input}`;
    };

    const first = await translateContentText('Market stress is rising', 'pt', { translator });
    const second = await translateContentText('Market stress is rising', 'pt', { translator });

    assert.equal(first, 'pt:Market stress is rising');
    assert.equal(second, 'pt:Market stress is rising');
    assert.equal(calls, 1);
    assert.equal(
      getCachedContentTranslation('Market stress is rising', 'pt'),
      'pt:Market stress is rising',
    );
  });

  it('deduplicates concurrent translation requests for the same text', async () => {
    let calls = 0;
    const translator = async (input: string, lang: string): Promise<string> => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return `${lang}:${input}`;
    };

    const [first, second] = await Promise.all([
      translateContentText('Headline', 'de', { translator }),
      translateContentText('Headline', 'de', { translator }),
    ]);

    assert.equal(first, 'de:Headline');
    assert.equal(second, 'de:Headline');
    assert.equal(calls, 1);
  });

  it('hydrates cached translations back from localStorage after memory reset', async () => {
    const translator = async (input: string, lang: string): Promise<string> => `${lang}:${input}`;

    await translateContentText('Oil prices jump', 'es', { translator });
    resetContentTranslationCacheForTests();

    assert.equal(getCachedContentTranslation('Oil prices jump', 'es'), 'es:Oil prices jump');
  });

  it('reads legacy stored translations that predate savedAt metadata', async () => {
    const source = 'Legacy headline';
    const translated = 'pt:Legacy headline';
    const translator = async (): Promise<string> => translated;

    await translateContentText(source, 'pt', { translator });
    const key = fakeStorage.key(0);
    assert.ok(key, 'expected persisted translation key');
    fakeStorage.setItem(key, JSON.stringify({ source, translated }));
    resetContentTranslationCacheForTests();

    assert.equal(getCachedContentTranslation(source, 'pt'), translated);
  });

  it('caps persisted translations to the newest 500 entries', async () => {
    const translator = async (input: string, lang: string): Promise<string> => `${lang}:${input}`;

    for (let i = 0; i < 501; i += 1) {
      // Ensure each entry gets a strictly newer timestamp for deterministic eviction.
      await new Promise((resolve) => setTimeout(resolve, 1));
      await translateContentText(`Headline ${i}`, 'fr', { translator });
    }

    assert.equal(fakeStorage.length, 500);
    resetContentTranslationCacheForTests();
    assert.equal(getCachedContentTranslation('Headline 0', 'fr'), undefined);
    assert.equal(getCachedContentTranslation('Headline 500', 'fr'), 'fr:Headline 500');
  });
});
