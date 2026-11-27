/**
 * Locks the in-place Pro → Pro Business upgrade dialog copy and keeps the
 * dashboard (src/) and /pro (pro-test/, a sealed build) wording in step.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IN_PLACE_UPGRADE_SOURCE_PLANS,
  UPGRADE_ACCOUNT_CHANGED_BODY,
  UPGRADE_CANCEL_SCHEDULED_BODY,
  UPGRADE_FAILED_BODY,
  UPGRADE_SUCCESS_BODY,
  buildUpgradePreviewBody,
  formatMinorAmount,
} from '../src/services/pro-business-upgrade-copy.ts';
import * as copy from '../src/services/pro-business-upgrade-copy.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('buildUpgradePreviewBody', () => {
  it('states the charge today, the restarted period, the renewal and the failure outcome', () => {
    const body = buildUpgradePreviewBody('Pro Monthly', {
      chargeAmount: 667,
      currency: 'USD',
      renewalAmount: 4999,
      renewalCurrency: 'USD',
      renewalDate: '2026-12-07T11:03:06.344647383Z',
      billingPeriod: 'monthly',
    });
    assert.equal(
      body,
      'Your Pro Monthly subscription moves to Pro Business now. You pay $6.67 today and your billing period restarts today. It renews at $49.99 a month plus any tax on December 7, 2026. If the payment fails, you stay on Pro.',
    );
  });

  // Shape of a live Dodo preview (2026-11-07): the charge is in the customer's
  // adaptive currency, the new plan's recurring price stays in USD.
  it('formats the renewal in the plan currency, not the charge currency', () => {
    const body = buildUpgradePreviewBody('Pro Monthly', {
      chargeAmount: 20053,
      currency: 'AED',
      renewalAmount: 4999,
      renewalCurrency: 'USD',
      renewalDate: '2026-12-07T11:03:06Z',
      billingPeriod: 'monthly',
    });
    assert.match(body, /You pay AED\s?200\.53 today/);
    assert.ok(body.includes('It renews at $49.99 a month plus any tax on December 7, 2026.'));
  });

  it('uses the annual period and survives a missing renewal amount, currency or date', () => {
    const annual = buildUpgradePreviewBody('Pro Annual', {
      chargeAmount: 6000,
      currency: 'USD',
      renewalAmount: 44999,
      renewalCurrency: 'USD',
      renewalDate: null,
      billingPeriod: 'annual',
    });
    assert.ok(annual.includes('It renews at $449.99 a year plus any tax.'));
    const unknown = buildUpgradePreviewBody('Pro', {
      chargeAmount: 100,
      currency: 'USD',
      renewalAmount: null,
      renewalCurrency: null,
      renewalDate: 'not-a-date',
      billingPeriod: 'monthly',
    });
    assert.ok(unknown.includes('It renews at the Pro Business price.'));
  });

  it('names no renewal number when its currency is missing, instead of borrowing the charge currency', () => {
    const body = buildUpgradePreviewBody('Pro Monthly', {
      chargeAmount: 20053,
      currency: 'AED',
      renewalAmount: 4999,
      renewalCurrency: null,
      renewalDate: '2026-12-07T11:03:06Z',
      billingPeriod: 'monthly',
    });
    assert.doesNotMatch(body, /AED\s?49\.99/);
    assert.ok(body.includes('It renews at the Pro Business price on December 7, 2026.'));
  });

  it('never claims the charge covers only the rest of the old period', () => {
    const body = buildUpgradePreviewBody('Pro', {
      chargeAmount: 100, currency: 'USD', renewalAmount: 4999, renewalCurrency: 'USD', renewalDate: null, billingPeriod: 'monthly',
    });
    assert.doesNotMatch(body, /rest of (this|the) billing period|next renewal/);
  });

  it('never promises "no charge" for an unconfirmed outcome', () => {
    assert.doesNotMatch(UPGRADE_FAILED_BODY, /not been charged|no charge/i);
    assert.match(UPGRADE_FAILED_BODY, /could not confirm/);
  });

  it('formats an unknown currency code without throwing', () => {
    assert.equal(formatMinorAmount(1234, 'NOTACURRENCY'), '12.34 NOTACURRENCY');
  });

  it('uses each currency\'s minor-unit exponent', () => {
    assert.equal(formatMinorAmount(667, 'USD'), '$6.67');
    assert.equal(formatMinorAmount(1000, 'JPY'), '¥1,000');
    assert.equal(formatMinorAmount(12345, 'KWD').replace(/\s/g, ' '), 'KWD 12.345');
  });

  it('upgrades only the plans the server maps', () => {
    assert.deepEqual([...IN_PLACE_UPGRADE_SOURCE_PLANS].sort(), ['pro_annual', 'pro_monthly']);
    const billing = readFileSync(resolve(root, 'convex/payments/billing.ts'), 'utf8');
    assert.match(billing, /pro_monthly: "pro_business_monthly"/);
    assert.match(billing, /pro_annual: "pro_business_annual"/);
  });
});

describe('cross-app copy parity (dashboard vs /pro)', () => {
  const proSource = readFileSync(resolve(root, 'pro-test/src/services/pro-business-upgrade.ts'), 'utf8');
  const shared = [
    'subscription moves to Pro Business now. ',
    'today and your billing period restarts today. ',
    'If the payment fails, you stay on Pro.',
    'the Pro Business price',
    "new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })",
    "preview.renewalAmount === null || !preview.renewalCurrency",
    UPGRADE_SUCCESS_BODY,
    UPGRADE_CANCEL_SCHEDULED_BODY,
    UPGRADE_FAILED_BODY,
    UPGRADE_ACCOUNT_CHANGED_BODY,
  ];
  for (const sentence of shared) {
    it(`/pro mirrors: ${sentence.slice(0, 48)}`, () => {
      assert.ok(proSource.includes(sentence), `pro-test copy drifted from src copy: ${sentence}`);
    });
  }
  it('/pro upgrades the same source plans', () => {
    assert.match(proSource, /new Set\(\['pro_monthly', 'pro_annual'\]\)/);
  });
});

describe('Pro Monthly → Pro Yearly switch copy', () => {
  // Live P2 preview shape with the offer code (2026-11-26): the server quotes
  // the renewal from the catalog list price, not Dodo's discounted 14400.
  const DISCOUNTED = {
    chargeAmount: 10496,
    currency: 'USD',
    renewalAmount: 35999,
    renewalCurrency: 'USD',
    renewalDate: '2027-11-26T10:00:00Z',
    discounted: true,
    percentOff: 60,
  };

  it('states the discounted first year, the credit, the restart, the list renewal and the failure outcome', () => {
    assert.equal(
      copy.buildSwitchPreviewBody(DISCOUNTED),
      "Your Pro Monthly subscription moves to Pro Yearly now. You pay $104.96 today: your first year at 60% off, less the unused part of this month. Your billing period restarts today. It renews at $359.99 a year plus any tax on November 26, 2027. Cancel anytime before then and you won't be charged again. If the payment fails, you stay on Pro Monthly.",
    );
  });

  it('drops only the offer clause from a list-price quote', () => {
    assert.equal(
      copy.buildSwitchPreviewBody({ ...DISCOUNTED, chargeAmount: 33503, discounted: false, percentOff: null }),
      "Your Pro Monthly subscription moves to Pro Yearly now. You pay $335.03 today: less the unused part of this month. Your billing period restarts today. It renews at $359.99 a year plus any tax on November 26, 2027. Cancel anytime before then and you won't be charged again. If the payment fails, you stay on Pro Monthly.",
    );
  });

  it('never names a percent the quote does not carry', () => {
    assert.doesNotMatch(copy.buildSwitchPreviewBody({ ...DISCOUNTED, percentOff: null }), /% off/);
    assert.doesNotMatch(copy.buildSwitchPreviewBody({ ...DISCOUNTED, discounted: false }), /% off/);
  });

  it('survives a missing renewal price, currency or date', () => {
    const body = copy.buildSwitchPreviewBody({ ...DISCOUNTED, renewalAmount: null, renewalCurrency: null, renewalDate: 'not-a-date' });
    assert.ok(body.includes('It renews at the Pro Yearly price. Cancel anytime before then'));
    const noCurrency = copy.buildSwitchPreviewBody({ ...DISCOUNTED, currency: 'AED', chargeAmount: 38548, renewalCurrency: null });
    assert.doesNotMatch(noCurrency, /AED\s?359\.99/);
  });

  it('pins the dialog labels and states', () => {
    assert.equal(copy.SWITCH_TITLE, 'Switch to Pro Yearly');
    assert.equal(copy.SWITCH_CONFIRM_LABEL, 'Switch now');
    assert.equal(copy.SWITCH_DISMISS_LABEL, 'Not now');
    assert.equal(copy.SWITCH_SUCCESS_TITLE, 'Switched to Pro Yearly');
    assert.equal(copy.SWITCH_ENTRY_LABEL, 'Switch to yearly');
    assert.doesNotMatch(copy.SWITCH_FAILED_BODY, /not been charged|no charge/i);
    assert.match(copy.SWITCH_FAILED_BODY, /could not confirm/);
  });

  // PromoDisplayPrices: the savings figure is against twelve monthly payments,
  // so it is always shown beside its monthly reference.
  it('builds the Settings offer line with the monthly reference, the renewal and cancel anytime', () => {
    assert.equal(
      copy.buildSwitchPromoLine({ listCents: 35999, perMonthCents: 1200, monthlyTotalCents: 47988, savingsVsMonthlyPct: 70 }),
      'Black Friday: $12.00 a month instead of $39.99, billed yearly. That is 70% less than paying monthly for your first year. Renews at $359.99 a year. Cancel anytime.',
    );
  });

  it('switches only Pro Monthly, the plan the server switches', () => {
    assert.equal(copy.PRO_ANNUAL_SWITCH_SOURCE_PLAN, 'pro_monthly');
    const billing = readFileSync(resolve(root, 'convex/payments/billing.ts'), 'utf8');
    assert.match(billing, /function selectProAnnualSwitchCandidate/);
  });

  describe('/pro mirrors the switch copy', () => {
    const proSource = readFileSync(resolve(root, 'pro-test/src/services/pro-business-upgrade.ts'), 'utf8');
    const shared = [
      'Your Pro Monthly subscription moves to Pro Yearly now. ',
      'your first year at ${preview.percentOff}% off, ',
      'less the unused part of this month. Your billing period restarts today. ',
      "Cancel anytime before then and you won't be charged again. If the payment fails, you stay on Pro Monthly.",
      'the Pro Yearly price',
      copy.SWITCH_TITLE,
      copy.SWITCH_CONFIRM_LABEL,
      copy.SWITCH_SUCCESS_TITLE,
      copy.SWITCH_SUCCESS_BODY,
      copy.SWITCH_CANCEL_SCHEDULED_TITLE,
      copy.SWITCH_CANCEL_SCHEDULED_BODY,
      copy.SWITCH_FAILED_TITLE,
      copy.SWITCH_FAILED_BODY,
      copy.SWITCH_ACCOUNT_CHANGED_BODY,
      copy.SWITCH_QUOTE_CHANGED_NOTICE,
      copy.SWITCH_CHARGE_CHANGED_NOTICE,
      copy.SWITCH_OFFER_NOT_APPLIED_NOTICE,
    ];
    shared.forEach((sentence, index) => {
      it(`/pro mirrors switch sentence ${index}: ${String(sentence).slice(0, 40)}`, () => {
        assert.equal(typeof sentence, 'string', 'the src copy defines this sentence');
        assert.ok(proSource.includes(sentence), `pro-test copy drifted from src copy: ${sentence}`);
      });
    });
  });
});
