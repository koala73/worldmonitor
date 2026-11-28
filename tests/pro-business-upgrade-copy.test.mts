/**
 * Locks the in-place Pro → Pro Business upgrade dialog copy and keeps the
 * dashboard (src/) and /pro (pro-test/, a sealed build) wording in step.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
import { catalogTranslate, enTranslate } from './helpers/en-translate.mts';

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
    assert.deepEqual([...IN_PLACE_UPGRADE_SOURCE_PLANS].sort(), ['pro_annual', 'pro_monthly', 'pro_monthly_mcp']);
    const billing = readFileSync(resolve(root, 'convex/payments/billing.ts'), 'utf8');
    assert.match(billing, /pro_monthly: "pro_business_monthly"/);
    assert.match(billing, /pro_monthly_mcp: "pro_business_monthly"/);
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
    assert.match(proSource, /new Set\(\['pro_monthly', 'pro_monthly_mcp', 'pro_annual'\]\)/);
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
      copy.buildSwitchPreviewBody(DISCOUNTED, enTranslate),
      "Your Pro Monthly subscription moves to Pro Yearly now. You pay $104.96 today: your first year at 60% off, less the unused part of this month. Your billing period restarts today. It renews at $359.99 a year plus any tax on November 26, 2027. Cancel anytime before then and you won't be charged again. If the payment fails, you stay on Pro Monthly.",
    );
  });

  it('drops only the offer clause from a list-price quote', () => {
    assert.equal(
      copy.buildSwitchPreviewBody({ ...DISCOUNTED, chargeAmount: 33503, discounted: false, percentOff: null }, enTranslate),
      "Your Pro Monthly subscription moves to Pro Yearly now. You pay $335.03 today: less the unused part of this month. Your billing period restarts today. It renews at $359.99 a year plus any tax on November 26, 2027. Cancel anytime before then and you won't be charged again. If the payment fails, you stay on Pro Monthly.",
    );
  });

  it('never names a percent the quote does not carry', () => {
    assert.doesNotMatch(copy.buildSwitchPreviewBody({ ...DISCOUNTED, percentOff: null }, enTranslate), /% off/);
    assert.doesNotMatch(copy.buildSwitchPreviewBody({ ...DISCOUNTED, discounted: false }, enTranslate), /% off/);
  });

  it('survives a missing renewal price, currency or date', () => {
    const body = copy.buildSwitchPreviewBody({ ...DISCOUNTED, renewalAmount: null, renewalCurrency: null, renewalDate: 'not-a-date' }, enTranslate);
    assert.ok(body.includes('It renews at the Pro Yearly price. Cancel anytime before then'));
    const noCurrency = copy.buildSwitchPreviewBody({ ...DISCOUNTED, currency: 'AED', chargeAmount: 38548, renewalCurrency: null }, enTranslate);
    assert.doesNotMatch(noCurrency, /AED\s?359\.99/);
  });

  it('pins the dialog labels and states', () => {
    const en = copy.switchCopy(enTranslate);
    assert.equal(en.title, 'Switch to Pro Yearly');
    assert.equal(en.confirmLabel, 'Switch now');
    assert.equal(en.dismissLabel, 'Not now');
    assert.equal(en.successTitle, 'Switched to Pro Yearly');
    assert.equal(en.entryLabel, 'Switch to yearly');
    assert.equal(en.doneLabel, 'Done');
    assert.equal(en.closeLabel, 'Close');
    assert.doesNotMatch(en.failedBody, /not been charged|no charge/i);
    assert.match(en.failedBody, /could not confirm/);
  });

  // Every app locale renders the flow from its own catalog: a missing key or a
  // dropped {{placeholder}} throws in catalogTranslate, and the figures survive.
  const APP_LOCALES = readdirSync(resolve(root, 'src/locales'))
    .filter((f) => /^[a-z]{2}(-[A-Z]{2})?\.json$/.test(f))
    .map((f) => f.replace('.json', ''));
  for (const locale of APP_LOCALES) {
    it(`renders the switch copy in ${locale} with every figure`, () => {
      const tr = catalogTranslate(locale);
      const labels = copy.switchCopy(tr);
      for (const [name, value] of Object.entries(labels)) {
        assert.ok(value.trim().length > 0, `${locale} ${name} is empty`);
      }
      const body = copy.buildSwitchPreviewBody(DISCOUNTED, tr, locale);
      for (const figure of ['$104.96', '60', '$359.99', copy.formatRenewalDate(DISCOUNTED.renewalDate, locale)!]) {
        assert.ok(body.includes(figure), `${locale} preview lost ${figure}: ${body}`);
      }
      const line = copy.buildSwitchPromoLine({ listCents: 35999, perMonthCents: 1200, monthlyTotalCents: 47988, savingsVsMonthlyPct: 70 }, tr);
      for (const figure of ['$12.00', '$39.99', '$359.99', '70']) {
        assert.ok(line.includes(figure), `${locale} offer line lost ${figure}: ${line}`);
      }
      if (locale !== 'en') {
        assert.notEqual(labels.entryLabel, 'Switch to yearly', `${locale} entry label is untranslated`);
        assert.notEqual(labels.title, 'Switch to Pro Yearly', `${locale} title is untranslated`);
      }
    });
  }

  it('dates the renewal in the reader locale', () => {
    const body = copy.buildSwitchPreviewBody(DISCOUNTED, enTranslate, 'fr-FR');
    assert.ok(body.includes('26 novembre 2027'), body);
  });

  // PromoDisplayPrices: the savings figure is against twelve monthly payments,
  // so it is always shown beside its monthly reference.
  it('builds the Settings offer line with the monthly reference, the renewal and cancel anytime', () => {
    assert.equal(
      copy.buildSwitchPromoLine({ listCents: 35999, perMonthCents: 1200, monthlyTotalCents: 47988, savingsVsMonthlyPct: 70 }, enTranslate),
      'Black Friday: $12.00 a month instead of $39.99, billed yearly. That is 70% less than paying monthly for your first year. Renews at $359.99 a year. Cancel anytime.',
    );
  });

  it('switches only Pro Monthly, the plan the server switches', () => {
    assert.equal(copy.PRO_ANNUAL_SWITCH_SOURCE_PLAN, 'pro_monthly');
    const billing = readFileSync(resolve(root, 'convex/payments/billing.ts'), 'utf8');
    assert.match(billing, /function selectProAnnualSwitchCandidate/);
  });

  // /pro is a sealed English build; it mirrors the dashboard's English catalog.
  describe('/pro mirrors the switch copy', () => {
    const proSource = readFileSync(resolve(root, 'pro-test/src/services/pro-business-upgrade.ts'), 'utf8');
    const en = copy.switchCopy(enTranslate);
    const k = (name: string, vars?: Record<string, string | number>) => enTranslate(`settings.account.switchYearly.${name}`, vars);
    const shared = [
      k('previewMoves'),
      k('previewRestart'),
      k('previewTerms'),
      en.title,
      en.confirmLabel,
      en.successTitle,
      en.successBody,
      en.cancelScheduledTitle,
      en.cancelScheduledBody,
      en.failedTitle,
      en.failedBody,
      en.accountChangedBody,
      en.quoteChangedNotice,
      en.chargeChangedNotice,
      en.offerNotAppliedNotice,
    ];
    shared.forEach((sentence, index) => {
      it(`/pro mirrors switch sentence ${index}: ${String(sentence).slice(0, 40)}`, () => {
        assert.ok(proSource.includes(sentence), `pro-test copy drifted from src copy: ${sentence}`);
      });
    });
    // /pro builds these sentences from fragments; each fragment must still read the same in the catalog.
    const fragments: Array<[string, string]> = [
      ['your first year at ${preview.percentOff}% off, ', k('previewChargeOffer', { charge: '$1', percent: '${preview.percentOff}' })],
      ['less the unused part of this month. ', k('previewCharge', { charge: '$1' })],
      ['the Pro Yearly price', k('renewsList')],
    ];
    for (const [fragment, sentence] of fragments) {
      it(`/pro and the catalog share: ${fragment.slice(0, 40)}`, () => {
        assert.ok(proSource.includes(fragment), `pro-test lost: ${fragment}`);
        assert.ok(`${sentence} `.includes(fragment), `catalog drifted from /pro: ${sentence}`);
      });
    }
  });
});
