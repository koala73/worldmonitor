import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { __clearLocalUnavailableBackoffForTests } from '../server/_shared/redis.ts';
import {
  getCountryFacts,
  selectWikidataEntityId,
} from '../server/worldmonitor/intelligence/v1/get-country-facts.ts';

const originalFetch = globalThis.fetch;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_URL = 'https://redis.country-facts.test';
const NEG_SENTINEL = '__WM_NEG__';

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv('UPSTASH_REDIS_REST_URL', originalRedisUrl);
  restoreEnv('UPSTASH_REDIS_REST_TOKEN', originalRedisToken);
  __clearLocalUnavailableBackoffForTests();
});

function configureRemoteRedis(): void {
  process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
}

function wikidataCacheWrites(writes: string[]): string[] {
  return writes.filter(body => body.includes('intel:country-facts:wikidata:v6:'));
}

function wikidataWritesContainNegSentinel(writes: string[]): boolean {
  return wikidataCacheWrites(writes).some(body => body.includes(NEG_SENTINEL));
}

function wikidataValue(value: string): { value: string } {
  return { value };
}

function wikidataEntity(qid: string, label: string): {
  country: { value: string };
  countryLabel: { value: string };
} {
  return {
    country: { value: `http://www.wikidata.org/entity/${qid}` },
    countryLabel: { value: label },
  };
}

function isWikidataIdentityQuery(query: string): boolean {
  return query.includes('wdt:P297') && !/\bwd:Q\d+\b/.test(query);
}

const ISO_ENTITIES = {
  US: { qid: 'Q30', label: 'United States' },
  BR: { qid: 'Q155', label: 'Brazil' },
  FR: { qid: 'Q142', label: 'France' },
  JP: { qid: 'Q17', label: 'Japan' },
  ZA: { qid: 'Q258', label: 'South Africa' },
  AQ: { qid: 'Q51', label: 'Antarctica' },
  IN: { qid: 'Q668', label: 'India' },
  NL: { qid: 'Q55', label: 'Netherlands' },
} as const;

function identityBindingsForQuery(
  query: string,
  extra: Array<ReturnType<typeof wikidataEntity>> = [],
): Response | null {
  if (!isWikidataIdentityQuery(query)) return null;
  const code = query.match(/wdt:P297 "([A-Z]{2})"/)?.[1] as keyof typeof ISO_ENTITIES | undefined;
  const entity = code ? ISO_ENTITIES[code] : undefined;
  if (!entity) return null;
  return new Response(JSON.stringify({
    results: { bindings: [...extra, wikidataEntity(entity.qid, entity.label)] },
  }));
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
        const identity = identityBindingsForQuery(query);
        if (identity) return identity;
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
        const identity = identityBindingsForQuery(query);
        if (identity) {
          assert.match(query, /wdt:P297 "BR"/, 'the identity query must use the requested ISO country code');
          return identity;
        }
        assert.match(query, /\bwd:Q155\b/, 'facts query must pin the verified Brazil entity');

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
      FR: { iso3: 'FRA', qid: 'Q142', name: 'France', capital: 'Paris', language: 'French', currency: 'euro' },
      JP: { iso3: 'JPN', qid: 'Q17', name: 'Japan', capital: 'Tokyo', language: 'Japanese', currency: 'yen' },
      ZA: { iso3: 'ZAF', qid: 'Q258', name: 'South Africa', capital: 'Bloemfontein', language: 'Zulu', currency: 'rand' },
    } as const;

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.hostname === 'query.wikidata.org') {
        const query = url.searchParams.get('query') ?? '';
        const identity = identityBindingsForQuery(query);
        if (identity) {
          const code = query.match(/wdt:P297 "([A-Z]{2})"/)?.[1] as keyof typeof countries | undefined;
          assert.ok(code && countries[code], 'the identity query must contain the requested ISO country code');
          assert.match(query, new RegExp(`wdt:P298 "${countries[code].iso3}"`));
          return identity;
        }
        const qid = query.match(/\bwd:(Q\d+)\b/)?.[1];
        const country = Object.values(countries).find(entry => entry.qid === qid);
        assert.ok(country, 'facts query must pin a verified representative-country entity');
        const code = (Object.keys(countries) as Array<keyof typeof countries>)
          .find(key => countries[key].qid === qid);
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
        const query = url.searchParams.get('query') ?? '';
        if (wikidataAttempts === 1) return new Response('temporarily unavailable', { status: 503 });
        const identity = identityBindingsForQuery(query);
        if (identity) return identity;
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

  it('does not infer a language for a territory with no factual language binding', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.hostname === 'query.wikidata.org') {
        const query = url.searchParams.get('query') ?? '';
        const identity = identityBindingsForQuery(
          query,
          [wikidataEntity('Q21590062', 'Antarctic Treaty area')],
        );
        if (identity) return identity;
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
        const query = url.searchParams.get('query') ?? '';
        const identity = identityBindingsForQuery(query);
        if (identity) {
          assert.match(query, /wdt:P297 "IN"/);
          assert.match(query, /wdt:P298 "IND"/);
          return identity;
        }
        capturedQuery = query;
        assert.match(capturedQuery, /\bwd:Q668\b/);
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

  it('does not negative-cache a Wikidata status or transport failure', async () => {
    configureRemoteRedis();
    const redis = new Map<string, string>();
    const writes: string[] = [];
    let wikidataCalls = 0;
    let wikidataMode: 'status' | 'network' | 'ok' = 'status';

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const raw = String(input instanceof Request ? input.url : input);
      if (init?.method === 'POST' && init.body) {
        writes.push(String(init.body));
        const command = JSON.parse(String(init.body)) as [string, string, string];
        if (command[0] === 'SET') redis.set(command[1], command[2]);
        return new Response(JSON.stringify({ result: 'OK' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (raw.startsWith(`${REDIS_URL}/get/`)) {
        const key = decodeURIComponent(raw.slice(`${REDIS_URL}/get/`.length));
        return new Response(JSON.stringify({ result: redis.get(key) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const url = new URL(raw);
      if (url.hostname === 'query.wikidata.org') {
        wikidataCalls += 1;
        const query = url.searchParams.get('query') ?? '';
        if (wikidataMode === 'status') return new Response('rate limited', { status: 429 });
        if (wikidataMode === 'network') throw new Error('wikidata network down');
        const identity = identityBindingsForQuery(query);
        if (identity) return identity;
        return new Response(JSON.stringify({
          results: {
            bindings: [{
              countryLabel: wikidataValue('United States'),
              headLabel: wikidataValue('Donald Trump'),
              officeLabel: wikidataValue('president'),
              population: wikidataValue('340110988'),
              area: wikidataValue('9826675'),
              capitalLabel: wikidataValue('Washington, D.C.'),
              languageLabel: wikidataValue('English'),
              currencyLabel: wikidataValue('United States dollar'),
            }],
          },
        }));
      }

      if (url.hostname === 'en.wikipedia.org') {
        return new Response(JSON.stringify({ extract: 'The United States is a country.' }));
      }

      throw new Error(`Unexpected country-facts request: ${raw}`);
    }) as typeof fetch;

    const failed = await getCountryFacts({} as never, { countryCode: 'US' });
    assert.equal(failed.population, 0);
    assert.equal(failed.capital, '');
    assert.equal(failed.headOfState, '');
    assert.equal(wikidataCalls, 1);
    assert.equal(wikidataCacheWrites(writes).length, 0);
    assert.equal(wikidataWritesContainNegSentinel(writes), false);

    const stillFailed = await getCountryFacts({} as never, { countryCode: 'US' });
    assert.equal(stillFailed.population, 0);
    assert.equal(wikidataCalls, 1, 'isolate-local backoff must suppress Wikidata fan-out');
    assert.equal(wikidataCacheWrites(writes).length, 0);

    __clearLocalUnavailableBackoffForTests();
    wikidataMode = 'network';
    const networkFailed = await getCountryFacts({} as never, { countryCode: 'US' });
    assert.equal(networkFailed.population, 0);
    assert.equal(wikidataCalls, 3, 'transport errors retry once, then throw without caching');
    assert.equal(wikidataWritesContainNegSentinel(writes), false);

    __clearLocalUnavailableBackoffForTests();
    wikidataMode = 'ok';
    const recovered = await getCountryFacts({} as never, { countryCode: 'US' });
    assert.equal(recovered.population, 340_110_988);
    assert.equal(recovered.capital, 'Washington, D.C.');
    assert.equal(recovered.headOfState, 'Donald Trump');
    assert.equal(wikidataCalls, 5, 'recovery issues identity then facts after the outage');
    assert.equal(wikidataWritesContainNegSentinel(writes), false);
    assert.ok(
      wikidataCacheWrites(writes).some(body => body.includes('Donald Trump')),
      'recovered facts must be written as a positive cache entry',
    );
  });

  it('negative-caches a successful empty Wikidata result, not a later healthy payload', async () => {
    configureRemoteRedis();
    const redis = new Map<string, string>();
    const writes: string[] = [];
    let wikidataCalls = 0;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const raw = String(input instanceof Request ? input.url : input);
      if (init?.method === 'POST' && init.body) {
        writes.push(String(init.body));
        const command = JSON.parse(String(init.body)) as [string, string, string];
        if (command[0] === 'SET') redis.set(command[1], command[2]);
        return new Response(JSON.stringify({ result: 'OK' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (raw.startsWith(`${REDIS_URL}/get/`)) {
        const key = decodeURIComponent(raw.slice(`${REDIS_URL}/get/`.length));
        return new Response(JSON.stringify({ result: redis.get(key) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const url = new URL(raw);
      if (url.hostname === 'query.wikidata.org') {
        wikidataCalls += 1;
        return new Response(JSON.stringify({ results: { bindings: [] } }));
      }

      if (url.hostname === 'en.wikipedia.org') {
        return new Response(JSON.stringify({ extract: 'Antarctica is a continent.' }));
      }

      throw new Error(`Unexpected country-facts request: ${raw}`);
    }) as typeof fetch;

    const empty = await getCountryFacts({} as never, { countryCode: 'AQ' });
    assert.equal(empty.population, 0);
    assert.deepEqual(empty.languages, []);
    assert.equal(wikidataCalls, 1);
    assert.equal(wikidataWritesContainNegSentinel(writes), true);

    const cachedEmpty = await getCountryFacts({} as never, { countryCode: 'AQ' });
    assert.equal(cachedEmpty.population, 0);
    assert.equal(wikidataCalls, 1, 'successful empty must be served from NEG_SENTINEL');
  });

  it('resolves NL to Q55 and does not mix Kingdom of the Netherlands facts', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    const factsQueries: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.hostname === 'query.wikidata.org') {
        const query = url.searchParams.get('query') ?? '';
        if (isWikidataIdentityQuery(query)) {
          assert.match(query, /wdt:P297 "NL"/);
          assert.match(query, /wdt:P298 "NLD"/);
          return new Response(JSON.stringify({
            results: {
              bindings: [
                wikidataEntity('Q29999', 'Kingdom of the Netherlands'),
                wikidataEntity('Q55', 'Netherlands'),
              ],
            },
          }));
        }

        factsQueries.push(query);
        assert.match(query, /\bwd:Q55\b/, 'facts query must pin the verified Netherlands entity');
        assert.doesNotMatch(query, /\bwd:Q29999\b/);
        assert.doesNotMatch(query, /wdt:P297/);

        return new Response(JSON.stringify({
          results: {
            bindings: [{
              countryLabel: wikidataValue('Netherlands'),
              headLabel: wikidataValue('Willem-Alexander'),
              officeLabel: wikidataValue('King of the Netherlands'),
              population: wikidataValue('17900000'),
              area: wikidataValue('41543'),
              capitalLabel: wikidataValue('Amsterdam'),
              currencyLabel: wikidataValue('euro'),
              languageLabel: wikidataValue('Dutch'),
            }],
          },
        }));
      }

      if (url.hostname === 'en.wikipedia.org') {
        return new Response(JSON.stringify({
          extract: 'The Netherlands is a country in Northwestern Europe.',
        }));
      }

      throw new Error(`Unexpected country-facts request: ${url}`);
    }) as typeof fetch;

    assert.equal(
      selectWikidataEntityId('NL', [
        wikidataEntity('Q29999', 'Kingdom of the Netherlands'),
        wikidataEntity('Q55', 'Netherlands'),
      ]),
      'Q55',
    );

    const result = await getCountryFacts({} as never, { countryCode: 'NL' });

    assert.equal(factsQueries.length, 1);
    assert.deepEqual(result, {
      headOfState: 'Willem-Alexander',
      headOfStateTitle: 'King of the Netherlands',
      wikipediaSummary: 'The Netherlands is a country in Northwestern Europe.',
      wikipediaThumbnailUrl: '',
      population: 17_900_000,
      capital: 'Amsterdam',
      languages: ['Dutch'],
      currencies: ['euro'],
      areaSqKm: 41_543,
      countryName: 'Netherlands',
    });
  });
});
