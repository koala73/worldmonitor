import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isJapaneseLocale } from '../src/utils/locale.ts';

describe('isJapaneseLocale', () => {
  it('returns false when document is undefined', () => {
    const original = (globalThis as Record<string, unknown>).document;
    try {
      (globalThis as Record<string, unknown>).document = undefined;
      assert.strictEqual(isJapaneseLocale(), false);
    } finally {
      (globalThis as Record<string, unknown>).document = original;
    }
  });

  it('returns true when lang="ja"', () => {
    const original = (globalThis as Record<string, unknown>).document;
    try {
      (globalThis as Record<string, unknown>).document = {
        documentElement: { lang: 'ja' },
      };
      assert.strictEqual(isJapaneseLocale(), true);
    } finally {
      (globalThis as Record<string, unknown>).document = original;
    }
  });

  it('returns true when lang="ja-JP"', () => {
    const original = (globalThis as Record<string, unknown>).document;
    try {
      (globalThis as Record<string, unknown>).document = {
        documentElement: { lang: 'ja-JP' },
      };
      assert.strictEqual(isJapaneseLocale(), true);
    } finally {
      (globalThis as Record<string, unknown>).document = original;
    }
  });

  it('returns false when lang="en"', () => {
    const original = (globalThis as Record<string, unknown>).document;
    try {
      (globalThis as Record<string, unknown>).document = {
        documentElement: { lang: 'en' },
      };
      assert.strictEqual(isJapaneseLocale(), false);
    } finally {
      (globalThis as Record<string, unknown>).document = original;
    }
  });

  it('returns false when documentElement has no lang attribute', () => {
    const original = (globalThis as Record<string, unknown>).document;
    try {
      (globalThis as Record<string, unknown>).document = {
        documentElement: {},
      };
      assert.strictEqual(isJapaneseLocale(), false);
    } finally {
      (globalThis as Record<string, unknown>).document = original;
    }
  });
});
