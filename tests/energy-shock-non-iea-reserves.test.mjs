/**
 * Strategic reserves for importers outside the IEA (India, China). They have
 * no IEA stock observation, so the oil shock reported no cover at all. A
 * dated low/central/high reserve estimate now gives cover days, labelled as an
 * estimate everywhere and never as IEA data.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { NON_IEA_RESERVES } from '../server/worldmonitor/intelligence/v1/_non-iea-reserves.ts';
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
const IN_JODI = { 'energy:jodi-oil:v1:IN': { iso2: 'IN', dataMonth: '2026-03', crude: { importsKbd: IN_IMPORTS }, gasoline: { demandKbd: 900 }, diesel: { demandKbd: 1900 } } };
const CN_IMPORTS = 8955.9019;
const CN = {
  'energy:jodi-oil:v1:CN': { iso2: 'CN', dataMonth: '2026-08', crude: { importsKbd: CN_IMPORTS }, gasoline: { demandKbd: 3300 }, diesel: { demandKbd: 3500 } },
  'comtrade:bilateral-hs4-partners:CN:v1': { iso2: 'CN', products: [{ hs4: '2709', year: 2024, totalValue: 1000, partners: [
    { partnerCode: 682, partnerIso2: 'SA', value: 200 }, { partnerCode: 368, partnerIso2: 'IQ', value: 178 }, { partnerCode: 643, partnerIso2: 'RU', value: 622 },
  ], omittedCount: 0, omittedShare: 0 }] },
};
const shock = (countryCode, extra = {}) => computeEnergyShockScenario({}, { countryCode, chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil', ...extra });
const cover = (r, stockMb, imports) => computeEffectiveCoverDaysWithRamp(stockMb * 1000 / imports, false, r.preCrisisBaseline.crudeLossKbd, r.crudeLossKbd, imports);

describe('non-IEA reserve constants', () => {
  it('cover India and China with dated, ordered, sourced ranges; China is flagged low credibility', () => {
    assert.deepEqual(Object.keys(NON_IEA_RESERVES).sort(), ['CN', 'IN']);
    for (const [iso2, e] of Object.entries(NON_IEA_RESERVES)) {
      assert.ok(e.lowMb > 0 && e.lowMb <= e.centralMb && e.centralMb <= e.highMb, iso2);
      assert.match(e.asOf, /^\d{4}-\d{2}(-\d{2})?$/, iso2);
      assert.ok(e.scope.length > 0 && e.basis.length > 0, iso2);
      assert.ok(e.sources.length > 0 && e.sources.every((s) => /^https:\/\//.test(s)), iso2);
    }
    assert.equal(NON_IEA_RESERVES.IN.credibility, 'high');
    assert.equal(NON_IEA_RESERVES.CN.credibility, 'low');
    // India: 3.372 MMT held on 2026-03-23 (64% of 5.33 MMT), about 24 M bbl.
    assert.equal(NON_IEA_RESERVES.IN.centralMb, 24);
    assert.equal(NON_IEA_RESERVES.IN.asOf, '2026-03-23');
    // China: about 360 M bbl government-held, about 1.4 bn bbl with state-directed commercial stocks (EIA, Dec 2025).
    assert.equal(NON_IEA_RESERVES.CN.lowMb, 360);
    assert.equal(NON_IEA_RESERVES.CN.highMb, 1400);
  });
});

describe('handler: cover from a non-IEA reserve estimate', () => {
  it('India: estimated cover from the ISPRL reserve, labelled as an estimate and never as IEA data', async (t) => {
    t.after(restore);
    seed({ ...HORMUZ, ...ORIGIN, ...IN_JODI });
    const r = await shock('IN');
    assert.equal(r.ieaStocksCoverage, false, 'an estimate is not IEA coverage');
    const est = r.reserveEstimate;
    assert.ok(est, 'reserveEstimate is reported');
    assert.equal(est.credibility, 'high');
    assert.equal(est.asOf, '2026-03-23');
    assert.deepEqual([est.lowMb, est.centralMb, est.highMb], [NON_IEA_RESERVES.IN.lowMb, 24, NON_IEA_RESERVES.IN.highMb]);
    assert.equal(r.effectiveCoverDays, cover(r, 24, IN_IMPORTS));
    assert.equal(est.coverDaysLow, cover(r, NON_IEA_RESERVES.IN.lowMb, IN_IMPORTS));
    assert.equal(est.coverDaysHigh, cover(r, NON_IEA_RESERVES.IN.highMb, IN_IMPORTS));
    assert.ok(est.coverDaysLow <= r.effectiveCoverDays && r.effectiveCoverDays <= est.coverDaysHigh);
    const note = r.limitations.find((l) => /^Strategic reserve estimate/.test(l));
    assert.ok(note, r.limitations.join('\n'));
    assert.match(note, /not IEA data/);
    assert.match(note, /24 M bbl/);
    assert.match(note, /2026-03-23/);
    assert.match(note, /commercial stocks are not counted/);
    assert.ok(r.limitations.includes('IEA strategic stock data unavailable'));
    assert.doesNotMatch(r.assessment, /IEA cover: ~|days IEA cover/);
    assert.match(r.assessment, /estimated strategic reserve/);
  });

  it('a JODI row with crude imports but no product demand does not read as a 0.0% deficit', async (t) => {
    t.after(restore);
    seed({ ...HORMUZ, ...ORIGIN, 'energy:jodi-oil:v1:IN': { iso2: 'IN', dataMonth: '2026-03', crude: { importsKbd: IN_IMPORTS } } });
    const r = await shock('IN');
    assert.deepEqual(r.products, []);
    assert.doesNotMatch(r.assessment, /0\.0%/);
    assert.match(r.assessment, /no refined-product demand observation/);
    assert.match(r.assessment, /estimated strategic reserve cover: ~\d+ days \(not IEA data\)/);
  });

  it('recorded demand with zero deficits names a 0.0% deficit, not a missing demand observation', () => {
    // Observed zero crude imports: demand is recorded, every deficit is 0.
    const products = [{ product: 'Gasoline', deficitPct: 0 }, { product: 'Diesel', deficitPct: 0 }];
    const msg = buildAssessment('JP', 'hormuz_strait', true, 0.4, 30, 30, 50, products, 'full', false, true, true);
    assert.doesNotMatch(msg, /no refined-product demand observation/);
    assert.match(msg, /faces 0\.0% gasoline deficit/);
    assert.match(buildAssessment('JP', 'hormuz_strait', true, 0.4, 30, 30, 50, [], 'full', false, true, true), /no refined-product demand observation/);
  });

  it('China: the estimate carries its low credibility and range', async (t) => {
    t.after(restore);
    seed({ ...HORMUZ, ...ORIGIN, ...CN });
    const r = await shock('CN');
    assert.equal(r.reserveEstimate?.credibility, 'low');
    assert.equal(r.effectiveCoverDays, cover(r, NON_IEA_RESERVES.CN.centralMb, CN_IMPORTS));
    const note = r.limitations.find((l) => /^Strategic reserve estimate/.test(l));
    assert.match(note, /low credibility/);
    assert.match(note, /publishes no stock data/);
  });

  it('a country with IEA stocks keeps IEA cover and gets no estimate', async (t) => {
    t.after(restore);
    seed({
      ...HORMUZ, ...ORIGIN,
      'energy:jodi-oil:v1:JP': { iso2: 'JP', dataMonth: '2026-07', crude: { importsKbd: 2382.1742 }, gasoline: { demandKbd: 790.8 } },
      'energy:iea-oil-stocks:v1:JP': { daysOfCover: 178, netExporter: false, anomaly: false },
    });
    const r = await shock('JP');
    assert.equal(r.reserveEstimate, undefined);
    assert.ok(!r.limitations.some((l) => /^Strategic reserve estimate/.test(l)));
  });

  it('India without JODI imports: the reserve is reported, cover is not modeled', async (t) => {
    t.after(restore);
    seed({ ...HORMUZ, ...ORIGIN });
    const r = await shock('IN');
    assert.equal(r.effectiveCoverDays, 0);
    assert.equal(r.reserveEstimate?.centralMb, 24);
    assert.equal(r.reserveEstimate?.coverDaysLow, undefined);
    assert.equal(r.reserveEstimate?.coverDaysHigh, undefined);
    assert.ok(r.limitations.some((l) => /^Strategic reserve estimate/.test(l) && /cover is not modeled/.test(l)), r.limitations.join('\n'));
  });

  it('gas-only mode carries no reserve estimate', async (t) => {
    t.after(restore);
    seed({ ...HORMUZ, ...ORIGIN, ...IN_JODI, 'energy:jodi-gas:v1:IN': { lngImportsTj: 111255.8, totalDemandTj: 185285.1, dataMonth: '2026-03' } });
    const r = await shock('IN', { fuelMode: 'gas' });
    assert.equal(r.reserveEstimate, undefined);
    assert.ok(!r.limitations.some((l) => /^Strategic reserve estimate/.test(l)));
  });

  it('a stale v12 cache entry (#9792, no estimate) is not served', async (t) => {
    t.after(restore);
    seed({ ...HORMUZ, ...ORIGIN, ...IN_JODI, 'energy:shock:v12:IN:hormuz_strait:100:l:oil': { countryCode: 'IN', effectiveCoverDays: 0, limitations: [] } });
    const r = await shock('IN');
    assert.ok(r.reserveEstimate);
  });

  it('get-country-cost-shock keeps coverageDays as IEA-only: the estimate is not passed off as IEA cover', async (t) => {
    t.after(restore);
    process.env.WORLDMONITOR_VALID_KEYS = 'wm_reserve_fixture';
    seed({ ...HORMUZ, ...ORIGIN, ...IN_JODI });
    const ctx = { request: new Request('https://api.worldmonitor.app/api/supply-chain/v1/get-country-cost-shock', { headers: { 'X-WorldMonitor-Key': 'wm_reserve_fixture' } }) };
    const result = await getCountryCostShock(ctx, { iso2: 'IN', chokepointId: 'hormuz_strait', hs2: '27' });
    assert.equal(result.coverageDays, 0);
    assert.match(result.unavailableReason, /coverageDays is unavailable: no IEA stock observation for IN/);
  });
});
