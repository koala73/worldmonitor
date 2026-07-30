/**
 * Gateway-level regression tests for LeadsService public access.
 *
 * Regression: the enterprise contact form on the /pro marketing page POSTs
 * to /api/leads/v1/submit-contact with NO credentials (no wms_ session, no
 * API key) — by design, since the audience is anonymous prospects. The
 * gateway 401'd these requests because the leads paths were missing from
 * PUBLIC_NO_AUTH_RPC_PATHS, so the handler's own anti-abuse stack
 * (server-side Turnstile, honeypot, free-email rejection, per-IP and
 * per-email rate limits) never ran. Same class of breakage for
 * register-interest, which the desktop runtime deliberately calls key-free
 * (src/services/runtime.ts isKeyFreeApiTarget).
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { installRedis } from './helpers/fake-upstash-redis.mts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.keys(process.env).forEach((k) => {
    if (!(k in originalEnv)) delete process.env[k];
  });
  Object.assign(process.env, originalEnv);
});

async function loadLeadsGateway() {
  const [{ createDomainGateway, PUBLIC_NO_AUTH_RPC_PATHS, serverOptions }, generated, { leadsHandler }, { PREMIUM_RPC_PATHS }] = await Promise.all([
    import('../server/gateway.ts'),
    import('../src/generated/server/worldmonitor/leads/v1/service_server.ts'),
    import('../server/worldmonitor/leads/v1/handler.ts'),
    import('../src/shared/premium-paths.ts'),
  ]);
  delete process.env.WORLDMONITOR_VALID_KEYS;
  // The endpoint rate limiter fails closed (503) when Redis is unconfigured;
  // install the fake so the request reaches the handler like in production.
  installRedis({});
  return {
    PUBLIC_NO_AUTH_RPC_PATHS,
    PREMIUM_RPC_PATHS,
    gateway: createDomainGateway(generated.createLeadsServiceRoutes(leadsHandler, serverOptions)),
  };
}

describe('leads gateway public access', () => {
  it('declares both leads RPCs public-no-auth and non-premium', async () => {
    const { PUBLIC_NO_AUTH_RPC_PATHS, PREMIUM_RPC_PATHS } = await loadLeadsGateway();
    assert.equal(PUBLIC_NO_AUTH_RPC_PATHS.has('/api/leads/v1/submit-contact'), true);
    assert.equal(PUBLIC_NO_AUTH_RPC_PATHS.has('/api/leads/v1/register-interest'), true);
    assert.equal(PREMIUM_RPC_PATHS.has('/api/leads/v1/submit-contact'), false);
    assert.equal(PREMIUM_RPC_PATHS.has('/api/leads/v1/register-interest'), false);
  });

  it('accepts an anonymous submit-contact POST (no API key, no session token)', async () => {
    const { gateway } = await loadLeadsGateway();

    // Honeypot-filled body: the handler short-circuits to a silent success
    // without touching Turnstile/Convex/Resend, so this exercises ONLY the
    // gateway auth pipeline — exactly the layer that regressed.
    const res = await gateway(new Request('https://api.worldmonitor.app/api/leads/v1/submit-contact', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://worldmonitor.app',
      },
      body: JSON.stringify({
        email: 'lead@example-corp.com',
        name: 'Lead',
        organization: 'ExampleCorp',
        phone: '+1 555 123 4567',
        message: 'hello',
        source: 'enterprise-contact',
        website: 'http://honeypot-filled.example',
        turnstileToken: '',
      }),
    }));

    assert.notEqual(res.status, 401, 'gateway must not 401 anonymous contact submissions');
    assert.equal(res.status, 200);
    const body = await res.json() as { status?: string };
    assert.equal(body.status, 'sent');
  });

  it('accepts an anonymous register-interest POST (no API key, no session token)', async () => {
    const { gateway } = await loadLeadsGateway();

    // Same honeypot short-circuit as submit-contact: registerInterest returns
    // a silent success before Turnstile/desktop-HMAC/Convex, isolating the
    // gateway auth layer for the waitlist path too.
    const res = await gateway(new Request('https://api.worldmonitor.app/api/leads/v1/register-interest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://worldmonitor.app',
      },
      body: JSON.stringify({
        email: 'lead@example-corp.com',
        source: 'pro-waitlist',
        website: 'http://honeypot-filled.example',
        turnstileToken: '',
      }),
    }));

    assert.notEqual(res.status, 401, 'gateway must not 401 anonymous waitlist signups');
    assert.equal(res.status, 200);
    const body = await res.json() as { status?: string };
    assert.equal(body.status, 'registered');
  });
});
