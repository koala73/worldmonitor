import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { computeRankings } from '../scripts/seed-wb-indicators.mjs';
import wbTechProjection from '../scripts/_wb-tech-readiness-projection.cjs';

const { buildWorldBankTechObservations } = wbTechProjection;

describe('World Bank technology readiness provenance', () => {
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

  it('uses one observation projection for both World Bank writers', () => {
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
    assert.match(relaySource, /require\('\.\/_wb-tech-readiness-projection\.cjs'\)/);
    assert.match(relaySource, /const observations = buildWorldBankTechObservations\(/);
    assert.match(relaySource, /scores\.push\(\{[^}]*components, observations \}\)/);
  });
});
