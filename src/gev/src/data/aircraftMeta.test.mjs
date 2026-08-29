// src/data/aircraftMeta.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stickyText, stickyNumber } from './aircraftMeta.js';

test('stickyText holds last non-empty value', () => {
  assert.equal(stickyText('UAL123 ', undefined), 'UAL123');
  assert.equal(stickyText('', 'UAL123'), 'UAL123');
  assert.equal(stickyText('  ', 'UAL123'), 'UAL123');
  assert.equal(stickyText('DAL9', 'UAL123'), 'DAL9'); // new value wins
  assert.equal(stickyText(null, null), '');
});

test('stickyNumber holds last finite value, keeps 0, honors fallback', () => {
  assert.equal(stickyNumber(250, 100, 0), 250);
  assert.equal(stickyNumber(null, 100, 0), 100);
  assert.equal(stickyNumber(0, 100, 7), 0);        // 0 is a REAL value
  assert.equal(stickyNumber(NaN, undefined, 7), 7);
  assert.equal(stickyNumber(undefined, undefined, null), null);
});
