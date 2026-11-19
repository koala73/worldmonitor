import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DODO_PRODUCTS, parseDodoProductId } from '../src/config/products.ts';

const PLAN_KEYS = [
  'pro_monthly',
  'pro_annual',
  'pro_business_monthly',
  'pro_business_annual',
  'api_starter',
  'api_business',
  'enterprise',
  'free',
];

describe('parseDodoProductId', () => {
  it('rejects plan keys', () => {
    for (const planKey of PLAN_KEYS) {
      assert.equal(parseDodoProductId(planKey), null, planKey);
    }
  });

  it('accepts every catalog product id', () => {
    for (const productId of Object.values(DODO_PRODUCTS)) {
      assert.equal(parseDodoProductId(productId), productId);
    }
  });
});
