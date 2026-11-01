/**
 * Malaysia reports product imports and exports to JODI but no product
 * demand, so its shock had no products table ("no refined-product demand
 * observation"). Product demand now comes from national statistics
 * (productDemandNational: Malaysia from DOSM annual final consumption),
 * used only for a product JODI gives no demand for, and labelled with its
 * source and year.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { computeEnergyShockScenario } from '../server/worldmonitor/intelligence/v1/compute-energy-shock.ts';
import { buildCrudeImportOrigin, crudeImportOriginPeriods, productDemandNationalSection } from '../scripts/seed-oil-trade-series.mjs';
import { installRedis } from './helpers/fake-upstash-redis.mts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN, local: process.env.LOCAL_API_MODE };
function restore() {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const [k, v] of [['UPSTASH_REDIS_REST_URL', ORIGINAL_ENV.url], ['UPSTASH_REDIS_REST_TOKEN', ORIGINAL_ENV.token], ['LOCAL_API_MODE', ORIGINAL_ENV.local]]) {
    if (v == null) delete process.env[k]; else process.env[k] = v;
  }
}
function seed(values) {
  installRedis(values);
  delete process.env.LOCAL_API_MODE;
}

const DOSM = JSON.parse(readFileSync(new URL('./fixtures/energy-shock/dosm-my-energy-consumption-2026-10-28.json', import.meta.url), 'utf8'));
const MONTHS = crudeImportOriginPeriods(Date.parse('2026-10-28T12:00:00Z')).flat();
// Malaysia's monthly Comtrade filings: 58% Gulf (SA 30%, AE 28%), as in production.
const comtradeRows = MONTHS.flatMap((m) => {
  const period = m.replace('-', '');
  return [[0, 1000e6], [682, 300e6], [784, 280e6]].map(([partnerCode, primaryValue]) => ({
    reporterISO: 'MYS', partnerCode, period, cmdCode: '2709', flowCode: 'M', primaryValue,
  }));
});
const comtradeSection = { status: 'ok', fetchedAt: '2026-10-28T03:00:00.000Z', months: MONTHS, importers: buildCrudeImportOrigin(comtradeRows, MONTHS) };
const dosmSection = productDemandNationalSection({ rows: DOSM.rows, fetchedAt: '2026-10-28T03:00:00.000Z' });

// Production energy:jodi-oil:v1:MY (2026-10-28): trade, no demand.
const trade = (gasoline, diesel, lpg, naphtha) => ({
  gasoline: { demandKbd: null, importsKbd: gasoline[0], exportsKbd: gasoline[1] },
  diesel: { demandKbd: null, importsKbd: diesel[0], exportsKbd: diesel[1] },
  jet: { demandKbd: null, importsKbd: null, exportsKbd: null },
  lpg: { demandKbd: null, importsKbd: lpg[0], exportsKbd: lpg[1] },
  naphtha: { demandKbd: null, importsKbd: naphtha[0], exportsKbd: naphtha[1] },
});
const jodiMy = (patch = {}) => ({
  iso2: 'MY',
  dataMonth: '2026-06',
  ...trade([321.2, 291.6], [157.0, 245.3], [30.2, 29.8], [1.5, 0]),
  crude: { productionKbd: 0, importsKbd: 329.4, exportsKbd: 153.5 },
  productTrade: {
    preCrisisBaseline: { startMonth: '2025-02', endMonth: '2026-01', months: 12, products: trade([276, 252.5], [144.9, 209.3], [21.4, 30.9], [1.1, 0.6]) },
    currentFlows: { startMonth: '2026-04', endMonth: '2026-06', months: 3, products: trade([283.8, 234.4], [173.7, 242.4], [28.3, 33.6], [1.6, 0.9]) },
  },
  ...patch,
});

const my = ({ national = dosmSection, jodi = jodiMy() } = {}) => ({
  'energy:chokepoint-flows:v1': { hormuz_strait: { flowRatio: 0.303 } },
  'energy:oil-trade-series:v1': { countries: {}, crudeImportOrigin: comtradeSection, ...(national ? { productDemandNational: national } : {}) },
  'energy:jodi-oil:v1:MY': jodi,
});
const shock = () => computeEnergyShockScenario({}, { countryCode: 'MY', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });
const line = (r, re) => r.limitations.find((l) => re.test(l));
const demandOf = (r) => Object.fromEntries(r.products.map((p) => [p.product, p.demandKbd]));

describe('product demand from national statistics (Malaysia, DOSM)', () => {
  it('models Malaysia\'s products with DOSM demand where JODI has none', async (t) => {
    t.after(restore);
    seed(my());
    const r = await shock();
    assert.equal(r.gulfCrudeShare, 0.58);
    assert.deepEqual(demandOf(r), { Gasoline: 340.5, Diesel: 240.7, 'Jet fuel': 62.9, LPG: 77.5 }, 'naphtha has no DOSM demand');
    assert.ok(r.products.find((p) => p.product === 'Jet fuel')?.deficitPct > 0, 'the national-demand jet fuel deficit is modeled, not zero');
    assert.ok(r.products.every((p) => p.deficitPct >= 0 && p.deficitPct <= 100));
    assert.doesNotMatch(r.assessment, /no refined-product demand observation/);
    assert.match(
      line(r, /^Product demand for MY/),
      /DOSM 2024 annual final consumption for gasoline, diesel, jet fuel, LPG.*JODI reports no demand for them in the pre-crisis window or the latest month.*excludes fuel burned for power/,
    );
    assert.match(line(r, /^product balance, pre-crisis baseline/), /2025-02–2026-01/);
  });

  it('JODI demand wins for a product it reports', async (t) => {
    t.after(restore);
    const jodi = jodiMy();
    jodi.productTrade.preCrisisBaseline.products.gasoline.demandKbd = 300;
    seed(my({ jodi }));
    const r = await shock();
    assert.equal(demandOf(r).Gasoline, 300);
    assert.equal(demandOf(r).Diesel, 240.7);
    assert.match(line(r, /^Product demand for MY/), /for diesel, jet fuel, LPG/);
  });

  it('JODI demand in the current-flows window is kept, never replaced by national demand', async (t) => {
    t.after(restore);
    const jodi = jodiMy();
    jodi.productTrade.currentFlows.products.jet.demandKbd = 1000;
    seed(my({ jodi }));
    const r = await shock();
    assert.equal(demandOf(r)['Jet fuel'], 62.9, 'the headline still uses DOSM: JODI has no pre-crisis or latest jet demand');
    assert.match(line(r, /^product balance, current flows/), /jet fuel 1\.3%/);
  });

  it('a national year more than three years before the JODI flow month is not used', async (t) => {
    t.after(restore);
    const old = productDemandNationalSection({ rows: DOSM.rows.filter((row) => row.date < '2023'), fetchedAt: '2026-10-28T03:00:00.000Z' });
    assert.equal(old.countries.MY.year, 2022);
    seed(my({ national: old }));
    const r = await shock();
    assert.deepEqual(r.products, []);
    assert.match(line(r, /DOSM product demand for MY/), /is for 2022, more than 3 years before the 2026-06 JODI flow month; not used/);
  });

  it('a national year after the JODI flow month is not used', async (t) => {
    t.after(restore);
    const future = { ...dosmSection, countries: { MY: { ...dosmSection.countries.MY, year: 2027 } } };
    seed(my({ national: future }));
    const r = await shock();
    assert.deepEqual(r.products, []);
    assert.match(line(r, /DOSM product demand for MY/), /is for 2027, after the 2026-06 JODI flow month; not used/);
  });

  it('national demand never makes a pre-crisis entry without trade win over the latest month', async (t) => {
    t.after(restore);
    const jodi = jodiMy({ jet: { demandKbd: null, importsKbd: 40, exportsKbd: 7 } });
    seed(my({ jodi }));
    const r = await shock();
    assert.equal(demandOf(r)['Jet fuel'], 62.9);
    assert.match(line(r, /^product balance, pre-crisis baseline/), /latest month 2026-06 for jet fuel\)/);
    assert.match(line(r, /^product balance, pre-crisis baseline/), /jet fuel [^;]*− 7(?:\.0)? = /);
  });

  it('without the national section Malaysia keeps no products table', async (t) => {
    t.after(restore);
    seed(my({ national: null }));
    const r = await shock();
    assert.deepEqual(r.products, []);
    assert.match(r.assessment, /no refined-product demand observation/);
  });

  it('a v16 cache entry from before national demand is not served', async (t) => {
    t.after(restore);
    seed({ ...my(), 'energy:shock:v16:MY:hormuz_strait:100:l:oil': { countryCode: 'MY', products: [], limitations: [] } });
    const r = await shock();
    assert.equal(r.products.length, 4);
  });
});
