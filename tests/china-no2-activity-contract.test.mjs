import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHINA_NO2_ACTIVITY_METHOD,
  CHINA_NO2_REGIONS,
  LUNAR_NEW_YEAR_DATES,
  isLunarNewYearHoliday,
  validateChinaNo2ActivityPayload,
} from '../scripts/shared/china-no2-activity.mjs';
import { chinaNo2ActivityPayload } from './helpers/china-no2-activity-fixture.mjs';

describe('China NO2 activity contract (#9722)', () => {
  it('registers distinct regions with west-south-east-north rectangles inside China', () => {
    assert.equal(new Set(CHINA_NO2_REGIONS.map((region) => region.id)).size, CHINA_NO2_REGIONS.length);
    for (const region of CHINA_NO2_REGIONS) {
      const [west, south, east, north] = region.bbox;
      assert.ok(west < east && south < north, region.id);
      assert.ok(west >= 73 && east <= 135 && south >= 18 && north <= 54, region.id);
      assert.ok(region.label.length >= 10, region.id);
    }
    assert.ok(CHINA_NO2_ACTIVITY_METHOD.minRegions <= CHINA_NO2_REGIONS.length);
  });

  it('masks the holiday window around each tabulated Lunar New Year and nothing else', () => {
    assert.equal(LUNAR_NEW_YEAR_DATES[2026], '2026-02-17');
    assert.equal(isLunarNewYearHoliday('2026-02-10'), true);
    assert.equal(isLunarNewYearHoliday('2026-02-09'), false);
    assert.equal(isLunarNewYearHoliday('2026-03-03'), true);
    assert.equal(isLunarNewYearHoliday('2026-03-04'), false);
    assert.equal(isLunarNewYearHoliday('2025-01-29'), true);
    assert.equal(isLunarNewYearHoliday('2025-07-01'), false);
    assert.equal(isLunarNewYearHoliday('2017-01-28'), false);
    assert.equal(isLunarNewYearHoliday('not a date'), false);
    assert.equal(isLunarNewYearHoliday('2026-02-30'), false);
  });

  it('accepts a payload that carries the reviewed method, every region, and a consistent composite', () => {
    assert.equal(validateChinaNo2ActivityPayload(chinaNo2ActivityPayload()), true);
    const insideDeadBand = chinaNo2ActivityPayload({
      changes: { 'jing-jin-ji': 3, 'yangtze-river-delta': -2, 'pearl-river-delta': 1, shandong: 4 },
    });
    assert.equal(insideDeadBand.composite.signalValue, 0);
    assert.equal(validateChinaNo2ActivityPayload(insideDeadBand), true);
    const tooFewRegions = chinaNo2ActivityPayload({ changes: { shandong: 20 } });
    assert.equal(tooFewRegions.composite.exclusion, 'insufficient_regions');
    assert.equal(validateChinaNo2ActivityPayload(tooFewRegions), true);
  });

  it('refuses payloads whose method, regions, or composite drift from the contract', () => {
    const cases = {
      'another method version': (payload) => { payload.methodVersion = 'china-no2-activity/v2'; },
      'a moved dead band': (payload) => { payload.method.deadBandPercent = 5; },
      'a different timeliness': (payload) => { payload.method.timeliness = 'NRTI'; },
      'an extra method field': (payload) => { payload.method.extra = 1; },
      'a missing region': (payload) => { payload.regions.pop(); },
      'regions out of registry order': (payload) => { payload.regions.reverse(); },
      'a region rectangle that moved': (payload) => { payload.regions[0].bbox[0] = 113; },
      'a composite median that disagrees with the dead band': (payload) => {
        payload.composite.changePercent = 4;
        payload.composite.signalValue = 4;
      },
      'a composite that is not the median of its regions': (payload) => {
        payload.composite.changePercent = -20;
        payload.composite.signalValue = -20;
      },
      'a window on an impossible calendar day': (payload) => {
        payload.regions[0].current.windowStart = '2026-02-30';
      },
      'a composite that lists an excluded region': (payload) => {
        payload.regions[0].exclusion = 'insufficient_valid_days';
        payload.regions[0].changePercent = null;
      },
      'an excluded region that still carries a change': (payload) => {
        payload.regions[0].exclusion = 'request_failed';
      },
      'an unknown exclusion': (payload) => {
        payload.regions[0].exclusion = 'cloudy';
        payload.regions[0].changePercent = null;
      },
      'a window that ends after generation': (payload) => { payload.generatedAt = '2026-10-23T12:00:00.000Z'; },
      'a window with valid days but no mean': (payload) => { payload.regions[1].current.meanNo2MolM2 = null; },
      'a missing attribution': (payload) => { payload.source.attribution = 'Sentinel-5P'; },
      'another publisher': (payload) => { payload.source.publisherId = 'publisher:nasa'; },
    };
    for (const [label, mutate] of Object.entries(cases)) {
      const payload = chinaNo2ActivityPayload();
      mutate(payload);
      assert.equal(validateChinaNo2ActivityPayload(payload), false, label);
    }
    assert.equal(validateChinaNo2ActivityPayload(null), false);
    assert.equal(validateChinaNo2ActivityPayload([]), false);
  });
});
