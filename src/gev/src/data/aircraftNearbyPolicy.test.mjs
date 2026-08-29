import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aircraftIncludedInNearby } from './aircraftNearbyPolicy.js';

test('awareness proximity includes horizon-hidden loaded aircraft without changing the default', () => {
  const horizonHidden = {
    isTracked: false,
    billboardShown: false,
    modelRendering: false,
  };
  assert.equal(aircraftIncludedInNearby(horizonHidden), false);
  assert.equal(aircraftIncludedInNearby({ ...horizonHidden, includeHidden: true }), true);
});
