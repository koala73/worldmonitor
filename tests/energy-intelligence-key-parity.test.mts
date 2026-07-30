import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Static parity guard: the cache-keys.ts constant the consumer imports
// (chat-analyst-context.ts) MUST equal the seeder's CANONICAL_KEY.
//
// Background — concrete regression that motivated this test:
//
// scripts/seed-energy-intelligence.mjs writes to
//   `energy:intelligence:feed:v1`
// server/_shared/cache-keys.ts declared
//   `energy:intelligence:v1:feed`  (drifted)
// server/worldmonitor/intelligence/v1/chat-analyst-context.ts imports
// ENERGY_INTELLIGENCE_KEY from cache-keys.ts and calls getCachedJson on
// it. With the drift, the OilPrice + OPEC RSS feed was being seeded
// weekly but never reached the chat analyst — silently invisible for
// ~1 month before discovery (commit e98df6f69, 2026-04-18 → audit).
//
// Locking this here means a future rename on either side breaks CI in
// the same PR, not in production.

import { ENERGY_INTELLIGENCE_KEY as CACHE_KEY } from '../server/_shared/cache-keys';
// @ts-expect-error -- seeder is plain .mjs, no .d.ts; type doesn't matter
// because the test only compares the string value at runtime.
import { ENERGY_INTELLIGENCE_KEY as SEEDER_KEY } from '../scripts/seed-energy-intelligence.mjs';

describe('ENERGY_INTELLIGENCE_KEY parity', () => {
  it('cache-keys.ts constant matches seeder CANONICAL_KEY', () => {
    assert.equal(
      CACHE_KEY,
      SEEDER_KEY,
      `Drift detected: cache-keys.ts -> ${CACHE_KEY}, seeder -> ${SEEDER_KEY}. ` +
        `Update both sides together or the chat analyst silently reads an empty key.`,
    );
  });
});
