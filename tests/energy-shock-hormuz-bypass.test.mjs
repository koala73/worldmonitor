/**
 * Hormuz bypass recovery in the oil shock model. Before this, a full Hormuz
 * closure counted every Saudi and UAE barrel as lost, so Japan lost ~93% of
 * its crude imports, against a ~27% Middle East shortfall observed in Aug 2026.
 * Saudi crude keeps flowing through the East-West pipeline to Yanbu, UAE crude
 * through ADCOP to Fujairah, and northern Iraqi crude through Kirkuk-Ceyhan.
 * Recovery is a dated, cited constant per exporter, allocated pro rata to buyers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  HORMUZ_BYPASS_AS_OF,
  HORMUZ_BYPASS_BY_EXPORTER,
  BYPASS_RAMP_DAYS,
  lostShareAfterBypass,
} from '../server/worldmonitor/intelligence/v1/_hormuz-bypass.ts';
import {
  computeEffectiveCoverDaysWithRamp,
  computeEffectiveCoverDays,
  computeMonthlyGulfShares,
  GLOBAL_MEDIAN_REFINERY_YIELD,
  GULF_PARTNER_ISO2,
} from '../server/worldmonitor/intelligence/v1/_shock-compute.ts';
import { computeEnergyShockScenario } from '../server/worldmonitor/intelligence/v1/compute-energy-shock.ts';
import { buildCrudeImportOrigin, crudeImportOriginPeriods, CRUDE_ORIGIN_BYPASS_PARTNERS } from '../scripts/seed-oil-trade-series.mjs';
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

// Importer-declared Comtrade monthly HS 2709 rows recorded 2026-10-28 (JPN, IND, USA, KOR).
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/energy-shock/comtrade-crude-origin-2026-10-28.json', import.meta.url), 'utf8'));
const MONTHS = crudeImportOriginPeriods(Date.parse('2026-10-28T12:00:00Z')).flat();
const SECTION = { status: 'ok', fetchedAt: '2026-10-28T03:00:00.000Z', months: MONTHS, importers: buildCrudeImportOrigin(FIXTURE.rows, MONTHS) };
const ORIGIN = { 'energy:oil-trade-series:v1': { countries: {}, crudeImportOrigin: SECTION } };
const HORMUZ = { 'energy:chokepoint-flows:v1': { hormuz_strait: { flowRatio: 0.606 }, malacca_strait: { flowRatio: 1 } } };
const JP_IMPORTS = 2382.1742;
const JP = {
  'energy:jodi-oil:v1:JP': {
    iso2: 'JP', dataMonth: '2026-07',
    gasoline: { demandKbd: 790.8135 }, diesel: { demandKbd: 674.0471 }, jet: { demandKbd: 240.7139 }, lpg: { demandKbd: 304.2194 },
    crude: { importsKbd: JP_IMPORTS },
  },
  'energy:iea-oil-stocks:v1:JP': { iso2: 'JP', dataMonth: '2026-07', daysOfCover: 178, netExporter: false, anomaly: false },
};
const shock = (countryCode, extra = {}) => computeEnergyShockScenario({}, { countryCode, chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil', ...extra });

describe('bypass constants', () => {
  it('cover exactly the exporters with a working bypass, each dated, ranged and sourced', () => {
    assert.match(HORMUZ_BYPASS_AS_OF, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(Object.keys(HORMUZ_BYPASS_BY_EXPORTER).sort(), ['AE', 'IQ', 'SA']);
    for (const [iso2, b] of Object.entries(HORMUZ_BYPASS_BY_EXPORTER)) {
      assert.ok(GULF_PARTNER_ISO2.has(iso2));
      assert.ok(b.hormuzShare > 0 && b.hormuzShare <= 1, iso2);
      assert.ok(b.recovery.low <= b.recovery.central && b.recovery.central <= b.recovery.high && b.recovery.high < 1, iso2);
      assert.ok(b.route.length > 0 && b.basis.length > 0, iso2);
      assert.ok(b.sources.length > 0 && b.sources.every((s) => /^https:\/\//.test(s)), iso2);
    }
    assert.equal(HORMUZ_BYPASS_BY_EXPORTER.SA.recovery.central, 0.65);
    assert.equal(HORMUZ_BYPASS_BY_EXPORTER.AE.recovery.central, 0.3);
    assert.equal(HORMUZ_BYPASS_BY_EXPORTER.IQ.recovery.central, 0.1);
  });

  it('the seeder stores per-exporter columns for exactly these exporters', () => {
    const iso2ByM49 = { 682: 'SA', 784: 'AE', 368: 'IQ' };
    assert.deepEqual(CRUDE_ORIGIN_BYPASS_PARTNERS.map((c) => iso2ByM49[c]).sort(), Object.keys(HORMUZ_BYPASS_BY_EXPORTER).sort());
  });
});

describe('lostShareAfterBypass', () => {
  // Japan, pre-crisis Comtrade monthly value shares (2025-02..2026-01).
  const jp = { gulfShare: 0.9275, byPartner: { SA: 0.4083, AE: 0.4210 } };

  it('full closure: Japan loses ~41% of crude imports, not ~93%', () => {
    const lost = lostShareAfterBypass(jp, 1, 'central');
    // 0.0985 non-bypass Gulf + SA 0.4083*0.85*0.35 + AE 0.4210*0.65*0.70
    assert.ok(Math.abs(lost - 0.4112) < 0.0005, `${lost}`);
  });

  it('recovery is capacity-limited: a half closure is absorbed by the Saudi spare route', () => {
    const lost = lostShareAfterBypass(jp, 0.5, 'central');
    const expected = (0.9275 - 0.4083 - 0.4210) * 0.5 + 0 + 0.4210 * 0.65 * (0.5 - 0.3);
    assert.ok(Math.abs(lost - expected) < 1e-9, `${lost} vs ${expected}`);
  });

  it('low recovery loses more than central, which loses more than high', () => {
    assert.ok(lostShareAfterBypass(jp, 1, 'low') > lostShareAfterBypass(jp, 1, 'central'));
    assert.ok(lostShareAfterBypass(jp, 1, 'central') > lostShareAfterBypass(jp, 1, 'high'));
  });

  it('no recoverable exporter means no recovery', () => {
    assert.equal(lostShareAfterBypass({ gulfShare: 0.3, byPartner: {} }, 1, 'central'), 0.3);
  });
});

describe('computeEffectiveCoverDaysWithRamp', () => {
  it('equals the flat formula when the first-month and steady losses match', () => {
    assert.equal(computeEffectiveCoverDaysWithRamp(178, false, 2208, 2208, JP_IMPORTS), computeEffectiveCoverDays(178, false, 2208, JP_IMPORTS));
  });

  it('draws the first month at the no-bypass rate, then the steady rate', () => {
    const first = JP_IMPORTS * 0.9275;
    const steady = JP_IMPORTS * 0.4112;
    const expected = Math.round(BYPASS_RAMP_DAYS + (178 - BYPASS_RAMP_DAYS * 0.9275) / 0.4112);
    assert.equal(computeEffectiveCoverDaysWithRamp(178, false, first, steady, JP_IMPORTS), expected);
  });

  it('stocks exhausted inside the ramp month end at the no-bypass rate', () => {
    assert.equal(computeEffectiveCoverDaysWithRamp(20, false, JP_IMPORTS * 0.9275, JP_IMPORTS * 0.4112, JP_IMPORTS), Math.round(20 / 0.9275));
  });

  it('keeps the net-exporter sentinel and the 730-day cap', () => {
    assert.equal(computeEffectiveCoverDaysWithRamp(90, true, 10, 5, 100), -1);
    assert.equal(computeEffectiveCoverDaysWithRamp(500, false, 10, 1, 100), 730);
  });
});

describe('monthly per-exporter shares', () => {
  it('computeMonthlyGulfShares reports SA, AE and IQ shares over each window', () => {
    const { preCrisis, current } = computeMonthlyGulfShares(SECTION, 'JP');
    assert.ok(Math.abs(preCrisis.byPartner.SA - 0.4083) < 0.0005, JSON.stringify(preCrisis.byPartner));
    assert.ok(Math.abs(preCrisis.byPartner.AE - 0.4210) < 0.0005);
    assert.equal(preCrisis.byPartner.IQ ?? 0, 0);
    assert.ok(Math.abs(current.byPartner.SA - 0.3141) < 0.0005);
    const india = computeMonthlyGulfShares(SECTION, 'IN').preCrisis;
    assert.ok(Math.abs(india.byPartner.IQ - 0.1779) < 0.0005, JSON.stringify(india.byPartner));
  });

  it('a section written before per-exporter columns existed has no byPartner', () => {
    const legacy = { ...SECTION, importers: Object.fromEntries(Object.entries(SECTION.importers).map(([k, v]) => [k, { worldUsdM: v.worldUsdM, gulfUsdM: v.gulfUsdM }])) };
    assert.equal(computeMonthlyGulfShares(legacy, 'JP').preCrisis.byPartner, undefined);
  });
});

describe('handler: Hormuz bypass on the pre-crisis baseline', () => {
  it('Japan full closure: headline loss is ~41% of imports after bypass; ~93% before it is reported beside', async (t) => {
    t.after(restore);
    seed({ ...HORMUZ, ...JP, ...ORIGIN });
    const r = await shock('JP');
    const pre = r.preCrisisBaseline;
    assert.ok(Math.abs(pre.crudeLossKbd - JP_IMPORTS * 0.9275) < 2, `no-bypass ${pre.crudeLossKbd}`);
    assert.ok(Math.abs(pre.crudeLossAfterBypassKbd - JP_IMPORTS * 0.4112) < 2, `after bypass ${pre.crudeLossAfterBypassKbd}`);
    assert.equal(r.crudeLossKbd, pre.crudeLossAfterBypassKbd, 'the headline loss is the steady state after bypass');
    assert.equal(r.gulfCrudeShare, pre.gulfCrudeShare, 'the share stays the measured Gulf share');
    // Products use the steady-state loss through the refinery yield; this JODI row
    // has no country yields, so gasoline takes the global median.
    const gasoline = r.products.find((p) => p.product === 'Gasoline');
    assert.ok(Math.abs(gasoline.deficitPct - (JP_IMPORTS * 0.4112 * GLOBAL_MEDIAN_REFINERY_YIELD.gasoline / 790.8135) * 100) < 0.3, `${gasoline.deficitPct}`);
    const expectedCover = Math.round(BYPASS_RAMP_DAYS + (178 - BYPASS_RAMP_DAYS * 0.9275) / 0.4112);
    assert.ok(Math.abs(r.effectiveCoverDays - expectedCover) <= 1, `cover ${r.effectiveCoverDays} vs ${expectedCover}`);
    // No bypass recovery is applied to current flows.
    assert.equal(r.currentFlows.crudeLossAfterBypassKbd, undefined);
    const bypassNote = r.limitations.find((l) => /^Hormuz bypass/.test(l));
    assert.ok(bypassNote, r.limitations.join('\n'));
    assert.match(bypassNote, new RegExp(`as of ${HORMUZ_BYPASS_AS_OF}`));
    assert.match(bypassNote, /East-West/);
    assert.match(bypassNote, /ADCOP/);
    assert.match(bypassNote, /Kirkuk/);
    assert.match(bypassNote, /pro rata/);
    assert.match(bypassNote, /first month/);
    assert.match(bypassNote, /\d[\d,]* kbd before bypass, \d[\d,]* kbd after/);
    assert.match(bypassNote, /range \d[\d,]*-\d[\d,]* kbd from high to low recovery/);
    assert.ok(!r.limitations.some((l) => /bypass pipelines .* are not modeled/.test(l)), 'the old not-modeled clause is gone');
    // Comtrade records supplier origin, not route: the current-flows loss counts
    // Gulf crude already loading at Yanbu or Fujairah, so it is labelled a supplier-share estimate.
    const current = r.limitations.find((l) => /^Current flows/.test(l));
    assert.match(current, /supplier-share estimate/);
    assert.match(current, /origin, not route/);
    assert.doesNotMatch(current, /already reflect rerouting/);
    assert.match(r.assessment, /after bypass rerouting/);
  });

  it('a stale v11 cache entry (#9789 baselines, no bypass) is not served', async (t) => {
    t.after(restore);
    seed({ ...HORMUZ, ...JP, ...ORIGIN, 'energy:shock:v11:JP:hormuz_strait:100:l:oil': { countryCode: 'JP', crudeLossKbd: 2209.5, limitations: [] } });
    const r = await shock('JP');
    assert.ok(r.preCrisisBaseline?.crudeLossAfterBypassKbd > 0);
  });

  it('Malacca: no Hormuz bypass is applied', async (t) => {
    t.after(restore);
    seed({ ...HORMUZ, ...JP, ...ORIGIN });
    const r = await shock('JP', { chokepointId: 'malacca_strait' });
    assert.equal(r.preCrisisBaseline.crudeLossAfterBypassKbd, undefined);
    assert.equal(r.crudeLossKbd, r.preCrisisBaseline.crudeLossKbd);
    assert.ok(!r.limitations.some((l) => /^Hormuz bypass/.test(l)));
  });

  it('annual fallback (China): per-exporter shares come from the partner rows', async (t) => {
    t.after(restore);
    seed({
      ...HORMUZ, ...ORIGIN,
      'energy:jodi-oil:v1:CN': { iso2: 'CN', dataMonth: '2026-08', crude: { importsKbd: 8955.9 }, gasoline: { demandKbd: 3300 } },
      'comtrade:bilateral-hs4-partners:CN:v1': { iso2: 'CN', products: [{ hs4: '2709', year: 2024, totalValue: 1000, partners: [
        { partnerCode: 682, partnerIso2: 'SA', value: 200 }, { partnerCode: 368, partnerIso2: 'IQ', value: 178 }, { partnerCode: 643, partnerIso2: 'RU', value: 622 },
      ], omittedCount: 0, omittedShare: 0 }] },
    });
    const r = await shock('CN');
    assert.equal(r.preCrisisBaseline.basis, 'comtrade_annual');
    const lost = 0.2 * 0.85 * 0.35 + 0.178 * 0.95 * 0.9;
    assert.ok(Math.abs(r.preCrisisBaseline.crudeLossAfterBypassKbd - 8955.9 * lost) < 2, `${r.preCrisisBaseline.crudeLossAfterBypassKbd}`);
  });

  it('without JODI crude imports the after-bypass loss is absent, like the loss itself is not modeled', async (t) => {
    t.after(restore);
    seed({ ...HORMUZ, ...ORIGIN });
    const r = await shock('IN');
    assert.equal(r.dataAvailable, false);
    assert.equal(r.preCrisisBaseline.crudeLossKbd, 0);
    assert.equal(r.preCrisisBaseline.crudeLossAfterBypassKbd, undefined);
  });

  it('a monthly section without per-exporter columns: bypass is reported as not modeled, the headline stays the no-bypass loss', async (t) => {
    t.after(restore);
    const legacy = { ...SECTION, importers: Object.fromEntries(Object.entries(SECTION.importers).map(([k, v]) => [k, { worldUsdM: v.worldUsdM, gulfUsdM: v.gulfUsdM }])) };
    seed({ ...HORMUZ, ...JP, 'energy:oil-trade-series:v1': { countries: {}, crudeImportOrigin: legacy } });
    const r = await shock('JP');
    assert.equal(r.preCrisisBaseline.crudeLossAfterBypassKbd, undefined);
    assert.equal(r.crudeLossKbd, r.preCrisisBaseline.crudeLossKbd);
    assert.ok(r.limitations.some((l) => /Hormuz bypass recovery is not modeled for JP/.test(l) && /per-exporter shares are unavailable/.test(l)), r.limitations.join('\n'));
  });
});
