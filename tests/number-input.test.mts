import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIntegerInputValue } from '../src/utils/number-input.js';

test('parseIntegerInputValue clamps values into the allowed range', () => {
  assert.equal(parseIntegerInputValue('180', { min: 60, max: 86400, fallback: 60 }), 180);
  assert.equal(parseIntegerInputValue('5', { min: 60, max: 86400, fallback: 60 }), 60);
  assert.equal(parseIntegerInputValue('999999', { min: 60, max: 86400, fallback: 60 }), 86400);
  assert.equal(parseIntegerInputValue('', { min: 60, max: 86400, fallback: 60 }), 60);
  assert.equal(parseIntegerInputValue('abc', { min: 60, max: 86400, fallback: 60 }), 60);
});
