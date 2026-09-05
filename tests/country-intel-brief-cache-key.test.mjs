import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveCountryIntelCacheKey,
  buildSharedCountryContext,
} from '../server/worldmonitor/intelligence/v1/_country-brief-context.ts';

describe('country intel brief cache key derivation', () => {
  it('anon callers share one key per country+lang regardless of client context', () => {
    const a = deriveCountryIntelCacheKey({
      countryCode: 'FR', lang: 'en', isPremium: false,
      contextHash: 'aaaaaaaaaaaaaaaa', frameworkHash: '', energyYear: '2024', energyImportYear: '2023',
    });
    const b = deriveCountryIntelCacheKey({
      countryCode: 'FR', lang: 'en', isPremium: false,
      contextHash: 'bbbbbbbbbbbbbbbb', frameworkHash: '', energyYear: '2024', energyImportYear: '2023',
    });
    assert.equal(a, b, 'anon key must not vary with client context');
    assert.ok(a.startsWith('ci-sebuf:v7:FR:en:shared'), `anon key should use shared namespace, got ${a}`);
  });

  it('anon key ignores framework hash (framework is premium-only input)', () => {
    const base = deriveCountryIntelCacheKey({
      countryCode: 'FR', lang: 'en', isPremium: false,
      contextHash: 'base', frameworkHash: '', energyYear: '', energyImportYear: '',
    });
    const withFw = deriveCountryIntelCacheKey({
      countryCode: 'FR', lang: 'en', isPremium: false,
      contextHash: 'base', frameworkHash: 'deadbeef', energyYear: '', energyImportYear: '',
    });
    assert.equal(base, withFw);
  });

  it('anon keys separate by country, lang, and energy data-year', () => {
    const mk = (countryCode, lang, energyYear, energyImportYear = '2023') => deriveCountryIntelCacheKey({
      countryCode, lang, isPremium: false, contextHash: 'base', frameworkHash: '', energyYear, energyImportYear,
    });
    assert.notEqual(mk('FR', 'en', '2024'), mk('DE', 'en', '2024'));
    assert.notEqual(mk('FR', 'en', '2024'), mk('FR', 'fr', '2024'));
    assert.notEqual(mk('FR', 'en', '2024'), mk('FR', 'en', '2023'));
    assert.notEqual(mk('FR', 'en', '2024', '2023'), mk('FR', 'en', '2024', '2022'));
  });

  it('premium callers keep per-context and per-framework keys', () => {
    const mk = (contextHash, frameworkHash) => deriveCountryIntelCacheKey({
      countryCode: 'FR', lang: 'en', isPremium: true, contextHash, frameworkHash, energyYear: '2024',
      energyImportYear: '2023',
    });
    assert.notEqual(mk('aaaaaaaaaaaaaaaa', ''), mk('bbbbbbbbbbbbbbbb', ''), 'premium context must personalize the key');
    assert.equal(mk('aaaaaaaaaaaaaaaa', ''), mk('aaaaaaaaaaaaaaaa', ''), 'same premium context must share the key');
    assert.notEqual(mk('aaaaaaaaaaaaaaaa', 'deadbeef'), mk('aaaaaaaaaaaaaaaa', ''), 'framework must personalize the key');
    assert.ok(mk('aaaaaaaaaaaaaaaa', '').startsWith('ci-sebuf:v7:FR:en:aaaaaaaaaaaaaaaa'));
    assert.ok(!mk('aaaaaaaaaaaaaaaa', '').includes(':shared'));
  });
});

describe('shared country context from the news digest', () => {
  const digest = {
    categories: {
      politics: {
        items: [
          { title: 'France announces new energy plan', source: 'Reuters', link: 'https://example.com/fr-energy', pubDate: '2026-07-05T08:00:00.000Z' },
          { title: 'Unrelated market rally continues', source: 'Bloomberg', link: 'https://example.com/markets' },
        ],
      },
      conflict: {
        items: [
          { title: 'Strikes reported near France-Spain border corridor', source: 'AFP', link: 'https://example.com/border' },
        ],
      },
    },
  };

  it('filters digest items to the country and emits source lines + headlines', () => {
    const { contextSnapshot, sources } = buildSharedCountryContext(digest, 'FR');
    assert.ok(contextSnapshot.includes('France announces new energy plan'));
    assert.ok(contextSnapshot.includes('Source [1]:'), 'context should carry parseable source lines');
    assert.ok(!contextSnapshot.includes('Unrelated market rally'), 'non-matching items should be excluded when matches exist');
    assert.equal(sources.length, 2);
    assert.equal(sources[0].url, 'https://example.com/fr-energy');
    assert.equal(sources[0].publishedAt, '2026-07-05T08:00:00.000Z');
  });

  it('falls back to top digest items when nothing matches the country', () => {
    const { contextSnapshot, sources } = buildSharedCountryContext(digest, 'JP');
    assert.ok(contextSnapshot.includes('Headlines:'));
    assert.ok(sources.length > 0, 'fallback grounding should still surface sources');
  });

  it('returns empty context for an empty or malformed digest', () => {
    assert.deepEqual(buildSharedCountryContext(null, 'FR'), { contextSnapshot: '', sources: [] });
    assert.deepEqual(buildSharedCountryContext({ nope: true }, 'FR'), { contextSnapshot: '', sources: [] });
  });

  it('caps the context snapshot at 4000 chars', () => {
    const bigItems = Array.from({ length: 200 }, (_, i) => ({
      title: `France update ${i} ${'x'.repeat(120)}`,
      source: 'Wire',
      link: `https://example.com/${i}`,
    }));
    const { contextSnapshot } = buildSharedCountryContext({ items: bigItems }, 'FR');
    assert.ok(contextSnapshot.length <= 4000, `snapshot must stay bounded, got ${contextSnapshot.length}`);
  });
});

describe('shared country grounding', () => {
  // The matcher itself is covered in tests/country-mention.test.mjs; these
  // pin that the shared anonymous grounding routes through it.
  it('no longer sweeps unrelated items into stopword-code briefs', () => {
    const digest = {
      items: [
        { title: 'Markets rally in Europe on rate-cut hopes', source: 'Reuters', link: 'https://example.com/eu' },
        { title: 'India launches lunar mission', source: 'AFP', link: 'https://example.com/india' },
      ],
    };
    const { sources } = buildSharedCountryContext(digest, 'IN');
    assert.equal(sources.length, 1, 'only the India item should ground the IN brief');
    assert.equal(sources[0].url, 'https://example.com/india');
  });

  it('never grounds a country on a bare code that is someone else\'s acronym', () => {
    // The freeze published Australia's brief grounded on this headline (#7748).
    const digest = {
      items: [
        { title: 'Sudanese anti-war forces reject AU backing for El Burhan dialogue', source: 'Wire', link: 'https://example.com/au-sudan' },
        { title: 'Australian PM opens Canberra summit', source: 'Wire', link: 'https://example.com/australia' },
      ],
    };
    const { sources } = buildSharedCountryContext(digest, 'AU');
    assert.deepEqual(sources.map((source) => source.url), ['https://example.com/australia']);
  });

  it('reaches a country through an alias or demonym the display name misses', () => {
    const digest = {
      items: [
        { title: 'UK inflation cools further', source: 'Wire', link: 'https://example.com/uk' },
        { title: 'Ethiopian Airlines adds routes', source: 'Wire', link: 'https://example.com/et' },
      ],
    };
    assert.deepEqual(buildSharedCountryContext(digest, 'GB').sources.map((source) => source.url), ['https://example.com/uk']);
    assert.deepEqual(buildSharedCountryContext(digest, 'ET').sources.map((source) => source.url), ['https://example.com/et']);
  });
});
