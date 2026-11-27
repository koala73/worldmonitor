/**
 * Locks the in-place Pro → API Starter switch dialog copy and keeps the
 * dashboard (src/) and /pro (pro-test/, a sealed build) wording in step.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as copy from '../src/services/api-starter-switch-copy.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MONTHLY = {
  fromPlanKey: 'pro_monthly',
  chargeAmount: 6012,
  currency: 'USD',
  renewalAmount: 9999,
  renewalCurrency: 'USD',
  renewalDate: '2026-12-27T10:00:00Z',
  billingPeriod: 'monthly' as const,
};

const ANNUAL = {
  fromPlanKey: 'pro_annual',
  chargeAmount: 61204,
  currency: 'USD',
  renewalAmount: 89999,
  renewalCurrency: 'USD',
  renewalDate: '2027-11-27T10:00:00Z',
  billingPeriod: 'annual' as const,
};

describe('buildApiStarterSwitchBody', () => {
  it('states the prorated charge, the restart, the renewal, the key location and the failure outcome', () => {
    assert.equal(
      copy.buildApiStarterSwitchBody(MONTHLY),
      'Your Pro Monthly subscription moves to API Starter now. You pay $60.12 today, less the unused part of this month. ' +
        'Your billing period restarts today. It renews at $99.99 a month plus any tax on December 27, 2026. ' +
        'Your dashboard stays the same, and you can create an API key in Settings, under API keys. ' +
        'If the payment fails, you stay on Pro Monthly.',
    );
  });

  it('names Pro Yearly and the year for an annual switch', () => {
    assert.equal(
      copy.buildApiStarterSwitchBody(ANNUAL),
      'Your Pro Yearly subscription moves to API Starter now. You pay $612.04 today, less the unused part of this year. ' +
        'Your billing period restarts today. It renews at $899.99 a year plus any tax on November 27, 2027. ' +
        'Your dashboard stays the same, and you can create an API key in Settings, under API keys. ' +
        'If the payment fails, you stay on Pro Yearly.',
    );
  });

  it('calls the MCP monthly plan Pro Monthly', () => {
    assert.match(copy.buildApiStarterSwitchBody({ ...MONTHLY, fromPlanKey: 'pro_monthly_mcp' }), /^Your Pro Monthly subscription/);
  });

  it('never prints a plan key the copy does not know', () => {
    const body = copy.buildApiStarterSwitchBody({ ...MONTHLY, fromPlanKey: 'pro_<script>' });
    assert.doesNotMatch(body, /<script>|pro_/);
    assert.match(body, /^Your Pro subscription moves to API Starter now\./);
    assert.match(body, /you stay on Pro\.$/);
  });

  it('survives a missing renewal price, currency or date, and never borrows the charge currency', () => {
    const body = copy.buildApiStarterSwitchBody({ ...MONTHLY, renewalAmount: null, renewalCurrency: null, renewalDate: 'not-a-date' });
    assert.ok(body.includes('It renews at the API Starter price. Your dashboard stays the same'));
    const adaptive = copy.buildApiStarterSwitchBody({ ...MONTHLY, currency: 'AED', chargeAmount: 22080, renewalCurrency: null });
    assert.match(adaptive, /You pay AED\s?220\.80 today/);
    assert.doesNotMatch(adaptive, /AED\s?99\.99/);
  });

  it('uses no dash as punctuation', () => {
    for (const text of [copy.buildApiStarterSwitchBody(MONTHLY), copy.API_SWITCH_SUCCESS_BODY, copy.API_SWITCH_CANCEL_SCHEDULED_BODY]) {
      assert.doesNotMatch(text, /\s[-–—]\s|—/);
    }
  });
});

describe('API Starter switch labels and states', () => {
  it('pins the dialog labels', () => {
    assert.equal(copy.API_SWITCH_TITLE, 'Switch to API Starter');
    assert.equal(copy.API_SWITCH_ENTRY_LABEL, 'Switch to API Starter');
    assert.equal(copy.API_SWITCH_CONFIRM_LABEL, 'Switch now');
    assert.equal(copy.API_SWITCH_DISMISS_LABEL, 'Not now');
    assert.equal(copy.API_SWITCH_SUCCESS_TITLE, 'Switched to API Starter');
  });

  it('tells the buyer when the plan changes and where keys are made', () => {
    assert.equal(
      copy.API_SWITCH_SUCCESS_BODY,
      'Your plan changes as soon as the payment confirms, usually within a minute. Then you can create an API key in Settings, under API keys.',
    );
  });

  it('sends a cancel-scheduled Pro to the billing portal first', () => {
    assert.equal(copy.API_SWITCH_CANCEL_SCHEDULED_TITLE, 'Resume Pro first');
    assert.equal(
      copy.API_SWITCH_CANCEL_SCHEDULED_BODY,
      'Your Pro subscription is set to cancel at the end of this period. Resume it in the billing portal first, then switch to API Starter.',
    );
  });

  it('never promises the failed confirm charged nothing', () => {
    assert.equal(copy.API_SWITCH_FAILED_TITLE, 'Switch not confirmed');
    assert.match(copy.API_SWITCH_FAILED_BODY, /could not confirm/);
    assert.doesNotMatch(copy.API_SWITCH_FAILED_BODY, /not been charged|no charge/i);
  });

  it('names the account change', () => {
    assert.equal(
      copy.API_SWITCH_ACCOUNT_CHANGED_BODY,
      'You switched accounts after this quote. Start the switch again from the account you want to move to API Starter.',
    );
  });

  it('switches the plans the server switches, to the plans it targets', () => {
    assert.deepEqual([...copy.API_STARTER_SWITCH_SOURCE_PLANS].sort(), ['pro_annual', 'pro_monthly', 'pro_monthly_mcp']);
    assert.deepEqual([...copy.API_STARTER_SWITCH_TARGET_PLANS].sort(), ['api_starter', 'api_starter_annual']);
    const billing = readFileSync(resolve(root, 'convex/payments/billing.ts'), 'utf8');
    const targets = billing.match(/export const API_STARTER_SWITCH_TARGETS[^}]*}/)?.[0] ?? '';
    for (const plan of copy.API_STARTER_SWITCH_SOURCE_PLANS) assert.match(targets, new RegExp(`\\b${plan}:`));
    for (const plan of copy.API_STARTER_SWITCH_TARGET_PLANS) assert.match(targets, new RegExp(`"${plan}"`));
  });
});

describe('/pro mirrors the API Starter switch copy', () => {
  const proSource = readFileSync(resolve(root, 'pro-test/src/services/pro-business-upgrade.ts'), 'utf8');
  const shared = [
    ' subscription moves to API Starter now. ',
    ' today, less the unused part of this ',
    '. Your billing period restarts today. ',
    'Your dashboard stays the same, and you can create an API key in Settings, under API keys. ',
    'the API Starter price',
    copy.API_SWITCH_TITLE,
    copy.API_SWITCH_SUCCESS_TITLE,
    copy.API_SWITCH_SUCCESS_BODY,
    copy.API_SWITCH_CANCEL_SCHEDULED_TITLE,
    copy.API_SWITCH_CANCEL_SCHEDULED_BODY,
    copy.API_SWITCH_ACCOUNT_CHANGED_BODY,
    copy.API_SWITCH_FAILED_TITLE,
    copy.API_SWITCH_FAILED_BODY,
    copy.API_SWITCH_CHARGE_CHANGED_NOTICE,
    copy.API_SWITCH_UNAVAILABLE_BODY,
  ];
  shared.forEach((sentence, index) => {
    it(`/pro mirrors API Starter sentence ${index}: ${String(sentence).slice(0, 40)}`, () => {
      assert.equal(typeof sentence, 'string', 'the src copy defines this sentence');
      assert.ok(proSource.includes(sentence), `pro-test copy drifted from src copy: ${sentence}`);
    });
  });
});
