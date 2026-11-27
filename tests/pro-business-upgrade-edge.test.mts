/**
 * The /pro edge routes for in-place plan changes. Each plan change has its own
 * route at both hops, so a deploy that predates the Pro Yearly switch answers
 * 404 instead of running another plan change:
 *
 * - /api/pro-business-upgrade relays to /relay/pro-business-upgrade and does
 *   only Pro → Pro Business. It refuses a Pro Yearly request and forwards the
 *   body it had before the switch existed.
 * - /api/pro-annual-switch relays to /relay/pro-annual-switch. It validates the
 *   confirm's `discounted` flag, the accepted charge and listPrice, and passes
 *   the switch's typed refusals through for the client copy.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

process.env.CLERK_JWT_ISSUER_DOMAIN = 'https://clerk.upgrade.test';
process.env.CONVEX_SITE_URL = 'https://upgrade.convex.site';
process.env.CONVEX_TENANT_RELAY_SECRET = 'synthetic-tenant-relay-secret';
process.env.UPSTASH_REDIS_REST_URL = 'https://upgrade-redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic-redis-token';
const { default: upgradeHandler } = await import('../api/pro-business-upgrade.ts');
const { default: switchHandler } = await import('../api/pro-annual-switch.ts');
const { PLAN_CHANGE_RELAY_ABORT_MS } = await import('../api/_plan-change-relay.ts');
const originalFetch = globalThis.fetch;

let privateKey: CryptoKey;
let relayCalls: Array<{ path: string; body: unknown }> = [];
let limiterCalls = 0;
let relayResponse: () => Response = () => Response.json({ kind: 'preview' });
let relayFailure: Error | null = null;

before(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  const jwk = { ...await exportJWK(pair.publicKey), kid: 'upgrade-test', alg: 'RS256' };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === 'https://clerk.upgrade.test') return Response.json({ keys: [jwk] });
    if (url.origin === 'https://upgrade-redis.test') {
      limiterCalls += 1;
      const commands = JSON.parse(String(init?.body)) as unknown[][];
      // Every limiter call is under its quota; idempotency keys are not used here.
      return Response.json(commands.map(() => ({ result: [4, 5] })));
    }
    assert.equal(url.origin, 'https://upgrade.convex.site');
    relayCalls.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
    if (relayFailure) throw relayFailure;
    return relayResponse();
  };
});
after(() => { globalThis.fetch = originalFetch; });
beforeEach(() => {
  relayCalls = [];
  limiterCalls = 0;
  relayFailure = null;
  relayResponse = () => Response.json({ kind: 'preview' });
});

async function bearer(): Promise<string> {
  return new SignJWT({ sub: 'user_switch', plan: 'pro' })
    .setProtectedHeader({ alg: 'RS256', kid: 'upgrade-test' })
    .setIssuer('https://clerk.upgrade.test').setIssuedAt().setExpirationTime('5m').sign(privateKey);
}

async function postUpgrade(body: unknown): Promise<Response> {
  return upgradeHandler(new Request('https://worldmonitor.app/api/pro-business-upgrade', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await bearer()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

async function postSwitch(body: unknown): Promise<Response> {
  return switchHandler(new Request('https://worldmonitor.app/api/pro-annual-switch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await bearer()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

const relayBodies = () => relayCalls.map((call) => call.body);

describe('api/pro-business-upgrade is Pro Business only', () => {
  it('refuses a Pro Yearly request before the limiter and the relay', async () => {
    for (const body of [
      { confirm: true, kind: 'pro_annual', discounted: true },
      { confirm: false, kind: 'pro_annual' },
      { confirm: false, kind: 'pro_lifetime' },
      { confirm: false, kind: 7 },
    ]) {
      assert.equal((await postUpgrade(body)).status, 400, JSON.stringify(body));
    }
    assert.deepEqual(relayCalls, []);
    assert.equal(limiterCalls, 0);
  });

  // An open /pro tab from before the switch sends `{ confirm }` and nothing else.
  it('forwards the body it forwarded before the switch existed', async () => {
    relayResponse = () => Response.json({ kind: 'upgraded', fromPlanKey: 'pro_monthly', toPlanKey: 'pro_business_monthly' });
    assert.equal((await postUpgrade({ confirm: false })).status, 200);
    assert.equal((await postUpgrade({ confirm: true })).status, 200);
    assert.equal((await postUpgrade({ confirm: true, kind: 'pro_business', discounted: true })).status, 200);
    assert.deepEqual(relayCalls, [
      { path: '/relay/pro-business-upgrade', body: { userId: 'user_switch', confirm: false } },
      { path: '/relay/pro-business-upgrade', body: { userId: 'user_switch', confirm: true } },
      { path: '/relay/pro-business-upgrade', body: { userId: 'user_switch', confirm: true } },
    ]);
  });
});

describe('api/pro-annual-switch', () => {
  it('relays only to the switch relay, and never names a kind', async () => {
    relayResponse = () => Response.json({ kind: 'upgraded', fromPlanKey: 'pro_monthly', toPlanKey: 'pro_annual' });
    assert.equal((await postSwitch({ confirm: false })).status, 200);
    assert.equal((await postSwitch({ confirm: true, discounted: true })).status, 200);
    assert.deepEqual(relayCalls, [
      { path: '/relay/pro-annual-switch', body: { userId: 'user_switch', confirm: false } },
      { path: '/relay/pro-annual-switch', body: { userId: 'user_switch', confirm: true, discounted: true } },
    ]);
  });

  it('rejects a non-boolean discounted, and a confirm that does not name its quote, before the relay', async () => {
    assert.equal((await postSwitch({ confirm: true, discounted: 'yes' })).status, 400);
    assert.equal((await postSwitch({ confirm: true })).status, 400);
    assert.equal((await postSwitch({ discounted: true })).status, 400);
    assert.deepEqual(relayCalls, []);
  });

  it('passes the switch refusals through as 409', async () => {
    for (const code of ['PROMO_ENDED', 'PROMO_CODE_REJECTED', 'ALREADY_PRO_ANNUAL', 'CHARGE_CHANGED']) {
      relayResponse = () => Response.json({ error: code }, { status: 409 });
      const res = await postSwitch({ confirm: true, discounted: true });
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: code });
    }
  });

  // New Vercel, old Convex: the relay route does not exist yet.
  it('fails closed when the Convex deployment predates the switch relay', async () => {
    relayResponse = () => new Response('No matching routes found', { status: 404 });
    const res = await postSwitch({ confirm: true, discounted: true });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'Upgrade unavailable' });
    assert.deepEqual(relayCalls.map((call) => call.path), ['/relay/pro-annual-switch']);
  });

  // Under the Edge runtime's 25 s first-response cap, and above a confirm's
  // worst case: 21 s (PLAN_CHANGE_CONFIRM_WORST_CASE_MS in
  // convex/payments/billing.ts) plus the Convex hop.
  it('waits long enough for a confirm, and answers before the Edge runtime cap', () => {
    assert.equal(PLAN_CHANGE_RELAY_ABORT_MS, 23_000);
  });

  it('fails closed when the relay cannot be reached', async () => {
    relayFailure = new TypeError('fetch failed');
    const res = await postSwitch({ confirm: true, discounted: true });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'Upgrade unavailable' });
    assert.equal(relayCalls.length, 1);
  });

  // 200 headers, then the connection drops inside the JSON body.
  it('fails closed on a success reply whose body cannot be read, on both routes', async () => {
    relayResponse = () => new Response('{"kind":"upgraded","toPlan', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
    for (const res of [await postSwitch({ confirm: true, discounted: true }), await postUpgrade({ confirm: true })]) {
      assert.equal(res.status, 502);
      assert.deepEqual(await res.json(), { error: 'Upgrade unavailable' });
    }
  });

  describe('accepted charge', () => {
    const confirm = { confirm: true, discounted: true };

    it('rejects a malformed accepted charge before the relay', async () => {
      for (const bad of [
        { acceptedChargeAmount: '10496', acceptedChargeCurrency: 'USD' },
        { acceptedChargeAmount: -1, acceptedChargeCurrency: 'USD' },
        { acceptedChargeAmount: 10.5, acceptedChargeCurrency: 'USD' },
        { acceptedChargeAmount: 10496 },
        { acceptedChargeCurrency: 'USD' },
        { acceptedChargeAmount: 10496, acceptedChargeCurrency: 'usd' },
      ]) {
        assert.equal((await postSwitch({ ...confirm, ...bad })).status, 400, JSON.stringify(bad));
      }
      assert.deepEqual(relayCalls, []);
    });

    it('forwards the accepted charge, and omits it when the client sends none', async () => {
      relayResponse = () => Response.json({ kind: 'upgraded', fromPlanKey: 'pro_monthly', toPlanKey: 'pro_annual' });
      assert.equal((await postSwitch({ ...confirm, acceptedChargeAmount: 10496, acceptedChargeCurrency: 'USD' })).status, 200);
      assert.equal((await postSwitch(confirm)).status, 200);
      assert.deepEqual(relayBodies(), [
        { userId: 'user_switch', ...confirm, acceptedChargeAmount: 10496, acceptedChargeCurrency: 'USD' },
        { userId: 'user_switch', ...confirm },
      ]);
    });

    it('validates and forwards a list-price preview', async () => {
      assert.equal((await postSwitch({ confirm: false, listPrice: 'yes' })).status, 400);
      assert.deepEqual(relayCalls, []);
      assert.equal((await postSwitch({ confirm: false, listPrice: true })).status, 200);
      assert.deepEqual(relayBodies(), [{ userId: 'user_switch', confirm: false, listPrice: true }]);
    });
  });
});
