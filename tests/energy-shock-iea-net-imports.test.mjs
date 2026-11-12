/**
 * IEA days of cover are days of the previous calendar year's net oil imports
 * (crude, NGL and feedstocks, and products). The shock converts them to
 * barrels with JODI net oil imports when the seeder publishes them; crude
 * imports alone understate a product importer and overstate a product
 * exporter (audit 2026-10-28: Australia 4.25x, Korea 0.83x).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { computeEffectiveCoverDaysWithRamp } from '../server/worldmonitor/intelligence/v1/_shock-compute.ts';
import { computeEnergyShockScenario } from '../server/worldmonitor/intelligence/v1/compute-energy-shock.ts';
import { buildCrudeImportOrigin, crudeImportOriginPeriods } from '../scripts/seed-oil-trade-series.mjs';
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

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/energy-shock/comtrade-crude-origin-2026-10-28.json', import.meta.url), 'utf8'));
const MONTHS = crudeImportOriginPeriods(Date.parse('2026-10-28T12:00:00Z')).flat();
const ORIGIN = { 'energy:oil-trade-series:v1': { countries: {}, crudeImportOrigin: { status: 'ok', fetchedAt: '2026-10-28T03:00:00.000Z', months: MONTHS, importers: buildCrudeImportOrigin(FIXTURE.rows, MONTHS) } } };
const HORMUZ = { 'energy:chokepoint-flows:v1': { hormuz_strait: { flowRatio: 0.606 } } };

// Japan: JODI 2026-07 crude imports; 2025 net oil imports from the live JODI files.
const JP_CRUDE = 2382.1742;
const JP_NET = [{ year: 2025, kbd: 3113.5, months: 12 }, { year: 2024, kbd: 3240.2, months: 12 }];
const jp = (netOilImports, ieaMonth = '2026-07') => ({
  ...HORMUZ, ...ORIGIN,
  'energy:jodi-oil:v1:JP': { iso2: 'JP', dataMonth: '2026-07', crude: { importsKbd: JP_CRUDE }, gasoline: { demandKbd: 790.8 }, ...(netOilImports !== undefined ? { netOilImports } : {}) },
  'energy:iea-oil-stocks:v1:JP': { dataMonth: ieaMonth, daysOfCover: 178, netExporter: false, anomaly: false },
});
const shock = () => computeEnergyShockScenario({}, { countryCode: 'JP', chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });
const cover = (r, basisKbd) => computeEffectiveCoverDaysWithRamp(178, false, r.preCrisisBaseline.crudeLossKbd, r.crudeLossKbd, basisKbd);
const basisNote = (r) => r.limitations.find((l) => /^IEA days of cover converted to barrels/.test(l));

describe('IEA cover in barrels of net oil imports', () => {
  it('converts IEA days with JODI net oil imports of the previous year', async (t) => {
    t.after(restore);
    seed(jp(JP_NET));
    const r = await shock();
    assert.equal(r.effectiveCoverDays, cover(r, 3113.5));
    assert.ok(r.effectiveCoverDays > cover(r, JP_CRUDE), 'Japan imports products too, so its stock is larger than crude imports imply');
    assert.match(basisNote(r), /JODI 2025 net oil imports \(crude and products\) of 3,113\.5 kb\/d/);
    assert.match(basisNote(r), /a proxy for the net imports IEA counts days against, which deduct naphtha, adjust for stock changes and convert products to crude-oil equivalent/);
  });

  it("takes the year before IEA's own data month, which can lag JODI's across a new year", async (t) => {
    t.after(restore);
    seed(jp(JP_NET, '2025-12'));
    const r = await shock();
    assert.equal(r.effectiveCoverDays, cover(r, 3240.2));
    assert.match(basisNote(r), /JODI 2024 net oil imports \(crude and products\) of 3,240\.2 kb\/d/);
  });

  it("falls back to crude imports, and says so, when that year's net oil imports are unavailable", async (t) => {
    t.after(restore);
    const cases = [
      [undefined, '2026-07'], [null, '2026-07'], [[{ year: 2025, kbd: -10, months: 12 }], '2026-07'],
      [[{ year: '2025', kbd: 'x', months: 12 }], '2026-07'], [{ year: 2025, kbd: 3113.5, months: 12 }, '2026-07'],
      [JP_NET, '2024-11'],
    ];
    for (const [net, ieaMonth] of cases) {
      seed(jp(net, ieaMonth));
      const r = await shock();
      assert.equal(r.effectiveCoverDays, cover(r, JP_CRUDE), JSON.stringify(net));
      assert.match(basisNote(r), new RegExp(`JODI crude imports of 2,382\\.2 kb/d; JODI net oil imports for ${Number(ieaMonth.slice(0, 4)) - 1} are unavailable, so cover is misstated for a country that trades products`));
    }
    seed(jp(JP_NET, null));
    assert.match(basisNote(await shock()), /net oil imports for the year IEA counts days against are unavailable/);
  });

  it('a stale v14 cache entry (crude-import conversion) is not served', async (t) => {
    t.after(restore);
    seed({ ...jp(JP_NET), 'energy:shock:v14:JP:hormuz_strait:100:l:oil': { countryCode: 'JP', effectiveCoverDays: 1, limitations: [] } });
    const r = await shock();
    assert.notEqual(r.effectiveCoverDays, 1);
  });
});
