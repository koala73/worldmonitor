import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// These pure helpers back the `wmQuery` i18next detector and the explicit-choice
// reload in src/services/i18n.ts. They live in a zero-import sibling module
// (src/services/i18n-url.ts) precisely so they can be imported directly here —
// importing src/services/i18n.ts would drag in i18next + import.meta.glob and
// crash under `tsx --test`.
import {
  EXPLICIT_LOCALE_KEY,
  readExplicitLanguage,
  readQueryLanguage,
  stripQueryLanguage,
} from '../src/utils/i18n-url.ts';

describe('readQueryLanguage — wmQuery detector lookup', () => {
  it('returns the lang param for shareable application-language state', () => {
    assert.equal(readQueryLanguage('https://www.worldmonitor.app/dashboard?lang=fa'), 'fa');
    assert.equal(readQueryLanguage('https://www.worldmonitor.app/dashboard?foo=1&lang=hr'), 'hr');
  });

  it('returns undefined (fall through to next detector) when lang is absent or empty', () => {
    assert.equal(readQueryLanguage('https://www.worldmonitor.app/dashboard'), undefined);
    assert.equal(readQueryLanguage('https://www.worldmonitor.app/dashboard?lang='), undefined);
    assert.equal(readQueryLanguage('https://www.worldmonitor.app/dashboard?other=x'), undefined);
  });

  it('returns undefined instead of throwing on an unparseable URL', () => {
    assert.doesNotThrow(() => readQueryLanguage('not a url'));
    assert.equal(readQueryLanguage('not a url'), undefined);
    assert.equal(readQueryLanguage(''), undefined);
  });
});

describe('stripQueryLanguage — explicit-choice reload guard', () => {
  it('removes the lang param so a stale ?lang does not out-rank the saved choice on reload', () => {
    assert.equal(
      stripQueryLanguage('https://www.worldmonitor.app/dashboard?lang=fa'),
      'https://www.worldmonitor.app/dashboard',
    );
  });

  it('preserves every other query param and the hash', () => {
    assert.equal(
      stripQueryLanguage('https://www.worldmonitor.app/dashboard?view=map&lang=de&zoom=3#panel'),
      'https://www.worldmonitor.app/dashboard?view=map&zoom=3#panel',
    );
  });

  it('returns the URL unchanged when there is no lang param', () => {
    const href = 'https://www.worldmonitor.app/dashboard?view=map';
    assert.equal(stripQueryLanguage(href), href);
  });

  it('returns the input unchanged instead of throwing on an unparseable URL', () => {
    assert.doesNotThrow(() => stripQueryLanguage('not a url'));
    assert.equal(stripQueryLanguage('not a url'), 'not a url');
  });
});

describe('readExplicitLanguage — the Settings choice, never the URL or browser', () => {
  const allowed = new Set(['en', 'fr', 'fa', 'zh-TW']);
  const storage = (values: Record<string, string>) => ({ getItem: (key: string) => values[key] ?? null });

  it('readExplicitLanguage returns null when storage has no explicit key', () => {
    // `?lang=` and the browser locale never write the explicit key.
    assert.equal(readExplicitLanguage(storage({ i18nextLng: 'fa' }), allowed), null);
  });

  it('readExplicitLanguage returns the stored explicit choice', () => {
    assert.equal(EXPLICIT_LOCALE_KEY, 'wm-locale-explicit');
    assert.equal(readExplicitLanguage(storage({ [EXPLICIT_LOCALE_KEY]: 'zh-TW' }), allowed), 'zh-TW');
  });

  it('readExplicitLanguage returns null for a stored value outside the list', () => {
    assert.equal(readExplicitLanguage(storage({ [EXPLICIT_LOCALE_KEY]: 'xx' }), allowed), null);
    assert.equal(readExplicitLanguage(storage({ [EXPLICIT_LOCALE_KEY]: '' }), allowed), null);
  });

  it('readExplicitLanguage returns null when storage throws or is missing', () => {
    const throwing = { getItem: () => { throw new Error('SecurityError'); } };
    assert.equal(readExplicitLanguage(throwing, allowed), null);
    assert.equal(readExplicitLanguage(null, allowed), null);
    assert.equal(readExplicitLanguage(undefined, allowed), null);
  });

  it('callEnsureRecord derives uiLanguage only from readExplicitLanguage', () => {
    const source = readFileSync(new URL('../src/services/convex-client.ts', import.meta.url), 'utf8');
    const helper = source.match(/function readExplicitUiLanguage\(\)[^{]*\{([\s\S]*?)\n\}/);
    assert.ok(helper, 'readExplicitUiLanguage must exist');
    assert.match(helper[1], /readExplicitLanguage\(/);
    assert.doesNotMatch(helper[1], /navigator|i18next|location/);
    const assignments = [...source.matchAll(/uiLanguage\s*=\s*([^;\n]+)/g)].map((match) => match[1]);
    assert.deepEqual(assignments, ['readExplicitUiLanguage()']);
  });
});
