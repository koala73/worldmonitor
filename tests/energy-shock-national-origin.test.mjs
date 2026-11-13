/**
 * Turkey files no partner-level crude imports to UN Comtrade, so the shock
 * reported its Hormuz exposure as unsupported. Its crude origin now comes
 * from EPDK's monthly petroleum reports (crudeImportOriginNational, tonnes),
 * used only for an importer Comtrade does not cover, and labelled as a
 * volume share with basis national_monthly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { computeEnergyShockScenario } from '../server/worldmonitor/intelligence/v1/compute-energy-shock.ts';
import { buildCrudeImportOrigin, crudeImportOriginNationalSection, crudeImportOriginPeriods } from '../scripts/seed-oil-trade-series.mjs';
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

const MONTHS = crudeImportOriginPeriods(Date.parse('2026-10-28T12:00:00Z')).flat();
const COMTRADE = JSON.parse(readFileSync(new URL('./fixtures/energy-shock/comtrade-crude-origin-2026-10-28.json', import.meta.url), 'utf8'));
// Live EPDK months (scripts/_epdk-crude-imports.mjs), 2025-01..2026-08.
const EPDK = JSON.parse(readFileSync(new URL('./fixtures/energy-shock/epdk-tr-crude-imports-2026-10-28.json', import.meta.url), 'utf8'));
const EPDK_MONTHS = new Map(Object.entries(EPDK.months));

const comtradeSection = { status: 'ok', fetchedAt: '2026-10-28T03:00:00.000Z', months: MONTHS, importers: buildCrudeImportOrigin(COMTRADE.rows, MONTHS) };
const nationalSection = (extra = {}) => ({
  ...crudeImportOriginNationalSection({ months: MONTHS, byMonth: EPDK_MONTHS, fetchedAt: '2026-10-21T03:00:00.000Z' }),
  ...extra,
});

const tr = ({ national = nationalSection(), comtrade = comtradeSection } = {}) => ({
  'energy:chokepoint-flows:v1': { hormuz_strait: { flowRatio: 0.606 } },
  'energy:oil-trade-series:v1': { countries: {}, crudeImportOrigin: comtrade, ...(national ? { crudeImportOriginNational: national } : {}) },
  'energy:jodi-oil:v1:TR': { iso2: 'TR', dataMonth: '2026-07', crude: { importsKbd: 650 }, gasoline: { demandKbd: 60 } },
});
const shock = (code = 'TR') => computeEnergyShockScenario({}, { countryCode: code, chokepointId: 'hormuz_strait', disruptionPct: 100, fuelMode: 'oil' });
const line = (r, re) => r.limitations.find((l) => re.test(l));

describe('crude origin from national statistics (Turkey, EPDK)', () => {
  it('models Turkey from EPDK when Comtrade has no filings for it', async (t) => {
    t.after(restore);
    assert.equal(comtradeSection.importers.TR, undefined, 'fixture: Turkey files no HS 2709 partners to Comtrade');
    seed(tr());
    const r = await shock();
    assert.equal(r.comtradeCoverage, true);
    assert.notEqual(r.coverageLevel, 'unsupported');
    assert.deepEqual(
      { basis: r.preCrisisBaseline.basis, from: r.preCrisisBaseline.fromMonth, to: r.preCrisisBaseline.toMonth, n: r.preCrisisBaseline.monthsCovered, share: r.preCrisisBaseline.gulfCrudeShare },
      { basis: 'national_monthly', from: '2025-02', to: '2026-01', n: 12, share: 0.235 },
    );
    assert.equal(r.gulfCrudeShare, 0.235);
    assert.ok(r.preCrisisBaseline.crudeLossAfterBypassKbd < r.preCrisisBaseline.crudeLossKbd, 'Saudi and Iraqi bypass routes apply');
    assert.deepEqual(
      { basis: r.currentFlows.basis, from: r.currentFlows.fromMonth, to: r.currentFlows.toMonth, share: r.currentFlows.gulfCrudeShare },
      { basis: 'national_monthly', from: '2026-06', to: '2026-08', share: 0.241 },
    );
    assert.match(line(r, /^Gulf crude share \(headline/), /EPDK monthly crude import volume share \(tonnes\) 2025-02\.\.2026-01 \(12 of 12 months\)/);
    assert.match(line(r, /^Current flows:/), /EPDK monthly crude import volume share \(tonnes\) 2026-06\.\.2026-08: 24\.1% Gulf.*EPDK records origin, not route/);
    assert.equal(line(r, /Crude import origin share unavailable/), undefined);
  });

  it('withholds current flows from a carried-forward national section and says so', async (t) => {
    t.after(restore);
    seed(tr({ national: nationalSection({ status: 'unavailable', carriedForward: true }) }));
    const r = await shock();
    assert.equal(r.preCrisisBaseline.basis, 'national_monthly');
    assert.equal(r.currentFlows, undefined);
    assert.match(line(r, /^Current flows unavailable for TR/), /the latest monthly EPDK fetch failed/);
    assert.match(line(r, /crude origin data is carried forward/), /^Monthly EPDK crude origin data is carried forward from the 2026-10-21 fetch/);
  });

  it('without the national section Turkey stays unmodeled, never filled', async (t) => {
    t.after(restore);
    seed(tr({ national: null }));
    const r = await shock();
    assert.equal(r.comtradeCoverage, false);
    assert.equal(r.gulfCrudeShare, 0);
    assert.match(line(r, /Crude import origin share unavailable for TR/), /no UN Comtrade partner-level crude/);
  });

  it('an importer with Comtrade filings keeps Comtrade even when a national series exists', async (t) => {
    t.after(restore);
    const jpFromComtrade = comtradeSection.importers.JP;
    assert.ok(jpFromComtrade, 'fixture: Japan files monthly to Comtrade');
    const national = nationalSection();
    national.importers = { ...national.importers, JP: { source: 'EPDK', ...national.importers.TR } };
    seed({ ...tr({ national }), 'energy:jodi-oil:v1:JP': { iso2: 'JP', dataMonth: '2026-07', crude: { importsKbd: 2382.2 } } });
    const r = await shock('JP');
    assert.equal(r.preCrisisBaseline.basis, 'comtrade_monthly');
    assert.match(line(r, /^Gulf crude share \(headline/), /UN Comtrade monthly import value share/);
  });

  it('a v15 cache entry from before the national source is not served', async (t) => {
    t.after(restore);
    seed({ ...tr(), 'energy:shock:v15:TR:hormuz_strait:100:l:oil': { countryCode: 'TR', gulfCrudeShare: 0, limitations: [] } });
    const r = await shock();
    assert.equal(r.gulfCrudeShare, 0.235);
  });
});
