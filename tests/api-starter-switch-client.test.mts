/**
 * The dashboard's API Starter switch calls its own Convex action. A Convex
 * deployment that predates the switch has no such function, so the call fails
 * and the checkout caller continues to the normal checkout; it is never sent
 * to another plan-change action.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { getFunctionName } from 'convex/server';

import { __setConvexClientForTests } from '../src/services/convex-client.ts';
import { __setClerkInstanceForTests } from '../src/services/clerk.ts';
import * as billing from '../src/services/billing.ts';

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

describe('dashboard API Starter switch calls', () => {
  it('sends every request to its own action, with exactly the fields given', async () => {
    const fake = signedInClient();
    await billing.requestApiStarterSwitch({ confirm: false });
    await billing.requestApiStarterSwitch({ confirm: true, acceptedChargeAmount: 6012, acceptedChargeCurrency: 'USD' });
    assert.deepEqual(fake.actions, [
      { name: 'payments/billing:switchToApiStarter', args: { confirm: false } },
      {
        name: 'payments/billing:switchToApiStarter',
        args: { confirm: true, acceptedChargeAmount: 6012, acceptedChargeCurrency: 'USD' },
      },
    ]);
  });

  // New dashboard, old Convex.
  it('fails when the Convex deployment predates the switch, and tries nothing else', async () => {
    const fake = signedInClient();
    fake.actionResult = () => Promise.reject(new Error(
      "[Request ID: x] Server Error\nCould not find public function for 'payments/billing:switchToApiStarter'.",
    ));
    await assert.rejects(billing.requestApiStarterSwitch({ confirm: false }), /Could not find public function/);
    assert.deepEqual(fake.actions.map((call) => call.name), ['payments/billing:switchToApiStarter']);
  });

  it('refuses to run signed out', async () => {
    __setClerkInstanceForTests({ session: null, user: null } as never);
    const fake = new FakeConvexClient();
    __setConvexClientForTests(fake);
    await assert.rejects(billing.requestApiStarterSwitch({ confirm: false }));
    assert.deepEqual(fake.actions, []);
  });
});
