import assert from 'node:assert/strict';
import { it } from 'node:test';

import { LAST_GOOD_MAX_AGE_MS } from '../scripts/seed-live-video-resolved.mjs';
import { LIVE_VIDEO_TIMING } from '../src/services/live-video/model.ts';

// The seeder keeps an unreadable channel's last id for LAST_GOOD_MAX_AGE_MS; the player ignores any entry older
// than resolvedMaxAgeMs. If they drift, either the player drops ids the seeder still vouches for, or it plays ids
// the seeder already gave up on.
it('the player honours resolved ids exactly as long as the seeder keeps them (36 h)', () => {
  assert.equal(LIVE_VIDEO_TIMING.resolvedMaxAgeMs, LAST_GOOD_MAX_AGE_MS);
  assert.equal(LIVE_VIDEO_TIMING.resolvedMaxAgeMs, 36 * 60 * 60 * 1000);
});
