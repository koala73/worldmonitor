import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

async function loadCountryInstability(caseId: string) {
  return import(`../src/services/country-instability.ts?${caseId}`);
}

describe('frontend CII closeout regressions', () => {
  it('frontend sanctions ingestion accumulates duplicate ISO2 rows', async () => {
    const cii = await loadCountryInstability('sanctions');

    cii.ingestSanctionsForCII([
      { countryCode: 'US', entryCount: 60, newEntryCount: 1 },
      { countryCode: 'US', entryCount: 60, newEntryCount: 0 },
    ]);

    const data = cii.getCountryData('US');
    assert.equal(data?.sanctionsEntryCount, 120);
    assert.equal(data?.sanctionsNewEntryCount, 1);
  });

  it('frontend climate fallback maps producer zones into CII country stress', async () => {
    const cii = await loadCountryInstability('climate-producer-zones');

    cii.ingestClimateForCII([
      { zone: 'California', severity: 'extreme' },
      { zone: 'Amazon', severity: 'moderate' },
      { zone: 'Taiwan Strait', severity: 'extreme' },
      { zone: 'Caribbean', severity: 'moderate' },
      { zone: 'Europe', severity: 'extreme' },
      { zone: 'East Asia', severity: 'extreme' },
      { zone: 'Latin America', severity: 'moderate' },
    ]);

    assert.equal(cii.getCountryData('US')?.climateStress, 15);
    assert.equal(cii.getCountryData('BR')?.climateStress, 8);
    assert.equal(cii.getCountryData('TW')?.climateStress, 15);
    assert.equal(cii.getCountryData('CN')?.climateStress, 15);
    assert.equal(cii.getCountryData('MX')?.climateStress, 8);
    assert.equal(cii.getCountryData('CU')?.climateStress, 8);
    assert.equal(cii.getCountryData('PL')?.climateStress, 15);
    assert.equal(cii.getCountryData('DE')?.climateStress, 15);
    assert.equal(cii.getCountryData('FR')?.climateStress, 15);
    assert.equal(cii.getCountryData('GB')?.climateStress, 15);
    assert.equal(cii.getCountryData('UA')?.climateStress, 15);
    assert.equal(cii.getCountryData('TR')?.climateStress, 15);
    assert.equal(cii.getCountryData('KP')?.climateStress, 15);
    assert.equal(cii.getCountryData('KR')?.climateStress, 15);
    assert.equal(cii.getCountryData('JP')?.climateStress, 15);
    assert.equal(cii.getCountryData('VE')?.climateStress, 8);
  });

  it('frontend climate fallback accepts backend-named CII climate zones', async () => {
    const cii = await loadCountryInstability('climate-backend-zones');

    cii.ingestClimateForCII([
      { zone: 'North America', severity: 'moderate' },
      { zone: 'Russia', severity: 'extreme' },
      { zone: 'North Africa', severity: 'moderate' },
      { zone: 'South Asia', severity: 'extreme' },
    ]);

    assert.equal(cii.getCountryData('US')?.climateStress, 8);
    assert.equal(cii.getCountryData('RU')?.climateStress, 15);
    assert.equal(cii.getCountryData('EG')?.climateStress, 8);
    assert.equal(cii.getCountryData('MM')?.climateStress, 15);
  });

});
