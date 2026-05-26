import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { normalizeCountryToken, createCountryResolvers, resolveIso2, isIso2, isIso3 } from '../scripts/_country-resolver.mjs';

const root = resolve(import.meta.dirname, '..');
const countryNames = JSON.parse(readFileSync(resolve(root, 'shared/country-names.json'), 'utf8'));
const iso3ToIso2 = JSON.parse(readFileSync(resolve(root, 'shared/iso3-to-iso2.json'), 'utf8'));
const iso2ToIso3 = JSON.parse(readFileSync(resolve(root, 'shared/iso2-to-iso3.json'), 'utf8'));

describe('country-names.json structural validation', () => {
  it('every key equals normalizeCountryToken(key)', () => {
    for (const key of Object.keys(countryNames)) {
      assert.equal(key, normalizeCountryToken(key), `key "${key}" is not normalized`);
    }
  });
  it('every value is a valid ISO2 code', () => {
    for (const [key, value] of Object.entries(countryNames)) {
      assert.ok(isIso2(value), `"${key}" → "${value}" is not valid ISO2`);
    }
  });
  it('has at least 300 entries', () => {
    assert.ok(Object.keys(countryNames).length >= 300);
  });
});

describe('iso3-to-iso2.json validation', () => {
  it('has at least 238 entries', () => {
    assert.ok(Object.keys(iso3ToIso2).length >= 238);
  });
  it('every key is valid ISO3, every value is valid ISO2', () => {
    for (const [k, v] of Object.entries(iso3ToIso2)) {
      assert.ok(isIso3(k), `key "${k}" not valid ISO3`);
      assert.ok(isIso2(v), `value "${v}" not valid ISO2`);
    }
  });
  it('bidirectional consistency with iso2-to-iso3', () => {
    for (const [iso2, iso3] of Object.entries(iso2ToIso3)) {
      assert.equal(iso3ToIso2[iso3], iso2, `iso3ToIso2[${iso3}] !== ${iso2}`);
    }
  });
  it('resolves Taiwan and Kosovo', () => {
    assert.equal(iso3ToIso2['TWN'], 'TW');
    assert.equal(iso3ToIso2['XKX'], 'XK');
  });
});

describe('resolver parity', () => {
  const resolvers = createCountryResolvers();

  const oldAliases = {
    'bahamas the': 'BS', 'cape verde': 'CV', 'congo brazzaville': 'CG',
    'congo kinshasa': 'CD', 'congo rep': 'CG', 'congo dem rep': 'CD',
    'czech republic': 'CZ', 'egypt arab rep': 'EG', 'gambia the': 'GM',
    'hong kong sar china': 'HK', 'iran islamic rep': 'IR',
    'korea dem peoples rep': 'KP', 'korea rep': 'KR', 'lao pdr': 'LA',
    'macao sar china': 'MO', 'micronesia fed sts': 'FM',
    'morocco western sahara': 'MA', 'north macedonia': 'MK',
    'occupied palestinian territory': 'PS', 'palestinian territories': 'PS',
    'palestine state of': 'PS', 'russian federation': 'RU',
    'slovak republic': 'SK', 'st kitts and nevis': 'KN', 'st lucia': 'LC',
    'st vincent and the grenadines': 'VC', 'syrian arab republic': 'SY',
    'the bahamas': 'BS', 'timor leste': 'TL', 'turkiye': 'TR',
    'united states of america': 'US', 'venezuela rb': 'VE',
    'viet nam': 'VN', 'west bank and gaza': 'PS', 'yemen rep': 'YE',
  };

  it('resolves all old COUNTRY_ALIAS_MAP entries', () => {
    for (const [name, expected] of Object.entries(oldAliases)) {
      const result = resolveIso2({ name }, resolvers);
      assert.equal(result, expected, `"${name}" → ${result}, expected ${expected}`);
    }
  });

  it('resolves ISO3 codes', () => {
    assert.equal(resolveIso2({ iso3: 'USA' }, resolvers), 'US');
    assert.equal(resolveIso2({ iso3: 'GBR' }, resolvers), 'GB');
    assert.equal(resolveIso2({ iso3: 'TWN' }, resolvers), 'TW');
    assert.equal(resolveIso2({ iso3: 'XKX' }, resolvers), 'XK');
  });
});
