/**
 * Behaviour of the dashboard's in-place Pro → Pro Business upgrade flow.
 * Every service is injected, so this runs without a DOM or Convex.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runProBusinessUpgradeFlow, type ProBusinessUpgradeFlowOptions } from '../src/services/pro-business-upgrade-dialog.ts';
import type { CheckoutConfirmDialogOptions } from '../src/services/checkout-dialog-factory.ts';

const PREVIEW = {
  kind: 'preview' as const,
  fromPlanKey: 'pro_monthly',
  toPlanKey: 'pro_business_monthly',
  chargeAmount: 667,
  currency: 'USD',
  renewalAmount: 4999,
  renewalCurrency: 'USD',
  renewalDate: '2026-12-07T11:03:06Z',
  billingPeriod: 'monthly' as const,
};

function harness(overrides: Partial<ProBusinessUpgradeFlowOptions> = {}) {
  const dialogs: CheckoutConfirmDialogOptions[] = [];
  const calls: boolean[] = [];
  let user: string | undefined = 'user_a';
  let fellBack = false;
  const options: ProBusinessUpgradeFlowOptions = {
    planKey: 'pro_monthly',
    planDisplayName: 'Pro Monthly',
    fallback: () => { fellBack = true; },
    requestUpgrade: async (confirm) => {
      calls.push(confirm);
      return confirm ? { kind: 'upgraded', fromPlanKey: 'pro_monthly', toPlanKey: 'pro_business_monthly' } : PREVIEW;
    },
    currentUserId: () => user,
    openPortal: () => {},
    showDialog: (d) => { dialogs.push(d); },
    errorKind: (err) => (err as { data?: { kind?: string } })?.data?.kind ?? null,
    reportError: () => {},
    ...overrides,
  };
  return {
    options,
    dialogs,
    calls,
    setUser: (next: string | undefined) => { user = next; },
    fellBack: () => fellBack,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('runProBusinessUpgradeFlow', () => {
  it('previews, then applies the change on confirm', async () => {
    const h = harness();
    await runProBusinessUpgradeFlow(h.options);
    assert.equal(h.dialogs[0]?.confirmLabel, 'Upgrade now');
    h.dialogs[0]!.onConfirm();
    await settle();
    assert.deepEqual(h.calls, [false, true]);
    assert.equal(h.dialogs[1]?.title, 'Upgraded to Pro Business');
  });

  it('refuses to confirm after the signed-in account changed', async () => {
    const h = harness();
    await runProBusinessUpgradeFlow(h.options);
    h.setUser('user_b');
    h.dialogs[0]!.onConfirm();
    await settle();
    assert.deepEqual(h.calls, [false], 'no confirm request may reach the server');
    assert.equal(h.dialogs[1]?.title, 'Account changed');
  });

  it('falls back to the guided dialog when the preview fails', async () => {
    const h = harness({ requestUpgrade: async () => { throw new Error('provider down'); } });
    await runProBusinessUpgradeFlow(h.options);
    assert.equal(h.fellBack(), true);
    assert.equal(h.dialogs.length, 0);
  });

  it('asks a cancelling Pro to resume first', async () => {
    const h = harness({ requestUpgrade: async () => { throw Object.assign(new Error('x'), { data: { kind: 'PRO_CANCEL_SCHEDULED' } }); } });
    await runProBusinessUpgradeFlow(h.options);
    assert.equal(h.dialogs[0]?.title, 'Resume Pro first');
  });

  it('never claims "no charge" when the confirm outcome is unknown', async () => {
    let n = 0;
    const h = harness({
      requestUpgrade: async () => {
        n += 1;
        if (n === 1) return PREVIEW;
        throw new Error('timeout');
      },
    });
    await runProBusinessUpgradeFlow(h.options);
    h.dialogs[0]!.onConfirm();
    await settle();
    assert.equal(h.dialogs[1]?.title, 'Upgrade not confirmed');
    assert.match(h.dialogs[1]!.body, /could not confirm/);
  });

  it('falls back for plans it cannot upgrade in place or without a user', async () => {
    const api = harness({ planKey: 'api_starter' });
    await runProBusinessUpgradeFlow(api.options);
    assert.equal(api.fellBack(), true);
    const anon = harness();
    anon.setUser(undefined);
    await runProBusinessUpgradeFlow(anon.options);
    assert.equal(anon.fellBack(), true);
    assert.deepEqual(anon.calls, []);
  });
});
