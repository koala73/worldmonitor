import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PRIORITY_COUNTRIES,
  EXPOSURE_CENTROIDS,
  computeBoundedExposure,
  computeExposure,
  getRadiusForEventType,
  listCountryPopulations,
  MAX_EXPOSURE_RADIUS_KM,
} from '../shared/analysis-population-exposure.ts';
import { getPopulationExposure } from '../server/worldmonitor/displacement/v1/get-population-exposure.ts';
import {
  Z_THRESHOLD_LOW,
  Z_THRESHOLD_MEDIUM,
  Z_THRESHOLD_HIGH,
  getBaselineSeverity,
} from '../shared/analysis-temporal-severity.ts';

describe('analysis-population-exposure core', () => {
  it('keeps the priority table and centroids aligned', () => {
    const countryCodes = Object.keys(PRIORITY_COUNTRIES).sort();
    const centroidCodes = Object.keys(EXPOSURE_CENTROIDS).sort();
    assert.deepEqual(countryCodes, centroidCodes);
    assert.equal(countryCodes.length, 20);
    for (const [code, [lat, lon]] of Object.entries(EXPOSURE_CENTROIDS)) {
      assert.ok(lat >= -90 && lat <= 90, `${code} lat in range`);
      assert.ok(lon >= -180 && lon <= 180, `${code} lon in range`);
    }
  });

  it('picks the nearest centroid and applies density * area', () => {
    // Point right on Israel's centroid.
    const exposure = computeExposure(31.0, 34.8, 50);
    assert.equal(exposure.nearestCountry, 'ISR');
    const density = PRIORITY_COUNTRIES.ISR.pop / PRIORITY_COUNTRIES.ISR.area;
    assert.equal(exposure.densityPerKm2, Math.round(density));
    assert.equal(exposure.exposedPopulation, Math.round(density * Math.PI * 50 * 50));
    assert.equal(exposure.exposureRadiusKm, 50);
  });

  it('resolves interior points, not just exact centroids', () => {
    // Kyiv is nearer the Ukraine centroid than any other.
    const exposure = computeExposure(50.45, 30.52, 100);
    assert.equal(exposure.nearestCountry, 'UKR');
  });

  it('maps event types to radii with a 50km default', () => {
    assert.equal(getRadiusForEventType('earthquake'), 100);
    assert.equal(getRadiusForEventType('flood'), 100);
    assert.equal(getRadiusForEventType('wildfire'), 30);
    assert.equal(getRadiusForEventType('fire'), 30);
    assert.equal(getRadiusForEventType('battle'), 50);
    assert.equal(getRadiusForEventType('state-based'), 50);
    assert.equal(getRadiusForEventType('unknown-thing'), 50);
  });

  it('lists country populations with rounded densities', () => {
    const countries = listCountryPopulations();
    assert.equal(countries.length, 20);
    const india = countries.find((c) => c.code === 'IND');
    assert.ok(india);
    assert.equal(india.population, PRIORITY_COUNTRIES.IND.pop);
    assert.equal(
      india.densityPerKm2,
      Math.round(PRIORITY_COUNTRIES.IND.pop / PRIORITY_COUNTRIES.IND.area),
    );
  });
});

describe('analysis-temporal-severity core', () => {
  it('exports the canonical z-score thresholds', () => {
    assert.equal(Z_THRESHOLD_LOW, 1.5);
    assert.equal(Z_THRESHOLD_MEDIUM, 2.0);
    assert.equal(Z_THRESHOLD_HIGH, 3.0);
  });

  it('classifies severity bands exactly at the boundaries', () => {
    assert.equal(getBaselineSeverity(3.0), 'critical');
    assert.equal(getBaselineSeverity(4.7), 'critical');
    assert.equal(getBaselineSeverity(2.999), 'high');
    assert.equal(getBaselineSeverity(2.0), 'high');
    assert.equal(getBaselineSeverity(1.999), 'medium');
    assert.equal(getBaselineSeverity(1.5), 'medium');
    assert.equal(getBaselineSeverity(1.499), 'normal');
    assert.equal(getBaselineSeverity(0), 'normal');
  });
});

describe('exposure radius clamping', () => {
  it('caps free-form agent radii so an absurd request cannot return an absurd population', () => {
    // Unclamped, radius 20000 returned ~5.6e11 people — roughly 69x the world
    // population — because density is multiplied across the whole disc.
    const wild = computeBoundedExposure(31.0, 34.8, 20000);
    assert.equal(wild.exposureRadiusKm, MAX_EXPOSURE_RADIUS_KM, 'result reports the radius actually used');
    const capped = computeExposure(31.0, 34.8, MAX_EXPOSURE_RADIUS_KM);
    assert.equal(wild.exposedPopulation, capped.exposedPopulation);
    assert.ok(wild.exposedPopulation < 8.1e9 * 10, 'stays within an order of magnitude of world population');
  });

  it('leaves in-range radii untouched', () => {
    for (const r of [1, 30, 50, 100, MAX_EXPOSURE_RADIUS_KM]) {
      assert.equal(computeExposure(31.0, 34.8, r).exposureRadiusKm, r);
    }
  });

  it('treats non-finite and negative radii as zero rather than NaN', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const result = computeBoundedExposure(31.0, 34.8, bad);
      assert.equal(result.exposedPopulation, 0);
      assert.equal(result.exposureRadiusKm, 0);
    }
  });
});

describe('v1 population-exposure compatibility', () => {
  it('preserves the existing unbounded REST radius contract', async () => {
    const radius = MAX_EXPOSURE_RADIUS_KM + 1;
    const result = await getPopulationExposure(
      /** @type {never} */ ({}),
      { mode: 'exposure', lat: 31.0, lon: 34.8, radius },
    );

    assert.equal(result.exposure?.exposureRadiusKm, radius);
    assert.deepEqual(result.exposure, computeExposure(31.0, 34.8, radius));
  });
});
