/**
 * The /pro build's Pro Monthly -> Pro Yearly switch (pro-test/src/services/
 * pro-business-upgrade.ts), driven through its real dialog and fetch calls.
 * The dashboard flow has the same behaviour under node tests; this pins the
 * sealed /pro mirror at runtime, not only by copy parity.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A variable specifier keeps tsconfig.dom-tests.json from type-checking the
// pro-test module, whose `@sentry/react` is installed only under pro-test/.
// At run time vitest.dom.config.mts aliases that import to a no-op stub.
const PRO_UPGRADE_MODULE = '../../pro-test/src/services/pro-business-upgrade.ts';
type RunProAnnualSwitchFlow = (options: {
  apiBase: string;
  getToken: () => Promise<string | null>;
  getUserId: () => Promise<string | null>;
  openPortal: () => void;
  fallback: () => void;
}) => Promise<void>;
type RunProBusinessUpgradeFlow = (options: Parameters<RunProAnnualSwitchFlow>[0] & { planDisplayName: string }) => Promise<void>;
const { runProAnnualSwitchFlow, runProBusinessUpgradeFlow } = (await import(/* @vite-ignore */ PRO_UPGRADE_MODULE)) as {
  runProAnnualSwitchFlow: RunProAnnualSwitchFlow;
  runProBusinessUpgradeFlow: RunProBusinessUpgradeFlow;
};

const QUOTE = {
  kind: 'preview',
  fromPlanKey: 'pro_monthly',
  toPlanKey: 'pro_annual',
  chargeAmount: 10496,
  currency: 'USD',
  renewalAmount: 35999,
  renewalCurrency: 'USD',
  renewalDate: '2027-11-26T10:00:00Z',
  billingPeriod: 'annual',
  discounted: true,
  percentOff: 60,
};
const LIST_QUOTE = { ...QUOTE, chargeAmount: 33503, discounted: false, percentOff: null };
const UPGRADED = { kind: 'upgraded', fromPlanKey: 'pro_monthly', toPlanKey: 'pro_annual' };

type Reply = { status: number; body: unknown };
let replies: Reply[];
let bodies: unknown[];
let paths: string[];
let fellBack: boolean;

function options() {
  return {
    apiBase: 'https://api.test',
    getToken: async () => 'token',
    getUserId: async () => 'user_a',
    openPortal: () => {},
    fallback: () => { fellBack = true; },
  };
}

function dialog() {
  const root = document.getElementById('wm-pro-business-upgrade-dialog');
  return {
    open: root !== null,
    title: root?.querySelector('h2')?.textContent ?? '',
    body: root?.querySelector('p')?.textContent ?? '',
    confirm: () => (document.getElementById('wm-pro-business-upgrade-dialog-confirm') as HTMLButtonElement).click(),
  };
}

beforeEach(() => {
  replies = [];
  bodies = [];
  paths = [];
  fellBack = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    paths.push(new URL(url).pathname);
    bodies.push(JSON.parse(String(init.body)));
    const reply = replies.shift() ?? { status: 500, body: {} };
    // Status 0: the request never reaches a server.
    if (reply.status === 0) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('/pro Pro Yearly switch flow', () => {
  it('quotes and confirms with the quote it showed', async () => {
    replies = [{ status: 200, body: QUOTE }, { status: 200, body: UPGRADED }];
    await runProAnnualSwitchFlow(options());
    expect(dialog().title).toBe('Switch to Pro Yearly');
    expect(dialog().body).toContain('You pay $104.96 today: your first year at 60% off, less the unused part of this month.');
    dialog().confirm();
    await vi.waitFor(() => expect(dialog().title).toBe('Switched to Pro Yearly'));
    expect(bodies).toEqual([
      { confirm: false },
      { confirm: true, discounted: true },
    ]);
    expect(paths).toEqual(['/pro-annual-switch', '/pro-annual-switch']);
  });

  // Each plan change has its own route, so an edge or Convex deployment that
  // predates the switch answers 404 instead of running a Pro Business upgrade.
  describe('a deployment that predates the switch route', () => {
    // What the old edge answers today: api/[...notfound].ts.
    const NOT_FOUND = { status: 404, body: { error: { code: 'not_found', message: 'No API endpoint matches /api/pro-annual-switch.' } } };

    it('falls back on the quote, and never tries the Pro Business route', async () => {
      replies = [NOT_FOUND];
      await runProAnnualSwitchFlow(options());
      expect(fellBack).toBe(true);
      expect(dialog().open).toBe(false);
      expect(paths).toEqual(['/pro-annual-switch']);
    });

    // A rollback between the quote and the confirm.
    it('fails closed on the confirm, and never tries the Pro Business route', async () => {
      replies = [{ status: 200, body: QUOTE }, NOT_FOUND];
      await runProAnnualSwitchFlow(options());
      dialog().confirm();
      await vi.waitFor(() => expect(dialog().title).toBe('Switch not confirmed'));
      expect(paths).toEqual(['/pro-annual-switch', '/pro-annual-switch']);
    });

    // The browser waits past the edge route's own 25 s cap, so it reads the
    // route's answer instead of timing out first.
    it('the confirm waits longer than the edge route can run', async () => {
      const timeouts: number[] = [];
      const original = AbortSignal.timeout.bind(AbortSignal);
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => { timeouts.push(ms); return original(ms); });
      replies = [{ status: 200, body: QUOTE }, { status: 200, body: UPGRADED }];
      await runProAnnualSwitchFlow(options());
      dialog().confirm();
      await vi.waitFor(() => expect(dialog().title).toBe('Switched to Pro Yearly'));
      expect(timeouts.length).toBeGreaterThanOrEqual(2);
      for (const ms of timeouts) expect(ms).toBeGreaterThanOrEqual(30_000);
    });

    it('fails closed when the confirm cannot reach the route', async () => {
      replies = [{ status: 200, body: QUOTE }, { status: 0, body: null }];
      await runProAnnualSwitchFlow(options());
      dialog().confirm();
      await vi.waitFor(() => expect(dialog().title).toBe('Switch not confirmed'));
      expect(paths).toEqual(['/pro-annual-switch', '/pro-annual-switch']);
    });

    // Only a reply that says the plan is now Pro Yearly is a switch.
    it('does not report a switch for a success reply that names another plan', async () => {
      replies = [
        { status: 200, body: QUOTE },
        { status: 200, body: { kind: 'upgraded', fromPlanKey: 'pro_monthly', toPlanKey: 'pro_business_monthly' } },
      ];
      await runProAnnualSwitchFlow(options());
      dialog().confirm();
      await vi.waitFor(() => expect(dialog().title).toBe('Switch not confirmed'));
    });
  });

  it('re-quotes once after PROMO_ENDED and confirms only the new price', async () => {
    replies = [
      { status: 200, body: QUOTE },
      { status: 409, body: { error: 'PROMO_ENDED' } },
      { status: 200, body: LIST_QUOTE },
      { status: 200, body: UPGRADED },
    ];
    await runProAnnualSwitchFlow(options());
    dialog().confirm();
    await vi.waitFor(() => expect(dialog().body).toMatch(/^The offer is no longer available and your plan has not changed\./));
    expect(dialog().body).toContain('You pay $335.03 today: less the unused part of this month.');
    dialog().confirm();
    await vi.waitFor(() => expect(dialog().title).toBe('Switched to Pro Yearly'));
    expect(bodies).toEqual([
      { confirm: false },
      { confirm: true, discounted: true },
      { confirm: false },
      { confirm: true, discounted: false },
    ]);
  });

  it('ends with the failed dialog when the fresh quote still carries the offer', async () => {
    replies = [
      { status: 200, body: QUOTE },
      { status: 409, body: { error: 'PROMO_CODE_REJECTED' } },
      { status: 200, body: QUOTE },
    ];
    await runProAnnualSwitchFlow(options());
    dialog().confirm();
    await vi.waitFor(() => expect(dialog().title).toBe('Switch not confirmed'));
    expect(bodies).toHaveLength(3);
  });

  // A relay that predates the switch ignores `kind` and quotes Pro Business.
  it('falls back instead of showing a quote for another plan', async () => {
    replies = [{ status: 200, body: { ...LIST_QUOTE, toPlanKey: 'pro_business_monthly', billingPeriod: 'monthly' } }];
    await runProAnnualSwitchFlow(options());
    expect(fellBack).toBe(true);
    expect(dialog().open).toBe(false);
    expect(bodies).toEqual([{ confirm: false }]);
  });

  describe('accepted charge', () => {
    const GUARDED = { ...QUOTE, acceptsQuoteGuards: true };

    it('confirms with the charge the quote showed when the quote advertises the check', async () => {
      replies = [{ status: 200, body: GUARDED }, { status: 200, body: UPGRADED }];
      await runProAnnualSwitchFlow(options());
      dialog().confirm();
      await vi.waitFor(() => expect(dialog().title).toBe('Switched to Pro Yearly'));
      expect(bodies[1]).toEqual({
        confirm: true, discounted: true, acceptedChargeAmount: 10496, acceptedChargeCurrency: 'USD',
      });
    });

    it('after CHARGE_CHANGED shows the new charge for acceptance and confirms only that charge', async () => {
      replies = [
        { status: 200, body: GUARDED },
        { status: 409, body: { error: 'CHARGE_CHANGED' } },
        { status: 200, body: { ...GUARDED, chargeAmount: 10600 } },
        { status: 200, body: UPGRADED },
      ];
      await runProAnnualSwitchFlow(options());
      dialog().confirm();
      await vi.waitFor(() => expect(dialog().body).toMatch(/^The price changed since your quote and your plan has not changed\./));
      expect(dialog().body).toContain('You pay $106.00 today: your first year at 60% off');
      dialog().confirm();
      await vi.waitFor(() => expect(dialog().title).toBe('Switched to Pro Yearly'));
      expect(bodies.slice(2)).toEqual([
        { confirm: false },
        { confirm: true, discounted: true, acceptedChargeAmount: 10600, acceptedChargeCurrency: 'USD' },
      ]);
    });

    const LOST_OFFER = { ...LIST_QUOTE, acceptsQuoteGuards: true, offerNotApplied: true };

    it('says so on a first quote that lost the running offer', async () => {
      replies = [{ status: 200, body: LOST_OFFER }];
      await runProAnnualSwitchFlow(options());
      expect(dialog().body).toMatch(/^The offer is not available for this switch\. Here is the price without it\. Your Pro Monthly/);
    });

    it('after PROMO_CODE_REJECTED asks for a list-price quote and confirms only that', async () => {
      replies = [
        { status: 200, body: GUARDED },
        { status: 409, body: { error: 'PROMO_CODE_REJECTED' } },
        { status: 200, body: LOST_OFFER },
        { status: 200, body: UPGRADED },
      ];
      await runProAnnualSwitchFlow(options());
      dialog().confirm();
      await vi.waitFor(() => expect(dialog().body).toMatch(/^The offer is no longer available and your plan has not changed\. Here is the price without it\. Your Pro Monthly/));
      dialog().confirm();
      await vi.waitFor(() => expect(dialog().title).toBe('Switched to Pro Yearly'));
      expect(bodies.slice(2)).toEqual([
        { confirm: false, listPrice: true },
        { confirm: true, discounted: false, acceptedChargeAmount: 33503, acceptedChargeCurrency: 'USD' },
      ]);
    });

    it('re-quotes a changed charge at most once', async () => {
      replies = [
        { status: 200, body: GUARDED },
        { status: 409, body: { error: 'CHARGE_CHANGED' } },
        { status: 200, body: GUARDED },
        { status: 409, body: { error: 'CHARGE_CHANGED' } },
      ];
      await runProAnnualSwitchFlow(options());
      dialog().confirm();
      await vi.waitFor(() => expect(dialog().body).toMatch(/^The price changed/));
      dialog().confirm();
      await vi.waitFor(() => expect(dialog().title).toBe('Switch not confirmed'));
      expect(bodies).toHaveLength(4);
    });
  });

  // getAuthToken waits 2 s before its retry, which reads the active Clerk
  // session again: a token for another account can come back. The account
  // check must run after the token resolves.
  describe('account switch while the confirm token resolves', () => {
    function switchingAccountOptions() {
      let user = 'user_a';
      let tokenCalls = 0;
      return {
        ...options(),
        getUserId: async () => user,
        getToken: async () => {
          tokenCalls += 1;
          if (tokenCalls > 1) user = 'user_b';
          return `token_${user}`;
        },
      };
    }

    it('the Pro Yearly switch refuses to confirm for the other account', async () => {
      replies = [{ status: 200, body: QUOTE }, { status: 200, body: UPGRADED }];
      await runProAnnualSwitchFlow(switchingAccountOptions());
      dialog().confirm();
      await vi.waitFor(() => expect(dialog().title).toBe('Account changed'));
      expect(bodies).toEqual([{ confirm: false }]);
    });

    it('the Pro Business upgrade refuses to confirm for the other account', async () => {
      replies = [
        {
          status: 200,
          body: { ...LIST_QUOTE, toPlanKey: 'pro_business_monthly', billingPeriod: 'monthly', chargeAmount: 667, renewalAmount: 4999 },
        },
        { status: 200, body: { kind: 'upgraded', fromPlanKey: 'pro_monthly', toPlanKey: 'pro_business_monthly' } },
      ];
      await runProBusinessUpgradeFlow({ ...switchingAccountOptions(), planDisplayName: 'Pro Monthly' });
      expect(dialog().title).toBe('Upgrade to Pro Business');
      dialog().confirm();
      await vi.waitFor(() => expect(dialog().title).toBe('Account changed'));
      expect(bodies).toEqual([{ confirm: false }]);
    });
  });

  it('asks a cancelling Pro Monthly to resume first', async () => {
    replies = [{ status: 409, body: { error: 'PRO_CANCEL_SCHEDULED' } }];
    await runProAnnualSwitchFlow(options());
    expect(dialog().title).toBe('Resume Pro Monthly first');
    expect(fellBack).toBe(false);
  });
});
