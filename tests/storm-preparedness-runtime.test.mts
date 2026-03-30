import test from 'node:test';
import assert from 'node:assert/strict';

import { getStormPreparednessForPlace } from '../src/services/storm-preparedness.ts';
import type { SavedPlace } from '../src/services/saved-places.ts';

const basePlace: SavedPlace = {
  id: 'home',
  name: 'Norman',
  lat: 35.22,
  lon: -97.44,
  radiusKm: 40,
  tags: ['home'],
  priority: 1,
  notes: '',
  offlinePinned: false,
  primary: true,
  source: 'manual',
  sortIndex: 1,
  createdAt: 1,
  updatedAt: 1,
};

test('storm preparedness escalates to shelter-now for a tornado warning over a saved place', () => {
  const preparedness = getStormPreparednessForPlace(basePlace, {
    weatherAlerts: [
      {
        id: 'tornado-warning',
        event: 'Tornado Warning',
        severity: 'Extreme',
        headline: 'Tornado Warning for central Oklahoma',
        description: 'Take shelter now.',
        areaDesc: 'Cleveland County',
        onset: new Date('2026-03-29T17:00:00Z'),
        expires: new Date('2026-03-29T18:00:00Z'),
        coordinates: [
          [-97.6, 35.1],
          [-97.2, 35.1],
          [-97.2, 35.35],
          [-97.6, 35.35],
          [-97.6, 35.1],
        ],
        centroid: [-97.4, 35.22],
      },
    ],
    nwsAlerts: [],
    tropicalCyclones: [],
    spcSummary: null,
    excessiveRainfallOutlooks: [],
    winterWeatherOutlooks: [],
    marineHazards: [],
    buoyAlerts: [],
    reconFixes: [],
    updatedAt: Date.now(),
  });

  assert.ok(preparedness, 'storm preparedness should return a place-specific posture');
  assert.equal(preparedness?.scenario, 'tornado');
  assert.equal(preparedness?.posture, 'shelter-now');
  assert.equal(preparedness?.severity, 'critical');
  assert.match(preparedness?.headline ?? '', /tornado/i);
  assert.ok(
    preparedness?.guidance.some((item) => /interior room|basement|windows/i.test(item)),
    'tornado posture should include immediate shelter guidance',
  );
});

test('storm preparedness uses WPC excessive rainfall outlooks to raise early flood posture', () => {
  const preparedness = getStormPreparednessForPlace(basePlace, {
    weatherAlerts: [],
    nwsAlerts: [],
    tropicalCyclones: [],
    spcSummary: null,
    excessiveRainfallOutlooks: [
      {
        id: 'wpc-day2-slight',
        day: 2,
        riskLevel: 'slight',
        riskText: 'Slight',
        headline: 'WPC Day 2 excessive rainfall risk',
        validTime: '12Z 03/30/26 - 12Z 03/31/26',
        issuedAt: new Date('2026-03-29T19:01:00Z'),
        startsAt: new Date('2026-03-30T12:00:00Z'),
        endsAt: new Date('2026-03-31T12:00:00Z'),
        coordinates: [
          [
            [-97.8, 34.9],
            [-97.0, 34.9],
            [-97.0, 35.5],
            [-97.8, 35.5],
            [-97.8, 34.9],
          ],
        ],
        centroid: [-97.4, 35.2],
        severity: 'high',
      },
    ],
    winterWeatherOutlooks: [],
    marineHazards: [],
    buoyAlerts: [],
    reconFixes: [],
    updatedAt: Date.now(),
  });

  assert.ok(preparedness, 'excessive rainfall outlook should create flood preparedness for a saved place');
  assert.equal(preparedness?.scenario, 'flood');
  assert.equal(preparedness?.posture, 'prepare-today');
  assert.match(preparedness?.headline ?? '', /rainfall|flood/i);
});

test('storm preparedness uses WPC winter outlooks to raise early blizzard and icing posture', () => {
  const preparedness = getStormPreparednessForPlace(basePlace, {
    weatherAlerts: [],
    nwsAlerts: [],
    tropicalCyclones: [],
    spcSummary: null,
    excessiveRainfallOutlooks: [],
    winterWeatherOutlooks: [
      {
        id: 'wpc-day1-snow-8',
        day: 1,
        hazardType: 'snow',
        threshold: '8in',
        probabilityTier: 'high',
        probabilityPercent: 70,
        headline: 'WPC Day 1 snow > 8 inches',
        issuedAt: new Date('2026-03-29T09:13:00Z'),
        startsAt: new Date('2026-03-30T12:00:00Z'),
        endsAt: new Date('2026-03-31T12:00:00Z'),
        coordinates: [
          [
            [-97.8, 34.9],
            [-97.0, 34.9],
            [-97.0, 35.5],
            [-97.8, 35.5],
            [-97.8, 34.9],
          ],
        ],
        centroid: [-97.4, 35.2],
        severity: 'critical',
        sourceUrl: 'https://www.wpc.ncep.noaa.gov/kml/winwx/HPC_Day1-3_psnow_gt_08_latest.kml',
      },
    ],
    marineHazards: [],
    buoyAlerts: [],
    reconFixes: [],
    updatedAt: Date.now(),
  });

  assert.ok(preparedness, 'winter outlook should create winter preparedness for a saved place');
  assert.equal(preparedness?.scenario, 'winter');
  assert.equal(preparedness?.posture, 'act-now');
  assert.match(preparedness?.headline ?? '', /winter|snow/i);
  assert.ok(
    preparedness?.guidance.some((item) => /travel|blankets|outages|heat/i.test(item)),
    'winter posture should include cold-weather readiness guidance',
  );
});
