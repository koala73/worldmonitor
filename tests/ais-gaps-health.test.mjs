// Registration contract for the ais-gaps health surface (#7574).
//
// maritime:ais-gaps:v1 is a relay-published intermediate key consumed by the
// temporal-anomalies rebuild. These assertions pin the pairing that the
// producers and consumers on both sides assume: the STANDALONE data key, the
// seed-meta freshness entry, and the zero-records-are-valid grading (zero
// dark ships is a peaceful state, not a failed publish).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { __testing__ } from '../api/health.js';

const { SEED_META, STANDALONE_KEYS, ZERO_RECORD_DATA_OK_KEYS } = __testing__;

describe('aisGaps health registration (#7574)', () => {
  it('registers the data key the relay publishes and the rebuild reads', () => {
    assert.equal(
      STANDALONE_KEYS.aisGaps,
      'maritime:ais-gaps:v1',
      'STANDALONE_KEYS.aisGaps must match AIS_GAPS_REDIS_KEY in scripts/ais-relay.cjs and COUNT_SOURCE_KEYS.ais_gaps',
    );
  });

  it('registers the seed-meta freshness entry with the pinned budget', () => {
    assert.equal(SEED_META.aisGaps.key, 'seed-meta:maritime:ais-gaps');
    // Co-pinned with AIS_GAPS_TTL=3600 in scripts/ais-relay.cjs: the data TTL
    // must STRICTLY exceed this budget so a dead relay reads STALE_SEED
    // before the envelope expires to EMPTY.
    assert.equal(SEED_META.aisGaps.maxStaleMin, 30);
  });

  it('grades a present-but-zero dark-ship payload as valid, absence as EMPTY', () => {
    assert.ok(
      ZERO_RECORD_DATA_OK_KEYS.has('aisGaps'),
      'zero dark ships is a legitimate peaceful state (producer publishes zeroOk)',
    );
  });
});
