// Hormuz LNG exposure from measured supplier shares.
//
// Before this change the gas model assumed 30% of every importer's LNG transits
// Hormuz (`modelBasis: assumed_route_sensitivity`). The shares here come from
// UN Comtrade HS 271111 partner rows (the responses recorded on 2026-10-28,
// run through the seeder's own builder) and the JODI gas observations read
// from production the same day.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { computeEnergyShockScenario } from '../server/worldmonitor/intelligence/v1/compute-energy-shock.ts';
import { CHOKEPOINT_LNG_EXPOSURE, computeGasDisruption } from '../server/worldmonitor/intelligence/v1/_shock-compute.ts';
import { buildLngOriginShares, parseLngRows, LNG_HORMUZ_SHARE_KEY } from '../scripts/shared/comtrade-lng-origin.mjs';
import { normalizeComtradePartner } from '../scripts/shared/comtrade.mjs';
import { installRedis } from './helpers/fake-upstash-redis.mts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN, localApiMode: process.env.LOCAL_API_MODE };
function restore() {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const [name, value] of [['UPSTASH_REDIS_REST_URL', ORIGINAL_ENV.url], ['UPSTASH_REDIS_REST_TOKEN', ORIGINAL_ENV.token], ['LOCAL_API_MODE', ORIGINAL_ENV.localApiMode]]) {
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
}
function install(seed) {
  installRedis(seed);
  delete process.env.LOCAL_API_MODE;
}
const shock = (request) => computeEnergyShockScenario({}, request);

const fixture = (name) => parseLngRows(JSON.parse(readFileSync(
  new URL(`./fixtures/energy-shock/comtrade-lng-271111-${name}-2026-10-28.json`, import.meta.url), 'utf8')));
const RECORDED_SNAPSHOT = {
  fetchedAt: '2026-10-28T09:00:00.000Z',
  source: 'UN Comtrade data API',
  ...buildLngOriginShares(
    { annual: fixture('annual'), preCrisis: fixture('pre-crisis'), current: fixture('current') },
    {
      reporterIso2: (code) => ({ 490: 'TW', 381: 'IT' })[code] ?? normalizeComtradePartner(code).iso2,
      partnerKind: (code) => normalizeComtradePartner(code).kind,
    },
  ),
};

// Production `energy:jodi-gas:v1:{iso2}` on 2026-10-28. China has no JODI gas row.
const JODI_GAS = {
  JP: { dataMonth: '2026-07', lngImportsTj: 274197, totalDemandTj: 299947, lngShareOfImports: 1 },
  KR: { dataMonth: '2026-07', lngImportsTj: 193604, totalDemandTj: 115795, lngShareOfImports: 1 },
  IN: { dataMonth: '2026-03', lngImportsTj: 111255.81, totalDemandTj: 185285.09, lngShareOfImports: 1 },
  DE: { dataMonth: '2026-07', lngImportsTj: 25135, totalDemandTj: 137779, lngShareOfImports: 0.0919 },
};
const HORMUZ_RED = { 'energy:chokepoint-flows:v1': { hormuz_strait: { currentMbd: 12.7, baselineMbd: 21, flowRatio: 0.606 }, malacca_strait: { flowRatio: 1.08 } } };
const seedFor = (iso2, snapshot = RECORDED_SNAPSHOT) => ({
  ...HORMUZ_RED,
  ...(snapshot ? { [LNG_HORMUZ_SHARE_KEY]: snapshot } : {}),
  ...(JODI_GAS[iso2] ? { [`energy:jodi-gas:v1:${iso2}`]: JODI_GAS[iso2] } : {}),
});
const round1 = (v) => Math.round(v * 10) / 10;
const gasRequest = (countryCode, disruptionPct = 100) => ({ countryCode, chokepointId: 'hormuz_strait', disruptionPct, fuelMode: 'gas' });

describe('Hormuz LNG exposure uses measured Comtrade supplier shares', () => {
  it('Japan: pre-crisis monthly 6.4% drives the headline; current flows 0.4% is reported beside it', async (t) => {
    t.after(restore);
    install(seedFor('JP'));
    const r = await shock(gasRequest('JP'));
    const g = r.gasSensitivity;

    assert.equal(g.modelBasis, 'comtrade_lng_origin_share');
    assert.deepEqual(g.preCrisisBaseline, {
      basis: 'comtrade_monthly', fromMonth: '2025-02', toMonth: '2026-01', monthsCovered: 12,
      hormuzLngShare: 0.064, lngDisruptionTj: round1(274197 * 0.064),
    });
    assert.deepEqual(g.currentFlows, {
      basis: 'comtrade_monthly', fromMonth: '2026-06', toMonth: '2026-08', monthsCovered: 3,
      hormuzLngShare: 0.0044, lngDisruptionTj: round1(274197 * 0.0044),
    });
    // The headline fields equal the pre-crisis baseline.
    assert.equal(g.lngDisruptionTj, g.preCrisisBaseline.lngDisruptionTj);
    assert.equal(g.deficitPct, round1(274197 * 0.064 / 299947 * 100));
    assert.ok(g.lngDisruptionTj < 274197 * 0.30 / 4, 'the 30% assumption overstated Japan about fivefold');

    assert.match(r.assessment, /pre-crisis/);
    assert.match(r.assessment, /2025-02 to 2026-01/);
    assert.match(r.assessment, /current flows/);
    assert.match(r.assessment, /2026-06 to 2026-08/);
    assert.match(r.assessment, /not a supply-shortage forecast/);
    assert.doesNotMatch(r.assessment, /assum/i);
    const origin = r.limitations.find((l) => l.startsWith('LNG Hormuz share'));
    assert.ok(origin, r.limitations.join('\n'));
    assert.match(origin, /UN Comtrade HS 271111/);
    assert.match(origin, /Qatar and the UAE/);
    assert.match(origin, /Oman/);
    assert.match(origin, /6\.4% by weight/);
    assert.match(origin, /0\.4% by weight/);
    assert.match(origin, /JODI LNG imports for 2026-07/);
    assert.ok(!r.limitations.some((l) => /assumed route|30%/.test(l)), r.limitations.join('\n'));
    assert.equal(r.dataAvailable, true);
    assert.equal(r.coverageLevel, 'partial');
  });

  it('Korea: annual 2025 pre-crisis share where the monthly window is incomplete; no current flows', async (t) => {
    t.after(restore);
    install(seedFor('KR'));
    const g = (await shock(gasRequest('KR'))).gasSensitivity;
    assert.deepEqual(
      [g.preCrisisBaseline.basis, g.preCrisisBaseline.fromMonth, g.preCrisisBaseline.toMonth, g.preCrisisBaseline.hormuzLngShare],
      ['comtrade_annual', '2025-01', '2025-12', 0.1545],
    );
    assert.equal(g.currentFlows, undefined, 'a missing baseline is absent, never zero');
    const r = await shock(gasRequest('KR'));
    assert.ok(r.limitations.some((l) => /Current-flows LNG share unavailable for KR/.test(l)), r.limitations.join('\n'));
    assert.match(r.assessment, /current-flows share unavailable/);
  });

  it('India: pre-crisis 58.2% and current flows 16.1% (2026-05 to 2026-07) against the 30% assumption', async (t) => {
    t.after(restore);
    install(seedFor('IN'));
    const g = (await shock(gasRequest('IN'))).gasSensitivity;
    assert.equal(g.preCrisisBaseline.hormuzLngShare, 0.5824);
    assert.equal(g.currentFlows.hormuzLngShare, 0.1612);
    assert.deepEqual([g.currentFlows.fromMonth, g.currentFlows.toMonth], ['2026-05', '2026-07']);
    assert.equal(g.lngDisruptionTj, round1(111255.81 * 0.5824));
    assert.ok(g.lngDisruptionTj > 111255.81 * 0.30, 'the 30% assumption understated India');
  });

  it('China: the measured share exists but JODI has no gas row, so gas stays unavailable for that reason', async (t) => {
    t.after(restore);
    install(seedFor('CN'));
    const r = await shock(gasRequest('CN'));
    assert.equal(r.gasSensitivity, undefined);
    assert.equal(r.dataAvailable, false);
    assert.match(r.assessment, /Insufficient gas import data for CN/);
    assert.ok(!r.limitations.some((l) => /LNG origin share unavailable/.test(l)), 'the origin share is not the missing input');
  });

  it('Germany: Comtrade books every LNG import to unspecified partners, so the share is unavailable, not 30%', async (t) => {
    t.after(restore);
    install(seedFor('DE'));
    const r = await shock(gasRequest('DE'));
    assert.equal(r.gasSensitivity, undefined);
    assert.equal(r.dataAvailable, false);
    assert.equal(r.coverageLevel, 'unsupported');
    assert.equal(r.assessment, 'LNG origin share unavailable for DE; Strait of Hormuz LNG exposure is not modeled.');
    const reason = r.limitations.find((l) => l.startsWith('LNG origin share unavailable for DE'));
    assert.match(reason, /unspecified partners/);
    assert.ok(!r.limitations.some((l) => /Insufficient gas measurements/.test(l)), 'the JODI measurements are fine');
  });

  it('a missing snapshot (seeder not yet run) reports the origin share unavailable instead of assuming 30%', async (t) => {
    t.after(restore);
    install(seedFor('JP', null));
    const r = await shock(gasRequest('JP'));
    assert.equal(r.gasSensitivity, undefined);
    assert.match(r.assessment, /LNG origin share unavailable for JP/);
    assert.ok(r.limitations.some((l) => /LNG origin share unavailable for JP: the UN Comtrade LNG origin snapshot is unavailable/.test(l)), r.limitations.join('\n'));
  });

  it('a reporter absent from the snapshot is unavailable with its own reason', async (t) => {
    t.after(restore);
    install({ ...seedFor('JP'), [LNG_HORMUZ_SHARE_KEY]: { ...RECORDED_SNAPSHOT, countries: {} } });
    const r = await shock(gasRequest('JP'));
    assert.ok(r.limitations.some((l) => /LNG origin share unavailable for JP: no UN Comtrade LNG \(HS 271111\) import rows/.test(l)), r.limitations.join('\n'));
  });

  for (const [label, preCrisis] of [
    ['a share above 1', { basis: 'comtrade_monthly', fromMonth: '2025-02', toMonth: '2026-01', monthsCovered: 12, share: 1.5 }],
    ['an unknown basis', { basis: 'guess', fromMonth: '2025-02', toMonth: '2026-01', monthsCovered: 12, share: 0.2 }],
    ['a malformed month', { basis: 'comtrade_monthly', fromMonth: '2025-2', toMonth: '2026-01', monthsCovered: 12, share: 0.2 }],
    ['a string share', { basis: 'comtrade_monthly', fromMonth: '2025-02', toMonth: '2026-01', monthsCovered: 12, share: '0.2' }],
  ]) {
    it(`treats ${label} in the snapshot as unavailable`, async (t) => {
      t.after(restore);
      install({ ...seedFor('JP'), [LNG_HORMUZ_SHARE_KEY]: { ...RECORDED_SNAPSHOT, countries: { JP: { preCrisis, current: null } } } });
      const r = await shock(gasRequest('JP'));
      assert.equal(r.gasSensitivity, undefined);
      assert.match(r.assessment, /LNG origin share unavailable for JP/);
    });
  }

  it('a current-flows share alone drives the loss, labelled as such, when the pre-crisis share is unavailable', async (t) => {
    // Azerbaijan is the one importer in the 2026-10-28 snapshot with current
    // flows and no pre-crisis share; Japan's inputs stand in for it here.
    t.after(restore);
    const current = { basis: 'comtrade_monthly', fromMonth: '2026-06', toMonth: '2026-08', monthsCovered: 3, share: 0.0044, measure: 'weight', unattributedShare: 0 };
    install({ ...seedFor('JP'), [LNG_HORMUZ_SHARE_KEY]: { countries: { JP: { preCrisis: null, preCrisisUnavailable: 'no_rows', current } } } });
    const r = await shock(gasRequest('JP'));
    const g = r.gasSensitivity;
    assert.equal(g.modelBasis, 'comtrade_lng_origin_share');
    assert.equal(g.preCrisisBaseline, undefined, 'the unavailable baseline stays absent');
    assert.equal(g.currentFlows.hormuzLngShare, 0.0044);
    assert.equal(g.lngDisruptionTj, g.currentFlows.lngDisruptionTj, 'the headline uses the only measured share');
    assert.match(r.assessment, /pre-crisis share unavailable/);
    assert.match(r.assessment, /at the current-flows share, modeled loss equals/);
    const origin = r.limitations.find((l) => l.startsWith('LNG Hormuz share'));
    assert.match(origin, /Pre-crisis baseline: unavailable \(no UN Comtrade LNG \(HS 271111\) import rows for the window\)/);
    assert.match(origin, /The headline loss applies the current-flows share/);
  });

  it('ignores a stored reason code that names an Object.prototype member', async (t) => {
    t.after(restore);
    install({ ...seedFor('JP'), [LNG_HORMUZ_SHARE_KEY]: { countries: { JP: { preCrisis: null, preCrisisUnavailable: 'toString', current: null, currentUnavailable: 'constructor' } } } });
    const r = await shock(gasRequest('JP'));
    const reason = r.limitations.find((l) => l.startsWith('LNG origin share unavailable for JP'));
    assert.match(reason, /no UN Comtrade LNG \(HS 271111\) import rows for the window/);
    assert.doesNotMatch(r.limitations.join(' '), /native code|function/);
  });

  it('zero recorded LNG imports stay a measured zero loss even without an origin share', async (t) => {
    t.after(restore);
    install({ ...HORMUZ_RED, 'energy:jodi-gas:v1:DE': { dataMonth: '2026-07', lngImportsTj: 0, totalDemandTj: 1000 } });
    const g = (await shock(gasRequest('DE'))).gasSensitivity;
    assert.equal(g.dataAvailable, true);
    assert.equal(g.lngDisruptionTj, 0);
    assert.equal(g.modelBasis, 'observed_zero_lng_imports');
    assert.equal(g.preCrisisBaseline, undefined);
    assert.match(g.assessment, /recorded zero LNG imports/);
  });

  it('the live shipping flow ratio does not scale the measured loss', async (t) => {
    t.after(restore);
    install({ ...seedFor('JP'), 'energy:chokepoint-flows:v1': { hormuz_strait: { flowRatio: 1 } } });
    const calm = (await shock(gasRequest('JP'))).gasSensitivity.lngDisruptionTj;
    install(seedFor('JP'));
    const red = (await shock(gasRequest('JP'))).gasSensitivity.lngDisruptionTj;
    assert.equal(calm, red);
  });

  it('combined mode with neither fuel modeled names the missing LNG origin beside the oil reason', async (t) => {
    t.after(restore);
    install(seedFor('DE'));
    const both = await shock({ ...gasRequest('DE'), fuelMode: 'both' });
    assert.equal(both.dataAvailable, false);
    // The panel shows only the assessment for an unavailable scenario, so the
    // gas reason must be in it, not only in the limitations.
    assert.match(both.assessment, /^Insufficient import data for Germany/, 'the oil reason comes first');
    assert.match(both.assessment, /LNG origin share unavailable for DE; Strait of Hormuz LNG exposure is not modeled\.$/);
  });

  it('combined mode carries the same gas baselines', async (t) => {
    t.after(restore);
    install(seedFor('JP'));
    const both = await shock({ ...gasRequest('JP'), fuelMode: 'both' });
    assert.equal(both.gasSensitivity.preCrisisBaseline.hormuzLngShare, 0.064);
    assert.equal(both.gasSensitivity.currentFlows.hormuzLngShare, 0.0044);
  });

  it('does not reuse a gas response cached by the assumed-route model', async (t) => {
    t.after(restore);
    install({ ...seedFor('JP'), 'energy:shock:v4:JP:hormuz_strait:100:l:gas': { dataAvailable: true, assessment: 'JP gas sensitivity assumes 30% of recorded LNG imports use Strait of Hormuz.' } });
    const r = await shock(gasRequest('JP'));
    assert.doesNotMatch(r.assessment, /assumes 30%/);
    assert.equal(r.gasSensitivity.modelBasis, 'comtrade_lng_origin_share');
  });
});

describe('other chokepoints keep the fixed route sensitivity, labelled as an assumption', () => {
  it('Malacca still uses the 50% assumed route share and says so', async (t) => {
    t.after(restore);
    install(seedFor('JP'));
    const r = await shock({ countryCode: 'JP', chokepointId: 'malacca_strait', disruptionPct: 100, fuelMode: 'gas' });
    assert.equal(r.gasSensitivity.modelBasis, 'assumed_route_sensitivity');
    assert.equal(r.gasSensitivity.lngDisruptionTj, round1(274197 * 0.5));
    assert.equal(r.gasSensitivity.preCrisisBaseline, undefined);
    assert.match(r.assessment, /assumes 50%/);
    assert.ok(r.limitations.some((l) => /assumed route sensitivities/.test(l)));
  });

  it('the Hormuz route fraction is no longer a constant', () => {
    assert.equal(CHOKEPOINT_LNG_EXPOSURE.hormuz_strait, undefined);
    assert.equal(computeGasDisruption(1000, 5000, 'hormuz_strait', 100), undefined, 'no share, no loss');
    assert.deepEqual(computeGasDisruption(1000, 5000, 'hormuz_strait', 100, 0.064), { lngDisruptionTj: 64, deficitPct: 1.3 });
    for (const bad of [-0.1, 1.2, NaN, '0.2']) assert.equal(computeGasDisruption(1000, 5000, 'hormuz_strait', 100, bad), undefined, String(bad));
  });
});
