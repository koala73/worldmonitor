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
    globalThis.fetch = (async (input: string | URL | Request) => {
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
              ...(query.includes('wdt:P2936')
                ? [{ ...shared, languageLabel: wikidataValue('English') }]
                : []),
              { ...shared, languageLabel: wikidataValue('Spanish') },
              { ...shared, languageLabel: wikidataValue('Hawaiian') },
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
      languages: ['English', 'Spanish', 'Hawaiian'],
      currencies: ['United States dollar'],
      areaSqKm: 9_826_675,
      countryName: 'United States',
    });
    assert.ok(
      !requestedHosts.includes('restcountries.com'),
      'the retired REST Countries v3 endpoint must not be called',
    );
  });

  it('does not infer a language for a territory with no factual language binding', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.hostname === 'query.wikidata.org') {
        return new Response(JSON.stringify({
          results: {
            bindings: [{
              countryLabel: wikidataValue('Antarctica'),
              population: wikidataValue('1000'),
              area: wikidataValue('14200000'),
            }],
          },
        }));
      }

      if (url.hostname === 'en.wikipedia.org') {
        return new Response(JSON.stringify({ extract: 'Antarctica is a continent.' }));
      }

      throw new Error(`Unexpected country-facts request: ${url}`);
    }) as typeof fetch;

    const result = await getCountryFacts({} as never, { countryCode: 'AQ' });

    assert.deepEqual(result.languages, []);
  });
});
