import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

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
        assert.match(query, /wdt:P297 "BR"/, 'the query must use the requested ISO country code');

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
      FR: { iso3: 'FRA', name: 'France', capital: 'Paris', language: 'French', currency: 'euro' },
      JP: { iso3: 'JPN', name: 'Japan', capital: 'Tokyo', language: 'Japanese', currency: 'yen' },
      ZA: { iso3: 'ZAF', name: 'South Africa', capital: 'Bloemfontein', language: 'Zulu', currency: 'rand' },
    } as const;

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.hostname === 'query.wikidata.org') {
        const query = url.searchParams.get('query') ?? '';
        const code = query.match(/wdt:P297 "([A-Z]{2})"/)?.[1] as keyof typeof countries | undefined;
        assert.ok(code && countries[code], 'the query must contain the requested ISO country code');
        const country = countries[code];
        assert.match(query, new RegExp(`wdt:P298 "${country.iso3}"`));
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

  it('retries one transient Wikidata failure before returning empty facts', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    let wikidataAttempts = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.hostname === 'query.wikidata.org') {
        wikidataAttempts += 1;
        if (wikidataAttempts === 1) return new Response('temporarily unavailable', { status: 503 });
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

    assert.equal(wikidataAttempts, 2);
    assert.equal(result.population, 62_027_503);
    assert.equal(result.capital, 'Bloemfontein');
  });

  it('does not infer a language for a territory with no factual language binding', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.hostname === 'query.wikidata.org') {
        const antarctica = {
          countryLabel: wikidataValue('Antarctica'),
          population: wikidataValue('1000'),
          area: wikidataValue('14200000'),
        };
        return new Response(JSON.stringify({
          results: {
            bindings: [
              {
                countryLabel: wikidataValue('Antarctic Treaty area'),
                population: wikidataValue('1100'),
                area: wikidataValue('14000000'),
              },
              antarctica,
            ],
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
    assert.deepEqual(result.languages, []);
  });

  it('keeps official India languages when the factual list exceeds 100 rows', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    // Labels that sort before English/Hindi, matching the live A-Tong..Desia truncation.
    const earlyLanguages = [
      'A-Tong', 'Adi', 'Angika', 'Ao', 'Assamese', 'Awadhi', 'Bagheli', 'Bagri',
      'Balti', 'Bangani', 'Banjari', 'Balti Tibetan', 'Bhojpuri', 'Bishnupriya',
      'Bodo', 'Braj', 'Bundeli', 'Chakma', 'Chhattisgarhi', 'Chokri', 'Chothe',
      'Deccani', 'Desia',
    ];
    const filler = Array.from({ length: 100 - earlyLanguages.length }, (_, index) => (
      `A-${String(index + 1).padStart(3, '0')}`
    ));
    const indiaLanguages = [...earlyLanguages, ...filler, 'English', 'Hindi', 'Tamil'];
    indiaLanguages.sort((left, right) => left.localeCompare(right, 'en'));
    assert.ok(indiaLanguages.length > 100);
    assert.ok(indiaLanguages.indexOf('English') >= 100);
    assert.ok(indiaLanguages.indexOf('Hindi') >= 100);

    let capturedQuery = '';
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.hostname === 'query.wikidata.org') {
        capturedQuery = url.searchParams.get('query') ?? '';
        assert.match(capturedQuery, /wdt:P297 "IN"/);
        assert.match(capturedQuery, /wdt:P298 "IND"/);
        const shared = {
          countryLabel: wikidataValue('India'),
          headLabel: wikidataValue('Droupadi Murmu'),
          officeLabel: wikidataValue('president'),
          population: wikidataValue('1400000000'),
          area: wikidataValue('3287263'),
          capitalLabel: wikidataValue('New Delhi'),
          currencyLabel: wikidataValue('Indian rupee'),
        };
        let bindings = indiaLanguages.map(language => ({
          ...shared,
          languageLabel: wikidataValue(language),
        }));
        const limitMatch = /\bLIMIT\s+(\d+)\s*$/i.exec(capturedQuery);
        if (limitMatch) bindings = bindings.slice(0, Number(limitMatch[1]));
        return new Response(JSON.stringify({ results: { bindings } }));
      }

      if (url.hostname === 'en.wikipedia.org') {
        return new Response(JSON.stringify({ extract: 'India is a country in South Asia.' }));
      }

      throw new Error(`Unexpected country-facts request: ${url}`);
    }) as typeof fetch;

    const result = await getCountryFacts({} as never, { countryCode: 'IN' });

    assert.doesNotMatch(capturedQuery, /\bLIMIT\b/i);
    assert.ok(result.languages.includes('Hindi'), `expected Hindi in ${JSON.stringify(result.languages)}`);
    assert.ok(result.languages.includes('English'), `expected English in ${JSON.stringify(result.languages)}`);
    assert.ok(result.languages.length > 100);
  });
});
