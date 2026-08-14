// C1 from #6555.
//
// #6546 admitted `zh-TW` to the catalogue but asserted nothing about how a tag
// RESOLVES to it — every test it touched was a registry entry. The risk that
// change carried was an over-broad matcher: treating any regioned `zh` as
// Traditional would have served Traditional copy to Simplified readers in
// mainland China, Singapore and anywhere sending `zh-Hans-*`, and no gate in
// the repo would have noticed.
//
// So the negative rows below matter more than the positive ones. They are the
// reason `resolveLanguageTag` reads the script and region subtags rather than
// treating `zh-` wholesale as Traditional.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLanguageTag } from '../src/shared/language-tags.ts';

// Mirrors SUPPORTED_LANGUAGES in src/services/i18n.ts. Not imported: that module
// evaluates `import.meta.glob` at load time, which does not exist outside Vite.
// The registry itself is gated separately by scripts/docs-stats.mjs.
const SUPPORTED = new Set([
  'en', 'bg', 'cs', 'fr', 'de', 'el', 'es', 'hr', 'hu', 'it', 'pl', 'pt', 'nl',
  'sv', 'ru', 'uk', 'ar', 'fa', 'zh', 'zh-TW', 'ja', 'ko', 'ro', 'tr', 'th',
  'vi', 'hi', 'sw',
]);

const resolve = (tag: string): string => resolveLanguageTag(tag, SUPPORTED);

describe('resolveLanguageTag — Traditional Chinese', () => {
  const traditional = [
    'zh-TW',
    'zh-HK',
    'zh-MO',
    'zh-Hant',
    'zh-Hant-TW',
    'zh-Hant-HK',
  ];

  for (const tag of traditional) {
    it(`resolves ${tag} to zh-TW`, () => {
      assert.equal(resolve(tag), 'zh-TW');
    });
  }

  it('is case-insensitive — navigator.language casing is not guaranteed', () => {
    assert.equal(resolve('zh-tw'), 'zh-TW');
    assert.equal(resolve('ZH-HANT'), 'zh-TW');
    assert.equal(resolve('zh-hAnT-tw'), 'zh-TW');
  });
});

describe('resolveLanguageTag — Simplified Chinese stays on zh', () => {
  // An over-broad Traditional matcher fails HERE, not above.
  const simplified = [
    'zh',
    'zh-CN',
    'zh-SG',
    'zh-Hans',
    'zh-Hans-CN',
    'zh-Hans-SG',
  ];

  for (const tag of simplified) {
    it(`resolves ${tag} to zh`, () => {
      assert.equal(resolve(tag), 'zh');
    });
  }
});

describe('resolveLanguageTag — subtags the exact-match list missed', () => {
  // Both rows below resolved wrongly while the matcher compared whole strings:
  // `zh-TW-u-ca-chinese` fell through to `zh` (Simplified copy for a Traditional
  // reader) and `zh_TW` fell through to `en`.
  it('reads a region that is followed by an extension', () => {
    assert.equal(resolve('zh-TW-u-ca-chinese'), 'zh-TW');
    assert.equal(resolve('zh-Hant-u-ca-chinese'), 'zh-TW');
    assert.equal(resolve('zh-Hant-TW-u-nu-hanidec'), 'zh-TW');
  });

  it('accepts the POSIX underscore spelling', () => {
    assert.equal(resolve('zh_TW'), 'zh-TW');
    assert.equal(resolve('zh_tw'), 'zh-TW');
    assert.equal(resolve('zh_Hant'), 'zh-TW');
    assert.equal(resolve('pt_BR'), 'pt');
  });

  it('stops at the singleton — an extension subtag is not a region', () => {
    // `-x-tw` is private use, not Taiwan. A walk that keeps reading past the
    // singleton sees a two-letter `tw` and serves Traditional to a `zh` reader.
    assert.equal(resolve('zh-x-tw'), 'zh');
    assert.equal(resolve('zh-u-rg-twzzzz'), 'zh');
  });

  it('lets an explicit script outrank the region', () => {
    // Simplified in a Traditional region is a real combination, and the script
    // subtag is the one that says which characters to render.
    assert.equal(resolve('zh-Hans-TW'), 'zh');
    assert.equal(resolve('zh-Hans-HK'), 'zh');
    assert.equal(resolve('zh_Hans_TW'), 'zh');
  });

  it('keeps Simplified regions on zh through the same path', () => {
    assert.equal(resolve('zh_CN'), 'zh');
    assert.equal(resolve('zh-CN-u-ca-chinese'), 'zh');
  });
});

describe('resolveLanguageTag — everything else', () => {
  it('strips the region from supported base languages', () => {
    assert.equal(resolve('en-US'), 'en');
    assert.equal(resolve('pt-BR'), 'pt');
    assert.equal(resolve('sw-KE'), 'sw');
  });

  it('passes through bare supported codes', () => {
    assert.equal(resolve('ja'), 'ja');
    assert.equal(resolve('sw'), 'sw');
  });

  it('falls back to en for unsupported and malformed input', () => {
    assert.equal(resolve('xx'), 'en');
    assert.equal(resolve('klingon-KL'), 'en');
    assert.equal(resolve(''), 'en');
    assert.equal(resolve('-'), 'en');
  });
});
