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
// reason `resolveLanguageTag` matches an explicit tag list plus the `zh-hant`
// prefix rather than `zh-` wholesale.

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
