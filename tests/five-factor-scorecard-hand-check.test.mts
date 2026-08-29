import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import handCheck from './fixtures/five-factor-scorecard-hand-check-v1.json' with { type: 'json' };
import { SCORECARD_INPUT_REGISTRY } from '../server/worldmonitor/scorecard/v1/_input-registry.ts';
import { scoreCountry } from '../server/worldmonitor/scorecard/v1/_score-country.ts';
import { SCORECARD_PILLARS, type CountryScorecardEvidence, type ScorecardEvidence, type ScorecardInputId } from '../server/worldmonitor/scorecard/v1/_types.ts';

function rawValueAtAnchor(inputId: ScorecardInputId, anchor: number): number {
  const { worst, best, kind } = SCORECARD_INPUT_REGISTRY[inputId].normalization;
  const fraction = anchor / 100;
  if (kind === 'log') {
    return 10 ** (Math.log10(worst) + (Math.log10(best) - Math.log10(worst)) * fraction);
  }
  return worst + (best - worst) * fraction;
}

function anchorCountry(countryCode: string, anchor: number): CountryScorecardEvidence {
  const inputs = Object.fromEntries((Object.keys(SCORECARD_INPUT_REGISTRY) as ScorecardInputId[]).map((inputId) => {
    const definition = SCORECARD_INPUT_REGISTRY[inputId];
    const evidence: ScorecardEvidence = inputId === 'defense.supplierDiversity'
      ? {
        availability: 'unavailable', inputId, reason: 'redistribution-blocked',
        source: 'SIPRI Arms Transfers Database', sourceKey: definition.sourceKey,
      }
      : {
        availability: 'available', inputId, value: rawValueAtAnchor(inputId, anchor),
        year: 2024, unit: definition.unit, source: 'Frozen hand-check anchor',
        sourceKey: definition.sourceKey, quality: 'observed', observations: [],
      };
    return [inputId, evidence];
  })) as CountryScorecardEvidence['inputs'];
  return { countryCode, population: inputs.population, inputs };
}

describe('five-factor scorecard ten-country hand check', () => {
  it('matches the independently frozen anchor table for every pillar', () => {
    assert.equal(handCheck.methodologyVersion, '1.0.0');
    assert.equal(handCheck.countries.length, 10);
    for (const anchor of handCheck.countries) {
      const result = scoreCountry(anchorCountry(anchor.countryCode, anchor.normalizedAnchor));
      for (const pillarId of SCORECARD_PILLARS) {
        const pillar = result.pillars[pillarId];
        assert.equal(pillar.hasScore, true, `${anchor.countryCode} ${pillarId} should be scoreable`);
        assert.equal(pillar.score, anchor.expectedBand, `${anchor.countryCode} ${pillarId} band drift`);
        assert.ok(Math.abs(pillar.subScore! - anchor.normalizedAnchor) < 0.01,
          `${anchor.countryCode} ${pillarId} continuous score drift: ${pillar.subScore}`);
      }
    }
  });
});
