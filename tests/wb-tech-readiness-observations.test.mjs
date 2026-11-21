import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { computeRankings } from '../scripts/seed-wb-indicators.mjs';
import wbTechProjection from '../scripts/_wb-tech-readiness-projection.cjs';

const { buildWorldBankTechObservations } = wbTechProjection;

describe('World Bank technology readiness provenance', () => {
  it('ranks entries with at least three observations and keeps sparse source data', () => {
    const observation = (value) => ({ value, year: 2024 });
    const rankings = computeRankings({
      internet: { KOR: observation(97.9), MCO: observation(99), LOW: observation(0), TWO: observation(100) },
      mobile: { SXM: observation(205.37), KOR: observation(172.52), MCO: observation(107.4), LOW: observation(0), TWO: observation(150) },
      broadband: { KOR: observation(47.8), MCO: observation(55.68), LOW: observation(0) },
      rdSpend: { KOR: observation(4.94352) },
    });

    assert.deepEqual(rankings.slice(0, 3).map(({ country, score, rank, componentCount }) =>
      [country, score, rank, componentCount]), [
      ['KOR', 98.1, 1, 4],
      ['MCO', 93, 2, 3],
      ['LOW', 0, 3, 3],
    ]);
    const sxm = rankings.find(({ country }) => country === 'SXM');
    assert.equal(sxm.score, null);
    assert.equal(sxm.rank, null);
    assert.equal(sxm.componentCount, 1);
    assert.equal(sxm.observations.mobile.value, 205.37);
    const two = rankings.find(({ country }) => country === 'TWO');
    assert.equal(two.componentCount, 2);
    assert.equal(two.score, null);
    assert.equal(two.rank, null);
  });

  it('adds source observations without changing score, rank, or normalized components', () => {
    const rankings = computeRankings({
      internet: {
        USA: { value: 97, year: 2023, name: 'United States' },
        DEU: { value: 93, year: 2022, name: 'Germany' },
      },
      mobile: {
        USA: { value: 110, year: 2023, name: 'United States' },
        DEU: { value: 120, year: 2022, name: 'Germany' },
      },
      broadband: {
        USA: { value: 38, year: 2023, name: 'United States' },
        DEU: { value: 45, year: 2022, name: 'Germany' },
      },
      rdSpend: {
        USA: { value: 3.5, year: 2022, name: 'United States' },
        DEU: { value: 3.1, year: 2022, name: 'Germany' },
      },
    });

    const us = rankings.find((entry) => entry.country === 'USA');
    assert.deepEqual(
      { score: us.score, rank: us.rank, components: us.components },
      {
        score: 79.8,
        rank: 1,
        components: {
          internet: 97,
          mobile: 73.33333333333333,
          broadband: 76,
          rdSpend: 70,
        },
      },
    );
    assert.deepEqual(us.observations, {
      internet: { value: 97, year: 2023, unit: 'percent', indicatorCode: 'IT.NET.USER.ZS', source: 'World Bank' },
      mobile: { value: 110, year: 2023, unit: 'per 100 people', indicatorCode: 'IT.CEL.SETS.P2', source: 'World Bank' },
      broadband: { value: 38, year: 2023, unit: 'per 100 people', indicatorCode: 'IT.NET.BBND.P2', source: 'World Bank' },
      rdSpend: { value: 3.5, year: 2022, unit: 'percent of GDP', indicatorCode: 'GB.XPD.RSDV.GD.ZS', source: 'World Bank' },
    });
  });

  it('uses null for an unavailable source observation', () => {
    const [entry] = computeRankings({
      internet: { JPN: { value: 86, year: 2023, name: 'Japan' } },
      mobile: {},
      broadband: {},
      rdSpend: {},
    });
    assert.equal(entry.observations.mobile, null);
    assert.equal(entry.observations.broadband, null);
    assert.equal(entry.observations.rdSpend, null);
    assert.equal(buildWorldBankTechObservations({ mobile: { value: null, year: 2023 } }).mobile, null);
  });

  it('uses one ranking and observation projection for both World Bank writers', () => {
    const input = {
      internet: { value: 91, year: 2023 },
      mobile: { value: 120, year: 2022 },
      broadband: null,
      rdSpend: { value: 2.4, year: 2021 },
    };
    const [entry] = computeRankings({
      internet: { USA: { ...input.internet, name: 'United States' } },
      mobile: { USA: { ...input.mobile, name: 'United States' } },
      broadband: {},
      rdSpend: { USA: { ...input.rdSpend, name: 'United States' } },
    });
    assert.deepEqual(entry.observations, buildWorldBankTechObservations(input));
    const relaySource = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
    assert.equal(computeRankings, wbTechProjection.computeWorldBankTechRankings);
    assert.match(relaySource, /\{ computeWorldBankTechRankings: wbComputeRankings \} = require\('\.\/_wb-tech-readiness-projection\.cjs'\)/);
    assert.match(relaySource, /const rankings = wbComputeRankings\(indicatorData\)/);
  });
});
