import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  globeCenterForOffset,
  isOnVisibleHemisphere,
  mercatorCenterForOffset,
  visibleMapArea,
} from '../src/utils/map-point-offset.ts';

const PALM = { lat: 25.112, lon: 55.139 };

function mercatorPx(lat: number, lon: number, zoom: number) {
  const world = 512 * 2 ** zoom;
  const phi = (lat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * world,
    y: (0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)) * world,
  };
}

describe('mercatorCenterForOffset', () => {
  it('returns the point itself for a zero offset', () => {
    const c = mercatorCenterForOffset(PALM.lat, PALM.lon, 11, { x: 0, y: 0 });
    assert.ok(Math.abs(c.lat - PALM.lat) < 1e-9);
    assert.ok(Math.abs(c.lon - PALM.lon) < 1e-9);
  });

  it('puts the point exactly at the offset from the new centre', () => {
    const offset = { x: -226, y: -40 };
    const c = mercatorCenterForOffset(PALM.lat, PALM.lon, 11, offset);
    const p = mercatorPx(PALM.lat, PALM.lon, 11);
    const q = mercatorPx(c.lat, c.lon, 11);
    assert.ok(Math.abs(p.x - q.x - offset.x) < 1e-6);
    assert.ok(Math.abs(p.y - q.y - offset.y) < 1e-6);
    assert.ok(c.lon > PALM.lon && c.lat < PALM.lat, 'a panel on the right moves the centre east and south');
  });

  it('wraps longitude across the antimeridian', () => {
    const c = mercatorCenterForOffset(0, 179.99, 6, { x: -400, y: 0 });
    assert.ok(c.lon < -170);
  });
});

describe('globeCenterForOffset', () => {
  it('moves the centre east of a point that should sit left of centre', () => {
    const c = globeCenterForOffset(PALM.lat, PALM.lon, 0.01, 50, 900, { x: -226, y: 0 });
    assert.ok(c.lon > PALM.lon);
    assert.ok(Math.abs(c.lat - PALM.lat) < 1e-9);
  });

  it('moves the centre south of a point that should sit above centre', () => {
    const c = globeCenterForOffset(PALM.lat, PALM.lon, 0.01, 50, 320, { x: 0, y: -60 });
    assert.ok(c.lat < PALM.lat);
  });

  it('leaves the point alone without a viewport', () => {
    assert.deepEqual(globeCenterForOffset(PALM.lat, PALM.lon, 0.01, 50, 0, { x: -226, y: 0 }), PALM);
  });
});

describe('isOnVisibleHemisphere', () => {
  it('sees the point under the camera and hides the far side', () => {
    assert.equal(isOnVisibleHemisphere(PALM.lat, PALM.lon, PALM.lat, PALM.lon, 0.01), true);
    assert.equal(isOnVisibleHemisphere(PALM.lat, PALM.lon, 20, -90, 1.5), false);
  });
});

describe('visibleMapArea', () => {
  const screen = { left: 0, top: 0, right: 1440, bottom: 900 };

  it('keeps the part left of a right-hand panel and above a status bar', () => {
    const panel = { left: 1004, top: 16, right: 1424, bottom: 856 };
    const status = { left: 0, top: 876, right: 1440, bottom: 900 };
    assert.deepEqual(visibleMapArea(screen, [panel, status]), { left: 0, top: 0, right: 1004, bottom: 876 });
  });

  it('keeps the part above a bottom sheet and its dock', () => {
    const map = { left: 0, top: 0, right: 390, bottom: 844 };
    const dock = { left: 0, top: 211, right: 390, bottom: 321 };
    const panel = { left: 0, top: 321, right: 390, bottom: 786 };
    assert.deepEqual(visibleMapArea(map, [panel, dock]), { left: 0, top: 0, right: 390, bottom: 211 });
  });

  it('ignores covers outside the map', () => {
    const map = { left: 0, top: 60, right: 900, bottom: 500 };
    assert.deepEqual(visibleMapArea(map, [{ left: 0, top: 600, right: 900, bottom: 700 }]), map);
  });
});
