import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import wholeIndexFixture from './fixtures/resilience-whole-index-pairs-2026-08-13.json' with { type: 'json' };
import { scoreAllDimensions, type ResilienceSeedReader } from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import { buildDimensionList, buildDomainList, penalizedPillarScore } from '../server/worldmonitor/resilience/v1/_shared.ts';
import { buildPillarList } from '../server/worldmonitor/resilience/v1/_pillar-membership.ts';

const fixture = wholeIndexFixture as typeof wholeIndexFixture & {
  __fixture: { countries: string[] };
};
const fixturePayload: Record<string, unknown> = Object.fromEntries(Object.entries(fixture));
const FROZEN_META_FETCHED_AT = Date.parse('2026-08-29T00:00:00.000Z');
const originalEnvironment = {
  education: process.env.RESILIENCE_EDUCATION_ENABLED,
  financialSystemExposure: process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED,
  pillarCombine: process.env.RESILIENCE_PILLAR_COMBINE_ENABLED,
  energyV2: process.env.RESILIENCE_ENERGY_V2_ENABLED,
};

function restoreEnvironmentValue(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function techReadiness(addObservations: boolean): unknown {
  return {
    countries: Object.fromEntries(fixture.__fixture.countries.map((countryCode, index) => [countryCode, {
      score: 40 + index,
      rank: index + 1,
      components: { internet: 50, mobile: 60, broadband: 40, rdSpend: 30 },
      ...(addObservations ? {
        observations: {
          internet: { value: 80, year: 2024, unit: 'percent', indicatorCode: 'IT.NET.USER.ZS', source: 'World Bank WDI' },
        },
      } : {}),
    }])),
  };
}

function createReader(withScorecardFields: boolean): ResilienceSeedReader {
  return async (key) => {
    if (key === 'economic:worldbank-techreadiness:v1') return techReadiness(withScorecardFields);
    let value = fixturePayload[key];
    if (withScorecardFields && key.startsWith('energy:mix:v1:') && value && typeof value === 'object') {
      value = { ...value, primaryEnergyConsumptionTwh: 1_000 };
    }
    if (!key.startsWith('seed-meta:')) return value ?? null;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { ...value, fetchedAt: FROZEN_META_FETCHED_AT }
      : null;
  };
}

async function frozenCriBytes(reader: ResilienceSeedReader): Promise<{ countryScores: string; ranking: string }> {
  const countries = [];
  for (const countryCode of fixture.__fixture.countries) {
    const scoreMap = await scoreAllDimensions(countryCode, reader);
    const dimensions = buildDimensionList(scoreMap);
    const domains = buildDomainList(dimensions);
    const pillars = buildPillarList(domains, true);
    countries.push({
      countryCode,
      overallScore: penalizedPillarScore(pillars.map(({ score, weight }) => ({ score, weight }))),
      dimensions,
    });
  }
  const ranking = countries
    .map(({ countryCode, overallScore }) => ({ countryCode, overallScore }))
    .sort((left, right) => right.overallScore - left.overallScore || left.countryCode.localeCompare(right.countryCode));
  return {
    countryScores: JSON.stringify(countries),
    ranking: JSON.stringify(ranking),
  };
}

before(() => {
  process.env.RESILIENCE_EDUCATION_ENABLED = 'true';
  process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED = 'false';
  process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'true';
  process.env.RESILIENCE_ENERGY_V2_ENABLED = 'false';
});

after(() => {
  restoreEnvironmentValue('RESILIENCE_EDUCATION_ENABLED', originalEnvironment.education);
  restoreEnvironmentValue('RESILIENCE_FIN_SYS_EXPOSURE_ENABLED', originalEnvironment.financialSystemExposure);
  restoreEnvironmentValue('RESILIENCE_PILLAR_COMBINE_ENABLED', originalEnvironment.pillarCombine);
  restoreEnvironmentValue('RESILIENCE_ENERGY_V2_ENABLED', originalEnvironment.energyV2);
});

describe('five-factor scorecard CRI isolation', () => {
  // This is an ISOLATION control, not a non-regression baseline: both sides run
  // the same live scorer, so a defect in the shared CRI code moves them together
  // and passes. It proves the scorecard's additions to shared seed keys do not
  // perturb CRI -- nothing more. Claims of "byte-identical CRI scores" must not
  // lean on it; that would need a checked-in golden fixture.
  it('keeps CRI country scores and ranking bytes identical when source-safe scorecard fields are added', async () => {
    const beforeBytes = await frozenCriBytes(createReader(false));
    const afterBytes = await frozenCriBytes(createReader(true));
    assert.equal(afterBytes.countryScores, beforeBytes.countryScores);
    assert.equal(afterBytes.ranking, beforeBytes.ranking);
    assert.ok(fixture.__fixture.countries.length >= 10, 'the frozen cohort must cover an approximately ten-country hand-check scale');
  });
});
