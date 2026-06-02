import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  MIN_DISPLACEMENT_COUNTRIES,
  declareRecords,
  validate,
} from '../scripts/seed-displacement-summary.mjs';

function payloadWithCountries(count) {
  return {
    summary: {
      year: new Date().getFullYear(),
      globalTotals: { refugees: 0, asylumSeekers: 0, idps: 0, stateless: 0, total: 0 },
      countries: Array.from({ length: count }, (_, index) => ({
        code: `X${index}`,
        name: `Country ${index}`,
        totalDisplaced: 0,
        hostTotal: 0,
      })),
      topFlows: [],
    },
  };
}

describe('seed-displacement-summary validation floor', () => {
  it('rejects a one-country partial UNHCR payload', () => {
    assert.equal(validate(payloadWithCountries(1)), false);
  });

  it('rejects payloads below the displacement country floor', () => {
    assert.equal(validate(payloadWithCountries(MIN_DISPLACEMENT_COUNTRIES - 1)), false);
  });

  it('accepts payloads at the displacement country floor', () => {
    assert.equal(validate(payloadWithCountries(MIN_DISPLACEMENT_COUNTRIES)), true);
  });

  it('declares the same country count that validation gates', () => {
    const payload = payloadWithCountries(MIN_DISPLACEMENT_COUNTRIES);
    assert.equal(declareRecords(payload), MIN_DISPLACEMENT_COUNTRIES);
  });

  it('treats sub-floor validation failure as a strict seeder failure', () => {
    const src = readFileSync(new URL('../scripts/seed-displacement-summary.mjs', import.meta.url), 'utf8');
    assert.match(src, /emptyDataIsFailure:\s*true/);
  });
});
