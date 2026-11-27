/**
 * The /pro edge route for in-place plan changes validates the optional `kind`
 * and the Pro Yearly confirm's `discounted` flag before the relay, forwards
 * both, and passes the switch's typed refusals through for the client copy.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

process.env.CLERK_JWT_ISSUER_DOMAIN = 'https://clerk.upgrade.test';
process.env.CONVEX_SITE_URL = 'https://upgrade.convex.site';
process.env.CONVEX_TENANT_RELAY_SECRET = 'synthetic-tenant-relay-secret';
process.env.UPSTASH_REDIS_REST_URL = 'https://upgrade-redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic-redis-token';
const { default: handler } = await import('../api/pro-business-upgrade.ts');
const originalFetch = globalThis.fetch;

let privateKey: CryptoKey;
let relayBodies: unknown[] = [];
let relayResponse: () => Response = () => Response.json({ kind: 'preview' });

before(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  const jwk = { ...await exportJWK(pair.publicKey), kid: 'upgrade-test', alg: 'RS256' };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === 'https://clerk.upgrade.test') return Response.json({ keys: [jwk] });
    if (url.origin === 'https://upgrade-redis.test') {
      const commands = JSON.parse(String(init?.body)) as unknown[][];
      // Every limiter call is under its quota; idempotency keys are not used here.
      return Response.json(commands.map(() => ({ result: [4, 5] })));
    }
    assert.equal(String(input), 'https://upgrade.convex.site/relay/pro-business-upgrade');
    relayBodies.push(JSON.parse(String(init?.body)));
    return relayResponse();
  };
});
after(() => { globalThis.fetch = originalFetch; });

async function post(body: unknown): Promise<Response> {
  const token = await new SignJWT({ sub: 'user_switch', plan: 'pro' })
    .setProtectedHeader({ alg: 'RS256', kid: 'upgrade-test' })
    .setIssuer('https://clerk.upgrade.test').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  return handler(new Request('https://worldmonitor.app/api/pro-business-upgrade', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('api/pro-business-upgrade kind and discounted', () => {
  it('rejects an unknown kind and a non-boolean discounted before the relay', async () => {
    relayBodies = [];
    assert.equal((await post({ confirm: false, kind: 'pro_lifetime' })).status, 400);
    assert.equal((await post({ confirm: false, kind: 7 })).status, 400);
    assert.equal((await post({ confirm: true, kind: 'pro_annual', discounted: 'yes' })).status, 400);
    assert.deepEqual(relayBodies, []);
  });

  it('rejects a Pro Yearly confirm that does not name its quote', async () => {
    relayBodies = [];
    assert.equal((await post({ confirm: true, kind: 'pro_annual' })).status, 400);
    assert.deepEqual(relayBodies, []);
  });

  it('forwards kind and discounted, and omits both for the original upgrade', async () => {
    relayBodies = [];
    relayResponse = () => Response.json({ kind: 'upgraded', fromPlanKey: 'pro_monthly', toPlanKey: 'pro_annual' });
    assert.equal((await post({ confirm: true, kind: 'pro_annual', discounted: true })).status, 200);
    assert.equal((await post({ confirm: false })).status, 200);
    assert.deepEqual(relayBodies, [
      { userId: 'user_switch', confirm: true, kind: 'pro_annual', discounted: true },
      { userId: 'user_switch', confirm: false },
    ]);
  });

  it('passes the switch refusals through as 409', async () => {
    for (const code of ['PROMO_ENDED', 'PROMO_CODE_REJECTED', 'ALREADY_PRO_ANNUAL']) {
      relayResponse = () => Response.json({ error: code }, { status: 409 });
      const res = await post({ confirm: true, kind: 'pro_annual', discounted: true });
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: code });
    }
  });
});

describe('api/pro-business-upgrade accepted charge', () => {
  const confirm = { confirm: true, kind: 'pro_annual', discounted: true };

  it('rejects a malformed accepted charge before the relay', async () => {
    relayBodies = [];
    for (const bad of [
      { acceptedChargeAmount: '10496', acceptedChargeCurrency: 'USD' },
      { acceptedChargeAmount: -1, acceptedChargeCurrency: 'USD' },
      { acceptedChargeAmount: 10.5, acceptedChargeCurrency: 'USD' },
      { acceptedChargeAmount: 10496 },
      { acceptedChargeCurrency: 'USD' },
      { acceptedChargeAmount: 10496, acceptedChargeCurrency: 'usd' },
    ]) {
      assert.equal((await post({ ...confirm, ...bad })).status, 400, JSON.stringify(bad));
    }
    assert.deepEqual(relayBodies, []);
  });

  it('forwards the accepted charge, and omits it when the client sends none', async () => {
    relayBodies = [];
    relayResponse = () => Response.json({ kind: 'upgraded', fromPlanKey: 'pro_monthly', toPlanKey: 'pro_annual' });
    assert.equal((await post({ ...confirm, acceptedChargeAmount: 10496, acceptedChargeCurrency: 'USD' })).status, 200);
    assert.equal((await post(confirm)).status, 200);
    assert.deepEqual(relayBodies, [
      { userId: 'user_switch', ...confirm, acceptedChargeAmount: 10496, acceptedChargeCurrency: 'USD' },
      { userId: 'user_switch', ...confirm },
    ]);
  });

  it('passes CHARGE_CHANGED through as 409', async () => {
    relayResponse = () => Response.json({ error: 'CHARGE_CHANGED' }, { status: 409 });
    const res = await post({ ...confirm, acceptedChargeAmount: 10496, acceptedChargeCurrency: 'USD' });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'CHARGE_CHANGED' });
  });
});
