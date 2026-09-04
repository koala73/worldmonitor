import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatDemographicsObservation,
  summarizeDemographicsSources,
} from '../src/components/demographics-capability-view-model.ts';

describe('demographics capability country view', () => {
  it('formats a valid observation with its own unit and observation year', () => {
    assert.equal(formatDemographicsObservation({
      available: true,
      value: 45.6901895449157,
      year: 2026,
      source: 'UN World Population Prospects 2024',
      unit: 'years',
    }, 'Not available'), '45.7 years · 2026');

    assert.equal(formatDemographicsObservation({
      available: true,
      value: 51_775_142,
      year: 2026,
      source: 'UN World Population Prospects 2024',
      unit: 'people',
    }, 'Not available'), '51,775,142 · 2026');

    assert.equal(formatDemographicsObservation({
      available: true,
      value: 8200,
      year: 2024,
      source: 'World Bank WDI',
      unit: 'people per million',
    }, 'Not available'), '8,200 / 10⁶ · 2024');
  });

  it('does not present proto zero defaults as real data', () => {
    assert.equal(formatDemographicsObservation({
      available: false,
      value: 0,
      year: 0,
      source: '',
      unit: '',
    }, 'Not available'), 'Not available');
  });

  it('keeps independent source attribution without duplicates', () => {
    assert.equal(summarizeDemographicsSources([
      { available: true, value: 60, year: 2024, source: 'UNESCO UIS via World Bank WDI', unit: 'percent' },
      { available: true, value: 23, year: 2023, source: 'UNESCO UIS via World Bank WDI', unit: 'percent' },
      { available: true, value: 8200, year: 2022, source: 'World Bank WDI', unit: 'people per million' },
      { available: false, value: 0, year: 0, source: 'Hidden source', unit: '' },
    ]), 'UNESCO UIS via World Bank WDI; World Bank WDI');
  });
});
