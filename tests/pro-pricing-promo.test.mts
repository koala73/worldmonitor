import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { promoPricingForTier } from '../pro-test/src/components/pricing-promo.ts';
import {
  formatPromoEnd,
  promoDisplayPrices,
  type PromoCampaign,
} from '../shared/promo-campaign.ts';

const PROMO: PromoCampaign = {
  id: 'test-promo',
  discountCode: 'TESTCODE',
  productId: 'pdt_yearly',
  planKey: 'pro_annual',
  monthlyPlanKey: 'pro_monthly',
  percentOff: 60,
  startsAtMs: Date.UTC(2026, 10, 26, 0, 0, 0),
  endsAtMs: Date.UTC(2026, 11, 4, 23, 45, 0),
};

const PRO = { annualProductId: 'pdt_yearly', annualPrice: 359.99, monthlyPrice: 39.99 };

describe('promoDisplayPrices', () => {
  it('derives 70% against paying monthly from 60% off the yearly price', () => {
    const prices = promoDisplayPrices(PROMO, 359.99, 39.99);
    assert.deepEqual(prices, {
      listCents: 35999,
      promoCents: 14400,
      perMonthCents: 1200,
      monthlyTotalCents: 47988,
      savingsVsMonthlyPct: 70,
    });
  });

  it('drops the monthly comparison without a monthly price', () => {
    const prices = promoDisplayPrices(PROMO, 359.99, undefined);
    assert.equal(prices?.promoCents, 14400);
    assert.equal(prices?.savingsVsMonthlyPct, null);
    assert.equal(prices?.monthlyTotalCents, null);
  });

  it('drops a monthly comparison that is not better than the yearly discount', () => {
    // Monthly priced at exactly a twelfth of yearly: the comparison is 60%.
    const prices = promoDisplayPrices(PROMO, 120, 10);
    assert.equal(prices?.savingsVsMonthlyPct, null);
  });

  it('is null without a usable yearly price', () => {
    assert.equal(promoDisplayPrices(PROMO, null, 39.99), null);
    assert.equal(promoDisplayPrices(PROMO, 0, 39.99), null);
  });
});

describe('promoPricingForTier (the /pro Pro card)', () => {
  it('formats the figures the card shows', () => {
    assert.deepEqual(promoPricingForTier(PRO, PROMO), {
      listLabel: '$359.99',
      promoLabel: '$144',
      perMonthLabel: '$12.00',
      percentOff: 60,
      monthlyTotalLabel: '$479.88',
      savingsVsMonthlyPct: 70,
    });
  });

  it('is null for other tiers and when no promotion runs', () => {
    assert.equal(promoPricingForTier({ ...PRO, annualProductId: 'pdt_other' }, PROMO), null);
    assert.equal(promoPricingForTier(PRO, null), null);
  });

  it('falls back to the yearly wording when the monthly price is missing', () => {
    const pricing = promoPricingForTier({ annualProductId: 'pdt_yearly', annualPrice: 359.99 }, PROMO);
    assert.equal(pricing?.savingsVsMonthlyPct, null);
    assert.equal(pricing?.monthlyTotalLabel, null);
    assert.equal(pricing?.percentOff, 60);
  });
});

describe('formatPromoEnd', () => {
  it('shows the last minute of the offer in the reader time zone', () => {
    assert.equal(formatPromoEnd(PROMO.endsAtMs, 'en-US', 'America/Los_Angeles'), 'Fri, Dec 4, 3:44 PM');
    assert.equal(formatPromoEnd(PROMO.endsAtMs, 'en-US', 'Asia/Dubai'), 'Sat, Dec 5, 3:44 AM');
  });
});

describe('promo copy', () => {
  const en = JSON.parse(readFileSync(new URL('../pro-test/src/locales/en.json', import.meta.url), 'utf8'));
  const app = JSON.parse(readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8'));

  it('names its monthly reference or the first year wherever the monthly saving appears', () => {
    const promo = en.pricing.promo as Record<string, string>;
    assert.match(promo.stripHeadline, /\{\{perMonth\}\} a month, billed yearly/);
    assert.match(promo.stripDetail, /\{\{monthlyTotal\}\} paying monthly/);
    assert.match(promo.monthlyNote, /with yearly/);
    assert.match(app.components.proBanner.promoHeadline, /first year/);
    // The dashboard strip's monthly-comparison variant names the monthly price
    // its saving is measured against, in every locale and in the shell copy.
    const appLocales = readdirSync(new URL('../src/locales/', import.meta.url))
      .filter((file) => file.endsWith('.json'));
    for (const file of appLocales) {
      const locale = JSON.parse(readFileSync(new URL(`../src/locales/${file}`, import.meta.url), 'utf8'));
      const tagline = locale.components?.proBanner?.promoTagline;
      if (typeof tagline !== 'string') continue;
      assert.match(tagline, /\{\{monthly\}\}/, `${file} promoTagline`);
      assert.match(tagline, /\{\{perMonth\}\}/, `${file} promoTagline`);
    }
  });

  it('states the renewal price and the cancel terms, with the offer end kept apart', () => {
    const promo = en.pricing.promo as Record<string, string>;
    for (const key of ['stripDetail', 'stripDetailYearlyOnly']) {
      assert.match(promo[key], /Renews at \{\{listPrice\}\} a year/, key);
      assert.match(promo[key], /Cancel anytime/, key);
      // The offer deadline is its own element, so it never reads as the
      // deadline for cancelling.
      assert.doesNotMatch(promo[key], /\{\{date\}\}/, key);
    }
    assert.equal(promo.stripEnds, 'Ends {{date}}.');
    assert.match(promo.cancelNote, /^Cancel anytime\./);
    // Cancelling stops the renewal; nothing promises money back.
    for (const value of Object.values(promo)) assert.doesNotMatch(value, /refund/i, value);
    assert.match(app.components.proBanner.promoTagline, /Cancel anytime/);
  });

  it('carries no hardcoded price or percentage', () => {
    const strings = [
      ...Object.values(en.pricing.promo as Record<string, string>),
      ...Object.entries(app.components.proBanner as Record<string, string>)
        .filter(([key]) => key.startsWith('promo'))
        .map(([, value]) => value),
    ];
    for (const value of strings) assert.doesNotMatch(value, /\$\d|\d+%/, value);
  });
});
