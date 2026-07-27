import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';

import { clearWelcomeRoot } from '../pro-test/src/welcome-root.ts';
import { resolveEffectiveWelcomeContentLanguage } from '../pro-test/src/welcome-language.ts';

const readLocale = (language: string): Record<string, unknown> => JSON.parse(
  readFileSync(new URL(`../pro-test/src/locales/${language}.json`, import.meta.url), 'utf8'),
) as Record<string, unknown>;

// Derived from the directory rather than hardcoded, so a locale added later is
// covered without editing this file.
const SUPPORTED_NON_ENGLISH = readdirSync(new URL('../pro-test/src/locales/', import.meta.url))
  .filter((name) => name.endsWith('.json') && name !== 'en.json')
  .map((name) => name.replace(/\.json$/, ''))
  .sort();

describe('welcome bootstrap root clearing', () => {
  it('uses replaceChildren when the browser supports it', () => {
    let replaceChildrenCalls = 0;
    const root = {
      textContent: 'prerendered markup',
      replaceChildren: () => {
        replaceChildrenCalls += 1;
      },
    };

    clearWelcomeRoot(root);

    assert.equal(replaceChildrenCalls, 1);
  });

  it('clears the root with textContent when replaceChildren is unavailable', () => {
    const root = { textContent: 'prerendered markup' };

    clearWelcomeRoot(root);

    assert.equal(root.textContent, '');
  });
});

describe('effective welcome content language', () => {
  const englishWelcome = readLocale('en').welcome;

  // Asserted against fixtures rather than real locale files. This previously
  // named fr/ar/fa as locales that omit or duplicate the welcome namespace,
  // which pinned a fact about the CONTENT — and #5633 then translated welcome.*
  // into all 24 locales, so the assertion failed on a legitimate improvement
  // rather than on a regression. The behaviour worth pinning is the resolver's,
  // and it does not need a locale to be missing translations to be exercised.
  it('uses English when a locale omits the welcome namespace', () => {
    assert.equal(
      resolveEffectiveWelcomeContentLanguage('fr', englishWelcome, { pricing: {} }),
      'en',
      'a locale with no welcome namespace must hydrate the truthful English prerender',
    );
  });

  it('uses English when a locale merely duplicates the English welcome namespace', () => {
    assert.equal(
      resolveEffectiveWelcomeContentLanguage('fr', englishWelcome, {
        welcome: JSON.parse(JSON.stringify(englishWelcome)),
      }),
      'en',
      'copy that is byte-identical to English is not a translation',
    );
  });

  it('hydrates its own language for every locale that ships welcome copy', () => {
    // The whole point of translating welcome.*: a visitor who picks a language
    // gets that language. Any locale still resolving to English here has lost
    // its welcome translations.
    const fallingBack = SUPPORTED_NON_ENGLISH.filter((language) => (
      resolveEffectiveWelcomeContentLanguage(language, englishWelcome, readLocale(language)) !== language
    ));
    assert.deepEqual(fallingBack, [], 'these locales no longer own localized welcome copy');
  });

  it('uses the detected locale once it owns genuinely localized welcome copy', () => {
    assert.equal(
      resolveEffectiveWelcomeContentLanguage(
        'fr-FR',
        englishWelcome,
        { welcome: { hero: { headline1: 'Déjà informé.' } } },
      ),
      'fr',
    );
  });
});
