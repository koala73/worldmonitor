// Executable coverage for GetBilateralTariff: the applied tariff on one HS6
// product between two countries, read on demand from UNCTAD TRAINS via WITS.
//
// Every upstream body below is a real WITS response captured on 2026-10-10
// (tests/fixtures/wits-trains/). The cases pin the filing behaviours the
// handler exists to interpret correctly:
//  - a partner-specific row exists only where a preference exists, so its
//    absence means "MFN applies" only when the reporter filed preferences
//    that year (US 2021 did; US 2022 did not);
//  - an all-specific-duty product reads 0% on the `reported` datatype (US
//    wine), so the `aveestimated` MFN row must stand in for it;
//  - EU members carry no preferences of their own; the EU files them as 918.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  APPLIED_TARIFF_BASIS as BASIS,
  BILATERAL_TARIFF_REASON as R,
  EU_MEMBER_REPORTERS,
  TRAINS_GROUP_NAMES_KEY,
  filingReporter,
  getBilateralTariff,
  parseTrainsAvailability,
  parseTrainsGroupNames,
  parseTrainsSeries,
  resolveBilateralTariff,
  trainsAvailabilityKey,
  trainsRowsKey,
  trainsRowsUrl,
  type TrainsRow,
} from '../server/worldmonitor/trade/v1/get-bilateral-tariff';
import { validateGeneratedRequest } from '../server/request-validator';
import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths';
import { getRequiredTier } from '../server/_shared/entitlement-check';

import type {
  GetBilateralTariffRequest,
  ServerContext,
} from '../src/generated/server/worldmonitor/trade/v1/service_server';

const ROUTE = '/api/trade/v1/get-bilateral-tariff';
const FIXTURES = resolve(import.meta.dirname, 'fixtures/wits-trains');
const fixture = (name: string): string => readFileSync(resolve(FIXTURES, name), 'utf8');

const SDMX = 'https://wits.worldbank.org/API/V1/SDMX/V21/datasource/TRN';
const META = 'https://wits.worldbank.org/API/V1/wits/datasource/trn';

// URL → [status, fixture]. Anything not listed is an unexpected upstream call.
const WITS_ROUTES: Record<string, [number, string]> = {
  [`${META}/dataavailability/country/840/year/all`]: [200, 'availability-840.xml'],
  [`${META}/dataavailability/country/918/year/all`]: [200, 'availability-918.xml'],
  [`${META}/dataavailability/country/999/year/all`]: [200, 'availability-no-data.xml'],
  [`${META}/country/all`]: [200, 'country-groups-excerpt.xml'],
  [`${SDMX}/reporter/840/partner/all/product/870323/year/2021/datatype/reported`]: [200, 'sdmx-840-870323-2021-reported.xml'],
  [`${SDMX}/reporter/840/partner/all/product/870323/year/2022/datatype/reported`]: [200, 'sdmx-840-870323-2022-reported.xml'],
  [`${SDMX}/reporter/840/partner/all/product/220421/year/2021/datatype/reported`]: [200, 'sdmx-840-220421-2021-reported.xml'],
  [`${SDMX}/reporter/840/partner/000/product/220421/year/2021/datatype/aveestimated`]: [200, 'sdmx-840-220421-2021-aveestimated-mfn.xml'],
  [`${SDMX}/reporter/918/partner/all/product/870323/year/2021/datatype/reported`]: [200, 'sdmx-918-870323-2021-reported.xml'],
  [`${SDMX}/reporter/840/partner/all/product/999999/year/2021/datatype/reported`]: [404, 'sdmx-no-records.txt'],
};

// ── Harness ────────────────────────────────────────────────────────────────

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
  localApiMode: process.env.LOCAL_API_MODE,
  validKeys: process.env.WORLDMONITOR_VALID_KEYS,
};
const REDIS_HOST = 'https://redis.test';
const ENTERPRISE_KEY = 'test-bilateral-tariff-enterprise-key';

let redisStore: Map<string, string>;
let witsCalls: string[];
let witsFaults: Set<string>;

beforeEach(() => {
  redisStore = new Map();
  witsCalls = [];
  witsFaults = new Set();
  process.env.UPSTASH_REDIS_REST_URL = REDIS_HOST;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  process.env.WORLDMONITOR_VALID_KEYS = ENTERPRISE_KEY;
  delete process.env.LOCAL_API_MODE;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = input instanceof Request ? input.url : String(input);
    const url = new URL(href);
    // Route on the parsed origin, not a string prefix, so a host such as
    // redis.test.example cannot be mistaken for the fake Redis.
    if (url.origin === REDIS_HOST && url.pathname.startsWith('/get/')) {
      const key = decodeURIComponent(url.pathname.slice('/get/'.length));
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
      if (witsFaults.has(href)) return new Response('Service Unavailable', { status: 503 });
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
    request: new Request(`https://api.worldmonitor.app${ROUTE}`, {
      headers: { 'X-WorldMonitor-Key': ENTERPRISE_KEY },
    }),
  } as ServerContext;
}

function freeCtx(): ServerContext {
  return { request: new Request(`https://api.worldmonitor.app${ROUTE}`) } as ServerContext;
}

function request(partial: Partial<GetBilateralTariffRequest>): GetBilateralTariffRequest {
  return { reportingCountry: '840', partnerCountry: '156', hsCode: '870323', year: 2021, ...partial };
}

// ── Parsers against captured WITS bodies ───────────────────────────────────

describe('WITS parsers', () => {
  test('SDMX partner/all answer yields the MFN row, partner preferences and group preferences', () => {
    const rows = parseTrainsSeries(fixture('sdmx-840-870323-2021-reported.xml'));
    const mfn = rows.find((row) => row.partner === '000');
    assert.deepEqual(mfn, {
      partner: '000', tariffType: 'MFN', year: 2021, nomenclature: 'H5',
      rate: 2.5, minRate: 2.5, maxRate: 2.5, lines: 1, nonAdValoremLines: 0,
    });
    assert.equal(rows.find((row) => row.partner === '484')?.tariffType, 'PREF');
    assert.equal(rows.find((row) => row.partner === '484')?.rate, 0);
    assert.ok(rows.some((row) => row.partner === 'A41'), 'group preference A41 present');
    assert.equal(rows.some((row) => row.partner === '156'), false, 'no China preference is filed');
  });

  test('an all-specific-duty product reads 0% with every line non-ad-valorem', () => {
    const mfn = parseTrainsSeries(fixture('sdmx-840-220421-2021-reported.xml')).find((row) => row.partner === '000');
    assert.equal(mfn?.rate, 0);
    assert.equal(mfn?.lines, 5);
    assert.equal(mfn?.nonAdValoremLines, 5);
  });

  test('availability lists years in order with the partners filed each year', () => {
    const years = parseTrainsAvailability(fixture('availability-840.xml'));
    assert.equal(years[years.length - 1]?.year, 2021);
    const y2021 = years.find((entry) => entry.year === 2021)!;
    assert.equal(y2021.nomenclature, 'H5');
    assert.ok(y2021.partners.includes('000'));
    assert.ok(y2021.partners.includes('484'));
    assert.equal(parseTrainsAvailability(fixture('availability-no-data.xml')).length, 0);
  });

  test('group names come from group entries only', () => {
    const names = parseTrainsGroupNames(fixture('country-groups-excerpt.xml'));
    assert.equal(names.A41, 'Caribbean Basin Economic Recovery Act: USA 2014');
    assert.equal(names.P22, 'North American Free Trade Agreement (NAFTA)');
    assert.equal(names['840'], undefined, 'countries are not groups');
  });
});

// ── Applied-rate resolution ────────────────────────────────────────────────

function row(partial: Partial<TrainsRow>): TrainsRow {
  return {
    partner: '000', tariffType: 'MFN', year: 2021, nomenclature: 'H5',
    rate: 5, minRate: 5, maxRate: 5, lines: 1, nonAdValoremLines: 0, ...partial,
  };
}

describe('resolveBilateralTariff', () => {
  test('a preference above MFN is not applied', () => {
    const resolved = resolveBilateralTariff(
      [row({}), row({ partner: '484', tariffType: 'PREF', rate: 7 })],
      '484',
      true,
    );
    assert.equal(resolved?.basis, BASIS.mfn);
    assert.equal(resolved?.applied?.rate, 5);
    assert.equal(resolved?.preferential?.rate, 7, 'the filed preference is still reported');
  });

  test('unknown availability with no preference rows is the conservative MFN reading', () => {
    assert.equal(resolveBilateralTariff([row({})], '156', null)?.basis, BASIS.mfnPreferencesNotReported);
  });

  test('preference rows for other partners prove preferences were filed', () => {
    const resolved = resolveBilateralTariff([row({}), row({ partner: '484', tariffType: 'PREF', rate: 0 })], '156', null);
    assert.equal(resolved?.basis, BASIS.mfn);
  });

  test('nothing on file resolves to null', () => {
    assert.equal(resolveBilateralTariff([], '156', true), null);
  });
});

// ── Handler ────────────────────────────────────────────────────────────────

describe('getBilateralTariff', () => {
  test('US <- Mexico, passenger cars, 2021: the USMCA preference applies', async () => {
    const res = await getBilateralTariff(premiumCtx(), request({ partnerCountry: '484' }));
    assert.equal(res.unavailableReason, R.served);
    assert.equal(res.upstreamUnavailable, false);
    assert.equal(res.basis, BASIS.preferential);
    assert.equal(res.appliedRate?.rate, 0);
    assert.equal(res.mfnRate?.rate, 2.5);
    assert.equal(res.preferentialRate?.rate, 0);
    assert.equal(res.year, 2021);
    assert.equal(res.nomenclature, 'H5');
    assert.equal(res.filingReporter, '840');
    assert.equal(res.sourceUrl, trainsRowsUrl('840', '870323', 2021));
  });

  test('US <- China, latest year: MFN applies and group preferences are listed unresolved', async () => {
    const res = await getBilateralTariff(premiumCtx(), request({ year: 0 }));
    assert.equal(res.year, 2021, 'year 0 selects the latest year in the availability list');
    assert.equal(res.basis, BASIS.mfn);
    assert.equal(res.appliedRate?.rate, 2.5);
    assert.equal(res.preferentialRate, undefined);
    const a41 = res.groupPreferences.find((group) => group.groupCode === 'A41');
    assert.equal(a41?.groupName, 'Caribbean Basin Economic Recovery Act: USA 2014');
    assert.equal(a41?.rate?.rate, 0);
    const unnamed = res.groupPreferences.find((group) => group.groupCode === 'B15');
    assert.equal(unnamed?.groupName, '', 'WITS publishes no name for B15');
  });

  test('US <- China, 2022: a year with no preferential schedules says so', async () => {
    const res = await getBilateralTariff(premiumCtx(), request({ year: 2022 }));
    assert.equal(res.basis, BASIS.mfnPreferencesNotReported);
    assert.equal(res.appliedRate?.rate, 2.5);
    assert.equal(res.nomenclature, 'H6');
    assert.equal(res.groupPreferences.length, 0);
  });

  test('US <- France, wine: the AVE MFN row replaces the 0% specific-duty average', async () => {
    const res = await getBilateralTariff(premiumCtx(), request({ partnerCountry: '250', hsCode: '220421' }));
    assert.equal(res.basis, BASIS.mfn);
    assert.equal(res.mfnRate?.rate, 0);
    assert.equal(res.mfnRate?.nonAdValoremLines, 5);
    assert.ok(Math.abs((res.mfnAveRate?.rate ?? 0) - 2.0302) < 1e-3);
    assert.equal(res.appliedRate?.rate, res.mfnAveRate?.rate);
    assert.ok(witsCalls.includes(`${SDMX}/reporter/840/partner/000/product/220421/year/2021/datatype/aveestimated`));
  });

  test('a product with ad valorem lines only never fetches AVE', async () => {
    await getBilateralTariff(premiumCtx(), request({ partnerCountry: '484' }));
    assert.equal(witsCalls.some((href) => href.includes('aveestimated')), false);
  });

  test('Germany <- Korea: EU members are answered from the EU schedule', async () => {
    assert.equal(EU_MEMBER_REPORTERS.size, 27);
    assert.equal(filingReporter('276'), '918');
    assert.equal(filingReporter('826'), '826', 'the UK files on its own');
    const res = await getBilateralTariff(premiumCtx(), request({ reportingCountry: '276', partnerCountry: '410' }));
    assert.equal(res.reportingCountry, '276');
    assert.equal(res.filingReporter, '918');
    assert.equal(res.basis, BASIS.preferential);
    assert.equal(res.appliedRate?.rate, 0);
    assert.equal(res.mfnRate?.rate, 10);
  });

  test('partner 000 returns the MFN rate with no preference or group detail', async () => {
    const res = await getBilateralTariff(premiumCtx(), request({ partnerCountry: '000' }));
    assert.equal(res.basis, BASIS.mfn);
    assert.equal(res.appliedRate?.rate, 2.5);
    assert.equal(res.groupPreferences.length, 0);
    assert.equal(witsCalls.some((href) => href.endsWith('/country/all')), false);
  });

  test('NoRecordsFound is a coverage answer, cached so a repeat makes no upstream call', async () => {
    const res = await getBilateralTariff(premiumCtx(), request({ hsCode: '999999' }));
    assert.equal(res.unavailableReason, R.notCovered);
    assert.equal(res.upstreamUnavailable, false);
    assert.equal(res.appliedRate, undefined);
    assert.ok(redisStore.has(trainsRowsKey('840', '999999', 2021)));

    witsCalls = [];
    const again = await getBilateralTariff(premiumCtx(), request({ hsCode: '999999' }));
    assert.equal(again.unavailableReason, R.notCovered);
    assert.deepEqual(witsCalls, []);
  });

  test('a reporter with no availability list is not covered for year 0', async () => {
    const res = await getBilateralTariff(premiumCtx(), request({ reportingCountry: '999', year: 0 }));
    assert.equal(res.unavailableReason, R.notCovered);
    assert.equal(res.upstreamUnavailable, false);
  });

  test('a WITS fault is reported as a fault, never as an empty answer', async () => {
    witsFaults.add(`${SDMX}/reporter/840/partner/all/product/870323/year/2021/datatype/reported`);
    const res = await getBilateralTariff(premiumCtx(), request({}));
    assert.equal(res.unavailableReason, R.upstreamUnavailable);
    assert.equal(res.upstreamUnavailable, true);
  });

  test('an availability fault with an explicit year still serves, conservatively', async () => {
    witsFaults.add(`${META}/dataavailability/country/840/year/all`);
    const res = await getBilateralTariff(premiumCtx(), request({ year: 2022 }));
    assert.equal(res.unavailableReason, R.served);
    assert.equal(res.basis, BASIS.mfnPreferencesNotReported);
  });

  test('an availability fault with year 0 cannot pick a year', async () => {
    witsFaults.add(`${META}/dataavailability/country/840/year/all`);
    const res = await getBilateralTariff(premiumCtx(), request({ year: 0 }));
    assert.equal(res.unavailableReason, R.upstreamUnavailable);
    assert.equal(res.upstreamUnavailable, true);
  });

  test('cache keys carry every request-varying input except the partner', async () => {
    await getBilateralTariff(premiumCtx(), request({ partnerCountry: '484' }));
    assert.ok(redisStore.has(trainsAvailabilityKey('840')));
    assert.ok(redisStore.has(trainsRowsKey('840', '870323', 2021)));
    assert.ok(redisStore.has(TRAINS_GROUP_NAMES_KEY));

    // Another partner for the same reporter/product/year shares the rows.
    witsCalls = [];
    const res = await getBilateralTariff(premiumCtx(), request({ partnerCountry: '156' }));
    assert.equal(res.basis, BASIS.mfn);
    assert.deepEqual(witsCalls, []);
  });

  test('a free caller gets the entitlement shape and reaches no upstream', async () => {
    const res = await getBilateralTariff(freeCtx(), request({ partnerCountry: '484' }));
    assert.equal(res.upstreamUnavailable, true);
    assert.equal(res.unavailableReason, R.served);
    assert.equal(res.appliedRate, undefined);
    assert.deepEqual(witsCalls, []);
  });

  test('a malformed request reaching the handler directly is rejected without a fetch', async () => {
    for (const bad of [
      request({ reportingCountry: 'US' }),
      request({ partnerCountry: '15' }),
      request({ hsCode: '8703' }),
      request({ year: -1 }),
    ]) {
      const res = await getBilateralTariff(premiumCtx(), bad);
      assert.equal(res.unavailableReason, R.invalidRequest, JSON.stringify(bad));
    }
    assert.deepEqual(witsCalls, []);
  });
});

// ── Contract and gating ────────────────────────────────────────────────────

describe('GetBilateralTariff contract', () => {
  test('the gateway rejects malformed codes with a 400 before the handler runs', () => {
    assert.equal(validateGeneratedRequest('getBilateralTariff', request({})), undefined);
    for (const body of [
      request({ reportingCountry: '' }),
      request({ partnerCountry: 'CN' }),
      request({ hsCode: '87032' }),
      request({ hsCode: '' }),
      request({ year: 2101 }),
    ]) {
      assert.ok(validateGeneratedRequest('getBilateralTariff', body), `expected a violation for ${JSON.stringify(body)}`);
    }
  });

  test('the route is Pro-gated at tier 1, which every paid plan including API Starter meets', () => {
    assert.ok(PREMIUM_RPC_PATHS.has(ROUTE));
    assert.equal(getRequiredTier(ROUTE), 1);
  });
});
