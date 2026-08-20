/**
 * The checkout relay must carry the legal version the buyer was shown (#6976).
 *
 * The version is stamped from the deployed constant, never read from the
 * request body: the /pro bundle that renders the consent line and this edge
 * function ship from the same commit, so the constant is evidence while a
 * client-supplied value would just be the client asserting what it agreed to.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { CURRENT_LEGAL_VERSION } from '../shared/legal-documents.ts';

const originalEnv = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

async function importFreshCreateCheckout() {
  process.env.CONVEX_SITE_URL = 'https://convex.test';
  process.env.RELAY_SHARED_SECRET = 'relay-secret';
  return import(`../api/create-checkout.ts?test=${Date.now()}-${Math.random()}`);
}

function makeCheckoutRequest(body: Record<string, unknown> = {}): Request {
  return new Request('https://worldmonitor.app/api/create-checkout', {
    method: 'POST',
    headers: {
      Origin: 'https://worldmonitor.app',
      Authorization: 'Bearer clerk-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      productId: 'pdt_pro_monthly',
      returnUrl: 'https://worldmonitor.app/?wm_checkout=return',
      ...body,
    }),
  });
}

function relayBodyOf(relayFetch: ReturnType<typeof mock.fn>): Record<string, unknown> {
  const call = relayFetch.mock.calls[0];
  assert.ok(call, 'expected the relay to be called');
  const init = call.arguments[1] as RequestInit;
  return JSON.parse(String(init.body));
}

function okRelay() {
  return mock.fn(async () => Response.json({ checkoutUrl: 'https://checkout.test/session' }, { status: 200 }));
}

const VALID_SESSION = {
  valid: true as const,
  userId: 'user_buyer',
  email: 'buyer@example.com',
  name: 'Buyer',
};

afterEach(() => {
  mock.restoreAll();
  restoreEnv();
});

describe('/api/create-checkout legal acceptance stamping', () => {
  it('sends the deployed legal version to the relay', async () => {
    const mod = await importFreshCreateCheckout();
    const relayFetch = okRelay();
    mod.__setCreateCheckoutDepsForTests({ validateBearerToken: async () => VALID_SESSION, fetch: relayFetch });

    await mod.default(makeCheckoutRequest());

    assert.equal(relayBodyOf(relayFetch).legalVersion, CURRENT_LEGAL_VERSION);
  });

  it('ignores a legalVersion supplied by the caller', async () => {
    const mod = await importFreshCreateCheckout();
    const relayFetch = okRelay();
    mod.__setCreateCheckoutDepsForTests({ validateBearerToken: async () => VALID_SESSION, fetch: relayFetch });

    await mod.default(makeCheckoutRequest({ legalVersion: '1970-01-01' }));

    assert.equal(
      relayBodyOf(relayFetch).legalVersion,
      CURRENT_LEGAL_VERSION,
      'a caller must not be able to choose which version it is recorded as accepting',
    );
  });

  it('stamps a version the Convex validator accepts', async () => {
    // The relay drops anything that is not an ISO date, so a malformed
    // constant would silently record nothing at all.
    assert.match(CURRENT_LEGAL_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  });
});
