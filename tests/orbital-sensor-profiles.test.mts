import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  SENSOR_CATEGORIES,
  SENSOR_INVENTORY_VERSION,
  SENSOR_PROFILES,
  matchSensorProfile,
} from '../shared/orbital/sensor-profiles.js';

const { records } = JSON.parse(readFileSync(new URL('./fixtures/orbital/celestrak-gp-2026-11-13.json', import.meta.url), 'utf8'));

describe('sensor profile inventory', () => {
  it('carries a version', () => {
    assert.match(SENSOR_INVENTORY_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it('cites an https source for every row and uses a known category', () => {
    for (const profile of SENSOR_PROFILES) {
      assert.ok(profile.sources.length > 0, `${profile.id} cites a source`);
      for (const source of profile.sources) assert.equal(new URL(source).protocol, 'https:', `${profile.id} source ${source}`);
      assert.ok(SENSOR_CATEGORIES.includes(profile.category), `${profile.id} category ${profile.category}`);
    }
  });

  it('keeps profile ids and NORAD ids unique', () => {
    const ids = SENSOR_PROFILES.map((profile) => profile.id);
    assert.equal(new Set(ids).size, ids.length);
    const norad = SENSOR_PROFILES.flatMap((profile) => profile.noradIds);
    assert.equal(new Set(norad).size, norad.length);
  });

  it('gives open missions a publication delay and weather sensors a daily mosaic', () => {
    for (const profile of SENSOR_PROFILES) {
      if (profile.category.startsWith('open-')) assert.ok((profile.archiveWaitHours ?? 0) > 0, `${profile.id} archive wait`);
      if (profile.category === 'weather-polar') assert.equal(profile.dailyMosaic, true, `${profile.id} daily mosaic`);
    }
  });
});

describe('matchSensorProfile', () => {
  it('matches every fixture satellite', () => {
    for (const omm of records) assert.ok(matchSensorProfile(omm.NORAD_CAT_ID, omm.OBJECT_NAME), omm.OBJECT_NAME);
  });

  it('prefers the NORAD id over the name', () => {
    assert.equal(matchSensorProfile(40697, 'LANDSAT 9')?.id, 'sentinel-2');
  });

  it('falls back to the name pattern for a satellite not yet listed by id', () => {
    assert.equal(matchSensorProfile(999_999, 'SENTINEL-2D')?.id, 'sentinel-2');
    assert.equal(matchSensorProfile(999_999, 'yaogan-45')?.id, 'yaogan');
    assert.equal(matchSensorProfile(999_999, 'CAPELLA-30 (ACADIA-20)')?.id, 'capella');
  });

  it('returns null for an unprofiled satellite', () => {
    assert.equal(matchSensorProfile(999_999, 'STARLINK-1007'), null);
    assert.equal(matchSensorProfile(999_999, null), null);
  });
});
