// get-tariff-trends with partner_country and/or product_sector: the reporter's
// effectively applied average on that partner's goods or in that product
// group, from World Bank WITS tradestats-tariff. Fixtures are real WITS answers
// captured 2026-10-10.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  getTariffTrends,
  isBilateralRequest,
  normalizeTariffTrendRequest,
  tariffTrendSeedKey,
  TARIFF_TREND_REASON as R,
} from '../server/worldmonitor/trade/v1/get-tariff-trends';
import {
  ALL_PRODUCTS_GROUP,
  PRODUCT_GROUPS,
  SIMPLE_INDICATOR,
  parseTradestatsTariff,
  tradestatsKey,
  tradestatsUrl,
  witsCountry,
  witsProductGroup,
} from '../server/worldmonitor/trade/v1/_tradestats-tariff';
import { validateGeneratedRequest } from '../server/request-validator';

import type {
  GetTariffTrendsRequest,
  ServerContext,
} from '../src/generated/server/worldmonitor/trade/v1/service_server';

const FIXTURES = resolve(import.meta.dirname, 'fixtures/wits-tradestats');
const fixture = (name: string): string => readFileSync(resolve(FIXTURES, name), 'utf8');

// URL → [status, fixture]. Anything not listed is an unexpected upstream call.
const WITS_ROUTES: Record<string, [number, string]> = {
  [tradestatsUrl('usa', 'chn', 'Total')]: [200, 'usa-chn-total.xml'],
  [tradestatsUrl('usa', 'chn', 'Textiles')]: [200, 'usa-chn-textiles.xml'],
  [tradestatsUrl('ind', 'wld', '84-85_MachElec')]: [200, 'ind-wld-84-85_machelec.xml'],
  [tradestatsUrl('eun', 'usa', 'Total')]: [200, 'eun-usa-total.xml'],
  [tradestatsUrl('twn', 'usa', 'Total')]: [404, 'no-records.txt'],
};
const REDIRECTED = tradestatsUrl('usa', 'afg', 'Total');

// ── Harness ────────────────────────────────────────────────────────────────

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
  localApiMode: process.env.LOCAL_API_MODE,
  validKeys: process.env.WORLDMONITOR_VALID_KEYS,
};
const REDIS_HOST = 'https://redis.test';
const ENTERPRISE_KEY = 'test-tariff-bilateral-enterprise-key';

let redisStore: Map<string, string>;
let redisReads: string[];
let witsCalls: string[];
let witsFaults: Set<string>;

beforeEach(() => {
  redisStore = new Map();
  redisReads = [];
  witsCalls = [];
  witsFaults = new Set();
  process.env.UPSTASH_REDIS_REST_URL = REDIS_HOST;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  process.env.WORLDMONITOR_VALID_KEYS = ENTERPRISE_KEY;
  delete process.env.LOCAL_API_MODE;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = input instanceof Request ? input.url : String(input);
    const url = new URL(href);
    if (url.origin === REDIS_HOST && url.pathname.startsWith('/get/')) {
      const key = decodeURIComponent(url.pathname.slice('/get/'.length));
      redisReads.push(key);
      return new Response(JSON.stringify({ result: redisStore.get(key) ?? null }), { status: 200 });
    }
    if (url.origin === REDIS_HOST) {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      const commands: unknown[][] = Array.isArray(body?.[0]) ? body : [body];
      for (const cmd of commands) {
        if (Array.isArray(cmd) && cmd[0] === 'SET') redisStore.set(String(cmd[1]), String(cmd[2]));
      }
      const reply = Array.isArray(body?.[0]) ? commands.map(() => ({ result: 'OK' })) : { result: 'OK' };
      return new Response(JSON.stringify(reply), { status: 200 });
    }
    if (url.origin === 'https://wits.worldbank.org') {
      witsCalls.push(href);
      assert.equal(init?.redirect, 'manual', 'WITS error redirects must stay visible');
      if (witsFaults.has(href)) return new Response('Service Unavailable', { status: 503 });
      if (href === REDIRECTED) {
        return new Response('', {
          status: 307,
          headers: { location: 'https://wits.zd.worldbank.org/API/V1/SDMX/V21/rest/data/WITSAPIError/Invalid_Partner' },
        });
      }
      const route = WITS_ROUTES[href];
      if (!route) throw new Error(`unexpected WITS call ${href}`);
      return new Response(fixture(route[1]), { status: route[0] });
    }
    throw new Error(`unexpected fetch to ${href}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const [name, value] of [
    ['UPSTASH_REDIS_REST_URL', ORIGINAL_ENV.url],
    ['UPSTASH_REDIS_REST_TOKEN', ORIGINAL_ENV.token],
    ['LOCAL_API_MODE', ORIGINAL_ENV.localApiMode],
    ['WORLDMONITOR_VALID_KEYS', ORIGINAL_ENV.validKeys],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function premiumCtx(): ServerContext {
  return {
    request: new Request('https://api.worldmonitor.app/api/trade/v1/get-tariff-trends', {
      headers: { 'X-WorldMonitor-Key': ENTERPRISE_KEY },
    }),
  } as ServerContext;
}

function freeCtx(): ServerContext {
  return { request: new Request('https://api.worldmonitor.app/api/trade/v1/get-tariff-trends') } as ServerContext;
}

function request(partial: Partial<GetTariffTrendsRequest> = {}): GetTariffTrendsRequest {
  return { reportingCountry: '840', partnerCountry: '156', productSector: '', years: 5, ...partial };
}

const series = (resp: { datapoints: Array<{ year: number; tariffRate: number; weightedRate: number }> }) =>
  resp.datapoints.map((d) => [d.year, d.tariffRate, d.weightedRate]);

// ── Parsing and codes ──────────────────────────────────────────────────────

describe('WITS tradestats-tariff parsing', () => {
  test('one point per year with the simple and weighted AHS averages', () => {
    const points = parseTradestatsTariff(fixture('usa-chn-total.xml'));
    assert.equal(points[0]!.year, 1991);
    assert.equal(points.at(-1)!.year, 2023);
    assert.deepEqual(points.at(-1), { year: 2023, simple: 3.584, weighted: 2.77 });
    assert.ok(points.every((p, i) => i === 0 || p.year > points[i - 1]!.year), 'sorted by year');
  });

  test('years without a simple average are dropped; a missing weighted average reads 0', () => {
    const xml = `<message:StructureSpecificData><Series INDICATOR="AHS-SMPL-AVRG"><Obs TIME_PERIOD="2020" OBS_VALUE="4.5" /></Series>`
      + `<Series INDICATOR="AHS-WGHTD-AVRG"><Obs TIME_PERIOD="2020" OBS_VALUE="3" /><Obs TIME_PERIOD="2021" OBS_VALUE="2" /></Series>`
      + `<Series INDICATOR="MFN-SMPL-AVRG"><Obs TIME_PERIOD="2022" OBS_VALUE="9" /></Series></message:StructureSpecificData>`;
    assert.deepEqual(parseTradestatsTariff(xml), [{ year: 2020, simple: 4.5, weighted: 3 }]);
    const simpleOnly = `<Series INDICATOR="AHS-SMPL-AVRG"><Obs TIME_PERIOD="2020" OBS_VALUE="4.5" /></Series>`;
    assert.deepEqual(parseTradestatsTariff(simpleOnly), [{ year: 2020, simple: 4.5, weighted: 0 }]);
  });

  test('UN M49 and WTO member codes both resolve to WITS ISO3 codes', () => {
    assert.equal(witsCountry('840', 'reporter'), 'usa');
    assert.equal(witsCountry('156', 'partner'), 'chn');
    // WTO's own codes, which the MFN series is keyed by.
    assert.equal(witsCountry('699', 'reporter'), 'ind');
    assert.equal(witsCountry('356', 'reporter'), 'ind');
    assert.equal(witsCountry('251', 'partner'), 'fra');
    assert.equal(witsCountry('757', 'partner'), 'che');
    assert.equal(witsCountry('579', 'reporter'), 'nor');
    // The EU reports as one but is not a partner here; World is only a partner.
    assert.equal(witsCountry('918', 'reporter'), 'eun');
    assert.equal(witsCountry('918', 'partner'), null);
    assert.equal(witsCountry('000', 'partner'), 'wld');
    assert.equal(witsCountry('000', 'reporter'), null);
    assert.equal(witsCountry('999', 'partner'), null);
  });

  test('product groups match case-insensitively and keep the WITS spelling', () => {
    assert.equal(witsProductGroup(''), ALL_PRODUCTS_GROUP);
    assert.equal(witsProductGroup('ALL'), ALL_PRODUCTS_GROUP);
    assert.equal(witsProductGroup('textiles'), 'Textiles');
    assert.equal(witsProductGroup('84-85_machelec'), '84-85_MachElec');
    assert.equal(witsProductGroup('01'), null);
    // Every group passes the contract's product_sector pattern.
    for (const group of PRODUCT_GROUPS) {
      assert.equal(
        validateGeneratedRequest('getTariffTrends', { reportingCountry: '840', partnerCountry: '', productSector: group, years: 0 }),
        undefined,
        group,
      );
    }
  });

  test('the cache key names reporter, partner and group', () => {
    assert.equal(tradestatsKey('usa', 'chn', 'Textiles'), 'trade:wits:tradestats-tariff:v1:usa:chn:textiles');
  });
});

// ── Routing ────────────────────────────────────────────────────────────────

describe('which series a request selects', () => {
  test('a partner other than World, or any sector other than all, selects WITS', () => {
    const norm = (p: Partial<GetTariffTrendsRequest>) => normalizeTariffTrendRequest(request(p))!;
    assert.equal(isBilateralRequest(norm({ partnerCountry: '156' })), true);
    assert.equal(isBilateralRequest(norm({ partnerCountry: '', productSector: 'Textiles' })), true);
    assert.equal(isBilateralRequest(norm({ partnerCountry: '000', productSector: 'Food' })), true);
    assert.equal(isBilateralRequest(norm({ partnerCountry: '', productSector: '' })), false);
    assert.equal(isBilateralRequest(norm({ partnerCountry: '000', productSector: 'all' })), false);
  });
});

// ── Handler ────────────────────────────────────────────────────────────────

describe('get-tariff-trends partner and sector answers', () => {
  test('US on Chinese goods: effectively applied averages, sliced to the window', async () => {
    const resp = await getTariffTrends(premiumCtx(), request({ years: 5 }));
    assert.equal(resp.unavailableReason, R.served);
    assert.equal(resp.upstreamUnavailable, false);
    assert.deepEqual(series(resp), [
      [2018, 4.226, 2.773], [2019, 3.604, 2.792], [2020, 3.539, 2.44],
      [2021, 3.614, 2.529], [2022, 3.615, 2.86], [2023, 3.584, 2.77],
    ]);
    const p = resp.datapoints[0]!;
    assert.equal(p.reportingCountry, '840');
    assert.equal(p.partnerCountry, '156');
    assert.equal(p.productSector, 'All products');
    assert.equal(p.indicatorCode, SIMPLE_INDICATOR);
    assert.equal(p.boundRate, 0);
    assert.equal(resp.coverageStartYear, 2018);
    assert.equal(resp.coverageEndYear, 2023);
    assert.ok(resp.fetchedAt);
    assert.equal(resp.effectiveTariffRate, undefined, 'the US-wide FRED snapshot is not about this pair');
    // The MFN seed is never read for a partner request.
    assert.equal(redisReads.includes(tariffTrendSeedKey('840')), false);
  });

  test('a product group with a partner', async () => {
    const resp = await getTariffTrends(premiumCtx(), request({ productSector: 'TEXTILES', years: 1 }));
    assert.deepEqual(series(resp), [[2022, 8.857, 9.829], [2023, 8.763, 9.865]]);
    assert.equal(resp.datapoints[0]!.productSector, 'Textiles');
  });

  test('a product group against the World, with a WTO reporter code', async () => {
    const resp = await getTariffTrends(premiumCtx(), request({ reportingCountry: '699', partnerCountry: '', productSector: '84-85_MachElec', years: 1 }));
    assert.deepEqual(series(resp), [[2022, 6.863, 5.217], [2023, 6.912, 5.517]]);
    assert.equal(resp.datapoints[0]!.partnerCountry, 'World');
    assert.equal(resp.datapoints[0]!.reportingCountry, '699');
  });

  test('the EU as reporter', async () => {
    const resp = await getTariffTrends(premiumCtx(), request({ reportingCountry: '918', partnerCountry: '840', years: 0 }));
    assert.equal(resp.unavailableReason, R.served);
    assert.deepEqual(series(resp).at(-1), [2023, 5.043, 1.552]);
  });

  test('codes and groups WITS does not know are NOT_COVERED without a fetch', async () => {
    for (const partial of [
      { partnerCountry: '999' },
      { partnerCountry: '918' },
      { productSector: '01' },
    ]) {
      const resp = await getTariffTrends(premiumCtx(), request(partial));
      assert.equal(resp.unavailableReason, R.notCovered, JSON.stringify(partial));
      assert.equal(resp.upstreamUnavailable, false);
      assert.equal(resp.datapoints.length, 0);
    }
    assert.deepEqual(witsCalls, []);
  });

  test('WITS "no records" and error redirects are NOT_COVERED, and cached', async () => {
    const none = await getTariffTrends(premiumCtx(), request({ reportingCountry: '158', partnerCountry: '840' }));
    assert.equal(none.unavailableReason, R.notCovered);
    assert.equal(none.upstreamUnavailable, false);
    const redirected = await getTariffTrends(premiumCtx(), request({ partnerCountry: '004' }));
    assert.equal(redirected.unavailableReason, R.notCovered);

    witsCalls = [];
    await getTariffTrends(premiumCtx(), request({ reportingCountry: '158', partnerCountry: '840' }));
    assert.deepEqual(witsCalls, [], 'an empty answer is a cached coverage verdict');
  });

  test('an unreachable WITS is a fault, not a coverage answer, and is not cached as one', async () => {
    witsFaults.add(tradestatsUrl('usa', 'chn', 'Total'));
    const resp = await getTariffTrends(premiumCtx(), request());
    assert.equal(resp.unavailableReason, R.upstreamUnavailable);
    assert.equal(resp.upstreamUnavailable, true);
    assert.equal(resp.datapoints.length, 0);
    // At most the short negative sentinel (FAULT_TTL), never an empty series
    // that would later read as NOT_COVERED.
    const stored = redisStore.get(tradestatsKey('usa', 'chn', 'Total'));
    assert.ok(stored === undefined || JSON.parse(stored) === '__WM_NEG__', String(stored));
  });

  test('a cached series answers without calling WITS', async () => {
    await getTariffTrends(premiumCtx(), request());
    assert.equal(witsCalls.length, 1);
    assert.ok(redisStore.has(tradestatsKey('usa', 'chn', 'Total')));
    witsCalls = [];
    const again = await getTariffTrends(premiumCtx(), request({ years: 30 }));
    assert.deepEqual(witsCalls, []);
    assert.equal(again.coverageEndYear, 2023);
    // years=30 is the inclusive window 1993–2023, one series for every window.
    assert.equal(again.coverageStartYear, 1993);
  });

  test('free callers get the empty gated answer with no WITS call', async () => {
    const resp = await getTariffTrends(freeCtx(), request());
    assert.equal(resp.datapoints.length, 0);
    assert.equal(resp.upstreamUnavailable, true);
    assert.deepEqual(witsCalls, []);
  });
});
