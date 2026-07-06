import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveCountryIntelCacheKey,
  buildSharedCountryContext,
  countryBriefSearchTerms,
  includesCountryTerm,
  includesCountryCodeToken,
  matchesCountry,
} from '../server/worldmonitor/intelligence/v1/_country-brief-context.ts';

describe('country intel brief cache key derivation', () => {
  it('anon callers share one key per country+lang regardless of client context', () => {
    const a = deriveCountryIntelCacheKey({
      countryCode: 'FR', lang: 'en', isPremium: false,
      contextHash: 'aaaaaaaaaaaaaaaa', frameworkHash: '', energyYear: '2024',
    });
    const b = deriveCountryIntelCacheKey({
      countryCode: 'FR', lang: 'en', isPremium: false,
      contextHash: 'bbbbbbbbbbbbbbbb', frameworkHash: '', energyYear: '2024',
    });
    assert.equal(a, b, 'anon key must not vary with client context');
    assert.ok(a.startsWith('ci-sebuf:v5:FR:en:shared'), `anon key should use shared namespace, got ${a}`);
  });

  it('anon key ignores framework hash (framework is premium-only input)', () => {
    const base = deriveCountryIntelCacheKey({
      countryCode: 'FR', lang: 'en', isPremium: false,
      contextHash: 'base', frameworkHash: '', energyYear: '',
    });
    const withFw = deriveCountryIntelCacheKey({
      countryCode: 'FR', lang: 'en', isPremium: false,
      contextHash: 'base', frameworkHash: 'deadbeef', energyYear: '',
    });
    assert.equal(base, withFw);
  });

  it('anon keys separate by country, lang, and energy data-year', () => {
    const mk = (countryCode, lang, energyYear) => deriveCountryIntelCacheKey({
      countryCode, lang, isPremium: false, contextHash: 'base', frameworkHash: '', energyYear,
    });
    assert.notEqual(mk('FR', 'en', '2024'), mk('DE', 'en', '2024'));
    assert.notEqual(mk('FR', 'en', '2024'), mk('FR', 'fr', '2024'));
    assert.notEqual(mk('FR', 'en', '2024'), mk('FR', 'en', '2023'));
  });

  it('premium callers keep per-context and per-framework keys', () => {
    const mk = (contextHash, frameworkHash) => deriveCountryIntelCacheKey({
      countryCode: 'FR', lang: 'en', isPremium: true, contextHash, frameworkHash, energyYear: '2024',
    });
    assert.notEqual(mk('aaaaaaaaaaaaaaaa', ''), mk('bbbbbbbbbbbbbbbb', ''), 'premium context must personalize the key');
    assert.equal(mk('aaaaaaaaaaaaaaaa', ''), mk('aaaaaaaaaaaaaaaa', ''), 'same premium context must share the key');
    assert.notEqual(mk('aaaaaaaaaaaaaaaa', 'deadbeef'), mk('aaaaaaaaaaaaaaaa', ''), 'framework must personalize the key');
    assert.ok(mk('aaaaaaaaaaaaaaaa', '').startsWith('ci-sebuf:v5:FR:en:aaaaaaaaaaaaaaaa'));
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

describe('country term matching', () => {
  it('derives an uppercase code + lowercase display names', () => {
    const terms = countryBriefSearchTerms('fr');
    assert.equal(terms.code, 'FR');
    assert.deepEqual(terms.names, ['france']);
  });

  it('does not treat the Intl code echo for unknown regions as a name', () => {
    const terms = countryBriefSearchTerms('ZZ');
    assert.equal(terms.code, 'ZZ');
    assert.deepEqual(terms.names, [], 'an echoed code must not become a lowercase word-match term');
  });

  it('matches display names on word boundaries, case-insensitively', () => {
    assert.equal(includesCountryTerm('France announces plan', 'france'), true);
    assert.equal(includesCountryTerm('shipment from Indiana port', 'india'), false, '"india" inside "Indiana" must not match');
  });

  it('matches ISO codes only as uppercase tokens in the raw text', () => {
    assert.equal(includesCountryCodeToken('Exports from IN surge on new deal', 'IN'), true);
    assert.equal(includesCountryCodeToken('Prices rise in Europe as inflation cools', 'IN'), false, 'lowercase "in" must not match the IN code');
    assert.equal(includesCountryCodeToken('US announces sanctions package', 'US'), true);
    assert.equal(includesCountryCodeToken('tell us more about the plan', 'US'), false);
    assert.equal(includesCountryCodeToken('INDIA expands exports', 'IN'), false, 'code token must not match inside a longer uppercase word');
  });

  it('matchesCountry rejects the stopword-collision codes that over-matched shared briefs', () => {
    const cases = [
      { cc: 'IN', hit: 'India launches lunar mission', miss: 'Markets rally in Europe' },
      { cc: 'US', hit: 'United States imposes tariffs', miss: 'tell us what happened next' },
      { cc: 'NO', hit: 'Norway boosts energy exports', miss: 'no deal reached in talks' },
      { cc: 'AT', hit: 'Austria tightens border rules', miss: 'explosion at refinery injures three' },
    ];
    for (const { cc, hit, miss } of cases) {
      const terms = countryBriefSearchTerms(cc);
      assert.equal(matchesCountry(hit, terms), true, `${cc} should match "${hit}"`);
      assert.equal(matchesCountry(miss, terms), false, `${cc} must NOT match "${miss}"`);
    }
  });

  it('shared context no longer sweeps unrelated items into stopword-code briefs', () => {
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
});
