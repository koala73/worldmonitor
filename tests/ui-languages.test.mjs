import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  BRIEF_SUBSET_LANGUAGES,
  RTL_UI_LANGUAGES,
  UI_LANGUAGES,
  UI_LANGUAGE_NAMES,
  htmlLangFor,
  isUiLanguage,
  resolveBriefLanguage,
  scriptClassFor,
} from '../shared/ui-languages.js';
import { NEWS_LANGUAGES } from '../src/shared/public-rpc-cache.ts';

function supportedLanguagesLiteral() {
  const source = readFileSync(new URL('../src/services/i18n.ts', import.meta.url), 'utf8');
  const declaration = source.match(/const SUPPORTED_LANGUAGES = \[([^\]]+)\]/);
  assert.ok(declaration, 'SUPPORTED_LANGUAGES declaration must be extractable');
  return [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

describe('shared/ui-languages', () => {
  it('UI_LANGUAGES matches the SUPPORTED_LANGUAGES literal in src/services/i18n.ts, in order', () => {
    assert.deepEqual([...UI_LANGUAGES], supportedLanguagesLiteral());
  });

  it('UI_LANGUAGES minus zh-TW equals NEWS_LANGUAGES', () => {
    assert.deepEqual(UI_LANGUAGES.filter((code) => code !== 'zh-TW').sort(), [...NEWS_LANGUAGES].sort());
  });

  it('every UI language has an English name', () => {
    assert.deepEqual(Object.keys(UI_LANGUAGE_NAMES).sort(), [...UI_LANGUAGES].sort());
    for (const code of UI_LANGUAGES) assert.match(UI_LANGUAGE_NAMES[code], /^[A-Z][A-Za-z ]+$/, code);
  });

  it('RTL languages are Arabic and Persian', () => {
    assert.deepEqual([...RTL_UI_LANGUAGES], ['ar', 'fa']);
    assert.ok(RTL_UI_LANGUAGES.every(isUiLanguage));
  });

  it('resolveBriefLanguage prefers the override, then the explicit choice, then en', () => {
    assert.equal(resolveBriefLanguage({ uiLanguage: 'fr', briefLanguage: 'de' }), 'de');
    assert.equal(resolveBriefLanguage({ uiLanguage: 'fr', briefLanguage: null }), 'fr');
    assert.equal(resolveBriefLanguage({ uiLanguage: 'zh-TW' }), 'zh-TW');
    assert.equal(resolveBriefLanguage({}), 'en');
    assert.equal(resolveBriefLanguage({ uiLanguage: null, briefLanguage: null }), 'en');
  });

  it('resolveBriefLanguage ignores values outside the list', () => {
    assert.equal(resolveBriefLanguage({ uiLanguage: 'fr', briefLanguage: 'xx' }), 'fr');
    assert.equal(resolveBriefLanguage({ uiLanguage: 'FR', briefLanguage: '__proto__' }), 'en');
    assert.equal(resolveBriefLanguage({ uiLanguage: 'zh-tw' }), 'en');
    assert.equal(isUiLanguage(42), false);
  });
});

describe('brief typography helpers', () => {
  it('htmlLangFor maps zh and zh-TW', () => {
    assert.equal(htmlLangFor('zh'), 'zh-CN');
    assert.equal(htmlLangFor('zh-TW'), 'zh-TW');
    assert.equal(htmlLangFor('fr'), 'fr');
    assert.equal(htmlLangFor('en'), 'en');
  });

  it('BRIEF_SUBSET_LANGUAGES excludes ar, fa, zh, zh-TW, ja, ko, hi, th', () => {
    const excluded = ['ar', 'fa', 'zh', 'zh-TW', 'ja', 'ko', 'hi', 'th'];
    assert.deepEqual([...BRIEF_SUBSET_LANGUAGES], UI_LANGUAGES.filter((c) => !excluded.includes(c)));
  });

  it('scriptClassFor classifies every UI language', () => {
    const expected = {
      bg: 'cyrillic', ru: 'cyrillic', uk: 'cyrillic', el: 'greek',
      zh: 'cjk', 'zh-TW': 'cjk', ja: 'cjk', ko: 'cjk',
      ar: 'arabic', fa: 'arabic', hi: 'devanagari', th: 'thai',
    };
    for (const code of UI_LANGUAGES) assert.equal(scriptClassFor(code), expected[code] ?? 'latin', code);
  });
});
