import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateGeneratedRequest } from '../server/request-validator.ts';

const PANEL_RPCS = [
  'getCountryStockIndex',
  'getCountryFacts',
  'getCountryRisk',
];

describe('generated validation vs. panel country codes', () => {
  for (const method of PANEL_RPCS) {
    it(`${method}: rejects lowercase, accepts uppercase`, () => {
      const lower = validateGeneratedRequest(method, { countryCode: 'de' });
      assert.ok(
        lower && lower.some((v) => v.field === 'countryCode'),
        `${method} accepted a lowercase code — if the validator relaxed, `
        + 'this suite is guarding a constraint that no longer exists',
      );
      const upper = validateGeneratedRequest(method, { countryCode: 'DE' });
      assert.equal(upper, undefined, `${method} must accept an uppercase code`);
    });
  }
});
