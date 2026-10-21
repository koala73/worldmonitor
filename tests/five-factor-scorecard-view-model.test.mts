import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildFiveFactorPillarRows,
  formatScorecardEvidence,
} from '../src/components/five-factor-scorecard-view-model.ts';

describe('five-factor scorecard country view model', () => {
  it('renders unavailable pillars as insufficient data and never as zero', () => {
    const rows = buildFiveFactorPillarRows([{
      pillar: 'energy',
      hasScore: false,
      score: 0,
      subScore: 0,
      band: '',
      inputCoverage: 0.4,
      aggregationMethod: 'physical-balance',
      inputs: [],
      insufficientReasons: ['required-input-unavailable', 'coverage-below-floor'],
    }], {
      insufficient: 'Insufficient data',
      score: (value) => `${value}/5`,
      coverage: (value) => `${value}% coverage`,
    });

    assert.deepEqual(rows.map((row) => row.pillar), ['food', 'energy', 'demographics', 'technology', 'defense']);
    const row = rows.find((candidate) => candidate.pillar === 'energy')!;
    assert.equal(row.status, 'insufficient');
    assert.equal(row.scoreLabel, 'Insufficient data');
    assert.equal(row.coverageLabel, '40% coverage');
    assert.ok(!row.scoreLabel.includes('0'));
    assert.deepEqual(row.reasons, ['required-input-unavailable', 'coverage-below-floor']);
  });

  it('keeps source provenance and explicit unavailability reasons visible', () => {
    const available = formatScorecardEvidence({
      inputId: 'technology.connectivity',
      available: true,
      value: 78.25,
      hasValue: true,
      year: 2024,
      unit: 'index',
      source: 'World Bank WDI',
      sourceKey: 'worldbank:tech-readiness:v1',
      unavailableReason: '',
      quality: 'observed',
      observations: [{
        name: 'Individuals using the Internet',
        value: 91.3,
        year: 2024,
        unit: 'percent',
        source: 'World Bank WDI',
        indicatorCode: 'IT.NET.USER.ZS',
      }],
    }, 'Not available');
    const blocked = formatScorecardEvidence({
      inputId: 'defense.supplierDiversity',
      available: false,
      value: 0,
      hasValue: false,
      year: 0,
      unit: '',
      source: 'SIPRI Arms Transfers Database',
      sourceKey: 'military:arms-suppliers:v1',
      unavailableReason: 'redistribution-blocked',
      quality: 'unavailable',
      observations: [],
    }, 'Not available');

    assert.equal(available.valueLabel, '78.3 index · 2024');
    assert.equal(available.provenance, 'World Bank WDI · IT.NET.USER.ZS');
    assert.equal(blocked.valueLabel, 'Not available');
    assert.equal(blocked.unavailableReason, 'redistribution-blocked');
    assert.equal(blocked.provenance, 'SIPRI Arms Transfers Database');
  });
});
