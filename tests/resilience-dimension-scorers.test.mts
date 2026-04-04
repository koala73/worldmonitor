import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RESILIENCE_DIMENSION_ORDER,
  scoreAllDimensions,
  scoreBorderSecurity,
  scoreCurrencyExternal,
  scoreCyberDigital,
  scoreEnergy,
  scoreFoodWater,
  scoreGovernanceInstitutional,
  scoreHealthPublicService,
  scoreInformationCognitive,
  scoreInfrastructure,
  scoreLogisticsSupply,
  scoreMacroFiscal,
  scoreSocialCohesion,
  scoreTradeSanctions,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import { RESILIENCE_FIXTURES, fixtureReader } from './helpers/resilience-fixtures.mts';

async function scoreTriple(
  scorer: (countryCode: string, reader?: (key: string) => Promise<unknown | null>) => Promise<{ score: number; coverage: number }>,
) {
  const [no, us, ye] = await Promise.all([
    scorer('NO', fixtureReader),
    scorer('US', fixtureReader),
    scorer('YE', fixtureReader),
  ]);
  return { no, us, ye };
}

function assertOrdered(label: string, no: number, us: number, ye: number) {
  assert.ok(no > us, `${label}: expected NO (${no}) > US (${us})`);
  assert.ok(us > ye, `${label}: expected US (${us}) > YE (${ye})`);
}

describe('resilience dimension scorers', () => {
  it('produce plausible country ordering for the economic dimensions', async () => {
    const macro = await scoreTriple(scoreMacroFiscal);
    const currency = await scoreTriple(scoreCurrencyExternal);
    const trade = await scoreTriple(scoreTradeSanctions);

    assertOrdered('macroFiscal', macro.no.score, macro.us.score, macro.ye.score);
    assertOrdered('currencyExternal', currency.no.score, currency.us.score, currency.ye.score);
    assertOrdered('tradeSanctions', trade.no.score, trade.us.score, trade.ye.score);
  });

  it('produce plausible country ordering for infrastructure and energy', async () => {
    const cyber = await scoreTriple(scoreCyberDigital);
    const logistics = await scoreTriple(scoreLogisticsSupply);
    const infrastructure = await scoreTriple(scoreInfrastructure);
    const energy = await scoreTriple(scoreEnergy);

    assertOrdered('cyberDigital', cyber.no.score, cyber.us.score, cyber.ye.score);
    assertOrdered('logisticsSupply', logistics.no.score, logistics.us.score, logistics.ye.score);
    assertOrdered('infrastructure', infrastructure.no.score, infrastructure.us.score, infrastructure.ye.score);
    assertOrdered('energy', energy.no.score, energy.us.score, energy.ye.score);
  });

  it('produce plausible country ordering for social, governance, health, and food dimensions', async () => {
    const governance = await scoreTriple(scoreGovernanceInstitutional);
    const social = await scoreTriple(scoreSocialCohesion);
    const border = await scoreTriple(scoreBorderSecurity);
    const information = await scoreTriple(scoreInformationCognitive);
    const health = await scoreTriple(scoreHealthPublicService);
    const foodWater = await scoreTriple(scoreFoodWater);

    assertOrdered('governanceInstitutional', governance.no.score, governance.us.score, governance.ye.score);
    assertOrdered('socialCohesion', social.no.score, social.us.score, social.ye.score);
    assertOrdered('borderSecurity', border.no.score, border.us.score, border.ye.score);
    assertOrdered('informationCognitive', information.no.score, information.us.score, information.ye.score);
    assertOrdered('healthPublicService', health.no.score, health.us.score, health.ye.score);
    assertOrdered('foodWater', foodWater.no.score, foodWater.us.score, foodWater.ye.score);
  });

  it('returns all 13 dimensions with bounded scores and coverage', async () => {
    const dimensions = await scoreAllDimensions('US', fixtureReader);

    assert.deepEqual(Object.keys(dimensions).sort(), [...RESILIENCE_DIMENSION_ORDER].sort());
    for (const dimensionId of RESILIENCE_DIMENSION_ORDER) {
      const result = dimensions[dimensionId];
      assert.ok(result.score >= 0 && result.score <= 100, `${dimensionId} score out of bounds: ${result.score}`);
      assert.ok(result.coverage >= 0 && result.coverage <= 1, `${dimensionId} coverage out of bounds: ${result.coverage}`);
    }
  });

  it('memoizes repeated seed reads inside scoreAllDimensions', async () => {
    const hits = new Map<string, number>();
    const countingReader = async (key: string) => {
      hits.set(key, (hits.get(key) ?? 0) + 1);
      return RESILIENCE_FIXTURES[key] ?? null;
    };

    await scoreAllDimensions('US', countingReader);

    for (const [key, count] of hits.entries()) {
      assert.equal(count, 1, `expected ${key} to be read once, got ${count}`);
    }
  });
});
