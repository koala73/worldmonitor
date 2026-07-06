/**
 * Annual-toggle billing-mode contract (#4946 round 4).
 *
 * With the page-level toggle on "Annual", a monthly-only tier (API
 * Business) must still resolve to its monthly product — but EXPLICITLY,
 * with `billedMonthlyOnly` set so the card renders a "billed monthly"
 * note. Silently entering a monthly checkout from an annual-selected
 * state is the regression this suite pins.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolveCheckoutProduct } from '../pro-test/src/components/pricing-billing-mode.ts';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

describe('resolveCheckoutProduct', () => {
  const proLike = { monthlyProductId: 'pdt_month', annualProductId: 'pdt_year' };
  const businessLike = { monthlyProductId: 'pdt_month_only' };

  it('annual mode with an annual product resolves annual, no note', () => {
    assert.deepEqual(resolveCheckoutProduct(proLike, 'annual'), {
      productId: 'pdt_year',
      billedMonthlyOnly: false,
    });
  });

  it('annual mode on a monthly-only tier resolves monthly WITH the explicit note flag', () => {
    assert.deepEqual(resolveCheckoutProduct(businessLike, 'annual'), {
      productId: 'pdt_month_only',
      billedMonthlyOnly: true,
    });
  });

  it('monthly mode never sets the note flag', () => {
    assert.deepEqual(resolveCheckoutProduct(proLike, 'monthly'), {
      productId: 'pdt_month',
      billedMonthlyOnly: false,
    });
    assert.deepEqual(resolveCheckoutProduct(businessLike, 'monthly'), {
      productId: 'pdt_month_only',
      billedMonthlyOnly: false,
    });
  });

  it('non-purchasable tiers (free/enterprise) resolve to null', () => {
    assert.equal(resolveCheckoutProduct({}, 'annual'), null);
    assert.equal(resolveCheckoutProduct({}, 'monthly'), null);
  });
});

describe('PricingSection wiring (source contract)', () => {
  it('renders the billed-monthly note and routes CTAs through the resolver', () => {
    const src = read('pro-test/src/components/PricingSection.tsx');
    assert.ok(src.includes('resolveCheckoutProduct(tier, billing)'),
      'getCtaProps no longer routes through resolveCheckoutProduct');
    assert.ok(src.includes('cta.billedMonthlyOnly'),
      'the card no longer renders the billed-monthly note for monthly-only tiers in annual mode');
    assert.ok(src.includes("pricing.billedMonthlyNote"),
      'billed-monthly note copy key missing');
  });
});
