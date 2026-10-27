import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  CLUSTERS,
  MAX_PIXELS_PER_REQUEST,
  NO2_GEOMETRIES_PATH,
  NO2_REGIONS_PATH,
  buildRegistry,
  projectBudget,
  renderGeometries,
  renderRegistryModule,
} from '../scripts/generate-no2-regions.mjs';
import {
  CHINA_NO2_COMPOSITE,
  LUNAR_NEW_YEAR_DATES,
  NO2_ACTIVITY_METHOD,
  NO2_REGIONS,
  backfillChunkDaysFor,
  composeRegions,
  isHolidayMasked,
  signalFor,
  validateNo2ActivityDataset,
} from '../scripts/shared/no2-activity.mjs';
import { no2ActivityDataset } from './helpers/no2-activity-fixture.mjs';

const MONTHLY_QUOTA = 30_000;

describe('NO2 activity region registry (#9722)', () => {
  it('is generated from the country geometry and the cluster table and is up to date', () => {
    const { regions, geometries } = buildRegistry();
    assert.equal(readFileSync(NO2_REGIONS_PATH, 'utf8'), renderRegistryModule(regions));
    assert.equal(readFileSync(NO2_GEOMETRIES_PATH, 'utf8'), renderGeometries(geometries));
    assert.equal(regions.filter((region) => region.kind === 'cluster').length, CLUSTERS.length);
    assert.ok(regions.filter((region) => region.kind === 'country').length >= 160);
    for (const region of regions.filter((item) => item.kind === 'country')) {
      assert.ok(geometries[region.id], `${region.id} has a polygon`);
    }
  });

  it('keeps every region inside the request pixel cap with a sane rectangle', () => {
    assert.equal(new Set(NO2_REGIONS.map((region) => region.id)).size, NO2_REGIONS.length);
    for (const region of NO2_REGIONS) {
      const [west, south, east, north] = region.bbox;
      assert.ok(west < east && south < north && west >= -180 && east <= 180 && south >= -90 && north <= 90, region.id);
      assert.ok(region.pixels <= MAX_PIXELS_PER_REQUEST, `${region.id} pixels ${region.pixels}`);
      assert.ok(region.label.length >= 4, region.id);
      assert.ok(region.countryCode === null || /^[A-Z]{2}$/.test(region.countryCode), region.id);
    }
    assert.deepEqual(CHINA_NO2_COMPOSITE.regionIds, ['jing-jin-ji', 'yangtze-river-delta', 'pearl-river-delta', 'shandong']);
    assert.equal(NO2_REGIONS.find((region) => region.id === 'country-ru')?.resolutionDegrees, 1);
    assert.equal(NO2_REGIONS.find((region) => region.id === 'jing-jin-ji')?.holidayCalendar, 'lunar_new_year');
    assert.equal(NO2_REGIONS.find((region) => region.id === 'country-de')?.holidayCalendar, null);
  });

  it('projects a daily refresh plus the backfill at well under half the monthly quotas', () => {
    const budget = projectBudget(NO2_REGIONS, NO2_ACTIVITY_METHOD, backfillChunkDaysFor);
    assert.ok(budget.refreshRequestsPerMonth + budget.backfillRequests < MONTHLY_QUOTA / 2, JSON.stringify(budget));
    assert.ok(budget.refreshPuPerMonth + budget.backfillPu < MONTHLY_QUOTA / 2, JSON.stringify(budget));
    assert.ok(budget.backfillRuns <= 30, JSON.stringify(budget));
    assert.equal(backfillChunkDaysFor(NO2_REGIONS.find((region) => region.id === 'country-ru')), 61);
    assert.equal(backfillChunkDaysFor(NO2_REGIONS.find((region) => region.id === 'jing-jin-ji')), 183);
  });
});

describe('NO2 activity method contract (#9722)', () => {
  it('masks the Lunar New Year window only for regions on that calendar', () => {
    assert.equal(LUNAR_NEW_YEAR_DATES[2026], '2026-02-17');
    assert.equal(isHolidayMasked('2026-02-10', 'lunar_new_year'), true);
    assert.equal(isHolidayMasked('2026-02-09', 'lunar_new_year'), false);
    assert.equal(isHolidayMasked('2026-03-03', 'lunar_new_year'), true);
    assert.equal(isHolidayMasked('2026-03-04', 'lunar_new_year'), false);
    assert.equal(isHolidayMasked('2026-02-17', null), false);
    assert.equal(isHolidayMasked('2017-01-28', 'lunar_new_year'), false);
    assert.equal(isHolidayMasked('2026-02-30', 'lunar_new_year'), false);
  });

  it('derives the signal and direction from the dead band', () => {
    assert.deepEqual(signalFor(14.2), { signalValue: 14.2, direction: 'strengthening' });
    assert.deepEqual(signalFor(-10), { signalValue: -10, direction: 'weakening' });
    assert.deepEqual(signalFor(-9.99), { signalValue: 0, direction: 'unchanged' });
  });

  it('composes the median of eligible regions and refuses too few', () => {
    const dataset = no2ActivityDataset({
      changes: { 'jing-jin-ji': 14.2, 'yangtze-river-delta': 12.8, 'pearl-river-delta': 9.1, shandong: 16.5 },
    });
    const composite = composeRegions(dataset, CHINA_NO2_COMPOSITE.regionIds, CHINA_NO2_COMPOSITE.minRegions);
    assert.deepEqual(composite, {
      changePercent: 13.5,
      signalValue: 13.5,
      direction: 'strengthening',
      regionIds: CHINA_NO2_COMPOSITE.regionIds,
      exclusion: null,
    });
    const starved = composeRegions(
      no2ActivityDataset({ changes: { 'jing-jin-ji': null, 'yangtze-river-delta': 'pending', 'pearl-river-delta': null, shandong: 20 } }),
      CHINA_NO2_COMPOSITE.regionIds,
      CHINA_NO2_COMPOSITE.minRegions,
    );
    assert.equal(starved.exclusion, 'insufficient_regions');
    assert.deepEqual(starved.regionIds, ['shandong']);
    assert.equal(starved.direction, null);
  });

  it('accepts a dataset that carries the reviewed method and one consistent record per region', () => {
    assert.equal(validateNo2ActivityDataset(no2ActivityDataset()), true);
    assert.equal(validateNo2ActivityDataset(no2ActivityDataset({ changes: { 'country-de': null, 'country-ru': 'pending' } })), true);
  });

  it('refuses datasets whose method, regions, or signals drift from the contract', () => {
    const cases = {
      'another method version': (dataset) => { dataset.methodVersion = 'no2-activity/v2'; },
      'a moved dead band': (dataset) => { dataset.method.deadBandPercent = 5; },
      'a different timeliness': (dataset) => { dataset.method.timeliness = 'NRTI'; },
      'an extra method field': (dataset) => { dataset.method.extra = 1; },
      'a changed chunk table': (dataset) => { dataset.method.backfillChunkDaysByWidth[0][1] = 365; },
      'a missing region': (dataset) => { delete dataset.regions['country-de']; },
      'an unregistered region': (dataset) => { dataset.regions.atlantis = dataset.regions['country-de']; delete dataset.regions['country-de']; },
      'a region rectangle that moved': (dataset) => { dataset.regions['jing-jin-ji'].bbox[0] = 113; },
      'a region grid that moved': (dataset) => { dataset.regions['country-ru'].resolutionDegrees = 0.5; },
      'a direction that disagrees with the change': (dataset) => { dataset.regions['country-de'].direction = 'strengthening'; },
      'a signal that ignores the dead band': (dataset) => { dataset.regions['country-de'].signalValue = 2; },
      'an excluded region that still carries a change': (dataset) => { dataset.regions['country-de'].exclusion = 'request_failed'; },
      'an unknown exclusion': (dataset) => {
        const region = dataset.regions['country-de'];
        Object.assign(region, { exclusion: 'cloudy', changePercent: null, signalValue: null, direction: null });
      },
      'a window that ends after generation': (dataset) => { dataset.generatedAt = '2026-10-23T12:00:00.000Z'; },
      'a generation time that is not an ISO UTC instant': (dataset) => { dataset.generatedAt = 'Oct 26 2026 06:10'; },
      'a generation time on an impossible day': (dataset) => { dataset.generatedAt = '2026-02-30T06:10:00.000Z'; },
      'a window on an impossible calendar day': (dataset) => { dataset.regions['country-de'].current.windowStart = '2026-02-30'; },
      'a window with valid days but no mean': (dataset) => { dataset.regions['country-de'].current.meanNo2MolM2 = null; },
      'series coverage without dates': (dataset) => { dataset.regions['country-de'].series.firstDate = null; },
      'an eligible region without a refresh clock': (dataset) => { dataset.regions['country-de'].series.refreshedAt = null; },
      'a future refresh clock': (dataset) => { dataset.regions['country-de'].series.refreshedAt = '2026-10-27T06:10:00.000Z'; },
      'a stale refresh clock on an eligible region': (dataset) => { dataset.regions['country-de'].series.refreshedAt = '2026-10-18T06:10:00.000Z'; },
      'a missing attribution': (dataset) => { dataset.source.attribution = 'Sentinel-5P'; },
      'another publisher': (dataset) => { dataset.source.publisherId = 'publisher:nasa'; },
    };
    for (const [label, mutate] of Object.entries(cases)) {
      const dataset = no2ActivityDataset();
      mutate(dataset);
      assert.equal(validateNo2ActivityDataset(dataset), false, label);
    }
    assert.equal(validateNo2ActivityDataset(null), false);
    assert.equal(validateNo2ActivityDataset([]), false);
  });
});
