import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  ACTIVE_PROMO,
  activePromo,
  activePromoFor,
  promoPriceCents,
  type PromoCampaign,
} from '../shared/promo-campaign.ts';

const PROMO: PromoCampaign = {
  id: 'test-promo',
  discountCode: 'TESTCODE',
  productId: 'pdt_test_yearly',
  planKey: 'pro_annual',
  monthlyPlanKey: 'pro_monthly',
  percentOff: 60,
  startsAtMs: Date.UTC(2026, 10, 26, 0, 0, 0),
  endsAtMs: Date.UTC(2026, 11, 4, 23, 45, 0),
};

describe('activePromo', () => {
  it('runs until the instant before the end and stops at it', () => {
    assert.equal(activePromo(PROMO.endsAtMs - 1, PROMO), PROMO);
    assert.equal(activePromo(PROMO.endsAtMs, PROMO), null);
    assert.equal(activePromo(PROMO.endsAtMs + 1, PROMO), null);
  });

  it('is not running before its start, so tests pinned to an old clock stay off it', () => {
    assert.equal(activePromo(PROMO.startsAtMs - 1, PROMO), null);
    assert.equal(activePromo(PROMO.startsAtMs, PROMO), PROMO);
    assert.equal(activePromo(0, PROMO), null);
  });

  it('is null with no promotion configured or an unusable clock', () => {
    assert.equal(activePromo(0, null), null);
    assert.equal(activePromo(Number.NaN, PROMO), null);
  });
});

describe('activePromoFor', () => {
  it('applies only to the product the code is restricted to', () => {
    assert.equal(activePromoFor('pdt_test_yearly', PROMO.endsAtMs - 1, PROMO), PROMO);
    assert.equal(activePromoFor('pdt_other', PROMO.endsAtMs - 1, PROMO), null);
    assert.equal(activePromoFor('pdt_test_yearly', PROMO.endsAtMs, PROMO), null);
  });
});

describe('promoPriceCents matches what Dodo charged', () => {
  it('rounds the discount down and the charge up', () => {
    // Live checkout form and change-plan preview on 2026-11-26.
    assert.equal(promoPriceCents(35999, 50), 18000);
    assert.equal(promoPriceCents(35999, 60), 14400);
    assert.equal(promoPriceCents(10000, 60), 4000);
  });
});

describe('the configured promotion', () => {
  it('targets the catalog Pro Yearly product and plan', () => {
    assert.ok(ACTIVE_PROMO, 'a promotion is configured');
    const catalog = readFileSync(new URL('../convex/config/productCatalog.ts', import.meta.url), 'utf8');
    const block = catalog.match(/pro_annual:\s*\{[\s\S]*?dodoProductId:\s*"([^"]+)"/);
    assert.equal(block?.[1], ACTIVE_PROMO.productId);
    assert.equal(ACTIVE_PROMO.planKey, 'pro_annual');
  });

  it('keeps the percentage a separate field from the code text', () => {
    assert.ok(ACTIVE_PROMO);
    assert.equal(ACTIVE_PROMO.percentOff, 60);
    assert.ok(ACTIVE_PROMO.discountCode.length >= 3);
  });

  it('ends at 23:45 UTC on 4 December 2026, before the Dodo code expires', () => {
    assert.ok(ACTIVE_PROMO);
    assert.equal(ACTIVE_PROMO.discountCode, 'BLACKFRIDAY');
    assert.equal(new Date(ACTIVE_PROMO.endsAtMs).toISOString(), '2026-12-04T23:45:00.000Z');
    assert.ok(ACTIVE_PROMO.endsAtMs < Date.parse('2026-12-04T23:59:59.999Z'));
  });
});
