import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { parseCREStationPrices, validateFuel, withFuelRetry, fetchUS_EIA, regionalFuelEntries, FUEL_FX_CURRENCIES, latestComComFuelDataUrl, readXlsxFirstSheet, parseNzComComFuel } from '../scripts/seed-fuel-prices.mjs';
import { SHARED_FX_FALLBACKS } from '../scripts/_seed-utils.mjs';
import { buildEnvelope } from '../scripts/_seed-envelope-source.mjs';
import { parseNorwayFuel, parseIcelandFuel, parseTaiwanFuel, fetchNorway, fetchIceland, fetchTaiwan, toUsdPerLiter, mergeFuelCountry } from '../scripts/seed-fuel-prices.mjs';

const fuelFixture = name => JSON.parse(readFileSync(new URL(`./fixtures/fuel-prices/${name}.json`, import.meta.url), 'utf8'));
const FUEL_NOW = Date.parse('2026-11-05T00:00:00Z');

test('SSB fixture selects latest monthly petrol/diesel by product and preserves NOK and month', () => {
  const data = fuelFixture('ssb-09654');
  data.data.reverse();
  const row = parseNorwayFuel(data, FUEL_NOW);
  assert.equal(row.code, 'NO');
  assert.equal(row.currency, 'NOK');
  assert.equal(row.gasoline.localPrice, 26.18);
  assert.equal(row.diesel.localPrice, 27.52);
  assert.equal(row.gasoline.observedAt, '2026-09-01');
  assert.match(row.gasoline.source, /SSB/);
  assert.equal(toUsdPerLiter(row.gasoline.localPrice, row.currency, { NOK: 0.1 }), 2.618);
});

test('SSB rejects stale/future months, layout changes, suppressed or invalid prices', () => {
  assert.equal(parseNorwayFuel(fuelFixture('ssb-09654'), Date.parse('2026-12-10')), null);
  assert.equal(parseNorwayFuel(fuelFixture('ssb-09654'), Date.parse('2026-09-01')), null);
  for (const value of ['', '..', null, '999', '-1']) {
    const data = fuelFixture('ssb-09654');
    for (const r of data.data) r.values = [value];
    assert.equal(parseNorwayFuel(data, FUEL_NOW), null);
  }
  const changed = fuelFixture('ssb-09654');
  changed.columns[2].code = 'Cents';
  assert.equal(parseNorwayFuel(changed, FUEL_NOW), null);
});

test('Gasvaktin fixture averages ordinary station prices independently, with community credit', () => {
  const data = fuelFixture('gasvaktin-stations');
  data.stations.push({ bensin95: null, diesel: 300 }, { bensin95: 0, diesel: 9999 });
  const row = parseIcelandFuel(data, '2026-11-04T13:00:26Z', FUEL_NOW);
  assert.equal(row.currency, 'ISK');
  assert.equal(row.gasoline.localPrice, 265.9667);
  assert.equal(row.diesel.localPrice, 317.575);
  assert.equal(row.gasoline.observedAt, '2026-11-04');
  assert.match(row.gasoline.source, /Gasvaktin.*community/);
  assert.equal(toUsdPerLiter(row.gasoline.localPrice, 'ISK', { ISK: 0.007 }), 1.8618);
  assert.equal(toUsdPerLiter(row.gasoline.localPrice, 'ISK', {}), null);
});

test('Gasvaktin never relabels stale, missing, invalid or future revision dates as current', () => {
  for (const date of [undefined, '', '2026-10-01', '2026-11-06', '2026-02-30']) {
    assert.equal(parseIcelandFuel(fuelFixture('gasvaktin-stations'), date, FUEL_NOW), null);
  }
  assert.equal(parseIcelandFuel({ stations: [{ bensin95: null, diesel: 0 }] }, '2026-11-04', FUEL_NOW), null);
});

test('Taiwan fixture weights mainland/offshore/mountain surveys and retains the week end', () => {
  const gas = parseTaiwanFuel(fuelFixture('taiwan-oil111-92'), '01', FUEL_NOW);
  const diesel = parseTaiwanFuel(fuelFixture('taiwan-oil111-diesel'), '04', FUEL_NOW);
  assert.equal(gas.localPrice, +((31.19 * 212 + 29.7 * 12 + 31.17 * 23) / 247).toFixed(4));
  assert.equal(diesel.localPrice, +((29.85 * 198 + 28.93 * 30 + 29.88 * 24) / 252).toFixed(4));
  assert.equal(gas.observedAt, '2026-10-31');
  assert.match(gas.grade, /RON92/);
  assert.match(gas.source, /MOEA/);
  assert.equal(toUsdPerLiter(gas.localPrice, 'TWD', { TWD: 0.031 }), +(gas.localPrice * 0.031).toFixed(4));
});

test('Taiwan rejects stale, wrong-grade, failed, malformed and invalid survey responses', () => {
  assert.equal(parseTaiwanFuel(fuelFixture('taiwan-oil111-92'), '01', Date.parse('2026-12-01')), null);
  assert.equal(parseTaiwanFuel(fuelFixture('taiwan-oil111-diesel'), '01', FUEL_NOW), null);
  for (const change of [
    d => { d.res = '02'; }, d => { d.data.start = '2026/11/08 ~ 2026/11/14'; },
    d => { d.data.start = '2026/02/30 ~ 2026/03/08'; }, d => { d.data.Aavg = null; },
    d => { d.data.Anum = -1; }, d => { d.data.Aavg = 0; }, d => { d.data.Aavg = 1000; },
  ]) {
    const data = fuelFixture('taiwan-oil111-92'); change(data);
    assert.equal(parseTaiwanFuel(data, '01', FUEL_NOW), null);
  }
  const data = fuelFixture('taiwan-oil111-92');
  data.data.Bnum = 0; data.data.Bavg = null;
  assert.ok(parseTaiwanFuel(data, '01', FUEL_NOW), 'a group with no reports may have null prices');
});

test('new fetchers use real source request contracts and fixtures without running a seed', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FUEL_NOW });
  const calls = [];
  const revision = fuelFixture('gasvaktin-revision');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push([url, options]);
    assert.ok(options.headers['User-Agent']);
    let data;
    if (url.includes('data.ssb.no')) {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body).query[0].selection.values, ['031', '035']);
      data = fuelFixture('ssb-09654');
    } else if (url.includes('api.github.com')) data = revision;
    else if (url.includes('raw.githubusercontent.com')) {
      assert.ok(url.includes(revision[0].sha), 'content pinned to dated revision');
      data = fuelFixture('gasvaktin-stations');
    } else {
      assert.equal(options.method, 'POST');
      assert.ok(options.body instanceof FormData);
      assert.equal(options.body.get('unit'), 'week');
      assert.equal(options.body.get('start'), 'lastone');
      data = fuelFixture(options.body.get('oil') === '01' ? 'taiwan-oil111-92' : 'taiwan-oil111-diesel');
    }
    return Response.json(data);
  });
  assert.equal((await fetchNorway())[0].code, 'NO');
  assert.equal((await fetchIceland({ ISK: 0.007 }))[0].code, 'IS');
  const taiwan = (await fetchTaiwan())[0];
  assert.equal(taiwan.code, 'TW');
  assert.equal(taiwan.currency, 'TWD');
  assert.ok(taiwan.gasoline && taiwan.diesel);
  assert.equal(calls.length, 5);
  assert.deepEqual(await fetchIceland({}), []);
  assert.equal(calls.length, 5, 'missing ISK FX omits the source without a useless request');
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  await assert.rejects(fetchNorway(), /503/);
  await assert.rejects(fetchIceland({ ISK: 0.007 }), /503/);
  assert.deepEqual(await fetchTaiwan({ baseDelayMs: 0 }), []);
});

for (const failedOil of ['01', '04']) {
  test(`Taiwan preserves the other grade when ${failedOil} exhausts its request retries`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: FUEL_NOW });
    const calls = { '01': 0, '04': 0 };
    t.mock.method(globalThis, 'fetch', async (_url, { body }) => {
      const oil = body.get('oil');
      calls[oil]++;
      if (oil === failedOil) return new Response('', { status: 503 });
      return Response.json(fuelFixture(oil === '01' ? 'taiwan-oil111-92' : 'taiwan-oil111-diesel'));
    });
    const rows = await fetchTaiwan({ baseDelayMs: 0 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].code, 'TW');
    const missing = failedOil === '01' ? 'gasoline' : 'diesel';
    const present = failedOil === '01' ? 'diesel' : 'gasoline';
    assert.equal(rows[0][missing], null);
    assert.ok(rows[0][present].localPrice > 0);
    assert.equal(rows[0][present].observedAt, '2026-10-31');
    assert.deepEqual(calls, { [failedOil]: 3, [failedOil === '01' ? '04' : '01']: 1 });
  });
}

test('Taiwan retries only the transiently failing grade and returns both prices after recovery', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FUEL_NOW });
  const calls = { '01': 0, '04': 0 };
  t.mock.method(globalThis, 'fetch', async (_url, { body }) => {
    const oil = body.get('oil');
    calls[oil]++;
    if (oil === '04' && calls[oil] === 1) throw new Error('network failure');
    return Response.json(fuelFixture(oil === '01' ? 'taiwan-oil111-92' : 'taiwan-oil111-diesel'));
  });
  const [row] = await fetchTaiwan({ baseDelayMs: 0 });
  assert.ok(row.gasoline && row.diesel);
  assert.deepEqual(calls, { '01': 1, '04': 2 });
});

test('country merge rejects empty USD coverage after conversion instead of counting it toward publish', () => {
  const countryMap = new Map();
  const norway = parseNorwayFuel(fuelFixture('ssb-09654'), FUEL_NOW);
  for (const fuel of [norway.gasoline, norway.diesel]) fuel.localPrice = 60;
  assert.equal(mergeFuelCountry(countryMap, norway, { NOK: 0.1 }), false);
  assert.equal(countryMap.size, 0, 'locally plausible prices outside USD bounds add no country');
  const iceland = parseIcelandFuel(fuelFixture('gasvaktin-stations'), '2026-11-04', FUEL_NOW);
  assert.equal(mergeFuelCountry(countryMap, iceland, {}), false);
  assert.equal(countryMap.size, 0, 'missing FX also adds no country');
  const countries = [{ code: 'US' }, { code: 'GB' }, { code: 'MY' },
    ...Array.from({ length: 26 }, (_, i) => ({ code: `EU${i}` })), ...countryMap.values()];
  assert.equal(validateFuel({ countries, failedSources: [] }), false, 'an empty NO row must not be country 30');
});

test('country merge retains a valid grade and preserves existing source priority when filling gaps', () => {
  const countryMap = new Map();
  const norway = parseNorwayFuel(fuelFixture('ssb-09654'), FUEL_NOW);
  norway.diesel.localPrice = 60;
  assert.equal(mergeFuelCountry(countryMap, norway, { NOK: 0.1 }), true);
  assert.equal(countryMap.size, 1);
  const row = countryMap.get('NO');
  assert.equal(row.gasoline.usdPrice, 2.618);
  assert.equal(row.diesel, null);
  const firstGasoline = row.gasoline;
  const backup = parseNorwayFuel(fuelFixture('ssb-09654'), FUEL_NOW);
  backup.gasoline.localPrice = 20;
  assert.equal(mergeFuelCountry(countryMap, backup, { NOK: 0.1 }), true);
  assert.equal(countryMap.get('NO').gasoline, firstGasoline);
  assert.equal(countryMap.get('NO').diesel.usdPrice, 2.752);
  const before = structuredClone(row);
  assert.equal(mergeFuelCountry(countryMap, { ...norway, gasoline: null }, { NOK: 0.2 }), false);
  assert.deepEqual(row, before, 'an unusable source cannot mutate a valid existing row');
});

test('new optional sources preserve core publish gates and missing-FX currencies fit the recovery budget', () => {
  assert.equal(validateFuel({ countries: HEALTHY_COUNTRIES,
    failedSources: ['Norway-SSB', 'Iceland-Gasvaktin', 'Taiwan-MOEA'] }), true);
  assert.equal(validateFuel({ countries: HEALTHY_COUNTRIES,
    failedSources: ['Taiwan-MOEA', 'Mexico'] }), false);
  for (const currency of ['NOK', 'ISK', 'TWD']) assert.ok(FUEL_FX_CURRENCIES.includes(currency));
  assert.ok(FUEL_FX_CURRENCIES.slice(0, 5).includes('ISK'));
});

test('fuel RPC reads the new fixture rows through the seed envelope with prices, dates and attribution intact', async t => {
  const { listFuelPrices } = await import('../server/worldmonitor/economic/v1/list-fuel-prices.ts');
  const countries = [
    parseNorwayFuel(fuelFixture('ssb-09654'), FUEL_NOW),
    parseIcelandFuel(fuelFixture('gasvaktin-stations'), '2026-11-04', FUEL_NOW),
    { code: 'TW', name: 'Taiwan', currency: 'TWD', flag: '🇹🇼',
      gasoline: parseTaiwanFuel(fuelFixture('taiwan-oil111-92'), '01', FUEL_NOW),
      diesel: parseTaiwanFuel(fuelFixture('taiwan-oil111-diesel'), '04', FUEL_NOW) },
  ];
  for (const c of countries) for (const fuel of [c.gasoline, c.diesel]) {
    fuel.usdPrice = toUsdPerLiter(fuel.localPrice, c.currency, { NOK: 0.092, ISK: 0.007, TWD: 0.031 });
  }
  const snapshot = { countries, fetchedAt: '2026-11-05T00:00:00Z', sourceCount: 3, countryCount: 3 };
  const env = { ...process.env };
  t.after(() => {
    for (const key of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'LOCAL_API_MODE']) {
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
  });
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.fixture.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  delete process.env.LOCAL_API_MODE;
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'https://redis.fixture.invalid/get/economic%3Afuel-prices%3Av1');
    return Response.json({ result: JSON.stringify(buildEnvelope({ fetchedAt: FUEL_NOW, recordCount: countries.length,
      schemaVersion: 1, sourceVersion: 'multi-source-fuel-prices-v1', state: 'OK', data: snapshot })) });
  });
  const result = await listFuelPrices({ request: new Request('https://fixture.invalid') }, {});
  assert.deepEqual(result, snapshot);
  for (const row of result.countries) {
    assert.ok(row.gasoline.usdPrice > 0 && row.diesel.usdPrice > 0);
    assert.ok(row.gasoline.observedAt && row.gasoline.source);
  }
});

test('withFuelRetry returns the first success without retrying', async () => {
  let calls = 0;
  const r = await withFuelRetry('T', async () => { calls++; return 'ok'; }, { baseDelayMs: 0 });
  assert.equal(r, 'ok');
  assert.equal(calls, 1);
});

test('withFuelRetry retries transient failures then succeeds', async () => {
  let calls = 0;
  const r = await withFuelRetry('T', async () => {
    calls++;
    if (calls < 3) throw new Error('boom');
    return 'ok';
  }, { baseDelayMs: 0 });
  assert.equal(r, 'ok');
  assert.equal(calls, 3);
});

test('withFuelRetry throws the last error after exhausting tries', async () => {
  let calls = 0;
  await assert.rejects(
    withFuelRetry('T', async () => { calls++; throw new Error(`fail-${calls}`); }, { tries: 3, baseDelayMs: 0 }),
    /fail-3/,
  );
  assert.equal(calls, 3);
});

// Regression: prod log 2026-06-23 showed a single `[US] fetchUS_EIA error: HTTP 502`
// rejecting the ENTIRE multi-source publish (US is critical + untolerated), because
// fetchUS_EIA did a bare fetch with no retry. A transient 502 must be retried.
test('fetchUS_EIA recovers from a transient 502 instead of failing the critical source', async () => {
  const origFetch = globalThis.fetch;
  const origKey = process.env.EIA_API_KEY;
  process.env.EIA_API_KEY = 'test-key';
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response('bad gateway', { status: 502 });
    return new Response(JSON.stringify({
      response: { data: [
        { series: 'EMM_EPMR_PTE_NUS_DPG', value: 3.10, period: '2026-06-16' },
        { series: 'EMD_EPD2DXL0_PTE_NUS_DPG', value: 3.60, period: '2026-06-16' },
      ] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    // baseDelayMs: 0 threads through to withFuelRetry so the retry is instant
    // (no 1.5s real sleep) — the seam's whole point.
    const out = await fetchUS_EIA({ baseDelayMs: 0 });
    assert.ok(calls >= 2, 'should have retried after the 502');
    assert.equal(out.length, 1);
    assert.equal(out[0].code, 'US');
    assert.ok(out[0].gasoline.usdPrice > 0, 'US gasoline price should be present after recovery');
  } finally {
    globalThis.fetch = origFetch;
    if (origKey === undefined) delete process.env.EIA_API_KEY;
    else process.env.EIA_API_KEY = origKey;
  }
});

test('parseCREStationPrices extracts regular + diesel per-station prices from CRE XML', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<places>
  <place place_id="1">
    <gas_price type="regular">22.95</gas_price>
    <gas_price type="premium">26.91</gas_price>
  </place>
  <place place_id="2">
    <gas_price type="regular">24.7</gas_price>
    <gas_price type="diesel">29.5</gas_price>
  </place>
</places>`;
  const { regular, diesel } = parseCREStationPrices(xml);
  assert.deepEqual(regular, [22.95, 24.7]);
  assert.deepEqual(diesel, [29.5]);
});

test('parseCREStationPrices filters out-of-range prices', () => {
  // 0.01 and 1000.0 are clearly bad (placeholder/test rows); 15 and 50 are valid MXN/L.
  const xml = `<places>
    <place><gas_price type="regular">0.01</gas_price></place>
    <place><gas_price type="regular">15</gas_price></place>
    <place><gas_price type="regular">1000.0</gas_price></place>
    <place><gas_price type="regular">50</gas_price></place>
  </places>`;
  const { regular } = parseCREStationPrices(xml);
  assert.deepEqual(regular, [15, 50]);
});

test('parseCREStationPrices handles empty XML', () => {
  const { regular, diesel } = parseCREStationPrices('<places></places>');
  assert.deepEqual(regular, []);
  assert.deepEqual(diesel, []);
});

const HEALTHY_COUNTRIES = [
  { code: 'US' }, { code: 'GB' }, { code: 'MY' }, { code: 'BR' }, { code: 'MX' }, { code: 'NZ' },
  ...Array.from({ length: 27 }, (_, i) => ({ code: `EU${i}` })),
];

test('validateFuel accepts healthy snapshot (all sources fresh, 33 countries, US+GB+MY present)', () => {
  assert.equal(validateFuel({ countries: HEALTHY_COUNTRIES, failedSources: [] }), true);
});

test('validateFuel rejects when an untolerated source failed (no silent degraded publishes)', () => {
  assert.equal(
    validateFuel({ countries: HEALTHY_COUNTRIES, failedSources: ['Mexico'] }),
    false,
    'a non-tolerated source failure must block publish; cache TTL serves last healthy snapshot',
  );
});

test('validateFuel accepts when only a TOLERATED source (Brazil) failed', () => {
  assert.equal(
    validateFuel({ countries: HEALTHY_COUNTRIES, failedSources: ['Brazil'] }),
    true,
    'Brazil ANP is structurally unreachable from Railway; must not gate publish or Railway crash-loops',
  );
});

test('validateFuel accepts when only TOLERATED New Zealand failed', () => {
  // A missed fortnightly Commerce Commission file must not gate the whole
  // multi-source publish, or fuel-prices goes STALE_SEED while ≥30 countries +
  // US/GB/MY are present. Same rationale as Brazil.
  assert.equal(
    validateFuel({ countries: HEALTHY_COUNTRIES, failedSources: ['New Zealand'] }),
    true,
    'NZ must not gate publish (≥30 countries + US/GB/MY still required)',
  );
});

test('validateFuel still accepts when BOTH tolerated sources (Brazil + New Zealand) failed', () => {
  assert.equal(
    validateFuel({ countries: HEALTHY_COUNTRIES, failedSources: ['Brazil', 'New Zealand'] }),
    true,
  );
});

test('validateFuel still REJECTS a tolerated + an untolerated failure together', () => {
  // Tolerating NZ must not weaken the gate for a real critical-source outage.
  assert.equal(
    validateFuel({ countries: HEALTHY_COUNTRIES, failedSources: ['New Zealand', 'Mexico'] }),
    false,
    'an untolerated failure (Mexico) must still reject even when a tolerated one (NZ) is also present',
  );
});

test('validateFuel rejects when country count < 30', () => {
  const countries = [
    { code: 'US' }, { code: 'GB' }, { code: 'MY' },
    ...Array.from({ length: 25 }, (_, i) => ({ code: `EU${i}` })),
  ];
  assert.equal(validateFuel({ countries, failedSources: [] }), false, '28 countries should fail >=30');
});

test('validateFuel rejects when critical source US is missing', () => {
  const countries = [
    { code: 'GB' }, { code: 'MY' }, { code: 'BR' }, { code: 'MX' }, { code: 'NZ' },
    ...Array.from({ length: 27 }, (_, i) => ({ code: `EU${i}` })),
  ];
  assert.equal(validateFuel({ countries, failedSources: [] }), false, 'missing US fails gate');
});

test('validateFuel rejects when critical source GB is missing', () => {
  const countries = [
    { code: 'US' }, { code: 'MY' }, { code: 'BR' }, { code: 'MX' }, { code: 'NZ' },
    ...Array.from({ length: 27 }, (_, i) => ({ code: `EU${i}` })),
  ];
  assert.equal(validateFuel({ countries, failedSources: [] }), false, 'missing GB fails gate');
});

test('validateFuel rejects when critical source MY is missing', () => {
  const countries = [
    { code: 'US' }, { code: 'GB' }, { code: 'BR' }, { code: 'MX' }, { code: 'NZ' },
    ...Array.from({ length: 27 }, (_, i) => ({ code: `EU${i}` })),
  ];
  assert.equal(validateFuel({ countries, failedSources: [] }), false, 'missing MY fails gate');
});

test('validateFuel rejects null/undefined/empty', () => {
  assert.equal(validateFuel(null), false);
  assert.equal(validateFuel(undefined), false);
  assert.equal(validateFuel({}), false);
  assert.equal(validateFuel({ countries: [] }), false);
});

// Fiji, Papua New Guinea and Guatemala prices come from the regional energy
// feeds already in Redis (#9893); Brazil's ANP feed backs up the direct fetch.
const obs = (period, value, unit, area, metric = 'fuel.retail_price') => ({ metric, period, value, unit, area });
const NOW = Date.parse('2026-11-02T12:00:00Z');

test('regionalFuelEntries maps the newest regional retail prices to fuel-panel rows', () => {
  const entries = regionalFuelEntries({
    mem: { sourceId: 'mem', observations: [
      obs('2026-10-28', 32.07, 'GTQ/gal', 'Gasolina Regular; Guatemala City'),
      obs('2026-10-27', 32.5, 'GTQ/gal', 'Gasolina Regular; Guatemala City'),
      obs('2026-10-28', 42.69, 'GTQ/gal', 'Diésel; Guatemala City'),
      obs('2026-10-28', 26.99, 'GTQ/gal', 'Bunker; Guatemala City', 'fuel.price'),
    ] },
    fccc: { sourceId: 'fccc', observations: [
      obs('2026-11-01', 3.7, 'FJD/l', 'Motor Spirit; Schedule 1'),
      obs('2026-11-01', 3.9, 'FJD/l', 'Motor Spirit; Schedule 2'),
      obs('2026-11-01', 3.86, 'FJD/l', 'Diesel; Schedule 1'),
    ] },
    iccc: { sourceId: 'iccc', observations: [
      obs('2026-10-08', 4.69, 'PGK/l', 'Petrol; Port Moresby'),
      obs('2026-10-08', 5.9, 'PGK/l', 'Diesel; Port Moresby'),
      obs('2026-10-08', 7.31, 'PGK/l', 'Diesel; Port Moresby', 'fuel.retail_price.unsubsidized'),
    ] },
    anp: { sourceId: 'anp', observations: [
      obs('2026-10-24', 6.49, 'BRL/l', 'GASOLINA COMUM'),
      obs('2026-10-24', 6.99, 'BRL/l', 'OLEO DIESEL'),
      obs('2026-10-24', 7.32, 'BRL/l', 'OLEO DIESEL S10'),
    ] },
  }, NOW);
  const by = Object.fromEntries(entries.map(e => [e.code, e]));
  assert.deepEqual(Object.keys(by).sort(), ['BR', 'FJ', 'GT', 'PG']);

  // MEM publishes per US gallon; the panel is per litre.
  assert.equal(by.GT.currency, 'GTQ');
  assert.equal(by.GT.gasoline.localPrice, 8.472);
  assert.equal(by.GT.gasoline.observedAt, '2026-10-28');
  assert.equal(by.GT.gasoline.source, 'mem.gob.gt');
  assert.equal(by.GT.diesel.localPrice, 11.2775);
  assert.equal(by.FJ.gasoline.localPrice, 3.7, 'Schedule 1: Viti Levu, the main schedule');
  assert.equal(by.FJ.diesel.localPrice, 3.86);
  assert.equal(by.PG.diesel.localPrice, 5.9, 'retail, not the unsubsidised price');
  assert.equal(by.PG.gasoline.localPrice, 4.69);
  assert.equal(by.BR.gasoline.localPrice, 6.49);
  assert.equal(by.BR.diesel.localPrice, 6.99);
});

test('validateFuel tolerates an unavailable regional feed set', () => {
  const countries = [{ code: 'US' }, { code: 'GB' }, { code: 'MY' }, ...Array.from({ length: 27 }, (_, i) => ({ code: `EU${i}` }))];
  assert.equal(validateFuel({ countries, failedSources: ['Regional feeds'] }), true);
});

test('regionalFuelEntries skips stale, missing and unexpected-unit series', () => {
  const entries = regionalFuelEntries({
    // A Guatemala price three months old is not shown as current.
    mem: { sourceId: 'mem', observations: [obs('2026-08-01', 32, 'GTQ/gal', 'Gasolina Regular; Guatemala City')] },
    // A changed unit is not converted by guesswork.
    iccc: { sourceId: 'iccc', observations: [obs('2026-10-08', 469, 'toea/l', 'Petrol; Port Moresby')] },
    // Diesel only: the row keeps an empty gasoline cell.
    fccc: { sourceId: 'fccc', observations: [obs('2026-11-01', 3.86, 'FJD/l', 'Diesel; Schedule 1')] },
    // A record for another source is ignored.
    anp: { sourceId: 'mem', observations: [obs('2026-10-24', 6.49, 'BRL/l', 'GASOLINA COMUM')] },
  }, NOW);
  assert.deepEqual(entries.map(e => e.code), ['FJ']);
  assert.equal(entries[0].gasoline, null);
  assert.equal(entries[0].diesel.localPrice, 3.86);
});

test('FX currencies without a fallback rate are requested first, inside the point-of-use budget', () => {
  // getSharedFxRates fetches at most five currencies from Yahoo when the shared cache is cold
  // or missing them; later ones fall back to SHARED_FX_FALLBACKS, so rows without one would vanish.
  const withoutFallback = FUEL_FX_CURRENCIES.filter(c => SHARED_FX_FALLBACKS[c] == null);
  for (const c of ['GTQ', 'FJD', 'PGK']) assert.ok(withoutFallback.includes(c), c);
  assert.ok(withoutFallback.length <= 5, `only five point-of-use FX requests fit; ${withoutFallback.length} lack a fallback`);
  assert.deepEqual(FUEL_FX_CURRENCIES.slice(0, withoutFallback.length), withoutFallback);
});

test('EUR stays inside the five cold-cache FX requests, since every EU row is priced in EUR', () => {
  assert.ok(FUEL_FX_CURRENCIES.slice(0, 5).includes('EUR'), FUEL_FX_CURRENCIES.slice(0, 5).join(','));
  // EU rows are all published as EUR, so a BGN quote is never used.
  assert.ok(!FUEL_FX_CURRENCIES.includes('BGN'));
});

// New Zealand: the Commerce Commission's fuel price monitoring spreadsheet replaces the
// Incapsula-walled MBIE CSV (#4010). The fixture is the real published file (CC BY 4.0).
const COMCOM_XLSX = readFileSync(new URL('./fixtures/fuel-prices/comcom-nz-data-to-2026-10-27.xlsx', import.meta.url));
const NZ_NOW = Date.parse('2026-11-01T12:00:00Z');

test('latestComComFuelDataUrl picks the newest data spreadsheet linked from the monitoring page', () => {
  const html = `
    <a href="/assets/Uploads/Fuel-price-monitoring-29-October-2026.pdf">report</a>
    <a href="/assets/Uploads/Fuel-price-monitoring-Data-to-13-October-2026.xlsx">older data</a>
    <a href="/assets/Uploads/Fuel-price-monitoring-Data-to-27-October-2026.xlsx">data</a>
    <a href="/assets/Uploads/Fuel-price-monitoring-Data-to-9-September-2026.xlsx">oldest</a>`;
  assert.equal(latestComComFuelDataUrl(html), 'https://www.comcom.govt.nz/assets/Uploads/Fuel-price-monitoring-Data-to-27-October-2026.xlsx');
  assert.equal(latestComComFuelDataUrl('<a href="/assets/Uploads/report.pdf">x</a>'), null);
});

test('readXlsxFirstSheet reads the x:-prefixed OpenXML workbook ExcelJS rejects', () => {
  const rows = readXlsxFirstSheet(COMCOM_XLSX);
  assert.deepEqual(rows[0], ['DATE', 'FUEL_TYPE', 'REFINED_COSTS', 'RETAIL_PRICES_AVG']);
  assert.equal(rows.length, 808);
  assert.deepEqual(rows.at(-1).slice(0, 2), ['27/10/2026', 'Diesel']);
  assert.equal(Number(rows.at(-1)[3]), 322.2);
});

test('readXlsxFirstSheet keeps empty cells in their columns and reads inline strings', () => {
  const sheet = '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + '<row r="1"><c r="A1" t="inlineStr"><is><t>A</t></is></c><c r="C1" t="s"><v>0</v></c></row>'
    + '<row r="2"><c r="B2"><v>1.5</v></c></row></sheetData></worksheet>';
  const strings = '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><r><t>C</t></r><r><t>!</t></r></si></sst>';
  const workbook = '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/data.xml"/></Relationships>';
  const bytes = zipSync({
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(rels),
    'xl/worksheets/data.xml': strToU8(sheet),
    'xl/sharedStrings.xml': strToU8(strings),
  });
  assert.deepEqual(readXlsxFirstSheet(bytes), [['A', '', 'C!'], ['', '1.5']]);
});

test('parseNzComComFuel takes the latest day with both regular petrol (91) and diesel', () => {
  const entry = parseNzComComFuel(readXlsxFirstSheet(COMCOM_XLSX), NZ_NOW);
  assert.deepEqual(entry, {
    code: 'NZ', name: 'New Zealand', currency: 'NZD', flag: '🇳🇿',
    gasoline: { localPrice: 3.587, grade: 'Regular 91', source: 'comcom.govt.nz', observedAt: '2026-10-27' },
    diesel: { localPrice: 3.222, grade: 'Diesel', source: 'comcom.govt.nz', observedAt: '2026-10-27' },
  });
});

test('parseNzComComFuel rejects a changed layout, stale data and implausible prices', () => {
  const header = ['DATE', 'FUEL_TYPE', 'REFINED_COSTS', 'RETAIL_PRICES_AVG'];
  const day = (date, petrol, diesel) => [[date, '91', '300', String(petrol)], [date, 'Diesel', '250', String(diesel)]];
  assert.equal(parseNzComComFuel([['DATE', 'FUEL', 'COST', 'PRICE'], ...day('27/10/2026', 358.7, 322.2)], NZ_NOW), null);
  assert.equal(parseNzComComFuel([header, ...day('20/09/2026', 358.7, 322.2)], NZ_NOW), null, 'older than 35 days');
  assert.equal(parseNzComComFuel([header, ...day('27/10/2026', 3.587, 3.222)], NZ_NOW), null, 'NZD/L where c/L expected');
  // The newest day lacks diesel, so the day before is used for both fuels.
  const mixed = parseNzComComFuel([header, ...day('26/10/2026', 350, 320), ['27/10/2026', '91', '300', '358.7']], NZ_NOW);
  assert.equal(mixed.gasoline.observedAt, '2026-10-26');
  assert.equal(mixed.diesel.localPrice, 3.2);
  // A newest day with a blank, non-numeric or out-of-range price is skipped, not
  // published with a null fuel.
  for (const bad of ['', 'n/a', 3.587]) {
    const fallback = parseNzComComFuel([header, ...day('26/10/2026', 350, 320), ...day('27/10/2026', bad, 322.2)], NZ_NOW);
    assert.equal(fallback.gasoline.observedAt, '2026-10-26', `newest 91 price ${JSON.stringify(bad)}`);
    assert.equal(fallback.gasoline.localPrice, 3.5);
    assert.equal(fallback.diesel.localPrice, 3.2);
  }
});

test('readXlsxFirstSheet rejects a cell reference past the last Excel column', () => {
  // Without a bound, r="AAAAAAAA2" pads the row to ~8e9 cells and exhausts the heap.
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const bytes = zipSync({
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet ${ns}><sheetData><row r="2"><c r="AAAAAAAA2"><v>1</v></c></row></sheetData></worksheet>`),
  });
  assert.throws(() => readXlsxFirstSheet(bytes), /column/);
});
