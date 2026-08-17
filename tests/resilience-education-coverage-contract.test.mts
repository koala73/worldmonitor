import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EDUCATION_MIN_RANKABLE_RECORD_COUNT,
  isRankableCountryCode,
  parseEducationPayloadRankableRecordCount,
  parseRankableRecordCount,
} from '../api/_rankable-coverage.js';
import { ACTIVATION_MIN_COUNTRIES } from '../scripts/seed-education-attainment.mjs';
import { EDUCATION_ACTIVATION_MIN_COUNTRIES } from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import sovereignStatus from '../scripts/shared/sovereign-status.json';

const countryCodes = sovereignStatus.entries.map((entry) => entry.iso2);

describe('education activation coverage contract', () => {
  it('keeps the producer, scorer, and Edge health floor aligned', () => {
    assert.equal(ACTIVATION_MIN_COUNTRIES, 180);
    assert.equal(EDUCATION_ACTIVATION_MIN_COUNTRIES, ACTIVATION_MIN_COUNTRIES);
    assert.equal(EDUCATION_MIN_RANKABLE_RECORD_COUNT, ACTIVATION_MIN_COUNTRIES);
    assert.deepEqual(countryCodes.filter(isRankableCountryCode), countryCodes);
  });

  it('accepts a safe numeric count and the legacy numeric-string form', () => {
    assert.equal(parseRankableRecordCount({ rankableRecordCount: 180 }), 180);
    assert.equal(parseRankableRecordCount({ rankableRecordCount: '180' }), 180);
  });

  it('derives unique coverage from the transition countrySet', () => {
    assert.equal(parseRankableRecordCount({ countrySet: countryCodes.slice(0, 180).join(',') }), 180);
    assert.equal(parseRankableRecordCount({ countrySet: countryCodes.slice(0, 179).join(',') }), 179);
    assert.equal(
      parseRankableRecordCount({ countrySet: [...countryCodes.slice(0, 179), countryCodes[0]].join(',') }),
      179,
      'duplicates must not inflate coverage',
    );
  });

  it('rejects empty, lowercase, malformed, and coercion-prone values', () => {
    assert.equal(parseRankableRecordCount({ countrySet: '' }), null);
    assert.equal(parseRankableRecordCount({ countrySet: 'US,,FR' }), null);
    assert.equal(parseRankableRecordCount({ countrySet: 'US,fr' }), null);
    assert.equal(parseRankableRecordCount({ countrySet: 'US,ZZ' }), null);
    assert.equal(parseRankableRecordCount({ rankableRecordCount: false }), null);
    assert.equal(parseRankableRecordCount({ rankableRecordCount: null }), null);
    assert.equal(parseRankableRecordCount({ rankableRecordCount: 180.5 }), null);
  });

  it('counts only usable rankable records in the canonical payload', () => {
    const countries = Object.fromEntries(
      countryCodes.slice(0, 180).map((code, index) => [code, { value: index % 100, year: 2024 }]),
    );
    assert.equal(parseEducationPayloadRankableRecordCount({ countries }), 180);
    assert.equal(parseEducationPayloadRankableRecordCount({
      countries: { ...countries, [countryCodes[0]]: { value: null, year: 2024 }, ZZ: { value: 50, year: 2024 } },
    }), 179);
    assert.equal(parseEducationPayloadRankableRecordCount({
      countries: { ...countries, [countryCodes[0]]: { value: 50, year: 2024.5 } },
    }), 179);
    assert.equal(parseEducationPayloadRankableRecordCount({ countries: null }), null);
  });
});
