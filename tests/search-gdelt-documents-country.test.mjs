import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { GDELT_BULK_COUNTRY_ARTICLES_KEY } from '../scripts/_gdelt-bulk-contract.mjs';
import {
  parseCountryQuery,
  searchGdeltDocuments,
  selectCountryArticles,
} from '../server/worldmonitor/intelligence/v1/search-gdelt-documents.ts';

// The `country:<ISO2>` query form (#7748): the crawlable country pages top up
// their "Recent developments" from the materializer's per-country index when
// the news digest never names the country.
describe('search-gdelt-documents country query', () => {
  const row = (overrides = {}) => ({
    title: 'Palau signs maritime pact',
    url: 'https://islandtimes.example/palau-pact',
    source: 'islandtimes.example',
    date: '20260904T101500Z',
    tone: 1.5,
    primary: true,
    countryCount: 1,
    ...overrides,
  });

  it('parses the operator form and nothing else', () => {
    assert.equal(parseCountryQuery('country:PW'), 'PW');
    assert.equal(parseCountryQuery('Country:pw'), 'PW');
    assert.equal(parseCountryQuery('  country:nr '), 'NR');
    assert.equal(parseCountryQuery('country:PWX'), null);
    assert.equal(parseCountryQuery('country:'), null);
    assert.equal(parseCountryQuery('palau'), null);
    assert.equal(parseCountryQuery('military country:PW'), null, 'the operator is the whole query, not a term');
    assert.equal(parseCountryQuery(''), null);
    assert.equal(parseCountryQuery(undefined), null);
  });

  it('reads the key the materializer writes', () => {
    const source = readFileSync(new URL('../server/worldmonitor/intelligence/v1/search-gdelt-documents.ts', import.meta.url), 'utf8');
    assert.equal(GDELT_BULK_COUNTRY_ARTICLES_KEY, 'gdelt:bulk:country-articles:v1');
    assert.match(source, new RegExp(`'${GDELT_BULK_COUNTRY_ARTICLES_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  });

  it('serves only rows whose title names the country, in index order', () => {
    const index = {
      byCountry: {
        PW: [
          row(),
          // Indexed by a Koror location mention, but the title is a regional
          // roundup: a location mention alone is not a country-specific claim.
          row({ title: 'Pacific leaders gather for climate summit', url: 'https://example.test/roundup', primary: false, countryCount: 3 }),
          row({ title: 'Palauan reef survey completes', url: 'https://example.test/reef', date: '20260903T080000Z' }),
        ],
      },
    };
    const articles = selectCountryArticles(index, 'pw');
    assert.deepEqual(articles.map((article) => article.url), [
      'https://islandtimes.example/palau-pact',
      'https://example.test/reef',
    ]);
    assert.deepEqual(articles[0], {
      title: 'Palau signs maritime pact',
      url: 'https://islandtimes.example/palau-pact',
      source: 'islandtimes.example',
      date: '20260904T101500Z',
      image: '',
      language: 'English',
      tone: 1.5,
    });
  });

  it('drops revoked, malformed and duplicate rows and caps the result', () => {
    const rows = [
      row({ url: 'https://example.test/revoked' }),
      row({ url: 'javascript:alert(1)' }),
      row({ url: '' }),
      row({ title: '' , url: 'https://example.test/untitled' }),
      row({ url: 'https://example.test/dupe' }),
      row({ url: 'https://example.test/dupe' }),
      ...Array.from({ length: 30 }, (_, index) => row({ url: `https://example.test/${index}`, tone: 'warm' })),
    ];
    const articles = selectCountryArticles({ byCountry: { PW: rows } }, 'PW', {
      revokedUrls: new Set(['https://example.test/revoked']),
      maxRecords: 250,
    });
    assert.ok(!articles.some((article) => article.url === 'https://example.test/revoked'));
    assert.ok(!articles.some((article) => article.url.startsWith('javascript:')));
    assert.equal(articles.filter((article) => article.url === 'https://example.test/dupe').length, 1);
    assert.equal(articles.length, 20, 'the handler cap applies to the country form too');
    assert.equal(articles.at(-1).tone, 0, 'a non-numeric tone publishes as 0');
    assert.deepEqual(selectCountryArticles({ byCountry: { PW: rows } }, 'PW', { maxRecords: 3 }).length, 3);
  });

  it('returns nothing for a country the index does not hold or a malformed index', () => {
    assert.deepEqual(selectCountryArticles({ byCountry: { PW: [row()] } }, 'NR'), []);
    assert.deepEqual(selectCountryArticles({ byCountry: { PW: 'not-an-array' } }, 'PW'), []);
    assert.deepEqual(selectCountryArticles(null, 'PW'), []);
    assert.deepEqual(selectCountryArticles({}, 'PW'), []);
  });

  it('falls back to the hostname when a row carries no source label', () => {
    const [article] = selectCountryArticles({ byCountry: { PW: [row({ source: '' })] } }, 'PW');
    assert.equal(article.source, 'islandtimes.example');
  });

  it('answers seed-unavailable for the country form when no index is seeded', async () => {
    // No Redis is configured under the test runner, so the index read misses:
    // the freeze must be able to tell "no index" from "no rows".
    const response = await searchGdeltDocuments({}, { query: 'country:PW', maxRecords: 5 });
    assert.deepEqual(response, { articles: [], query: 'country:PW', error: 'seed-unavailable' });
    const topic = await searchGdeltDocuments({}, { query: 'military', maxRecords: 5 });
    assert.equal(topic.error, 'seed-unavailable', 'the topic form keeps its contract');
  });
});
