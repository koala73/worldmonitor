import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { __testing__ } from '../api/health.js';

describe('forecast resolution health registration', () => {
  it('classifies the resolution ledger and scorecard as standalone health checks', () => {
    assert.equal(__testing__.STANDALONE_KEYS.forecastResolutions, 'forecast:resolutions:v1');
    assert.equal(__testing__.STANDALONE_KEYS.forecastScorecard, 'forecast:scorecard:v1');
    assert.equal(__testing__.SEED_META.forecastResolutions.key, 'seed-meta:forecast:resolutions');
    assert.equal(__testing__.SEED_META.forecastScorecard.key, 'seed-meta:forecast:scorecard');
  });
});
