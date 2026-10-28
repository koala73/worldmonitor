/**
 * Oil stocks for importers outside the IEA. They have no IEA stock
 * observation, so cover comes from the month-end crude and product stocks
 * they report to JODI, a recurring source the JODI seeder already downloads.
 * A country that reports none (China) gets no cover; no figure is typed in.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildAssessment, computeEffectiveCoverDaysWithRamp } from '../server/worldmonitor/intelligence/v1/_shock-compute.ts';
import { computeEnergyShockScenario } from '../server/worldmonitor/intelligence/v1/compute-energy-shock.ts';
import { getCountryCostShock } from '../server/worldmonitor/supply-chain/v1/get-country-cost-shock.ts';
import { buildCrudeImportOrigin, crudeImportOriginPeriods } from '../scripts/seed-oil-trade-series.mjs';
import { installRedis } from './helpers/fake-upstash-redis.mts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN, local: process.env.LOCAL_API_MODE, keys: process.env.WORLDMONITOR_VALID_KEYS };
function restore() {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const [k, v] of [['UPSTASH_REDIS_REST_URL', ORIGINAL_ENV.url], ['UPSTASH_REDIS_REST_TOKEN', ORIGINAL_ENV.token], ['LOCAL_API_MODE', ORIGINAL_ENV.local], ['WORLDMONITOR_VALID_KEYS', ORIGINAL_ENV.keys]]) {
    if (v == null) delete process.env[k]; else process.env[k] = v;
  }
}
function seed(values) {
  installRedis(values);
  delete process.env.LOCAL_API_MODE;
}

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/energy-shock/comtrade-crude-origin-2026-10-28.json', import.meta.url), 'utf8'));
const MONTHS = crudeImportOriginPeriods(Date.parse('2026-10-28T12:00:00Z')).flat();
const ORIGIN = { 'energy:oil-trade-series:v1': { countries: {}, crudeImportOrigin: { status: 'ok', fetchedAt: '2026-10-28T03:00:00.000Z', months: MONTHS, importers: buildCrudeImportOrigin(FIXTURE.rows, MONTHS) } } };
const HORMUZ = { 'energy:chokepoint-flows:v1': { hormuz_strait: { flowRatio: 0.606 } } };
// JODI rows as the fixed JODI seeder (#9393) publishes them from the 2026-10-28 files.
const IN_IMPORTS = 4496.651;
// India's JODI 2026-03 closing stocks: crude 45,280 kbbl, products 95,989 kbbl.
const IN_STOCKS = { month: '2026-03', crudeMb: 45.28, productsMb: 95.989 };
const IN_TOTAL_MB = 45.28 + 95.989;
const IN_JODI = { 'energy:jodi-oil:v1:IN': { iso2: 'IN', dataMonth: '2026-03', crude: { importsKbd: IN_IMPORTS }, gasoline: { demandKbd: 900 }, diesel: { demandKbd: 1900 }, stocks: IN_STOCKS } };
const CN_IMPORTS = 8955.9019;
const CN = {
  'energy:jodi-oil:v1:CN': { iso2: 'CN', dataMonth: '2026-08', crude: { importsKbd: CN_IMPORTS }, gasoline: { demandKbd: 3300 }, diesel: { demandKbd: 3500 }, stocks: null },
  'comtrade:bilateral-hs4-partners:CN:v1': { iso2: 'CN', products: [{ hs4: '2709', year: 2024, totalValue: 1000, partners: [
    { partnerCode: 682, partnerIso2: 'SA', value: 200 }, { partnerCode: 368, partnerIso2: 'IQ', value: 178 }, { partnerCode: 643, partnerIso2: 'RU', value: 622 },
  ], omittedCount: 0, omittedShare: 0 }] },
};
const shock = (countryCode, extra = {}) => computeEnergyShockScenario({}, { countryCode, chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil', ...extra });
const cover = (r, stockMb, imports) => computeEffectiveCoverDaysWithRamp(stockMb * 1000 / imports, false, r.preCrisisBaseline.crudeLossKbd, r.crudeLossKbd, imports);
const stocksNote = (r) => r.limitations.find((l) => /^Oil stocks reported to JODI/.test(l));

describe('handler: cover from JODI-reported stocks', () => {
  it('India: cover from its JODI crude and product stocks, labelled as JODI data and never as IEA cover', async (t) => {
    t.after(restore);
    seed({ ...HORMUZ, ...ORIGIN, ...IN_JODI });
    const r = await shock('IN');
    assert.equal(r.ieaStocksCoverage, false, 'JODI stocks are not IEA coverage');
    assert.equal(r.reserveEstimate, undefined, 'the deprecated hand-entered estimate is gone');
    const s = r.reportedStocks;
    assert.ok(s, 'reportedStocks is reported');
    assert.equal(s.source, 'jodi');
    assert.equal(s.month, '2026-03');
    assert.equal(s.crudeMb, 45.3);
    assert.equal(s.productsMb, 96);
    assert.equal(s.totalMb, 141.3);
    assert.equal(s.stockDays, Math.round(IN_TOTAL_MB * 1000 / IN_IMPORTS));
    assert.equal(r.effectiveCoverDays, cover(r, IN_TOTAL_MB, IN_IMPORTS));
    assert.ok(r.effectiveCoverDays > 0);
    const note = stocksNote(r);
    assert.ok(note, r.limitations.join('\n'));
    assert.match(note, /not IEA data/);
    assert.match(note, /crude 45\.3 \+ products 96\.0 = 141\.3 M bbl at the end of 2026-03/);
    assert.match(note, /government reserves/);
    assert.ok(r.limitations.includes('IEA strategic stock data unavailable'));
    assert.doesNotMatch(r.assessment, /IEA cover: ~|days IEA cover/);
    assert.match(r.assessment, /JODI-reported stock cover: ~\d+ days \(not IEA data\)/);
  });

  it('a JODI row with crude imports but no product demand does not read as a 0.0% deficit', async (t) => {
    t.after(restore);
    seed({ ...HORMUZ, ...ORIGIN, 'energy:jodi-oil:v1:IN': { iso2: 'IN', dataMonth: '2026-03', crude: { importsKbd: IN_IMPORTS }, stocks: IN_STOCKS } });
    const r = await shock('IN');
    assert.deepEqual(r.products, []);
    assert.doesNotMatch(r.assessment, /0\.0%/);
    assert.match(r.assessment, /no refined-product demand observation/);
    assert.match(r.assessment, /JODI-reported stock cover: ~\d+ days \(not IEA data\)/);
  });

  it('recorded demand with zero deficits names a 0.0% deficit, not a missing demand observation', () => {
    // Observed zero crude imports: demand is recorded, every deficit is 0.
    const products = [{ product: 'Gasoline', deficitPct: 0 }, { product: 'Diesel', deficitPct: 0 }];
    const msg = buildAssessment('JP', 'hormuz_strait', true, 0.4, 30, 30, 50, products, 'full', false, true, true);
    assert.doesNotMatch(msg, /no refined-product demand observation/);
    assert.match(msg, /faces 0\.0% gasoline deficit/);
    assert.match(buildAssessment('JP', 'hormuz_strait', true, 0.4, 30, 30, 50, [], 'full', false, true, true), /no refined-product demand observation/);
  });

  it('China reports no stocks to JODI: no cover and no figure stands in for one', async (t) => {
    t.after(restore);
    seed({ ...HORMUZ, ...ORIGIN, ...CN });
    const r = await shock('CN');
    assert.equal(r.reportedStocks, undefined);
    assert.equal(r.reserveEstimate, undefined);
    assert.equal(r.effectiveCoverDays, 0);
    assert.equal(stocksNote(r), undefined);
    assert.ok(r.limitations.some((l) => /^Oil stock cover not modeled for CN: no IEA or JODI stock observation/.test(l)), r.limitations.join('\n'));
  });

  it('stocks more than 12 months older than the JODI flow month are not used', async (t) => {
    t.after(restore);
    seed({ ...HORMUZ, ...ORIGIN, 'energy:jodi-oil:v1:IN': { ...IN_JODI['energy:jodi-oil:v1:IN'], stocks: { ...IN_STOCKS, month: '2025-02' } } });
    const r = await shock('IN');
    assert.equal(r.reportedStocks, undefined);
    assert.equal(r.effectiveCoverDays, 0);
    assert.ok(r.limitations.some((l) => /JODI stocks for IN are from 2025-02, more than 12 months before/.test(l)), r.limitations.join('\n'));
  });

  it('an impossible stock month is rejected, and stocks that cannot be dated against the flow month give no cover', async (t) => {
    t.after(restore);
    const row = IN_JODI['energy:jodi-oil:v1:IN'];
    seed({ ...HORMUZ, ...ORIGIN, 'energy:jodi-oil:v1:IN': { ...row, stocks: { ...IN_STOCKS, month: '2026-13' } } });
    assert.equal((await shock('IN')).reportedStocks, undefined);
    for (const dataMonth of [undefined, '2026-00', 'latest']) {
      seed({ ...HORMUZ, ...ORIGIN, 'energy:jodi-oil:v1:IN': { ...row, dataMonth } });
      const r = await shock('IN');
      assert.equal(r.reportedStocks, undefined, String(dataMonth));
      assert.ok(r.limitations.some((l) => /JODI stocks for IN \(2026-03\) cannot be dated against a valid JODI flow month/.test(l)), r.limitations.join('\n'));
    }
  });

  it('malformed stock fields are ignored, not read as zero stock', async (t) => {
    t.after(restore);
    seed({ ...HORMUZ, ...ORIGIN, 'energy:jodi-oil:v1:IN': { ...IN_JODI['energy:jodi-oil:v1:IN'], stocks: { month: '2026-03', crudeMb: 'x', productsMb: 96 } } });
    const r = await shock('IN');
    assert.equal(r.reportedStocks, undefined);
  });

  it('a country with IEA stocks keeps IEA cover and ignores its JODI stocks', async (t) => {
    t.after(restore);
    seed({
      ...HORMUZ, ...ORIGIN,
      'energy:jodi-oil:v1:JP': { iso2: 'JP', dataMonth: '2026-07', crude: { importsKbd: 2382.1742 }, gasoline: { demandKbd: 790.8 }, stocks: { month: '2026-07', crudeMb: 272.3, productsMb: 104.5 } },
      'energy:iea-oil-stocks:v1:JP': { daysOfCover: 178, netExporter: false, anomaly: false },
    });
    const r = await shock('JP');
    assert.equal(r.reportedStocks, undefined);
    assert.equal(stocksNote(r), undefined);
  });

  it('a JODI net exporter reports its stocks without stock days, never as "~-1 days" of cover', async (t) => {
    t.after(restore);
    // Crude balance that reads as a net exporter, with a measured Gulf share so the loss is modeled.
    const exporter = { ...IN_JODI['energy:jodi-oil:v1:IN'], crude: { productionKbd: 9000, refineryIntakeKbd: 5000, importsKbd: IN_IMPORTS, exportsKbd: 5000 } };
    seed({ ...HORMUZ, ...ORIGIN, 'energy:jodi-oil:v1:IN': exporter });
    const r = await shock('IN');
    assert.equal(r.effectiveCoverDays, -1);
    assert.equal(r.reportedStocks?.totalMb, 141.3);
    assert.equal(r.reportedStocks?.stockDays, undefined);
    assert.doesNotMatch(stocksNote(r), /~-1 days/);
    assert.match(stocksNote(r), /no import cover applies to a net oil exporter/);
  });

  it('an anomalous IEA record does not fall back to JODI stocks, and says why there is no cover', async (t) => {
    t.after(restore);
    seed({
      ...HORMUZ, ...ORIGIN,
      'energy:jodi-oil:v1:JP': { iso2: 'JP', dataMonth: '2026-07', crude: { importsKbd: 2382.1742 }, gasoline: { demandKbd: 790.8 }, stocks: { month: '2026-07', crudeMb: 272.3, productsMb: 104.5 } },
      'energy:iea-oil-stocks:v1:JP': { daysOfCover: 178, netExporter: false, anomaly: true },
    });
    const r = await shock('JP');
    assert.equal(r.ieaStocksCoverage, false);
    assert.equal(r.reportedStocks, undefined, 'an IEA member is not given JODI cover because its IEA record is anomalous');
    assert.equal(r.effectiveCoverDays, 0);
    assert.equal(stocksNote(r), undefined);
    assert.match(r.limitations.find((l) => /^Oil stock cover not modeled for JP/.test(l)) ?? '', /IEA stock record for JP is anomalous or incomplete/);
  });

  it('India without JODI crude imports: the stocks are reported, cover is not modeled', async (t) => {
    t.after(restore);
    seed({ ...HORMUZ, ...ORIGIN, 'energy:jodi-oil:v1:IN': { iso2: 'IN', dataMonth: '2026-03', crude: {}, diesel: { demandKbd: 1900 }, stocks: IN_STOCKS } });
    const r = await shock('IN');
    assert.equal(r.effectiveCoverDays, 0);
    assert.equal(r.reportedStocks?.totalMb, 141.3);
    assert.equal(r.reportedStocks?.stockDays, undefined);
    assert.match(stocksNote(r), /cover is not modeled/);
  });

  it('gas-only mode carries no stocks', async (t) => {
    t.after(restore);
    seed({ ...HORMUZ, ...ORIGIN, ...IN_JODI, 'energy:jodi-gas:v1:IN': { lngImportsTj: 111255.8, totalDemandTj: 185285.1, dataMonth: '2026-03' } });
    const r = await shock('IN', { fuelMode: 'gas' });
    assert.equal(r.reportedStocks, undefined);
    assert.equal(stocksNote(r), undefined);
  });

  it('a stale v13 cache entry (#9793, hand-entered estimate) is not served', async (t) => {
    t.after(restore);
    seed({ ...HORMUZ, ...ORIGIN, ...IN_JODI, 'energy:shock:v13:IN:hormuz_strait:100:l:oil': { countryCode: 'IN', effectiveCoverDays: 11, reserveEstimate: { centralMb: 24 }, limitations: [] } });
    const r = await shock('IN');
    assert.ok(r.reportedStocks);
    assert.equal(r.reserveEstimate, undefined);
  });

  it('get-country-cost-shock keeps coverageDays as IEA-only: JODI stocks are not passed off as IEA cover', async (t) => {
    t.after(restore);
    process.env.WORLDMONITOR_VALID_KEYS = 'wm_reserve_fixture';
    seed({ ...HORMUZ, ...ORIGIN, ...IN_JODI });
    const ctx = { request: new Request('https://api.worldmonitor.app/api/supply-chain/v1/get-country-cost-shock', { headers: { 'X-WorldMonitor-Key': 'wm_reserve_fixture' } }) };
    const result = await getCountryCostShock(ctx, { iso2: 'IN', chokepointId: 'hormuz_strait', hs2: '27' });
    assert.equal(result.coverageDays, 0);
    assert.match(result.unavailableReason, /coverageDays is unavailable: no IEA stock observation for IN/);
  });
});
