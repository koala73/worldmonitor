// U1 (#3199) — apiDailyAllowance catalog field + Business marketing copy.
// The per-account rate-limit layer reads features.apiDailyAllowance; these
// values are the single source of truth for the included allowance and the
// 10× safety ceiling, and feed the /pro marketing + docs/usage-rate-limits.mdx.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  getEntitlementFeatures,
  PRODUCT_CATALOG,
} from '../convex/config/productCatalog.ts';

describe('#3199 U1 — apiDailyAllowance per tier', () => {
  it('Starter includes 1,000/day', () => {
    assert.equal(getEntitlementFeatures('api_starter').apiDailyAllowance, 1000);
  });

  it('Business includes 10,000/day', () => {
    assert.equal(getEntitlementFeatures('api_business').apiDailyAllowance, 10000);
  });

  it('Enterprise is unlimited (-1)', () => {
    assert.equal(getEntitlementFeatures('enterprise').apiDailyAllowance, -1);
  });

  it('Free and Pro have no API allowance (0 — they cannot mint wm_ keys)', () => {
    assert.equal(getEntitlementFeatures('free').apiDailyAllowance, 0);
    assert.equal(getEntitlementFeatures('pro_monthly').apiDailyAllowance, 0);
  });

  it('every catalog entry sets apiDailyAllowance explicitly (no undefined in source-of-truth rows)', () => {
    for (const [planKey, entry] of Object.entries(PRODUCT_CATALOG)) {
      assert.equal(
        typeof entry.features.apiDailyAllowance,
        'number',
        `${planKey} must set apiDailyAllowance explicitly`,
      );
    }
  });
});

describe('#3199 U1 — Business marketing differentiation', () => {
  it('Business marketingFeatures is non-empty and advertises per-minute + per-day', () => {
    const business = PRODUCT_CATALOG.api_business.marketingFeatures;
    assert.ok(business.length > 0, 'Business must market its API allowance');
    assert.ok(
      business.some((f) => /requests?\/minute/i.test(f)),
      'Business markets a per-minute burst',
    );
    assert.ok(
      business.some((f) => /10,000 requests\/day/i.test(f)),
      'Business markets its daily included allowance',
    );
  });

  it('Starter daily copy reads "included" (allowance, not hard cap)', () => {
    const starter = PRODUCT_CATALOG.api_starter.marketingFeatures;
    assert.ok(
      starter.some((f) => /1,000 requests\/day included/i.test(f)),
      'Starter daily copy must say "included"',
    );
  });
});
