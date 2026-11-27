/**
 * The /pro build's individual Pro -> API Starter switch (pro-test/src/services/
 * pro-business-upgrade.ts), driven through its real dialog and fetch calls.
 * The dashboard flow has the same behaviour under node tests; this pins the
 * sealed /pro mirror at runtime, not only by copy parity.
 *
 * /pro calls it before every signed-in API Starter checkout. It resolves
 * 'not-switchable' for every reply that does not come from an account with a
 * Pro to switch, and the checkout then runs as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A variable specifier keeps tsconfig.dom-tests.json from type-checking the
// pro-test module, whose `@sentry/react` is installed only under pro-test/.
// At run time vitest.dom.config.mts aliases that import to a no-op stub.
const PRO_UPGRADE_MODULE = '../../pro-test/src/services/pro-business-upgrade.ts';
type RunApiStarterSwitchFlow = (options: {
  apiBase: string;
  getToken: () => Promise<string | null>;
  getUserId: () => Promise<string | null>;
  openPortal: () => void;
}) => Promise<'shown' | 'not-switchable'>;
const { runApiStarterSwitchFlow } = (await import(/* @vite-ignore */ PRO_UPGRADE_MODULE)) as {
  runApiStarterSwitchFlow: RunApiStarterSwitchFlow;
};

const QUOTE = {
  kind: 'preview',
  fromPlanKey: 'pro_monthly',
  toPlanKey: 'api_starter',
  chargeAmount: 6012,
  currency: 'USD',
  renewalAmount: 9999,
  renewalCurrency: 'USD',
  renewalDate: '2026-12-27T10:00:00Z',
  billingPeriod: 'monthly',
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
  billingPeriod: 'annual',
};
const UPGRADED = { kind: 'upgraded', fromPlanKey: 'pro_monthly', toPlanKey: 'api_starter' };
// What an edge that predates the route answers: api/[...notfound].ts.
const NOT_FOUND = { status: 404, body: { error: { code: 'not_found', message: 'No API endpoint matches /api/api-starter-switch.' } } };

type Reply = { status: number; body: unknown };
let replies: Reply[];
let bodies: unknown[];
let paths: string[];
let idempotencyKeys: Array<string | null>;
let portal: number;
let userId: string | null;

function options() {
  return {
    apiBase: 'https://api.test',
    getToken: async () => 'token',
    getUserId: async () => userId,
    openPortal: () => { portal += 1; },
  };
}

function dialog() {
  const root = document.getElementById('wm-pro-business-upgrade-dialog');
  return {
    open: root !== null,
    title: root?.querySelector('h2')?.textContent ?? '',
    body: root?.querySelector('p')?.textContent ?? '',
    confirmLabel: document.getElementById('wm-pro-business-upgrade-dialog-confirm')?.textContent ?? '',
    dismissLabel: document.getElementById('wm-pro-business-upgrade-dialog-dismiss')?.textContent ?? '',
    confirm: () => (document.getElementById('wm-pro-business-upgrade-dialog-confirm') as HTMLButtonElement).click(),
  };
}

beforeEach(() => {
  replies = [];
  bodies = [];
  paths = [];
  idempotencyKeys = [];
  portal = 0;
  userId = 'user_a';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    paths.push(new URL(url).pathname);
    bodies.push(JSON.parse(String(init.body)));
    idempotencyKeys.push(new Headers(init.headers).get('Idempotency-Key'));
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

describe('/pro API Starter switch flow', () => {
  it('quotes and confirms with the charge it showed', async () => {
    replies = [{ status: 200, body: QUOTE }, { status: 200, body: UPGRADED }];
    expect(await runApiStarterSwitchFlow(options())).toBe('shown');
    expect(dialog().title).toBe('Switch to API Starter');
    expect(dialog().confirmLabel).toBe('Switch now');
    expect(dialog().dismissLabel).toBe('Not now');
    expect(dialog().body).toBe(
      'Your Pro Monthly subscription moves to API Starter now. You pay $60.12 today, less the unused part of this month. ' +
        'Your billing period restarts today. It renews at $99.99 a month plus any tax on December 27, 2026. ' +
        'Your dashboard stays the same, and you can create an API key in Settings, under API keys. ' +
        'If the payment fails, you stay on Pro Monthly.',
    );
    dialog().confirm();
    await vi.waitFor(() => expect(dialog().title).toBe('Switched to API Starter'));
    expect(bodies).toEqual([
      { confirm: false },
      { confirm: true, acceptedChargeAmount: 6012, acceptedChargeCurrency: 'USD' },
    ]);
    expect(paths).toEqual(['/api-starter-switch', '/api-starter-switch']);
    expect(idempotencyKeys[0]).toBeNull();
    expect(idempotencyKeys[1]).toMatch(/.+/);
  });

  it('shows the annual quote a Pro Yearly holder gets', async () => {
    replies = [{ status: 200, body: ANNUAL_QUOTE }];
    expect(await runApiStarterSwitchFlow(options())).toBe('shown');
    expect(dialog().body).toMatch(/^Your Pro Yearly subscription moves to API Starter now\. You pay \$612\.04 today, less the unused part of this year\./);
    expect(dialog().body).toContain('It renews at $899.99 a year plus any tax on November 27, 2027.');
  });

  // Not a Pro holder the server would switch, or nothing known about the
  // account: the checkout runs exactly as before.
  const NOT_SWITCHABLE: Array<[string, Reply]> = [
    ['NO_UPGRADEABLE_PRO', { status: 409, body: { error: 'NO_UPGRADEABLE_PRO' } }],
    ['ALREADY_API_PLAN', { status: 409, body: { error: 'ALREADY_API_PLAN' } }],
    ['ACCOUNT_DELETION_IN_PROGRESS', { status: 409, body: { error: 'ACCOUNT_DELETION_IN_PROGRESS' } }],
    ['an edge that predates the route (404)', NOT_FOUND],
    ['a Convex that predates the relay (502)', { status: 502, body: { error: 'Upgrade unavailable' } }],
    ['the edge limiter (429)', { status: 429, body: { error: 'Too many requests' } }],
    ['the limiter outage (503)', { status: 503, body: { error: 'Rate-limit service temporarily unavailable' } }],
    ['an expired session (401)', { status: 401, body: { error: 'UNAUTHENTICATED' } }],
    ['a network failure', { status: 0, body: null }],
    ['a reply that is not an API Starter quote', { status: 200, body: { ...QUOTE, toPlanKey: 'pro_business_monthly' } }],
    ['a quote without a charge', { status: 200, body: { ...QUOTE, chargeAmount: null } }],
  ];
  for (const [label, reply] of NOT_SWITCHABLE) {
    it(`is not switchable after ${label}, and shows nothing`, async () => {
      replies = [reply];
      expect(await runApiStarterSwitchFlow(options())).toBe('not-switchable');
      expect(dialog().open).toBe(false);
      expect(paths).toEqual(['/api-starter-switch']);
    });
  }

  it('asks nothing without a signed-in account', async () => {
    userId = null;
    expect(await runApiStarterSwitchFlow(options())).toBe('not-switchable');
    expect(paths).toEqual([]);
  });

  it('sends a cancel-scheduled Pro to the billing portal instead of selling a second plan', async () => {
    replies = [{ status: 409, body: { error: 'PRO_CANCEL_SCHEDULED' } }];
    expect(await runApiStarterSwitchFlow(options())).toBe('shown');
    expect(dialog().title).toBe('Resume Pro first');
    expect(dialog().body).toBe('Your Pro subscription is set to cancel at the end of this period. Resume it in the billing portal first, then switch to API Starter.');
    dialog().confirm();
    expect(portal).toBe(1);
  });

  // Sent after the server picked the Pro subscription to switch.
  for (const code of ['UPGRADE_RATE_LIMITED', 'UPGRADE_IN_PROGRESS', 'DODO_PLAN_CHANGE_ERROR']) {
    it(`stops the purchase after ${code}`, async () => {
      replies = [{ status: 409, body: { error: code } }];
      expect(await runApiStarterSwitchFlow(options())).toBe('shown');
      expect(dialog().title).toBe('Switch to API Starter');
      expect(dialog().body).toMatch(/^We could not price the switch right now\./);
    });
  }

  it('re-quotes once after CHARGE_CHANGED and confirms only the new charge', async () => {
    replies = [
      { status: 200, body: QUOTE },
      { status: 409, body: { error: 'CHARGE_CHANGED' } },
      { status: 200, body: { ...QUOTE, chargeAmount: 6150 } },
      { status: 200, body: UPGRADED },
    ];
    await runApiStarterSwitchFlow(options());
    dialog().confirm();
    await vi.waitFor(() => expect(dialog().body).toMatch(/^The price changed since your quote and your plan has not changed\./));
    expect(dialog().body).toContain('You pay $61.50 today');
    dialog().confirm();
    await vi.waitFor(() => expect(dialog().title).toBe('Switched to API Starter'));
    expect(bodies).toEqual([
      { confirm: false },
      { confirm: true, acceptedChargeAmount: 6012, acceptedChargeCurrency: 'USD' },
      { confirm: false },
      { confirm: true, acceptedChargeAmount: 6150, acceptedChargeCurrency: 'USD' },
    ]);
  });

  it('re-quotes a changed charge at most once', async () => {
    replies = [
      { status: 200, body: QUOTE },
      { status: 409, body: { error: 'CHARGE_CHANGED' } },
      { status: 200, body: QUOTE },
      { status: 409, body: { error: 'CHARGE_CHANGED' } },
    ];
    await runApiStarterSwitchFlow(options());
    dialog().confirm();
    await vi.waitFor(() => expect(dialog().body).toMatch(/^The price changed/));
    dialog().confirm();
    await vi.waitFor(() => expect(dialog().title).toBe('Switch not confirmed'));
    expect(bodies).toHaveLength(4);
  });

  // A rollback between the quote and the confirm.
  it('fails closed when the route is gone at the confirm', async () => {
    replies = [{ status: 200, body: QUOTE }, NOT_FOUND];
    await runApiStarterSwitchFlow(options());
    dialog().confirm();
    await vi.waitFor(() => expect(dialog().title).toBe('Switch not confirmed'));
    expect(dialog().body).toMatch(/could not confirm/);
    expect(paths).toEqual(['/api-starter-switch', '/api-starter-switch']);
  });

  it('does not call a reply for another plan a switch', async () => {
    replies = [{ status: 200, body: QUOTE }, { status: 200, body: { ...UPGRADED, toPlanKey: 'pro_business_monthly' } }];
    await runApiStarterSwitchFlow(options());
    dialog().confirm();
    await vi.waitFor(() => expect(dialog().title).toBe('Switch not confirmed'));
  });

  it('refuses to confirm from another account than the one that saw the quote', async () => {
    replies = [{ status: 200, body: QUOTE }];
    await runApiStarterSwitchFlow(options());
    userId = 'user_b';
    dialog().confirm();
    await vi.waitFor(() => expect(dialog().title).toBe('Account changed'));
    expect(dialog().body).toBe('You switched accounts after this quote. Start the switch again from the account you want to move to API Starter.');
    expect(paths).toHaveLength(1);
  });

  it('asks for no quote when the account changes while the token is read', async () => {
    replies = [{ status: 200, body: QUOTE }];
    const outcome = await runApiStarterSwitchFlow({
      ...options(),
      getToken: async () => { userId = 'user_b'; return 'token'; },
    });
    expect(outcome).toBe('shown');
    expect(dialog().title).toBe('Account changed');
    expect(paths).toHaveLength(0);
  });
});
