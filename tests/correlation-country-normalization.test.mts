import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeToCountryCode } from '../src/services/correlation-engine/country-normalization.ts';

test('normalizes country names and ISO forms to ISO-2', () => {
  assert.equal(normalizeToCountryCode('United States'), 'US');
  assert.equal(normalizeToCountryCode('UKR'), 'UA');
  assert.equal(normalizeToCountryCode('ua'), 'UA');
});

test('disaster exclusion compares normalized countries', async () => {
  const source = await readFile(new URL('../src/services/correlation-engine/adapters/disaster.ts', import.meta.url), 'utf8');
  assert.match(source, /normalizeToCountryCode\(p\.country, p\.lat, p\.lon\)/);
  assert.match(source, /normalizeToCountryCode\(o\.country, o\.lat, o\.lon\)/);
});
