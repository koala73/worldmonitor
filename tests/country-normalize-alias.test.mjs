import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCountryToIso2 } from '../server/_shared/country-normalize.ts';

test('the country normalizer resolves the existing two-letter UK alias', () => {
  for (const input of ['UK', 'uk', ' Uk ']) assert.equal(normalizeCountryToIso2(input), 'GB');
});

test('the country normalizer retains valid codes, names, and unavailable states', () => {
  for (const [input, expected] of [['US', 'US'], ['gb', 'GB'], ['United Kingdom', 'GB'], ['USA', 'US'], ['Global', null], ['ZZ', null], ['Nowhere', null], ['constructor', null], ['', null], [null, null], [12, null]]) {
    assert.equal(normalizeCountryToIso2(input), expected, String(input));
  }
});
