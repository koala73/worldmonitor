import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readSignalMapPoint } from '../src/utils/signal-map-point.ts';

describe('readSignalMapPoint', () => {
  it('reads surge coordinates from location when data omits lat/lon', () => {
    const point = readSignalMapPoint({
      data: { theaterId: 'middle-east' },
      location: { lat: 0, lon: 0, name: 'Equator' },
    });
    assert.deepEqual(point, { lat: 0, lon: 0, regionName: 'Equator' });
  });

  it('prefers numeric data coordinates and rejects non-finite values', () => {
    assert.deepEqual(readSignalMapPoint({
      data: { lat: 12.5, lon: -4, regionName: 'Gulf' },
      location: { lat: 1, lon: 2, name: 'Other' },
    }), { lat: 12.5, lon: -4, regionName: 'Gulf' });
    assert.equal(readSignalMapPoint({ data: { lat: 'nope', lon: 4 } }), null);
    assert.equal(readSignalMapPoint({ data: {} }), null);
  });
});
