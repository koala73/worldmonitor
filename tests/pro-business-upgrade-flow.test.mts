/**
 * Behaviour of the dashboard's in-place Pro → Pro Business upgrade flow.
 * Every service is injected, so this runs without a DOM or Convex.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as flows from '../src/services/pro-business-upgrade-dialog.ts';
import type { ProAnnualSwitchFlowOptions, ProBusinessUpgradeFlowOptions } from '../src/services/pro-business-upgrade-dialog.ts';
import type { CheckoutConfirmDialogOptions } from '../src/services/checkout-dialog-factory.ts';
import type { ProBusinessUpgradeResponse } from '../src/services/billing.ts';
import { enTranslate } from './helpers/en-translate.mts';

const { runProBusinessUpgradeFlow } = flows;
// A namespace read, so the suite still loads (and fails per test) without the switch flow.
const runProAnnualSwitchFlow = (options: ProAnnualSwitchFlowOptions) => flows.runProAnnualSwitchFlow(options);

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

const SWITCH_QUOTE = {
  kind: 'preview' as const,
  fromPlanKey: 'pro_monthly',
  toPlanKey: 'pro_annual',
  chargeAmount: 10496,
  currency: 'USD',
  renewalAmount: 35999,
  renewalCurrency: 'USD',
  renewalDate: '2027-11-26T10:00:00Z',
  billingPeriod: 'annual' as const,
  discounted: true,
  percentOff: 60,
};
const LIST_QUOTE = { ...SWITCH_QUOTE, chargeAmount: 33503, discounted: false, percentOff: null };

type SwitchCall = Record<string, unknown> & { confirm: boolean };

function switchHarness(
  respond: (call: SwitchCall, index: number) => Promise<ProBusinessUpgradeResponse>,
  overrides: Partial<ProAnnualSwitchFlowOptions> = {},
) {
  const dialogs: CheckoutConfirmDialogOptions[] = [];
  const calls: SwitchCall[] = [];
  let fellBack = false;
  let succeeded = false;
  const options: ProAnnualSwitchFlowOptions = {
    planKey: 'pro_monthly',
    fallback: () => { fellBack = true; },
    requestSwitch: (request) => {
      const call: SwitchCall = { ...request };
      calls.push(call);
      return respond(call, calls.length - 1);
    },
    currentUserId: () => 'user_a',
    openPortal: () => {},
    afterSuccess: () => { succeeded = true; },
    showDialog: (d) => { dialogs.push(d); },
    errorKind: (err) => (err as { data?: { kind?: string } })?.data?.kind ?? null,
    reportError: () => {},
    translate: enTranslate,
    ...overrides,
  };
  return { options, dialogs, calls, fellBack: () => fellBack, succeeded: () => succeeded };
}

const refusal = (kind: string) => Object.assign(new Error(kind), { data: { kind } });
const upgraded = { kind: 'upgraded' as const, fromPlanKey: 'pro_monthly', toPlanKey: 'pro_annual' };

describe('runProAnnualSwitchFlow', () => {
  it('shows the discounted quote and confirms with the quote it showed', async () => {
    const h = switchHarness(async (call) => (call.confirm ? upgraded : SWITCH_QUOTE));
    await runProAnnualSwitchFlow(h.options);
    assert.equal(h.dialogs[0]?.title, 'Switch to Pro Yearly');
    assert.equal(h.dialogs[0]?.confirmLabel, 'Switch now');
    assert.equal(h.dialogs[0]?.dismissLabel, 'Not now');
    assert.match(h.dialogs[0]!.body, /You pay \$104\.96 today: your first year at 60% off/);
    assert.match(h.dialogs[0]!.body, /It renews at \$359\.99 a year/);
    h.dialogs[0]!.onConfirm();
    await settle();
    assert.deepEqual(h.calls, [{ confirm: false }, { confirm: true, discounted: true }]);
    assert.equal(h.dialogs[1]?.title, 'Switched to Pro Yearly');
    h.dialogs[1]!.onConfirm();
    assert.equal(h.succeeded(), true);
  });

  it('confirms a list-price quote as not discounted', async () => {
    const h = switchHarness(async (call) => (call.confirm ? upgraded : LIST_QUOTE));
    await runProAnnualSwitchFlow(h.options);
    assert.doesNotMatch(h.dialogs[0]!.body, /% off/);
    h.dialogs[0]!.onConfirm();
    await settle();
    assert.deepEqual(h.calls[1], { confirm: true, discounted: false });
  });

  for (const kind of ['PROMO_ENDED', 'PROMO_CODE_REJECTED']) {
    it(`re-quotes once after ${kind} and confirms only the new price`, async () => {
      const h = switchHarness(async (call, index) => {
        if (index === 0) return SWITCH_QUOTE;
        if (index === 1) throw refusal(kind);
        if (index === 2) return LIST_QUOTE;
        return upgraded;
      });
      await runProAnnualSwitchFlow(h.options);
      h.dialogs[0]!.onConfirm();
      await settle();
      assert.equal(h.dialogs[1]?.title, 'Switch to Pro Yearly');
      assert.match(h.dialogs[1]!.body, /^The offer is no longer available and your plan has not changed\./);
      assert.match(h.dialogs[1]!.body, /You pay \$335\.03 today: less the unused part/);
      h.dialogs[1]!.onConfirm();
      await settle();
      assert.deepEqual(h.calls, [
        { confirm: false },
        { confirm: true, discounted: true },
        { confirm: false },
        { confirm: true, discounted: false },
      ]);
      assert.equal(h.dialogs[2]?.title, 'Switched to Pro Yearly');
    });
  }

  it('re-quotes at most once', async () => {
    const h = switchHarness(async (call, index) => {
      if (call.confirm) throw refusal('PROMO_ENDED');
      return index === 0 ? SWITCH_QUOTE : LIST_QUOTE;
    });
    await runProAnnualSwitchFlow(h.options);
    h.dialogs[0]!.onConfirm();
    await settle();
    h.dialogs[1]!.onConfirm();
    await settle();
    assert.equal(h.calls.length, 4);
    assert.equal(h.dialogs[2]?.title, 'Switch not confirmed');
  });

  // After PROMO_CODE_REJECTED the fresh preview resends the code; if Dodo's
  // preview accepts it, "the offer is no longer available" would sit above a
  // discounted price.
  it('ends with the failed dialog when the fresh quote still carries the offer', async () => {
    const h = switchHarness(async (call) => {
      if (call.confirm) throw refusal('PROMO_CODE_REJECTED');
      return SWITCH_QUOTE;
    });
    await runProAnnualSwitchFlow(h.options);
    h.dialogs[0]!.onConfirm();
    await settle();
    assert.deepEqual(h.calls, [{ confirm: false }, { confirm: true, discounted: true }, { confirm: false }]);
    assert.equal(h.dialogs[1]?.title, 'Switch not confirmed');
    assert.equal(h.dialogs.length, 2);
  });

  // A server that predates the switch ignores `kind` and quotes Pro Business.
  it('falls back instead of showing a quote for another plan', async () => {
    const h = switchHarness(async () => ({ ...LIST_QUOTE, toPlanKey: 'pro_business_monthly', billingPeriod: 'monthly' as const }));
    await runProAnnualSwitchFlow(h.options);
    assert.equal(h.fellBack(), true);
    assert.equal(h.dialogs.length, 0);
    assert.deepEqual(h.calls, [{ confirm: false }]);
  });

  // A rollback between the quote and the confirm: the older Convex has no
  // switch action. The flow fails closed and does not try another call.
  it('fails closed when the confirm reaches a server without the switch', async () => {
    const h = switchHarness(async (call) => {
      if (call.confirm) throw new Error("Could not find public function for 'payments/billing:switchToProAnnual'");
      return SWITCH_QUOTE;
    });
    await runProAnnualSwitchFlow(h.options);
    h.dialogs[0]!.onConfirm();
    await settle();
    assert.deepEqual(h.calls, [{ confirm: false }, { confirm: true, discounted: true }]);
    assert.equal(h.dialogs[1]?.title, 'Switch not confirmed');
    assert.equal(h.succeeded(), false);
  });

  // Only a reply that says the plan is now Pro Yearly is a switch.
  it('does not report a switch for a reply that names another plan', async () => {
    const h = switchHarness(async (call) => (
      call.confirm ? { ...upgraded, toPlanKey: 'pro_business_monthly' } : SWITCH_QUOTE
    ));
    await runProAnnualSwitchFlow(h.options);
    h.dialogs[0]!.onConfirm();
    await settle();
    assert.equal(h.dialogs[1]?.title, 'Switch not confirmed');
    assert.equal(h.succeeded(), false);
  });

  it('treats an unknown confirm outcome as unconfirmed, never as a re-quote', async () => {
    const h = switchHarness(async (call) => {
      if (call.confirm) throw new Error('timeout');
      return SWITCH_QUOTE;
    });
    await runProAnnualSwitchFlow(h.options);
    h.dialogs[0]!.onConfirm();
    await settle();
    assert.equal(h.calls.length, 2);
    assert.equal(h.dialogs[1]?.title, 'Switch not confirmed');
    assert.doesNotMatch(h.dialogs[1]!.body, /no charge|not been charged/i);
  });

  it('asks a cancelling Pro Monthly to resume first', async () => {
    const h = switchHarness(async () => { throw refusal('PRO_CANCEL_SCHEDULED'); });
    await runProAnnualSwitchFlow(h.options);
    assert.equal(h.dialogs[0]?.title, 'Resume Pro Monthly first');
    assert.equal(h.dialogs[0]?.confirmLabel, 'Open billing portal');
    assert.equal(h.fellBack(), false);
  });

  it('falls back for any plan but Pro Monthly, a missing user, or no quote', async () => {
    const annual = switchHarness(async () => SWITCH_QUOTE, { planKey: 'pro_annual' });
    await runProAnnualSwitchFlow(annual.options);
    assert.equal(annual.fellBack(), true);
    assert.deepEqual(annual.calls, []);
    const anon = switchHarness(async () => SWITCH_QUOTE, { currentUserId: () => undefined });
    await runProAnnualSwitchFlow(anon.options);
    assert.equal(anon.fellBack(), true);
    assert.deepEqual(anon.calls, []);
    const down = switchHarness(async () => { throw new Error('provider down'); });
    await runProAnnualSwitchFlow(down.options);
    assert.equal(down.fellBack(), true);
  });

  // Settings returns focus to its switch button; the dialogs do not restore it.
  it('reports a dismissed dialog to the caller, and never a confirmed one', async () => {
    let dismissed = 0;
    const h = switchHarness(async (call) => (call.confirm ? upgraded : SWITCH_QUOTE), { onDismiss: () => { dismissed += 1; } });
    await runProAnnualSwitchFlow(h.options);
    h.dialogs[0]!.onDismiss();
    assert.equal(dismissed, 1);
    const again = switchHarness(async (call) => (call.confirm ? upgraded : SWITCH_QUOTE), { onDismiss: () => { dismissed += 1; } });
    await runProAnnualSwitchFlow(again.options);
    again.dialogs[0]!.onConfirm();
    await settle();
    assert.equal(dismissed, 1);
    // The result dialog's Close is a dismissal too.
    again.dialogs[1]!.onDismiss();
    assert.equal(dismissed, 2);
  });

  // The charge grows while a quote stays open. A server that re-checks it says
  // so on the quote; only then does the confirm name the charge it accepts.
  describe('accepted charge', () => {
    const GUARDED = { ...SWITCH_QUOTE, acceptsQuoteGuards: true };

    it('confirms with the charge the quote showed when the quote advertises the check', async () => {
      const h = switchHarness(async (call) => (call.confirm ? upgraded : GUARDED));
      await runProAnnualSwitchFlow(h.options);
      h.dialogs[0]!.onConfirm();
      await settle();
      assert.deepEqual(h.calls[1], { confirm: true, discounted: true, acceptedChargeAmount: 10496, acceptedChargeCurrency: 'USD' });
    });

    it('sends no accepted charge to a server whose quote does not advertise the check', async () => {
      const h = switchHarness(async (call) => (call.confirm ? upgraded : SWITCH_QUOTE));
      await runProAnnualSwitchFlow(h.options);
      h.dialogs[0]!.onConfirm();
      await settle();
      assert.deepEqual(h.calls[1], { confirm: true, discounted: true });
    });

    it('after CHARGE_CHANGED shows the new charge for acceptance and confirms only that charge', async () => {
      const h = switchHarness(async (_call, index) => {
        if (index === 0) return GUARDED;
        if (index === 1) throw refusal('CHARGE_CHANGED');
        if (index === 2) return { ...GUARDED, chargeAmount: 10600 };
        return upgraded;
      });
      await runProAnnualSwitchFlow(h.options);
      h.dialogs[0]!.onConfirm();
      await settle();
      assert.equal(h.dialogs[1]?.title, 'Switch to Pro Yearly');
      assert.match(h.dialogs[1]!.body, /^The price changed since your quote and your plan has not changed\./);
      assert.match(h.dialogs[1]!.body, /You pay \$106\.00 today: your first year at 60% off/);
      h.dialogs[1]!.onConfirm();
      await settle();
      assert.deepEqual(h.calls.slice(2), [
        { confirm: false },
        { confirm: true, discounted: true, acceptedChargeAmount: 10600, acceptedChargeCurrency: 'USD' },
      ]);
      assert.equal(h.dialogs[2]?.title, 'Switched to Pro Yearly');
    });

    const LOST_OFFER = { ...LIST_QUOTE, acceptsQuoteGuards: true, offerNotApplied: true };

    it('says so on a first quote that lost the running offer', async () => {
      const h = switchHarness(async (call) => (call.confirm ? upgraded : LOST_OFFER));
      await runProAnnualSwitchFlow(h.options);
      assert.match(h.dialogs[0]!.body, /^The offer is not available for this switch\. Here is the price without it\. Your Pro Monthly/);
      h.dialogs[0]!.onConfirm();
      await settle();
      assert.deepEqual(h.calls[1], { confirm: true, discounted: false, acceptedChargeAmount: 33503, acceptedChargeCurrency: 'USD' });
    });

    // Re-sending the code could bring back a discounted quote the confirm
    // refuses again, and the user could never switch.
    it('after PROMO_CODE_REJECTED asks for a list-price quote and confirms only that', async () => {
      const h = switchHarness(async (_call, index) => {
        if (index === 0) return GUARDED;
        if (index === 1) throw refusal('PROMO_CODE_REJECTED');
        if (index === 2) return LOST_OFFER;
        return upgraded;
      });
      await runProAnnualSwitchFlow(h.options);
      h.dialogs[0]!.onConfirm();
      await settle();
      assert.match(h.dialogs[1]!.body, /^The offer is no longer available and your plan has not changed\. Here is the price without it\. Your Pro Monthly/);
      h.dialogs[1]!.onConfirm();
      await settle();
      assert.deepEqual(h.calls.slice(2), [
        { confirm: false, listPrice: true },
        { confirm: true, discounted: false, acceptedChargeAmount: 33503, acceptedChargeCurrency: 'USD' },
      ]);
      assert.equal(h.dialogs[2]?.title, 'Switched to Pro Yearly');
    });

    it('a changed-charge re-quote that lost the offer says the offer is gone', async () => {
      const h = switchHarness(async (_call, index) => {
        if (index === 0) return GUARDED;
        if (index === 1) throw refusal('CHARGE_CHANGED');
        return LOST_OFFER;
      });
      await runProAnnualSwitchFlow(h.options);
      h.dialogs[0]!.onConfirm();
      await settle();
      assert.match(h.dialogs[1]!.body, /^The offer is no longer available and your plan has not changed\. Here is the price without it\. Your Pro Monthly/);
    });

    it('re-quotes a changed charge at most once', async () => {
      const h = switchHarness(async (call) => {
        if (call.confirm) throw refusal('CHARGE_CHANGED');
        return GUARDED;
      });
      await runProAnnualSwitchFlow(h.options);
      h.dialogs[0]!.onConfirm();
      await settle();
      h.dialogs[1]!.onConfirm();
      await settle();
      assert.equal(h.calls.length, 4);
      assert.equal(h.dialogs[2]?.title, 'Switch not confirmed');
    });
  });

  it('refuses to confirm after the signed-in account changed', async () => {
    let user = 'user_a';
    const h = switchHarness(async (call) => (call.confirm ? upgraded : SWITCH_QUOTE), { currentUserId: () => user });
    await runProAnnualSwitchFlow(h.options);
    user = 'user_b';
    h.dialogs[0]!.onConfirm();
    await settle();
    assert.deepEqual(h.calls, [{ confirm: false }]);
    assert.equal(h.dialogs[1]?.title, 'Account changed');
  });
});
