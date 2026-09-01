import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { __clearLocalUnavailableBackoffForTests } from '../server/_shared/redis.ts';
import { getCountryFacts } from '../server/worldmonitor/intelligence/v1/get-country-facts.ts';

const originalFetch = globalThis.fetch;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  __clearLocalUnavailableBackoffForTests();
  restoreEnv('UPSTASH_REDIS_REST_URL', originalRedisUrl);
  restoreEnv('UPSTASH_REDIS_REST_TOKEN', originalRedisToken);
});

function wikidataValue(value: string): { value: string } {
  return { value };
}

describe('getCountryFacts provider contract', () => {
  it('returns usable U.S. facts after the REST Countries v3 retirement', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    const requestedHosts: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requestedHosts.push(url.hostname);

      if (url.hostname === 'restcountries.com') {
        return new Response(JSON.stringify({
          success: false,
          data: null,
          errors: [{ message: 'This API version has been deprecated.' }],
        }));
      }

      if (url.hostname === 'query.wikidata.org') {
        assert.match(
          new Headers(init?.headers).get('User-Agent') ?? '',
          /^WorldMonitorCountryFacts\/\d/,
          'automated Wikimedia requests must identify the application',
        );
        const query = url.searchParams.get('query') ?? '';
        if (query.includes('SELECT ?country ?countryLabel')) {
          return new Response(JSON.stringify({
            results: {
              bindings: [{
                country: wikidataValue('http://www.wikidata.org/entity/Q30'),
                countryLabel: wikidataValue('United States'),
                m49: wikidataValue('840'),
              }],
            },
          }));
        }
        assert.match(query, /VALUES \?country \{ wd:Q30 \}/);
        const headLabel = query.includes('wikibase:language "en,mul"')
          ? 'Donald Trump'
          : 'Q22686';
        const shared = {
          countryLabel: wikidataValue('United States'),
          headLabel: wikidataValue(headLabel),
          officeLabel: wikidataValue('president'),
          population: wikidataValue('340110988'),
          area: wikidataValue('9826675'),
          capitalLabel: wikidataValue('Washington, D.C.'),
          currencyLabel: wikidataValue('United States dollar'),
        };
        return new Response(JSON.stringify({
          results: {
            bindings: [
              { ...shared, languageLabel: wikidataValue('English') },
              ...(!query.includes('pq:P518')
                ? [
                    { ...shared, languageLabel: wikidataValue('Spanish') },
                    { ...shared, languageLabel: wikidataValue('Hawaiian') },
                  ]
                : []),
            ],
          },
        }));
      }

      if (url.hostname === 'en.wikipedia.org') {
        return new Response(JSON.stringify({
          extract: 'The United States is a country primarily located in North America.',
          thumbnail: { source: 'https://upload.wikimedia.org/us.png' },
        }));
      }

      throw new Error(`Unexpected country-facts request: ${url}`);
    }) as typeof fetch;

    const result = await getCountryFacts({} as never, { countryCode: 'US' });

    assert.deepEqual(result, {
      headOfState: 'Donald Trump',
      headOfStateTitle: 'president',
      wikipediaSummary: 'The United States is a country primarily located in North America.',
      wikipediaThumbnailUrl: 'https://upload.wikimedia.org/us.png',
      population: 340_110_988,
      capital: 'Washington, D.C.',
      languages: ['English'],
      currencies: ['United States dollar'],
      areaSqKm: 9_826_675,
      countryName: 'United States',
    });
    assert.ok(
      !requestedHosts.includes('restcountries.com'),
      'the retired REST Countries v3 endpoint must not be called',
    );
  });

  it('returns country-wide languages instead of every language used in the requested country', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.hostname === 'query.wikidata.org') {
        const query = url.searchParams.get('query') ?? '';

        if (query.includes('SELECT ?country ?countryLabel')) {
          assert.match(query, /wdt:P297 "BR"/, 'the query must use the requested ISO country code');
          return new Response(JSON.stringify({
            results: {
              bindings: [{
                country: wikidataValue('http://www.wikidata.org/entity/Q155'),
                countryLabel: wikidataValue('Brazil'),
                m49: wikidataValue('076'),
              }],
            },
          }));
        }
        assert.match(query, /VALUES \?country \{ wd:Q155 \}/);

        const shared = {
          countryLabel: wikidataValue('Brazil'),
          population: wikidataValue('213421037'),
          area: wikidataValue('8515767'),
          capitalLabel: wikidataValue('Brasília'),
          headLabel: wikidataValue('Luiz Inácio Lula da Silva'),
          officeLabel: wikidataValue('president of Brazil'),
          currencyLabel: wikidataValue('Brazilian real'),
        };
        return new Response(JSON.stringify({
          results: {
            bindings: [
              { ...shared, languageLabel: wikidataValue('Portuguese') },
              ...(!query.includes('pq:P582 ?languageEnd')
                ? [{ ...shared, languageLabel: wikidataValue('Dutch') }]
                : []),
              ...(query.includes('wdt:P2936')
                ? [
                    { ...shared, languageLabel: wikidataValue('Nheengatu') },
                    { ...shared, languageLabel: wikidataValue('Pirahã') },
                  ]
                : []),
            ],
          },
        }));
      }

      if (url.hostname === 'en.wikipedia.org') {
        return new Response(JSON.stringify({ extract: 'Brazil is a country in South America.' }));
      }

      throw new Error(`Unexpected country-facts request: ${url}`);
    }) as typeof fetch;

    const result = await getCountryFacts({} as never, { countryCode: 'br' });

    assert.equal(result.countryName, 'Brazil');
    assert.equal(result.capital, 'Brasília');
    assert.deepEqual(result.languages, ['Portuguese']);
  });

  it('uses the same ISO-code query path for representative countries', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    const countries = {
      FR: { m49: '250', qid: 'Q142', name: 'France', capital: 'Paris', language: 'French', currency: 'euro' },
      JP: { m49: '392', qid: 'Q17', name: 'Japan', capital: 'Tokyo', language: 'Japanese', currency: 'yen' },
      ZA: { m49: '710', qid: 'Q258', name: 'South Africa', capital: 'Bloemfontein', language: 'Zulu', currency: 'rand' },
    } as const;

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.hostname === 'query.wikidata.org') {
        const query = url.searchParams.get('query') ?? '';
        const resolutionCode = query.match(/wdt:P297 "([A-Z]{2})"/)?.[1] as keyof typeof countries | undefined;
        if (resolutionCode) {
          const country = countries[resolutionCode];
          assert.ok(country, 'the query must contain the requested ISO country code');
          assert.match(query, /OPTIONAL \{ \?country wdt:P2082 \?m49 \}/);
          return new Response(JSON.stringify({
            results: {
              bindings: [{
                country: wikidataValue(`http://www.wikidata.org/entity/${country.qid}`),
                countryLabel: wikidataValue(country.name),
                m49: wikidataValue(country.m49),
              }],
            },
          }));
        }

        const code = Object.entries(countries).find(([, country]) => (
          query.includes(`VALUES ?country { wd:${country.qid} }`)
        ))?.[0] as keyof typeof countries | undefined;
        assert.ok(code, 'the facts query must use the resolved Wikidata entity');
        const country = countries[code];
        const currencies = code === 'FR'
          ? [
              ...(query.includes('wdt:P38') ? ['CFP Franc'] : []),
              ...(!query.includes('pq:P582 ?currencyEnd') ? ['French franc'] : []),
              country.currency,
            ]
          : [country.currency];
        return new Response(JSON.stringify({
          results: {
            bindings: currencies.map(currency => ({
              countryLabel: wikidataValue(country.name),
              population: wikidataValue('1000000'),
              area: wikidataValue('100000'),
              capitalLabel: wikidataValue(country.capital),
              languageLabel: wikidataValue(country.language),
              currencyLabel: wikidataValue(currency),
            })),
          },
        }));
      }

      if (url.hostname === 'en.wikipedia.org') {
        return new Response(JSON.stringify({ extract: 'Country summary.' }));
      }

      throw new Error(`Unexpected country-facts request: ${url}`);
    }) as typeof fetch;

    for (const [countryCode, expected] of Object.entries(countries)) {
      const result = await getCountryFacts({} as never, { countryCode: countryCode.toLowerCase() });
      assert.equal(result.countryName, expected.name);
      assert.equal(result.capital, expected.capital);
      assert.deepEqual(result.languages, [expected.language]);
      assert.deepEqual(result.currencies, [expected.currency]);
    }
  });

  it('resolves one verified Wikidata entity before fetching Netherlands facts', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    const wikidataQueries: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.hostname === 'query.wikidata.org') {
        const query = url.searchParams.get('query') ?? '';
        wikidataQueries.push(query);

        if (query.includes('SELECT ?country ?countryLabel')) {
          assert.match(query, /wdt:P297 "NL"/);
          assert.match(query, /OPTIONAL \{ \?country wdt:P2082 \?m49 \}/);
          return new Response(JSON.stringify({
            results: {
              bindings: [
                {
                  country: wikidataValue('http://www.wikidata.org/entity/Q55'),
                  countryLabel: wikidataValue('Netherlands'),
                  m49: wikidataValue('528'),
                },
                {
                  country: wikidataValue('http://www.wikidata.org/entity/Q29999'),
                  countryLabel: wikidataValue('Kingdom of the Netherlands'),
                },
              ],
            },
          }));
        }

        assert.match(query, /VALUES \?country \{ wd:Q55 \}/);
        assert.doesNotMatch(query, /\?country wdt:P297|wdt:P2082/);
        assert.match(query, /\?currencyRegion wdt:P297 \?currencyRegionCode/);
        return new Response(JSON.stringify({
          results: {
            bindings: [{
              countryLabel: wikidataValue('Netherlands'),
              population: wikidataValue('18044100'),
              area: wikidataValue('41865'),
              capitalLabel: wikidataValue('Amsterdam'),
              languageLabel: wikidataValue('Dutch'),
              currencyLabel: wikidataValue('euro'),
            }],
          },
        }));
      }

      if (url.hostname === 'en.wikipedia.org') {
        return new Response(JSON.stringify({ extract: 'The Netherlands is a country in Europe.' }));
      }

      throw new Error(`Unexpected country-facts request: ${url}`);
    }) as typeof fetch;

    const result = await getCountryFacts({} as never, { countryCode: 'NL' });

    assert.equal(wikidataQueries.length, 2);
    assert.equal(result.countryName, 'Netherlands');
    assert.equal(result.population, 18_044_100);
    assert.equal(result.capital, 'Amsterdam');
    assert.deepEqual(result.languages, ['Dutch']);
    assert.deepEqual(result.currencies, ['euro']);
  });

  it('retries one transient Wikidata failure before returning empty facts', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    let wikidataAttempts = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.hostname === 'query.wikidata.org') {
        wikidataAttempts += 1;
        if (wikidataAttempts === 1) return new Response('temporarily unavailable', { status: 503 });
        const query = url.searchParams.get('query') ?? '';
        if (query.includes('SELECT ?country ?countryLabel')) {
          return new Response(JSON.stringify({
            results: {
              bindings: [{
                country: wikidataValue('http://www.wikidata.org/entity/Q258'),
                countryLabel: wikidataValue('South Africa'),
                m49: wikidataValue('710'),
              }],
            },
          }));
        }
        return new Response(JSON.stringify({
          results: {
            bindings: [{
              countryLabel: wikidataValue('South Africa'),
              population: wikidataValue('62027503'),
              area: wikidataValue('1221037'),
              capitalLabel: wikidataValue('Bloemfontein'),
              languageLabel: wikidataValue('Zulu'),
              currencyLabel: wikidataValue('rand'),
            }],
          },
        }));
      }

      if (url.hostname === 'en.wikipedia.org') {
        return new Response(JSON.stringify({ extract: 'South Africa is a country in southern Africa.' }));
      }

      throw new Error(`Unexpected country-facts request: ${url}`);
    }) as typeof fetch;

    const result = await getCountryFacts({} as never, { countryCode: 'ZA' });

    assert.equal(wikidataAttempts, 3);
    assert.equal(result.population, 62_027_503);
    assert.equal(result.capital, 'Bloemfontein');
  });

  it('negative-caches a successful empty result but not a transient Wikidata failure', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

    const store = new Map<string, string>();
    let wikidataMode: 'failure' | 'empty' = 'failure';
    let wikidataAttempts = 0;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const rawUrl = input instanceof Request ? input.url : String(input);

      if (rawUrl.startsWith('https://redis.example.test/get/')) {
        const key = decodeURIComponent(rawUrl.slice('https://redis.example.test/get/'.length));
        return new Response(JSON.stringify({ result: store.get(key) ?? null }));
      }

      if (rawUrl === 'https://redis.example.test/') {
        const command = JSON.parse(String(init?.body)) as string[];
        if (command[0] === 'SET') store.set(command[1]!, command[2]!);
        return new Response(JSON.stringify({ result: 'OK' }));
      }

      const url = new URL(rawUrl);
      if (url.hostname === 'query.wikidata.org') {
        wikidataAttempts += 1;
        if (wikidataMode === 'failure') {
          return new Response('temporarily unavailable', { status: 503 });
        }
        return new Response(JSON.stringify({ results: { bindings: [] } }));
      }

      if (url.hostname === 'en.wikipedia.org') {
        return new Response(JSON.stringify({ extract: 'The Netherlands is a country in Europe.' }));
      }

      throw new Error(`Unexpected country-facts request: ${url}`);
    }) as typeof fetch;

    await getCountryFacts({} as never, { countryCode: 'NL' });
    assert.equal(wikidataAttempts, 2, 'a transient failure should use the bounded retry');
    assert.ok(
      ![...store.keys()].some(key => key.includes('country-facts:wikidata')),
      'a transient failure must not write a Wikidata negative cache entry',
    );

    __clearLocalUnavailableBackoffForTests();
    wikidataMode = 'empty';
    await getCountryFacts({} as never, { countryCode: 'NL' });
    assert.equal(wikidataAttempts, 3, 'a successful empty result should make one resolver request');

    const wikidataEntry = [...store.entries()].find(([key]) => key.includes('country-facts:wikidata'));
    assert.equal(JSON.parse(wikidataEntry?.[1] ?? 'null'), '__WM_NEG__');

    await getCountryFacts({} as never, { countryCode: 'NL' });
    assert.equal(wikidataAttempts, 3, 'the definitive empty result should be served from negative cache');
  });

  it('does not infer a language for a territory with no factual language binding', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.hostname === 'query.wikidata.org') {
        const query = url.searchParams.get('query') ?? '';
        if (query.includes('SELECT ?country ?countryLabel')) {
          return new Response(JSON.stringify({
            results: {
              bindings: [
                {
                  country: wikidataValue('http://www.wikidata.org/entity/Q51'),
                  countryLabel: wikidataValue('Antarctica'),
                  m49: wikidataValue('010'),
                },
                {
                  country: wikidataValue('http://www.wikidata.org/entity/Q10372207'),
                  countryLabel: wikidataValue('Antarctic Treaty area'),
                },
              ],
            },
          }));
        }
        assert.match(query, /VALUES \?country \{ wd:Q51 \}/);
        const antarctica = {
          countryLabel: wikidataValue('Antarctica'),
          population: wikidataValue('1000'),
          area: wikidataValue('14200000'),
        };
        return new Response(JSON.stringify({
          results: {
            bindings: [antarctica],
          },
        }));
      }

      if (url.hostname === 'en.wikipedia.org') {
        return new Response(JSON.stringify({ extract: 'Antarctica is a continent.' }));
      }

      throw new Error(`Unexpected country-facts request: ${url}`);
    }) as typeof fetch;

    const result = await getCountryFacts({} as never, { countryCode: 'AQ' });

    assert.equal(result.countryName, 'Antarctica');
    assert.equal(result.areaSqKm, 14_200_000);
    assert.deepEqual(result.languages, []);
  });
});
