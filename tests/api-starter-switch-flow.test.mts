/**
 * Behaviour of the dashboard's in-place individual Pro → API Starter switch.
 * Every service is injected, so this runs without a DOM or Convex.
 *
 * The flow runs before an API Starter checkout. It returns 'not-switchable'
 * whenever the account has no Pro the server would switch, and the caller
 * then continues to the normal checkout.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as flows from '../src/services/api-starter-switch-dialog.ts';
import type { ApiStarterSwitchFlowOptions } from '../src/services/api-starter-switch-dialog.ts';
import type { CheckoutConfirmDialogOptions } from '../src/services/checkout-dialog-factory.ts';
import type { ProBusinessUpgradeResponse } from '../src/services/billing.ts';

// A namespace read, so the suite still loads (and fails per test) without the flow.
const runApiStarterSwitchFlow = (options: ApiStarterSwitchFlowOptions) => flows.runApiStarterSwitchFlow(options);

const QUOTE = {
  kind: 'preview' as const,
  fromPlanKey: 'pro_monthly',
  toPlanKey: 'api_starter',
  chargeAmount: 6012,
  currency: 'USD',
  renewalAmount: 9999,
  renewalCurrency: 'USD',
  renewalDate: '2026-12-27T10:00:00Z',
  billingPeriod: 'monthly' as const,
  discounted: false,
  percentOff: null,
  acceptsQuoteGuards: true,
};
const ANNUAL_QUOTE = {
  ...QUOTE,
  fromPlanKey: 'pro_annual',
  toPlanKey: 'api_starter_annual',
  chargeAmount: 61204,
  renewalAmount: 89999,
  renewalDate: '2027-11-27T10:00:00Z',
  billingPeriod: 'annual' as const,
};
const upgraded = { kind: 'upgraded' as const, fromPlanKey: 'pro_monthly', toPlanKey: 'api_starter' };

type Call = Record<string, unknown> & { confirm: boolean };
const settle = () => new Promise((r) => setTimeout(r, 0));
const refusal = (kind: string) => Object.assign(new Error(kind), { data: { kind } });

function harness(
  respond: (call: Call, index: number) => Promise<ProBusinessUpgradeResponse>,
  overrides: Partial<ApiStarterSwitchFlowOptions> = {},
) {
  const dialogs: CheckoutConfirmDialogOptions[] = [];
  const calls: Call[] = [];
  const reported: string[] = [];
  let succeeded = false;
  let portal = 0;
  let dismissed = 0;
  const options: ApiStarterSwitchFlowOptions = {
    requestSwitch: (request) => {
      const call: Call = { ...request };
      calls.push(call);
      return respond(call, calls.length - 1);
    },
    currentUserId: () => 'user_a',
    openPortal: () => { portal += 1; },
    afterSuccess: () => { succeeded = true; },
    showDialog: (d) => { dialogs.push(d); },
    errorKind: (err) => (err as { data?: { kind?: string } })?.data?.kind ?? null,
    reportError: (action) => { reported.push(action); },
    onDismiss: () => { dismissed += 1; },
    ...overrides,
  };
  return {
    options, dialogs, calls, reported,
    succeeded: () => succeeded, portal: () => portal, dismissed: () => dismissed,
  };
}

describe('runApiStarterSwitchFlow', () => {
  it('shows the prorated quote and confirms with the charge it showed', async () => {
    const h = harness(async (call) => (call.confirm ? upgraded : QUOTE));
    assert.equal(await runApiStarterSwitchFlow(h.options), 'shown');
    assert.equal(h.dialogs[0]?.title, 'Switch to API Starter');
    assert.equal(h.dialogs[0]?.confirmLabel, 'Switch now');
    assert.equal(h.dialogs[0]?.dismissLabel, 'Not now');
    assert.match(h.dialogs[0]!.body, /^Your Pro Monthly subscription moves to API Starter now\. You pay \$60\.12 today, less the unused part of this month\./);
    h.dialogs[0]!.onConfirm();
    await settle();
    assert.deepEqual(h.calls, [
      { confirm: false },
      { confirm: true, acceptedChargeAmount: 6012, acceptedChargeCurrency: 'USD' },
    ]);
    assert.equal(h.dialogs[1]?.title, 'Switched to API Starter');
    assert.match(h.dialogs[1]!.body, /create an API key in Settings, under API keys/);
    h.dialogs[1]!.onConfirm();
    assert.equal(h.succeeded(), true);
  });

  it('shows the annual quote a Pro Yearly holder gets', async () => {
    const h = harness(async (call) => (call.confirm ? { ...upgraded, toPlanKey: 'api_starter_annual' } : ANNUAL_QUOTE));
    assert.equal(await runApiStarterSwitchFlow(h.options), 'shown');
    assert.match(h.dialogs[0]!.body, /^Your Pro Yearly subscription moves to API Starter now\. You pay \$612\.04 today, less the unused part of this year\./);
    h.dialogs[0]!.onConfirm();
    await settle();
    assert.equal(h.dialogs[1]?.title, 'Switched to API Starter');
  });

  // Refusals that mean the account holds no Pro the server would switch, plus
  // every failure that says nothing about the account (an older Convex, the
  // network, a bad reply). The caller continues to the normal checkout.
  for (const kind of ['NO_UPGRADEABLE_PRO', 'ALREADY_API_PLAN', 'ACCOUNT_DELETION_IN_PROGRESS']) {
    it(`is not switchable after ${kind}, and shows nothing`, async () => {
      const h = harness(async () => { throw refusal(kind); });
      assert.equal(await runApiStarterSwitchFlow(h.options), 'not-switchable');
      assert.deepEqual(h.dialogs, []);
      assert.equal(h.calls.length, 1);
    });
  }

  it('is not switchable when the Convex deployment predates the switch', async () => {
    const h = harness(async () => {
      throw new Error("Could not find public function for 'payments/billing:switchToApiStarter'.");
    });
    assert.equal(await runApiStarterSwitchFlow(h.options), 'not-switchable');
    assert.deepEqual(h.dialogs, []);
  });

  it('is not switchable on a reply that is not an API Starter quote', async () => {
    for (const reply of [
      { ...QUOTE, toPlanKey: 'pro_business_monthly' },
      { ...QUOTE, chargeAmount: Number.NaN },
      { ...QUOTE, currency: undefined as unknown as string },
      upgraded,
    ]) {
      const h = harness(async () => reply as ProBusinessUpgradeResponse);
      assert.equal(await runApiStarterSwitchFlow(h.options), 'not-switchable');
      assert.deepEqual(h.dialogs, []);
    }
  });

  it('is not switchable without a signed-in user, and asks nothing', async () => {
    const h = harness(async () => QUOTE, { currentUserId: () => null });
    assert.equal(await runApiStarterSwitchFlow(h.options), 'not-switchable');
    assert.deepEqual(h.calls, []);
  });

  it('sends a cancel-scheduled Pro to the billing portal instead of selling a second plan', async () => {
    const h = harness(async () => { throw refusal('PRO_CANCEL_SCHEDULED'); });
    assert.equal(await runApiStarterSwitchFlow(h.options), 'shown');
    assert.equal(h.dialogs[0]?.title, 'Resume Pro first');
    assert.match(h.dialogs[0]!.body, /then switch to API Starter\.$/);
    assert.equal(h.dialogs[0]?.confirmLabel, 'Open billing portal');
    h.dialogs[0]!.onConfirm();
    assert.equal(h.portal(), 1);
  });

  // These come after the server picked the Pro subscription to switch, so the
  // account does hold one; a second subscription must not be sold.
  for (const kind of ['UPGRADE_RATE_LIMITED', 'UPGRADE_IN_PROGRESS', 'DODO_PLAN_CHANGE_ERROR']) {
    it(`stops the purchase after ${kind} and says the switch is unavailable`, async () => {
      const h = harness(async () => { throw refusal(kind); });
      assert.equal(await runApiStarterSwitchFlow(h.options), 'shown');
      assert.equal(h.dialogs[0]?.title, 'Switch to API Starter');
      assert.match(h.dialogs[0]!.body, /^We could not price the switch right now\./);
    });
  }

  it('re-quotes once after CHARGE_CHANGED and confirms only the new charge', async () => {
    const h = harness(async (_call, index) => {
      if (index === 0) return QUOTE;
      if (index === 1) throw refusal('CHARGE_CHANGED');
      if (index === 2) return { ...QUOTE, chargeAmount: 6150 };
      return upgraded;
    });
    await runApiStarterSwitchFlow(h.options);
    h.dialogs[0]!.onConfirm();
    await settle();
    assert.equal(h.dialogs[1]?.title, 'Switch to API Starter');
    assert.notEqual(h.dialogs[1]?.id, h.dialogs[0]?.id);
    assert.match(h.dialogs[1]!.body, /^The price changed since your quote and your plan has not changed\. Here is the new price\. Your Pro Monthly/);
    assert.match(h.dialogs[1]!.body, /You pay \$61\.50 today/);
    h.dialogs[1]!.onConfirm();
    await settle();
    assert.deepEqual(h.calls, [
      { confirm: false },
      { confirm: true, acceptedChargeAmount: 6012, acceptedChargeCurrency: 'USD' },
      { confirm: false },
      { confirm: true, acceptedChargeAmount: 6150, acceptedChargeCurrency: 'USD' },
    ]);
    assert.equal(h.dialogs[2]?.title, 'Switched to API Starter');
  });

  it('re-quotes a changed charge at most once', async () => {
    const h = harness(async (call) => {
      if (call.confirm) throw refusal('CHARGE_CHANGED');
      return QUOTE;
    });
    await runApiStarterSwitchFlow(h.options);
    h.dialogs[0]!.onConfirm();
    await settle();
    h.dialogs[1]!.onConfirm();
    await settle();
    assert.equal(h.calls.length, 4);
    assert.equal(h.dialogs[2]?.title, 'Switch not confirmed');
  });

  it('ends with the failed dialog when the confirm fails or the reply is not an API Starter switch', async () => {
    const failing = harness(async (call) => {
      if (call.confirm) throw new Error('timeout');
      return QUOTE;
    });
    await runApiStarterSwitchFlow(failing.options);
    failing.dialogs[0]!.onConfirm();
    await settle();
    assert.equal(failing.dialogs[1]?.title, 'Switch not confirmed');
    assert.match(failing.dialogs[1]!.body, /could not confirm/);
    assert.ok(failing.reported.includes('applyApiStarterSwitch'));

    const wrongPlan = harness(async (call) => (call.confirm ? { ...upgraded, toPlanKey: 'pro_business_monthly' } : QUOTE));
    await runApiStarterSwitchFlow(wrongPlan.options);
    wrongPlan.dialogs[0]!.onConfirm();
    await settle();
    assert.equal(wrongPlan.dialogs[1]?.title, 'Switch not confirmed');
    assert.equal(wrongPlan.succeeded(), false);
  });

  it('refuses to confirm from another account than the one that saw the quote', async () => {
    let user = 'user_a';
    const h = harness(async () => QUOTE, { currentUserId: () => user });
    await runApiStarterSwitchFlow(h.options);
    user = 'user_b';
    h.dialogs[0]!.onConfirm();
    await settle();
    assert.equal(h.calls.length, 1);
    assert.equal(h.dialogs[1]?.title, 'Account changed');
    assert.match(h.dialogs[1]!.body, /move to API Starter\.$/);
  });

  it('reports a dismissal so the caller can release its checkout guard', async () => {
    const h = harness(async () => QUOTE);
    await runApiStarterSwitchFlow(h.options);
    h.dialogs[0]!.onDismiss();
    assert.equal(h.dismissed(), 1);
  });

  // Every API Starter checkout waits for this quote, Pro holder or not. A
  // Convex call that never settles must not leave the purchase dead.
  it('gives up on a quote that never arrives, and a late quote shows nothing', async () => {
    let answer: (reply: ProBusinessUpgradeResponse) => void = () => {};
    const h = harness(() => new Promise((resolve) => { answer = resolve; }), { quoteTimeoutMs: 20 });
    assert.equal(await runApiStarterSwitchFlow(h.options), 'not-switchable');
    answer(QUOTE);
    await settle();
    assert.equal(h.dialogs.length, 0);
  });

  it('bounds the quote by default inside the server preview budget plus overhead', () => {
    assert.equal(flows.API_STARTER_QUOTE_TIMEOUT_MS, 20_000);
  });

  it('ends a re-quote that never arrives in the failed dialog', async () => {
    const h = harness(
      (call, index) => {
        if (index === 0) return Promise.resolve(QUOTE);
        if (call.confirm) return Promise.reject(refusal('CHARGE_CHANGED'));
        return new Promise(() => {});
      },
      { quoteTimeoutMs: 20 },
    );
    await runApiStarterSwitchFlow(h.options);
    h.dialogs[0]!.onConfirm();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(h.dialogs[1]?.title, 'Switch not confirmed');
  });
});
