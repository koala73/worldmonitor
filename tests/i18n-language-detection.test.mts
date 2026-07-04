import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// These pure helpers back the `wmQuery` i18next detector and the explicit-choice
// reload in src/services/i18n.ts. They live in a zero-import sibling module
// (src/services/i18n-url.ts) precisely so they can be imported directly here —
// importing src/services/i18n.ts would drag in i18next + import.meta.glob and
// crash under `tsx --test`.
import { readQueryLanguage, stripQueryLanguage } from '../src/utils/i18n-url.ts';

describe('readQueryLanguage — wmQuery detector lookup', () => {
  it('returns the lang param for a shareable/SEO language URL', () => {
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
