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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('buildUpgradePreviewBody', () => {
  it('states the charge today, the renewal price and the failure outcome', () => {
    const body = buildUpgradePreviewBody('Pro Monthly', {
      chargeAmount: 667,
      currency: 'USD',
      renewalAmount: 4999,
      billingPeriod: 'monthly',
    });
    assert.equal(
      body,
      'Your Pro Monthly subscription moves to Pro Business now. You pay $6.67 today for the rest of this billing period, then $49.99 a month plus any tax from your next renewal. If the payment fails, you stay on Pro.',
    );
  });

  it('uses the annual period and survives a missing renewal amount', () => {
    const annual = buildUpgradePreviewBody('Pro Annual', {
      chargeAmount: 6000,
      currency: 'USD',
      renewalAmount: 44999,
      billingPeriod: 'annual',
    });
    assert.ok(annual.includes('$449.99 a year'));
    const unknown = buildUpgradePreviewBody('Pro', {
      chargeAmount: 100,
      currency: 'USD',
      renewalAmount: null,
      billingPeriod: 'monthly',
    });
    assert.ok(unknown.includes('then the Pro Business price from your next renewal'));
  });

  it('never promises "no charge" for an unconfirmed outcome', () => {
    assert.doesNotMatch(UPGRADE_FAILED_BODY, /not been charged|no charge/i);
    assert.match(UPGRADE_FAILED_BODY, /could not confirm/);
  });

  it('formats an unknown currency code without throwing', () => {
    assert.equal(formatMinorAmount(1234, 'NOTACURRENCY'), '12.34 NOTACURRENCY');
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
    'today for the rest of this billing period, ',
    'If the payment fails, you stay on Pro.',
    'then the Pro Business price from your next renewal',
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
