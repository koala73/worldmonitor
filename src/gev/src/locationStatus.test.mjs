import assert from 'node:assert/strict';
import test from 'node:test';

import { addressSegments, locationMiniStatus } from './locationStatus.js';

const NEW_YORK = {
  name: 'New York',
  pois: [{ name: 'Statue of Liberty' }, { name: 'Empire State Building' }],
};

test('a preset city reports its framed POI', () => {
  assert.deepEqual(
    locationMiniStatus({ city: NEW_YORK, currentPoi: { name: 'Empire State Building' } }),
    { city: '📍 New York', poi: 'Empire State Building' },
  );
});

test('a preset city with no framed POI falls back to its first POI', () => {
  assert.deepEqual(
    locationMiniStatus({ city: NEW_YORK }),
    { city: '📍 New York', poi: 'Statue of Liberty' },
  );
});

test('a free-text search reports the destination, never the empty placeholder', () => {
  // The bug: a searched destination left the readout on "Location: --"
  // because only the preset-city path was rendered.
  assert.deepEqual(
    locationMiniStatus({ searchedLabel: 'Tokyo, Japan' }),
    { city: '📍 Tokyo', poi: 'Japan' },
  );
  assert.deepEqual(
    locationMiniStatus({
      searchedLabel: 'Tokyo Tower, 4 Chome-2-8 Shibakoen, Minato City, Tokyo 105-0011, Japan',
    }),
    {
      city: '📍 Tokyo Tower',
      poi: '4 Chome-2-8 Shibakoen, Minato City, Tokyo 105-0011, Japan',
    },
  );
});

test('a single-segment geocode says it was searched rather than inventing context', () => {
  assert.deepEqual(
    locationMiniStatus({ searchedLabel: 'Japan' }),
    { city: '📍 Japan', poi: 'Searched location' },
  );
});

test('a preset city outranks a stale searched label', () => {
  assert.deepEqual(
    locationMiniStatus({ city: NEW_YORK, searchedLabel: 'Tokyo, Japan' }),
    { city: '📍 New York', poi: 'Statue of Liberty' },
  );
});

test('nothing selected keeps the honest empty placeholder', () => {
  const empty = { city: '📍 Location: --', poi: 'Landmark: --' };
  assert.deepEqual(locationMiniStatus(), empty);
  assert.deepEqual(locationMiniStatus({ city: null, searchedLabel: '' }), empty);
  assert.deepEqual(locationMiniStatus({ searchedLabel: '   ,  , ' }), empty);
  assert.deepEqual(locationMiniStatus({ searchedLabel: null }), empty);
});

test('a city record without a usable name is not treated as a preset', () => {
  assert.deepEqual(
    locationMiniStatus({ city: { pois: [] }, searchedLabel: 'Kyoto, Japan' }),
    { city: '📍 Kyoto', poi: 'Japan' },
  );
});

test('address segments drop empties and surrounding whitespace', () => {
  assert.deepEqual(addressSegments(' Tokyo ,, Japan '), ['Tokyo', 'Japan']);
  assert.deepEqual(addressSegments(undefined), []);
});
