import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  BRIEF_L10N_GATED_LANGS,
  RTL_UI_LANGUAGES,
  briefL10nDeliverableLanguages,
  UI_LANGUAGES,
  UI_LANGUAGE_NAMES,
  isUiLanguage,
  resolveBriefLanguage,
} from '../shared/ui-languages.js';
import { NEWS_LANGUAGES } from '../src/shared/public-rpc-cache.ts';

function supportedLanguagesLiteral() {
  const source = readFileSync(new URL('../src/services/i18n.ts', import.meta.url), 'utf8');
  const declaration = source.match(/const SUPPORTED_LANGUAGES = \[([^\]]+)\]/);
  assert.ok(declaration, 'SUPPORTED_LANGUAGES declaration must be extractable');
  return [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

describe('briefL10nDeliverableLanguages', () => {
  it('is empty unless BRIEF_L10N_ENABLED is exactly "1"', () => {
    assert.deepEqual(briefL10nDeliverableLanguages({}), []);
    assert.deepEqual(briefL10nDeliverableLanguages({ BRIEF_L10N_LANGS: 'fr' }), []);
    assert.deepEqual(briefL10nDeliverableLanguages({ BRIEF_L10N_ENABLED: 'true', BRIEF_L10N_LANGS: 'fr' }), []);
  });

  it('keeps allowlisted UI languages in list order, dropping en, unknown codes and gated languages', () => {
    const env = { BRIEF_L10N_ENABLED: '1', BRIEF_L10N_LANGS: ' de, xx ,en,fr,fa,ar,fr,' };
    assert.deepEqual(briefL10nDeliverableLanguages(env), ['fr', 'de']);
    assert.deepEqual([...BRIEF_L10N_GATED_LANGS], ['ar', 'fa']);
  });
});

describe('shared/ui-languages', () => {
  it('UI_LANGUAGES matches the SUPPORTED_LANGUAGES literal in src/services/i18n.ts, in order', () => {
    assert.deepEqual([...UI_LANGUAGES], supportedLanguagesLiteral());
  });

  it('every UI language except zh-TW is a news language', () => {
    assert.deepEqual(UI_LANGUAGES.filter((code) => code !== 'zh-TW' && !NEWS_LANGUAGES.has(code)), []);
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
