// Corporate-intelligence data product (#5695): SEC EDGAR helpers, seeder pure
// functions, and the four intelligence/v1 handler behaviors. Replaces
// tests/disabled-company-rpcs.test.mts, which locked the pre-#5695 disabled
// state (empty envelopes + source-level forbid list) — the handlers now do real
// work behind verified CIK attribution, so the lock is retired with it.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  EDGAR_FORMS_RE,
  MATERIAL_8K_ITEMS,
  __setCikMapMemoForTests,
  __resetCikMapMemoForTests,
  __testing__ as secEdgarTesting,
  filingDocumentUrl,
  filingIndexUrl,
  isEdgarIsoDate,
  isRelevantForm,
  materialItemCodes,
  normalizeEdgarForms,
  padCik,
  parseItemCodes,
  sanitizeTicker,
} from '../server/_shared/sec-edgar';
import { safeHttpUrl } from '../server/worldmonitor/intelligence/v1/_company-shared';
import {
  MATERIAL_ITEM_CODES,
  build8kStreamSnapshot,
  filterMaterialEvents,
  isSecGovUrl,
  mergeEventWindow,
  parse8kAtomFeed,
  validate8kStream,
} from '../scripts/seed-sec-8k-stream.mjs';
import { MIN_CIK_ENTRIES, slimCikMap, validateCikMap } from '../scripts/seed-sec-cik-map.mjs';
import { getCompanyEnrichment } from '../server/worldmonitor/intelligence/v1/get-company-enrichment';
import { listCompanySignals } from '../server/worldmonitor/intelligence/v1/list-company-signals';
import { searchSecFilings } from '../server/worldmonitor/intelligence/v1/search-sec-filings';
import { ValidationError } from '../src/generated/server/worldmonitor/intelligence/v1/service_server';

const ctx = { request: new Request('http://localhost/'), pathParams: {}, headers: {} } as never;

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  VERCEL_ENV: process.env.VERCEL_ENV,
  VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
  FINNHUB_API_KEY: process.env.FINNHUB_API_KEY,
  EXA_API_KEYS: process.env.EXA_API_KEYS,
  BRAVE_API_KEYS: process.env.BRAVE_API_KEYS,
  SERPAPI_API_KEYS: process.env.SERPAPI_API_KEYS,
};

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __resetCikMapMemoForTests();
});

beforeEach(() => {
  __resetCikMapMemoForTests();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('sec-edgar pure helpers', () => {
  it('pads CIKs to 10 digits and strips non-digits', () => {
    assert.equal(padCik(320193), '0000320193');
    assert.equal(padCik('320193'), '0000320193');
    assert.equal(padCik('CIK 320193'), '0000320193');
  });

  it('sanitizes tickers to the exchange grammar', () => {
    assert.equal(sanitizeTicker(' aapl '), 'AAPL');
    assert.equal(sanitizeTicker('BRK.B'), 'BRK.B');
    assert.equal(sanitizeTicker('bad ticker'), '');
    assert.equal(sanitizeTicker('<script>'), '');
    assert.equal(sanitizeTicker(''), '');
  });

  it('builds sec.gov archive URLs from CIK + accession', () => {
    assert.equal(
      filingIndexUrl('0000320193', '0000320193-26-000012'),
      'https://www.sec.gov/Archives/edgar/data/320193/000032019326000012/0000320193-26-000012-index.htm',
    );
    assert.equal(
      filingDocumentUrl('0001889450', '0001493152-26-032525', 'form8-k.htm'),
      'https://www.sec.gov/Archives/edgar/data/1889450/000149315226032525/form8-k.htm',
    );
    // EDGAR filenames legitimately carry one XSL subdirectory.
    assert.equal(
      filingDocumentUrl('320193', '0001140361-26-025622', 'xslF345X06/form4.xml'),
      'https://www.sec.gov/Archives/edgar/data/320193/000114036126025622/xslF345X06/form4.xml',
    );
  });

  it('never lets a filing document URL escape its filing directory', () => {
    const escaped = filingDocumentUrl('320193', '0001-26-000001', '../../../../secret.htm');
    assert.equal(escaped, 'https://www.sec.gov/Archives/edgar/data/320193/000126000001/secret.htm');
    assert.doesNotMatch(escaped, /\.\./);
    assert.equal(filingDocumentUrl('320193', '0001-26-000001', '../..'), '');
    assert.equal(filingDocumentUrl('320193', '', 'form8-k.htm'), '');
  });

  it('parses submissions item-code strings', () => {
    assert.deepEqual(parseItemCodes('2.02,9.01'), ['2.02', '9.01']);
    assert.deepEqual(parseItemCodes(' 5.02 '), ['5.02']);
    assert.deepEqual(parseItemCodes('garbage'), []);
    assert.deepEqual(parseItemCodes(undefined), []);
  });

  it('rejects forms filters that would silently widen EDGAR search', () => {
    assert.equal(normalizeEdgarForms(undefined), '');
    assert.equal(normalizeEdgarForms(''), '');
    assert.equal(normalizeEdgarForms('8-K'), '8-K');
    assert.equal(normalizeEdgarForms('10-K,10-Q'), '10-K,10-Q');
    // Comma/space-only used to pass EDGAR_FORMS_RE then drop to unfiltered.
    assert.equal(normalizeEdgarForms(','), null);
    assert.equal(normalizeEdgarForms('   '), null);
    assert.equal(normalizeEdgarForms('...'), null);
    assert.equal(EDGAR_FORMS_RE.test(','), false);
    assert.equal(isRelevantForm('40-F'), true);
    assert.equal(isRelevantForm('40-F/A'), true);
  });

  it('accepts only real calendar dates for EDGAR filters', () => {
    assert.equal(isEdgarIsoDate('2026-07-28'), true);
    assert.equal(isEdgarIsoDate('2024-02-29'), true);
    assert.equal(isEdgarIsoDate('2026-02-29'), false);
    assert.equal(isEdgarIsoDate('2026-02-30'), false);
    assert.equal(isEdgarIsoDate('2026-13-01'), false);
  });

  it('strips non-http(s) third-party URLs', () => {
    assert.equal(safeHttpUrl('https://logo.example/t.png'), 'https://logo.example/t.png');
    assert.equal(safeHttpUrl('javascript:alert(1)'), '');
    assert.equal(safeHttpUrl('data:text/html,hi'), '');
    assert.equal(safeHttpUrl('https://user:pass@evil.example/x'), '');
  });

  it('matches names by exact title only, refusing multi-CIK collisions and prefixes', () => {
    const map = {
      AAPL: { cik: 320193, name: 'Apple Inc.' },
      FMNB: { cik: 709337, name: 'Farmers National Banc Corp' },
      FARM: { cik: 34563, name: 'Farmer Bros Co' },
    };
    const exact = secEdgarTesting.matchByName(map, 'apple inc.');
    assert.equal(exact?.cik, '0000320193');
    assert.equal(exact?.matchedBy, 'name');
    // Prefix matching was removed: uniqueness of a short label is not ownership.
    assert.equal(secEdgarTesting.matchByName(map, 'apple'), null);
    assert.equal(secEdgarTesting.matchByName(map, 'farm'), null);
    // Two distinct CIKs with the same legal title must not pick the first map hit.
    const collision = {
      AAA: { cik: 1, name: 'Duplicate Title LLC' },
      BBB: { cik: 2, name: 'Duplicate Title LLC' },
    };
    assert.equal(secEdgarTesting.matchByName(collision, 'duplicate title llc'), null);
    // Share classes: exact title for one class still resolves that ticker.
    const shareClasses = {
      GOOGL: { cik: 1652044, name: 'Alphabet Inc.' },
      GOOG: { cik: 1652044, name: 'Alphabet Inc. Class C' },
    };
    assert.equal(secEdgarTesting.matchByName(shareClasses, 'alphabet inc.')?.ticker, 'GOOGL');
    assert.equal(secEdgarTesting.matchByName(shareClasses, 'alphabet'), null);
  });

  it('serves last-good CIK data only inside the bounded stale window', () => {
    const map = { AAPL: { cik: 320193, name: 'Apple Inc.' } };
    const now = Date.now();
    __setCikMapMemoForTests(map, now - secEdgarTesting.CIK_MAP_MEMO_MS - 1);
    assert.equal(secEdgarTesting.serveStaleMemo(now), map);

    __setCikMapMemoForTests(map, now - secEdgarTesting.CIK_MAP_STALE_MAX_MS);
    assert.equal(secEdgarTesting.serveStaleMemo(now), null);
  });

});

// ---------------------------------------------------------------------------
// Seeder pure functions
// ---------------------------------------------------------------------------

const ATOM_FIXTURE = `<?xml version="1.0" encoding="ISO-8859-1" ?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Latest Filings</title>
<entry>
<title>8-K - Huron Consulting Group Inc. (0001289848) (Filer)</title>
<link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1289848/000162828026049857/0001628280-26-049857-index.htm"/>
<summary type="html">
 &lt;b&gt;Filed:&lt;/b&gt; 2026-07-27 &lt;b&gt;AccNo:&lt;/b&gt; 0001628280-26-049857 &lt;b&gt;Size:&lt;/b&gt; 172 KB
&lt;br&gt;Item 5.02: Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers: Compensatory Arrangements of Certain Officers
</summary>
<updated>2026-07-27T17:29:58-04:00</updated>
<category scheme="https://www.sec.gov/" label="form type" term="8-K"/>
</entry>
<entry>
<title>8-K/A - RTB Digital, Inc. (0001419275) (Filer)</title>
<link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1419275/000118518526003142/0001185185-26-003142-index.htm"/>
<summary type="html">
 &lt;b&gt;Filed:&lt;/b&gt; 2026-07-27 &lt;b&gt;AccNo:&lt;/b&gt; 0001185185-26-003142 &lt;b&gt;Size:&lt;/b&gt; 5 MB
&lt;br&gt;Item 9.01: Financial Statements and Exhibits
</summary>
<updated>2026-07-27T17:30:53-04:00</updated>
<category scheme="https://www.sec.gov/" label="form type" term="8-K/A"/>
</entry>
<entry>
<title>10-Q - Someone Else Corp (0000123456) (Filer)</title>
<link rel="alternate" type="text/html" href="https://www.sec.gov/example"/>
<summary type="html"> &lt;b&gt;Filed:&lt;/b&gt; 2026-07-27 &lt;b&gt;AccNo:&lt;/b&gt; 0000000000-26-000001</summary>
<updated>2026-07-27T17:00:00-04:00</updated>
</entry>
</feed>`;

describe('seed-sec-8k-stream pure functions', () => {
  it('keeps the material set aligned with the server taxonomy', () => {
    assert.deepEqual([...MATERIAL_ITEM_CODES].sort(), materialItemCodes().sort());
  });

  it('parses the getcurrent Atom feed into typed events (8-K forms only)', () => {
    const events = parse8kAtomFeed(ATOM_FIXTURE);
    assert.equal(events.length, 2);
    const [huron, rtb] = events;
    assert.equal(huron.company, 'Huron Consulting Group Inc.');
    assert.equal(huron.cik, '0001289848');
    assert.equal(huron.form, '8-K');
    assert.equal(huron.accession, '0001628280-26-049857');
    assert.equal(huron.items.length, 1);
    assert.equal(huron.items[0].code, '5.02');
    assert.match(huron.items[0].description, /^Departure of Directors/);
    assert.equal(huron.filedAtMs, Date.parse('2026-07-27T17:29:58-04:00'));
    assert.match(huron.url, /^https:\/\/www\.sec\.gov\/Archives/);
    assert.equal(rtb.form, '8-K/A');
  });

  it('stores only sec.gov filing links', () => {
    assert.equal(isSecGovUrl('https://www.sec.gov/Archives/edgar/data/1/2/3-index.htm'), true);
    assert.equal(isSecGovUrl('https://sec.gov/x'), true);
    assert.equal(isSecGovUrl('https://evil.example/x'), false);
    assert.equal(isSecGovUrl('javascript:alert(1)'), false);
    assert.equal(isSecGovUrl('http://www.sec.gov/x'), false);
    assert.equal(isSecGovUrl(''), false);
    // A feed entry carrying a foreign host yields an empty url, never the host.
    const poisoned = ATOM_FIXTURE.replace('https://www.sec.gov/Archives/edgar/data/1289848/000162828026049857/0001628280-26-049857-index.htm', 'https://evil.example/pwn');
    const events = parse8kAtomFeed(poisoned);
    assert.equal(events[0].url, '');
  });

  it('filters routine-only filings out of the material stream', () => {
    const material = filterMaterialEvents(parse8kAtomFeed(ATOM_FIXTURE));
    assert.equal(material.length, 1);
    assert.equal(material[0].items[0].code, '5.02');
  });

  it('merges the rolling window: dedupe by accession, cutoff, newest first', () => {
    const now = Date.parse('2026-07-27T22:00:00Z');
    const day = 24 * 3600 * 1000;
    const old = { company: 'Old', cik: '1', form: '8-K', accession: 'A-old', filedAtMs: now - 8 * day, items: [{ code: '5.02', description: 'x' }], url: '' };
    const kept = { company: 'Kept', cik: '2', form: '8-K', accession: 'A-kept', filedAtMs: now - 2 * day, items: [{ code: '2.01', description: 'x' }], url: '' };
    const updated = { company: 'Updated v1', cik: '3', form: '8-K', accession: 'A-dup', filedAtMs: now - 3 * day, items: [{ code: '4.02', description: 'x' }], url: '' };
    const fresh = { company: 'Updated v2', cik: '3', form: '8-K/A', accession: 'A-dup', filedAtMs: now - day, items: [{ code: '4.02', description: 'x' }], url: '' };
    const merged = mergeEventWindow([old, kept, updated], [fresh], now);
    assert.deepEqual(merged.map((e: { accession: string }) => e.accession), ['A-dup', 'A-kept']);
    assert.equal(merged[0].company, 'Updated v2');
  });

  it('drops far-future events so clock skew cannot pin the top of the stream', () => {
    const now = Date.parse('2026-07-27T22:00:00Z');
    const day = 24 * 3600 * 1000;
    const real = { company: 'Real', cik: '1', form: '8-K', accession: 'A-real', filedAtMs: now - day, items: [{ code: '5.02', description: 'x' }], url: '' };
    const future = { company: 'Skewed', cik: '2', form: '8-K', accession: 'A-future', filedAtMs: now + 5 * day, items: [{ code: '5.02', description: 'x' }], url: '' };
    const merged = mergeEventWindow([future], [real], now);
    assert.deepEqual(merged.map((e: { accession: string }) => e.accession), ['A-real']);
  });

  it('rejects an empty successful feed instead of republishing old events as fresh', () => {
    const previous = {
      events: [{
        company: 'Old',
        cik: '1',
        form: '8-K',
        accession: 'A-old',
        filedAtMs: Date.now() - 86_400_000,
        items: [{ code: '5.02', description: 'x' }],
        url: '',
      }],
    };
    assert.throws(
      () => build8kStreamSnapshot(previous, '<feed xmlns="http://www.w3.org/2005/Atom"></feed>', Date.now()),
      /no entries/i,
    );
  });

  it('rejects a routine-only feed instead of advancing last-good freshness', () => {
    const previous = {
      events: [{
        company: 'Old',
        cik: '1',
        form: '8-K',
        accession: 'A-old',
        filedAtMs: Date.now() - 86_400_000,
        items: [{ code: '5.02', description: 'x' }],
        url: '',
      }],
    };
    const routineOnly = ATOM_FIXTURE.replace(
      /Item 5\.02:[^\n]+/,
      'Item 7.01: Regulation FD Disclosure',
    );
    assert.throws(
      () => build8kStreamSnapshot(previous, routineOnly, Date.now()),
      /no material events/i,
    );
  });

  it('enforces the stream coverage floor at the exact boundary', () => {
    const event = { accession: 'a' };
    assert.equal(validate8kStream({ events: Array(49).fill(event), fetchedAt: new Date().toISOString() }), false);
    assert.equal(validate8kStream({ events: Array(50).fill(event), fetchedAt: new Date().toISOString() }), true);
  });
});

describe('seed-sec-cik-map pure functions', () => {
  it('slims the index-keyed registry into a ticker map, first occurrence wins', () => {
    const slim = slimCikMap({
      0: { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA CORP' },
      1: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
      2: { cik_str: 999, ticker: 'AAPL', title: 'Impostor Corp' },
      3: { cik_str: 0, ticker: 'BAD', title: 'Zero CIK' },
      4: { cik_str: 5, ticker: '', title: 'No ticker' },
    });
    assert.deepEqual(Object.keys(slim).sort(), ['AAPL', 'NVDA']);
    assert.deepEqual(slim.AAPL, { cik: 320193, name: 'Apple Inc.' });
  });

  it('publishes a sane coverage floor', () => {
    assert.ok(MIN_CIK_ENTRIES >= 5000);
  });

  it('enforces the CIK registry floor at the exact boundary', () => {
    const tickers = (count: number) => Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`T${index}`, { cik: index + 1, name: `Company ${index}` }]),
    );
    assert.equal(validateCikMap({ tickers: tickers(4_999) }), false);
    assert.equal(validateCikMap({ tickers: tickers(5_000) }), true);
  });
});

// ---------------------------------------------------------------------------
// Handler behaviors (mocked Redis + upstreams)
// ---------------------------------------------------------------------------

function configureRedis() {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  process.env.VERCEL_ENV = 'production';
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  // Force the news-mentions leg down the (mockable) RSS fallback.
  delete process.env.EXA_API_KEYS;
  delete process.env.BRAVE_API_KEYS;
  delete process.env.SERPAPI_API_KEYS;
}

function envelope(data: unknown, fetchedAt = Date.now()) {
  // _seed.fetchedAt must be a NUMBER (epoch ms) or unwrapEnvelope treats the
  // value as a legacy non-envelope shape and passes it through wholesale.
  return {
    _seed: { fetchedAt, recordCount: 1, sourceVersion: 't', schemaVersion: 1, state: 'OK' },
    data,
  };
}

function upstashGet(value: unknown) {
  return new Response(JSON.stringify({ result: value === null ? null : JSON.stringify(value) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const CIK_MAP_VALUE = envelope({
  tickers: {
    TSTA: { cik: 111222, name: 'Testable Alpha Inc.' },
    TSTB: { cik: 333444, name: 'Testable Beta Corp' },
    TSTC: { cik: 555666, name: 'Zebrafields Corp' },
  },
});

interface MockRoutes {
  submissions?: unknown | 'fail';
  profile?: unknown | 'fail';
  earnings?: unknown | 'fail';
  efts?: unknown | 'fail';
  // Set null to simulate the ticker registry being unreadable.
  cikMap?: unknown | null;
  cache?: Record<string, unknown>;
}

function installFetchMock(routes: MockRoutes) {
  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://redis.example.test/get/')) {
      const key = decodeURIComponent(url.slice('https://redis.example.test/get/'.length));
      if (key === 'intelligence:sec-cik-map:v1') {
        return upstashGet('cikMap' in routes ? routes.cikMap : CIK_MAP_VALUE);
      }
      if (routes.cache && key in routes.cache) return upstashGet(routes.cache[key]);
      return upstashGet(null); // every cachedFetchJson read misses → fetcher runs
    }
    if (url.startsWith('https://redis.example.test/')) {
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    if (url.startsWith('https://data.sec.gov/submissions/')) {
      if (routes.submissions === 'fail') return new Response('nope', { status: 503 });
      return new Response(JSON.stringify(routes.submissions ?? null), { status: 200 });
    }
    if (url.startsWith('https://finnhub.io/api/v1/stock/profile2')) {
      if (routes.profile === 'fail') return new Response('nope', { status: 503 });
      return new Response(JSON.stringify(routes.profile ?? {}), { status: 200 });
    }
    if (url.startsWith('https://finnhub.io/api/v1/stock/earnings')) {
      if (routes.earnings === 'fail') return new Response('nope', { status: 503 });
      return new Response(JSON.stringify(routes.earnings ?? []), { status: 200 });
    }
    if (url.startsWith('https://efts.sec.gov/')) {
      if (routes.efts === 'fail') return new Response('nope', { status: 503 });
      return new Response(JSON.stringify(routes.efts ?? {}), { status: 200 });
    }
    // Google News RSS fallback for the news-mentions leg: empty feed.
    if (url.includes('news.google.com')) {
      return new Response('<rss><channel></channel></rss>', { status: 200 });
    }
    return new Response('unexpected fetch: ' + url, { status: 599 });
  }) as typeof fetch;
}

const SUBMISSIONS_FIXTURE = {
  name: 'Testable Alpha Inc.',
  sicDescription: 'Prepackaged Software',
  // SEC publishes this field but leaves it EMPTY in practice — 0 of 15 sampled
  // filers populate it, Apple and NVIDIA included. The fixture mirrors that, so
  // nothing here can depend on a value the real upstream never sends.
  website: '',
  tickers: ['TSTA'],
  exchanges: ['NASDAQ'],
  stateOfIncorporationDescription: 'DE',
  addresses: { business: { city: 'AUSTIN', stateOrCountryDescription: 'TX' } },
  filings: {
    recent: {
      form: ['8-K', '10-Q', '4', '8-K'],
      filingDate: ['2026-07-20', '2026-07-01', '2026-06-20', '2026-06-15'],
      accessionNumber: ['0001-26-000004', '0001-26-000003', '0001-26-000002', '0001-26-000001'],
      primaryDocument: ['a.htm', 'b.htm', 'c.xml', 'd.htm'],
      items: ['2.01,9.01', '', '', '7.01'],
      acceptanceDateTime: ['2026-07-20T12:00:00.000Z', '2026-07-01T12:00:00.000Z', '2026-06-20T12:00:00.000Z', '2026-06-15T12:00:00.000Z'],
    },
  },
};

describe('getCompanyEnrichment', () => {
  it('rejects a request with no company reference', async () => {
    configureRedis();
    installFetchMock({});
    await assert.rejects(
      () => getCompanyEnrichment(ctx, { ticker: '', name: '' }),
      ValidationError,
    );
  });

  it('aggregates SEC + Finnhub + earnings into the composite envelope', async () => {
    configureRedis();
    process.env.FINNHUB_API_KEY = 'test-finnhub';
    installFetchMock({
      submissions: SUBMISSIONS_FIXTURE,
      profile: { name: 'Testable Alpha Inc.', exchange: 'NASDAQ NMS', finnhubIndustry: 'Technology', marketCapitalization: 1234.5, ipo: '2015-05-05', logo: 'https://logo.example/t.png', country: 'US', currency: 'USD', weburl: 'https://www.testable-alpha.example' },
      earnings: [
        { period: '2026-03-31', actual: 2.0, estimate: 1.5, surprise: 0.5, surprisePercent: 33.3, year: 2026, quarter: 1 },
        { period: '2026-06-30', actual: 1.0, estimate: 1.2, surprise: -0.2, surprisePercent: -16.7, year: 2026, quarter: 2 },
      ],
    });

    const resp = await getCompanyEnrichment(ctx, { ticker: 'TSTA', name: '' });
    assert.deepEqual(resp.sources, ['sec_edgar', 'finnhub']);
    assert.equal(resp.company?.cik, '0000111222');
    assert.equal(resp.company?.ticker, 'TSTA');
    assert.equal(resp.company?.name, 'Testable Alpha Inc.');
    assert.equal(resp.company?.description, 'Prepackaged Software');
    assert.equal(resp.company?.location, 'AUSTIN, TX');
    // SEC leaves `website` empty, so the reported domain comes from the market
    // profile — the fallback is the normal path, not an edge case.
    assert.equal(resp.company?.website, 'https://www.testable-alpha.example');
    assert.equal(resp.company?.domain, 'testable-alpha.example');
    assert.equal(resp.market?.industry, 'Technology');
    assert.equal(resp.market?.marketCapMusd, 1234.5);
    // Newest earnings first.
    assert.equal(resp.earningsSurprises[0]?.period, '2026-06-30');
    // Ownership form 4 is filtered; the two 8-Ks and the 10-Q survive.
    assert.equal(resp.secFilings?.totalFilings, 4);
    assert.deepEqual(resp.secFilings?.recentFilings.map(f => f.form), ['8-K', '10-Q', '8-K']);
    const materialFiling = resp.secFilings?.recentFilings[0];
    assert.deepEqual(materialFiling?.items, ['2.01', '9.01']);
    assert.match(materialFiling?.description ?? '', /Completion of Acquisition/);
    assert.match(materialFiling?.url ?? '', /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/111222\//);
  });

  it('preserves the oldest successful source fetch time on cache hits', async () => {
    configureRedis();
    process.env.FINNHUB_API_KEY = 'test-finnhub';
    const secFetchedAtMs = 1_720_000_000_000;
    const profileFetchedAtMs = secFetchedAtMs + 60_000;
    installFetchMock({
      cache: {
        'intel:company:sec-submissions:v3:0000111222': {
          name: 'Testable Alpha Inc.',
          sicDescription: 'Prepackaged Software',
          website: '',
          tickers: ['TSTA'],
          exchanges: ['NASDAQ'],
          stateOfIncorporation: 'DE',
          city: 'AUSTIN',
          stateOrCountry: 'TX',
          totalRecentFilings: 0,
          filings: [],
          fetchedAtMs: secFetchedAtMs,
        },
        'intel:company:finnhub-profile:v2:TSTA': {
          name: 'Testable Alpha Inc.',
          website: 'https://testable-alpha.example',
          market: { exchange: 'NASDAQ' },
          fetchedAtMs: profileFetchedAtMs,
        },
        'intel:company:earnings-surprises:v2:TSTA': {
          items: [],
          fetchedAtMs: profileFetchedAtMs,
        },
      },
    });

    const resp = await getCompanyEnrichment(ctx, { ticker: 'TSTA', name: '', domain: '' });
    assert.equal(resp.enrichedAtMs, secFetchedAtMs);
  });

  it('preserves the deprecated domain-only v1 stub contract', async () => {
    configureRedis();
    installFetchMock({});
    const resp = await getCompanyEnrichment(ctx, { domain: 'Example.COM', name: '', ticker: '' });
    assert.deepEqual(resp.company, {
      name: '',
      domain: 'example.com',
      description: '',
      location: '',
      website: 'https://example.com',
      founded: 0,
      cik: '',
      ticker: '',
    });
    assert.deepEqual(resp.sources, []);
    assert.deepEqual(resp.techStack, []);
    assert.deepEqual(resp.hackerNewsMentions, []);
  });

  it('declares a User-Agent on the direct Upstash CIK registry read', async () => {
    configureRedis();
    installFetchMock({});
    const innerFetch = globalThis.fetch;
    let userAgent = '';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/get/intelligence%3Asec-cik-map%3Av1')) {
        userAgent = new Headers(init?.headers).get('User-Agent') ?? '';
      }
      return innerFetch(input, init);
    }) as typeof fetch;

    await getCompanyEnrichment(ctx, { ticker: 'TSTA', name: '', domain: '' });
    assert.match(userAgent, /WorldMonitor/);
  });

  it('degrades truthfully when SEC is down: no fabricated filings, no sec_edgar source', async () => {
    configureRedis();
    process.env.FINNHUB_API_KEY = 'test-finnhub';
    installFetchMock({
      submissions: 'fail',
      profile: { name: 'Testable Beta Corp', exchange: 'NYSE', finnhubIndustry: 'Banking' },
      earnings: [],
    });
    const resp = await getCompanyEnrichment(ctx, { ticker: 'TSTB', name: '' });
    assert.equal(resp.sources.includes('sec_edgar'), false);
    assert.equal(resp.sources.includes('finnhub'), true);
    assert.equal(resp.secFilings, undefined);
    assert.equal(resp.company?.cik, '0000333444');
  });

  it('marks a resolved company unavailable when every enrichment source fails', async () => {
    configureRedis();
    delete process.env.FINNHUB_API_KEY;
    installFetchMock({ submissions: 'fail' });
    const resp = await getCompanyEnrichment(ctx, { ticker: 'TSTC', name: '' });
    assert.equal(resp.company?.cik, '0000555666');
    assert.equal(resp.unavailable, true);
    assert.equal(resp.enrichedAtMs, 0, 'a total outage must not be relabeled with the assembly time');
    assert.deepEqual(resp.sources, []);
  });

  it('returns an empty envelope for a company absent from the SEC registry', async () => {
    configureRedis();
    installFetchMock({});
    const resp = await getCompanyEnrichment(ctx, { ticker: 'ZZZZ', name: '' });
    assert.deepEqual(resp.sources, []);
    assert.equal(resp.company?.cik, '');
    assert.equal(resp.secFilings, undefined);
    assert.deepEqual(resp.earningsSurprises, []);
  });

  it('reports a registry outage as unavailable, not as "no such company"', async () => {
    configureRedis();
    installFetchMock({ cikMap: null });
    const resp = await getCompanyEnrichment(ctx, { ticker: 'TSTA', name: '' });
    assert.equal(resp.unavailable, true, 'an unreadable registry must not read as an authoritative miss');
    assert.deepEqual(resp.sources, []);

    __resetCikMapMemoForTests();
    const signals = await listCompanySignals(ctx, { ticker: 'TSTA', company: '' });
    assert.equal(signals.unavailable, true);
  });

  it('rejects a CIK registry snapshot beyond its declared source-freshness budget', async () => {
    configureRedis();
    const staleFetchedAt = Date.now() - secEdgarTesting.CIK_MAP_SOURCE_MAX_STALE_MS;
    installFetchMock({ cikMap: envelope(CIK_MAP_VALUE.data, staleFetchedAt) });
    const resp = await getCompanyEnrichment(ctx, { ticker: 'TSTA', name: '' });
    assert.equal(resp.company?.cik, '');
    assert.equal(resp.unavailable, true);
  });

  it('shares one registry read across concurrent cold requests', async () => {
    configureRedis();
    let registryReads = 0;
    installFetchMock({});
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('sec-cik-map')) registryReads += 1;
      return inner(input, init);
    }) as typeof fetch;

    await Promise.all([
      getCompanyEnrichment(ctx, { ticker: 'TSTA', name: '' }),
      getCompanyEnrichment(ctx, { ticker: 'TSTB', name: '' }),
      getCompanyEnrichment(ctx, { ticker: 'TSTC', name: '' }),
    ]);
    assert.equal(registryReads, 1, 'three concurrent cold requests must not each pull the ~650KB registry');
  });

  it('marks a genuine miss as available so it stays cacheable', async () => {
    configureRedis();
    installFetchMock({});
    const resp = await getCompanyEnrichment(ctx, { ticker: 'ZZZZ', name: '' });
    assert.equal(resp.unavailable, false, 'a real "not in the registry" answer is cacheable');
  });

  it('uses bounded last-good registry data after a failed refresh, then expires it', async () => {
    configureRedis();
    installFetchMock({ cikMap: null, submissions: SUBMISSIONS_FIXTURE });
    const map = { TSTA: { cik: 111222, name: 'Testable Alpha Inc.' } };
    const now = Date.now();

    __setCikMapMemoForTests(map, now - secEdgarTesting.CIK_MAP_MEMO_MS - 1);
    const stale = await getCompanyEnrichment(ctx, { ticker: 'TSTA', name: '' });
    assert.equal(stale.company?.cik, '0000111222');
    assert.equal(stale.unavailable, false);

    __resetCikMapMemoForTests();
    __setCikMapMemoForTests(map, now - secEdgarTesting.CIK_MAP_STALE_MAX_MS);
    const expired = await getCompanyEnrichment(ctx, { ticker: 'TSTA', name: '' });
    assert.equal(expired.company?.cik, '');
    assert.equal(expired.unavailable, true);
  });

  it('keeps relevant filings for a filer whose recent window is mostly ownership forms', async () => {
    configureRedis();
    // 250 Form 4s ahead of the only 10-K: a chronological cap would drop it.
    const noise = Array.from({ length: 250 }, (_, i) => i);
    installFetchMock({
      submissions: {
        ...SUBMISSIONS_FIXTURE,
        filings: {
          recent: {
            form: [...noise.map(() => '4'), '10-K'],
            filingDate: [...noise.map(() => '2026-07-01'), '2026-06-01'],
            accessionNumber: [...noise.map((i) => `0001-26-0000${i}`), '0001-26-999999'],
            primaryDocument: [...noise.map(() => 'f4.xml'), 'tenk.htm'],
            items: [...noise.map(() => ''), ''],
            acceptanceDateTime: [...noise.map(() => '2026-07-01T12:00:00.000Z'), '2026-06-01T12:00:00.000Z'],
          },
        },
      },
    });
    const resp = await getCompanyEnrichment(ctx, { ticker: 'TSTA', name: '' });
    assert.deepEqual(resp.secFilings?.recentFilings.map(f => f.form), ['10-K']);
    assert.equal(resp.secFilings?.totalFilings, 251, 'the reported total still counts every filing');
  });

  it('refuses a non-exact company name instead of prefix-guessing (#3754/#3755)', async () => {
    configureRedis();
    installFetchMock({ submissions: SUBMISSIONS_FIXTURE });
    // Prefix of two distinct filers — exact-title policy returns empty, not a coin flip.
    const resp = await getCompanyEnrichment(ctx, { ticker: '', name: 'Testable' });
    assert.deepEqual(resp.sources, []);
    assert.equal(resp.company?.cik, '');
    assert.equal(resp.unavailable, false);
  });

  it('resolves an exact SEC title to the unique filer', async () => {
    configureRedis();
    installFetchMock({ submissions: SUBMISSIONS_FIXTURE });
    const resp = await getCompanyEnrichment(ctx, { ticker: '', name: 'Testable Alpha Inc.' });
    assert.equal(resp.company?.cik, '0000111222');
    assert.equal(resp.company?.ticker, 'TSTA');
    assert.equal(resp.unavailable, false);
  });





});

describe('listCompanySignals', () => {
  it('rejects a request with no company reference', async () => {
    configureRedis();
    installFetchMock({});
    await assert.rejects(
      () => listCompanySignals(ctx, { ticker: '', company: '' }),
      ValidationError,
    );
  });

  it('classifies dated 8-K events without inventing an earnings event date', async () => {
    configureRedis();
    process.env.FINNHUB_API_KEY = 'test-finnhub';
    const recentIso = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    const recentDate = recentIso.slice(0, 10);
    installFetchMock({
      submissions: {
        ...SUBMISSIONS_FIXTURE,
        filings: {
          recent: {
            form: ['8-K', '8-K'],
            filingDate: [recentDate, recentDate],
            accessionNumber: ['0001-26-000010', '0001-26-000011'],
            primaryDocument: ['a.htm', 'b.htm'],
            // One high-materiality restatement; one routine-only Reg FD (must not signal).
            items: ['4.02,9.01', '7.01'],
            acceptanceDateTime: [recentIso, recentIso],
          },
        },
      },
      earnings: [
        // `period` is the fiscal period end, not the report timestamp. Exact
        // equality also must not be labeled a beat.
        { period: recentDate, actual: 1.5, estimate: 1.5, surprise: 0, surprisePercent: 0, year: 2026, quarter: 2 },
      ],
    });

    const resp = await listCompanySignals(ctx, { ticker: 'TSTA', company: '' });
    assert.equal(resp.company, 'Testable Alpha Inc.');
    const types = resp.signals.map(signal => signal.type).sort();
    assert.deepEqual(types, ['Restatement']);

    const restatement = resp.signals.find(signal => signal.type === 'Restatement');
    assert.equal(restatement?.source, 'sec_edgar');
    assert.equal(restatement?.sourceTier, 1);
    assert.equal(restatement?.strength, 'Strong');
    assert.match(restatement?.title ?? '', /Non-Reliance/);
    assert.match(restatement?.url ?? '', /^https:\/\/www\.sec\.gov\//);

    assert.equal(resp.summary?.totalSignals, 1);
    assert.deepEqual(resp.summary?.byType, { Restatement: 1 });
    assert.equal(resp.summary?.strongestSignal?.type, 'Restatement');
    assert.equal(resp.summary?.signalDiversity, 1);
  });

  it('headlines a multi-item 8-K by its most material item, not the lowest code', async () => {
    configureRedis();
    const recentIso = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    installFetchMock({
      submissions: {
        ...SUBMISSIONS_FIXTURE,
        filings: {
          recent: {
            form: ['8-K'],
            filingDate: [recentIso.slice(0, 10)],
            accessionNumber: ['0001-26-000020'],
            primaryDocument: ['a.htm'],
            // 2.02 (medium, earnings exhibit) sorts first; 5.02 is the news.
            items: ['2.02,5.02'],
            acceptanceDateTime: [recentIso],
          },
        },
      },
      earnings: [],
    });
    const resp = await listCompanySignals(ctx, { ticker: 'TSTA', company: '' });
    assert.equal(resp.signals[0]?.type, 'Executive Change');
    assert.equal(resp.signals[0]?.strength, 'Strong');
  });

  it('drops unreported earnings periods instead of rendering them as a beat', async () => {
    configureRedis();
    process.env.FINNHUB_API_KEY = 'test-finnhub';
    installFetchMock({
      submissions: { ...SUBMISSIONS_FIXTURE, filings: { recent: { form: [], filingDate: [], accessionNumber: [], primaryDocument: [], items: [], acceptanceDateTime: [] } } },
      earnings: [
        // Not yet reported: Finnhub sends nulls. Coercing to 0 would publish a
        // "0.00 vs 1.50 est" Earnings Beat for a quarter nobody has reported.
        { period: '2026-12-31', actual: null, estimate: 1.5, surprise: null, surprisePercent: null, year: 2026, quarter: 4 },
      ],
    });
    const resp = await listCompanySignals(ctx, { ticker: 'TSTA', company: '' });
    assert.deepEqual(resp.signals.filter(s => s.type.startsWith('Earnings')), []);
  });

  it('returns a zeroed summary for a company absent from the SEC registry', async () => {
    configureRedis();
    installFetchMock({});
    const resp = await listCompanySignals(ctx, { ticker: '', company: 'No Such Company Anywhere' });
    assert.deepEqual(resp.signals, []);
    assert.equal(resp.summary?.totalSignals, 0);
    assert.equal(resp.summary?.signalDiversity, 0);
    assert.equal(resp.cik, '', 'an empty CIK marks an unresolved company');
  });

  it('preserves the deprecated domain v1 stub contract', async () => {
    configureRedis();
    installFetchMock({});
    const resp = await listCompanySignals(ctx, { ticker: '', company: 'Legacy Co', domain: 'legacy.example' });
    assert.equal(resp.company, 'Legacy Co');
    assert.equal(resp.domain, 'legacy.example');
    assert.deepEqual(resp.signals, []);
    assert.equal(resp.summary?.totalSignals, 0);
  });

  it('distinguishes a resolved-but-quiet company from an unresolved one via cik', async () => {
    configureRedis();
    // Resolves, but every filing is older than the 90-day signal window and
    // there are no earnings or news — zero signals with a real CIK.
    installFetchMock({
      submissions: {
        ...SUBMISSIONS_FIXTURE,
        filings: {
          recent: {
            form: ['8-K'],
            filingDate: ['2020-01-02'],
            accessionNumber: ['0001-20-000001'],
            primaryDocument: ['a.htm'],
            items: ['4.02'],
            acceptanceDateTime: ['2020-01-02T12:00:00.000Z'],
          },
        },
      },
      earnings: [],
    });
    const resp = await listCompanySignals(ctx, { ticker: 'TSTA', company: '' });
    assert.deepEqual(resp.signals, []);
    assert.equal(resp.summary?.totalSignals, 0);
    assert.equal(resp.cik, '0000111222', 'a resolved company keeps its CIK even with zero signals');
  });

  it('marks a resolved partial response unavailable when SEC submissions fail', async () => {
    configureRedis();
    installFetchMock({ submissions: 'fail' });
    const resp = await listCompanySignals(ctx, { ticker: 'TSTB', company: '' });
    assert.equal(resp.cik, '0000333444');
    assert.equal(resp.unavailable, true, 'an SEC outage must not masquerade as a quiet filing window');
  });
});

describe('searchSecFilings', () => {
  it('rejects an empty query', async () => {
    configureRedis();
    installFetchMock({});
    await assert.rejects(
      () => searchSecFilings(ctx, { query: ' ', forms: '', startDate: '', endDate: '', limit: 0 }),
      ValidationError,
    );
  });

  it('maps EDGAR full-text hits and honors the limit', async () => {
    configureRedis();
    const eftsUrls: string[] = [];
    installFetchMock({
      efts: {
        hits: {
          total: { value: 42 },
          hits: [
            {
              _id: '0001493152-26-032525:form8-k.htm',
              _source: {
                ciks: ['0001889450'],
                display_names: ['FutureTech II Acquisition Corp.  (CIK 0001889450)'],
                form: '8-K',
                file_date: '2026-07-08',
                items: ['4.02'],
                adsh: '0001493152-26-032525',
              },
            },
            { _id: 'x:y.htm', _source: { ciks: ['1'], display_names: ['B'], form: '10-K', file_date: '2026-07-01', adsh: 'x' } },
          ],
        },
      },
    });
    const innerFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://efts.sec.gov/')) eftsUrls.push(url);
      return innerFetch(input, init);
    }) as typeof fetch;
    const resp = await searchSecFilings(ctx, { query: 'material weakness', forms: '8-K', startDate: '2026-07-01', endDate: '2026-07-28', limit: 1 });
    assert.equal(resp.unavailable, false);
    assert.equal(resp.total, 42);
    assert.equal(resp.results.length, 1);
    assert.ok(eftsUrls.some(u => /[?&]size=1(?:&|$)/.test(u)), `EFTS request must set size=limit; got ${eftsUrls.join(' | ')}`);
    const [first] = resp.results;
    assert.equal(first.cik, '0001889450');
    assert.deepEqual(first.items, ['4.02']);
    assert.equal(first.url, 'https://www.sec.gov/Archives/edgar/data/1889450/000149315226032525/form8-k.htm');
  });

  it('rejects malformed filters instead of silently widening the search', async () => {
    configureRedis();
    installFetchMock({});
    await assert.rejects(
      () => searchSecFilings(ctx, { query: 'merger', forms: '', startDate: 'last-tuesday', endDate: '', limit: 0 }),
      ValidationError,
    );
    await assert.rejects(
      () => searchSecFilings(ctx, { query: 'merger', forms: '8-K"; DROP', startDate: '', endDate: '', limit: 0 }),
      ValidationError,
    );
    await assert.rejects(
      () => searchSecFilings(ctx, { query: 'merger', forms: ',', startDate: '', endDate: '', limit: 0 }),
      ValidationError,
      'comma-only forms must not silently widen the EDGAR query',
    );
    await assert.rejects(
      () => searchSecFilings(ctx, { query: 'merger', forms: '', startDate: '2026-02-30', endDate: '', limit: 0 }),
      ValidationError,
      'impossible calendar dates must not reach EDGAR',
    );
    await assert.rejects(
      () => searchSecFilings(ctx, { query: 'merger', forms: '', startDate: '2026-07-20', endDate: '2026-07-01', limit: 0 }),
      ValidationError,
      'a reversed range must not silently return an unintended result set',
    );
  });

  it('reports unavailable when EDGAR search is down', async () => {
    configureRedis();
    installFetchMock({ efts: 'fail' });
    const resp = await searchSecFilings(ctx, { query: 'no-cache-here-' + Math.random(), forms: '', startDate: '', endDate: '', limit: 0 });
    assert.equal(resp.unavailable, true);
    assert.deepEqual(resp.results, []);
  });

  it('preserves a cached EDGAR result timestamp without refetching upstream', async () => {
    configureRedis();
    const fetchedAtMs = 1_720_000_000_000;
    const search = new URLSearchParams({ q: '"cached freshness"', size: '10' }).toString();
    const hash = createHash('sha256').update(search).digest('hex').slice(0, 16);
    let eftsCalls = 0;
    installFetchMock({
      cache: {
        [`intel:company:edgar-fts:${hash}`]: { total: 0, results: [], fetchedAtMs },
      },
    });
    const innerFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://efts.sec.gov/')) eftsCalls += 1;
      return innerFetch(input, init);
    }) as typeof fetch;

    const resp = await searchSecFilings(ctx, {
      query: 'cached freshness',
      forms: '',
      startDate: '',
      endDate: '',
      limit: 0,
    });
    assert.equal(resp.fetchedAtMs, fetchedAtMs);
    assert.equal(eftsCalls, 0);
  });
});
