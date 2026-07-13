import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isKnownMilitaryHex } from '../src/config/military.ts';

describe('browser military hex confidence', () => {
  it('treats exact observed PLA aircraft as high confidence while ranges remain medium', () => {
    assert.deepEqual(isKnownMilitaryHex('7A4262'), {
      aircraftType: 'reconnaissance',
      operator: 'plaaf',
      country: 'China',
      confidence: 'high',
    });
    assert.equal(isKnownMilitaryHex('ADF7C8')?.confidence, 'medium');
  });
});
