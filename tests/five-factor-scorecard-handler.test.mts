import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildFiveFactorSnapshot } from '../server/worldmonitor/scorecard/v1/_snapshot';
import { drainResponseHeaders } from '../server/_shared/response-headers';
import { getFiveFactorScorecardWithReader } from '../server/worldmonitor/scorecard/v1/get-five-factor-scorecard';
import { getBlocScorecardWithReader } from '../server/worldmonitor/scorecard/v1/get-bloc-scorecard';
import { listFiveFactorScorecardsWithReader } from '../server/worldmonitor/scorecard/v1/list-five-factor-scorecards';

const ctx = {
  request: new Request('https://example.com/api/scorecard/v1/get-five-factor-scorecard'),
  pathParams: {},
  headers: {},
};

const sources = {
  population: { countries: { US: { populationMillions: 10, year: 2024 }, CA: { populationMillions: 5, year: 2024 } } },
  foodStocks: {
    US: { commodities: { wheat: { marketingYear: '2024/25', production: 120, consumption: 100, exports: 0, endingStocks: 20 } } },
  },
  demographics: null,
  defense: null,
  energyMix: { US: { year: 2024, primaryEnergyConsumptionTwh: 100, importShare: 0 } },
  staticByCountry: { US: {}, CA: {} },
  lowCarbon: { countries: { US: { value: 50, year: 2024 } } },
  powerLosses: { countries: { US: { value: 5, year: 2024 } } },
  importHhi: null,
  techByIso2: null,
};

const snapshot = buildFiveFactorSnapshot(['US', 'CA'], sources, '2026-08-29T00:00:00.000Z');
const reader = async () => snapshot;

describe('five-factor public handlers', () => {
  it('exposes an insufficient-data country with null semantics on the public API path', async () => {
    const response = await getFiveFactorScorecardWithReader(ctx, { countryCode: 'CA' }, reader);
    assert.equal(response.unavailable, false);
    const energy = response.scorecard?.pillars.find((pillar) => pillar.pillar === 'energy');
    assert.equal(energy?.hasScore, false);
    assert.equal(energy?.score, 0);
    assert.equal(energy?.subScore, 0);
    assert.ok(energy?.insufficientReasons.includes('coverage-below-floor'));
    assert.ok(energy?.inputs.some((input) => !input.available && input.unavailableReason === 'country-unavailable'));
  });

  it('returns the same frozen cohort through country, list, and bloc methods', async () => {
    const country = await getFiveFactorScorecardWithReader(ctx, { countryCode: 'us' }, reader);
    const list = await listFiveFactorScorecardsWithReader(ctx, {}, reader);
    const bloc = await getBlocScorecardWithReader(ctx, { preset: '', members: ['US', 'CA'] }, reader);
    assert.equal(country.scorecard?.computedAt, list.computedAt);
    assert.equal(bloc.scorecard?.computedAt, list.computedAt);
    assert.equal(list.scorecards.length, 2);
    assert.deepEqual(bloc.scorecard?.members, ['CA', 'US']);
  });

  it('keeps a requested member that is missing from the snapshot as an explicit bloc exclusion', async () => {
    const bloc = await getBlocScorecardWithReader(ctx, { preset: '', members: ['US', 'CA', 'MX'] }, reader);
    assert.deepEqual(bloc.scorecard?.members, ['CA', 'MX', 'US']);
    assert.deepEqual(bloc.scorecard?.includedMembers, ['CA', 'US']);
    assert.deepEqual(bloc.scorecard?.excludedMembers, [{ countryCode: 'MX', reason: 'country-unavailable' }]);
  });

  it('returns an explicit unavailable response when the atomic snapshot is absent', async () => {
    const response = await getFiveFactorScorecardWithReader(ctx, { countryCode: 'US' }, async () => null);
    assert.deepEqual(response, { unavailable: true, unavailableReason: 'scorecard-snapshot-unavailable' });
  });

  it('returns no-store fallbacks when each reader rejects', async () => {
    const rejectedReader = async () => { throw new Error('Redis unavailable'); };
    const cases = [
      (caseCtx: typeof ctx) => getFiveFactorScorecardWithReader(caseCtx, { countryCode: 'US' }, rejectedReader),
      (caseCtx: typeof ctx) => listFiveFactorScorecardsWithReader(caseCtx, {}, rejectedReader),
      (caseCtx: typeof ctx) => getBlocScorecardWithReader(caseCtx, { preset: '', members: ['US', 'CA'] }, rejectedReader),
    ];
    for (const invoke of cases) {
      const caseCtx = { ...ctx, request: new Request(ctx.request.url) };
      const response = await invoke(caseCtx);
      assert.equal(response.unavailable, true);
      assert.equal(response.unavailableReason, 'scorecard-snapshot-unavailable');
      assert.equal(drainResponseHeaders(caseCtx.request)?.['X-No-Cache'], '1');
    }
  });

  it('returns a no-store fallback when fewer than two requested bloc members exist in the snapshot', async () => {
    const onlyUs = buildFiveFactorSnapshot(['US'], sources, '2026-08-29T00:00:00.000Z');
    const caseCtx = { ...ctx, request: new Request(ctx.request.url) };
    const response = await getBlocScorecardWithReader(caseCtx, { preset: 'USMCA', members: [] }, async () => onlyUs);
    assert.deepEqual(response, { unavailable: true, unavailableReason: 'bloc-members-unavailable' });
    assert.equal(drainResponseHeaders(caseCtx.request)?.['X-No-Cache'], '1');
  });

  it('rejects invalid country and custom bloc requests', async () => {
    await assert.rejects(() => getFiveFactorScorecardWithReader(ctx, { countryCode: 'USA' }, reader), /Validation failed/);
    await assert.rejects(() => getBlocScorecardWithReader(ctx, { preset: '', members: ['US'] }, reader), /Validation failed/);
  });
});
