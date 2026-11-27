/**
 * The dashboard's Pro Yearly switch calls its own Convex action. A Convex
 * deployment that predates the switch has no such function, so the call fails
 * and nothing changes; it is never sent to the Pro Business upgrade action,
 * which an older deployment would run as a Pro Business upgrade.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { getFunctionName } from 'convex/server';

import { __setConvexClientForTests } from '../src/services/convex-client.ts';
import { __setClerkInstanceForTests } from '../src/services/clerk.ts';
import { requestProAnnualSwitch, requestProBusinessUpgrade } from '../src/services/billing.ts';

type AuthCallback = (isAuthenticated: boolean) => void;

class FakeConvexClient {
  readonly authCallbacks: AuthCallback[] = [];
  readonly actions: Array<{ name: string; args: unknown }> = [];
  actionResult: () => Promise<unknown> = () => Promise.resolve({ kind: 'preview' });

  setAuth(_fetchToken: unknown, onChange: AuthCallback): void {
    this.authCallbacks.push(onChange);
  }

  onUpdate(): (() => void) & { unsubscribe: () => void } {
    const unsubscribe = () => {};
    return Object.assign(unsubscribe, { unsubscribe });
  }

  action(ref: unknown, args: unknown): Promise<unknown> {
    this.actions.push({ name: getFunctionName(ref as never), args });
    return this.actionResult();
  }
}

function signedInClient(): FakeConvexClient {
  __setClerkInstanceForTests({
    session: { getToken: async () => 'token-a' },
    user: { id: 'user_a' },
  } as never);
  const fake = new FakeConvexClient();
  __setConvexClientForTests(fake);
  fake.authCallbacks[0]!(true);
  return fake;
}

afterEach(() => {
  __setConvexClientForTests(null);
  __setClerkInstanceForTests(null);
});

describe('dashboard plan-change calls', () => {
  it('sends every Pro Yearly request to its own action, without a kind', async () => {
    const fake = signedInClient();
    await requestProAnnualSwitch({ confirm: false });
    await requestProAnnualSwitch({ confirm: false, listPrice: true });
    await requestProAnnualSwitch({ confirm: true, discounted: true, acceptedChargeAmount: 10496, acceptedChargeCurrency: 'USD' });
    assert.deepEqual(fake.actions, [
      { name: 'payments/billing:switchToProAnnual', args: { confirm: false } },
      { name: 'payments/billing:switchToProAnnual', args: { confirm: false, listPrice: true } },
      {
        name: 'payments/billing:switchToProAnnual',
        args: { confirm: true, discounted: true, acceptedChargeAmount: 10496, acceptedChargeCurrency: 'USD' },
      },
    ]);
  });

  // New dashboard, old Convex.
  it('fails when the Convex deployment predates the switch, and tries nothing else', async () => {
    const fake = signedInClient();
    fake.actionResult = () => Promise.reject(new Error(
      "[Request ID: x] Server Error\nCould not find public function for 'payments/billing:switchToProAnnual'.",
    ));
    await assert.rejects(requestProAnnualSwitch({ confirm: true, discounted: true }), /Could not find public function/);
    assert.deepEqual(fake.actions.map((call) => call.name), ['payments/billing:switchToProAnnual']);
  });

  it('keeps the Pro Business upgrade on its original action and body', async () => {
    const fake = signedInClient();
    await requestProBusinessUpgrade(false);
    await requestProBusinessUpgrade(true);
    assert.deepEqual(fake.actions, [
      { name: 'payments/billing:upgradeToProBusiness', args: { confirm: false } },
      { name: 'payments/billing:upgradeToProBusiness', args: { confirm: true } },
    ]);
  });
});
