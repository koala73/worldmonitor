import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { archiveUrlAfterScrub, pointFromText, pointLeak } from '../.agents/skills/verify-worldmonitor/steps/_point-leak.mjs';

const point = { lat: 25.112, lon: 55.139 };

describe('verify recipe point-leak check', () => {
  it('reads the point from the sheet heading', () => {
    assert.deepEqual(pointFromText('25.112°N 55.139°E'), point);
    assert.deepEqual(pointFromText('33.900°S 151.200°W'), { lat: -33.9, lon: -151.2 });
  });

  it('catches the point at one decimal, at any finer precision, and either way round', () => {
    assert.equal(pointLeak('https://api.worldmonitor.app/x?lat=25.1&lon=55.1', point), 'point');
    assert.equal(pointLeak('https://api.worldmonitor.app/x?q=55.14,25.11', point), 'point');
    assert.equal(pointLeak('{"lat":25.1120,"zoom":11,"lon":55.1390}', point), 'point');
    assert.equal(pointLeak('https://sentry.io/x?url=%23orbital%3D25.11%252C55.14', point), 'point');
  });

  it('catches a box whose midpoint is the point when no corner is near it', () => {
    assert.equal(pointLeak('https://api.worldmonitor.app/tiles/54.639,24.612,55.639,25.612.png', point), 'box');
    assert.equal(pointLeak('BBOX=24.612,54.639,25.612,55.639', point), 'box');
  });

  it('passes coarse or unrelated numbers', () => {
    assert.equal(pointLeak('https://api.worldmonitor.app/x?lat=25&lon=55', point), null);
    assert.equal(pointLeak('https://tiles.example/11/1336/877.pbf', point), null);
    assert.equal(pointLeak('https://api.worldmonitor.app/x?lat=25.3&lon=55.1', point), null);
    assert.equal(pointLeak('{"lcp":25.1,"a":1,"b":2,"c":3,"cls":55.1}', point), null);
    assert.equal(pointLeak('BBOX=24.0,54.0,25.0,55.0', point), null);
  });

  it('keeps only what survives the telemetry scrub of an archive URL', () => {
    const crop = 'https://planetarycomputer.microsoft.com/api/data/v1/item/bbox/54.639,24.612,55.639,25.612/512x512.png?collection=sentinel-2-l2a';
    assert.equal(pointLeak(crop, point), 'box');
    assert.equal(pointLeak(archiveUrlAfterScrub(crop), point), null);
    assert.equal(pointLeak(archiveUrlAfterScrub('https://gibs.earthdata.nasa.gov/wms?BBOX=24.612,54.639,25.612,55.639'), point), null);
    assert.equal(pointLeak(archiveUrlAfterScrub('https://planetarycomputer.microsoft.com/tiles/at-25.1-55.1/x.png'), point), 'point');
  });
});
