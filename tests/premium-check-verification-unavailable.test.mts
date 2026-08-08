/**
 * #5622 — `server/_shared/premium-check.ts` no longer flattens an unverifiable
 * entitlement into "not a subscriber".
 *
 * The gap: `resolvePremiumCallerIdentity` returned the same
 * `{ isPremium: false }` for a CONFIRMED free row and for the transient marker
 * `getEntitlements` synthesizes when the Convex lookup fails. `api/chat-analyst.ts`
 * turned that into `403 Pro subscription required` — directly contradicting the
 * comment sitting above it, which had already committed to "503 (not 403) so a
 * transient dependency blip never misclassifies a paying Pro user as
 * unsubscribed".
 *
 * The signal is additive: `isPremium` keeps its exact meaning, so the ~25
 * `isCallerPremium()` boolean consumers are untouched. That deliberate lossiness
 * is asserted here too, because it is a decision and not an oversight.
 *
 * Driven through the internal-MCP verified-marker branch: it is the one path
 * whose only network dependency is `getEntitlements`, so a fetch stub is enough
 * to steer the entitlement outcome without standing up Clerk.
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';

import {
  isCallerPremium,
  resolvePremiumCallerIdentity,
} from '../server/_shared/premium-check.ts';
import {
  __resetEntitlementNegativeCacheForTests,
} from '../server/_shared/entitlement-check.ts';
import {
  INTERNAL_MCP_VERIFIED_HEADER,
  TRUSTED_USER_ID_HEADER,
  getInternalMcpVerifiedNonce,
} from '../server/_shared/mcp-internal-hmac.ts';

const VERIFIED_NONCE = getInternalMcpVerifiedNonce();
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };

const PRO_ROW = {
  planKey: 'pro_monthly',
  features: {
    tier: 1,
    apiAccess: false,
    apiRateLimit: 0,
    maxDashboards: 10,
    prioritySupport: false,
    exportFormats: ['csv'],
    mcpAccess: true,
  },
  validUntil: Date.now() + 86_400_000,
};

const FREE_ROW = {
  planKey: 'free',
  features: {
    tier: 0,
    apiAccess: false,
    apiRateLimit: 0,
    maxDashboards: 3,
    prioritySupport: false,
    exportFormats: ['csv'],
    mcpAccess: false,
  },
  validUntil: 0,
};

/**
 * Steer the entitlement lookup. `convex` decides what the Convex fallback does;
 * Redis always misses so every call reaches it.
 */
function installFetchStub(convex: () => Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : String((input as Request)?.url ?? input);
    if (url.includes('redis.test/get/')) {
      return new Response(JSON.stringify({ result: undefined }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('redis.test')) {
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    if (url.includes('/api/internal-entitlements')) return convex();
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

function markerRequest(userId: string): Request {
  return new Request('https://api.worldmonitor.app/api/chat-analyst', {
    method: 'POST',
    headers: {
      [INTERNAL_MCP_VERIFIED_HEADER]: VERIFIED_NONCE,
      [TRUSTED_USER_ID_HEADER]: userId,
    },
  });
}

const okRow = (row: unknown) => async () =>
  new Response(JSON.stringify(row), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

beforeEach(() => {
  process.env.CONVEX_SITE_URL = 'https://fake.convex.site';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'fake-secret';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-test-token';
  __resetEntitlementNegativeCacheForTests();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  __resetEntitlementNegativeCacheForTests();
});

describe('resolvePremiumCallerIdentity marks an unverifiable entitlement (#5622)', () => {
  it('a Convex 5xx denies WITH the billing classification attached', async () => {
    installFetchStub(async () => new Response('upstream error', { status: 503 }));

    const identity = await resolvePremiumCallerIdentity(markerRequest('user_convex_5xx'));

    assert.equal(identity.isPremium, false, 'still fail-closed — nothing is granted');
    assert.equal(identity.billingDenial?.code, 'entitlement_verification_unavailable');
    assert.equal(identity.billingDenial?.retryable, true);
    // No identity leaks out of a denial.
    assert.equal(identity.userId, null);
    assert.equal(identity.kind, null);
  });

  it('a lookup timeout denies WITH the classification', async () => {
    installFetchStub(async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      });
    });

    const identity = await resolvePremiumCallerIdentity(markerRequest('user_timeout'));
    assert.equal(identity.isPremium, false);
    assert.equal(identity.billingDenial?.retryable, true);
  });

  /**
   * The regression an earlier `verificationUnavailable?: true` boolean allowed.
   *
   * convex/http.ts really does return a tier-0 row carrying
   * `billingStatus: renewal_verification_*` while the provider re-check is in
   * flight. A boolean that only tracked the synthesized transient marker dropped
   * those two states straight back onto the terminal upsell — the exact #5600
   * failure mode this field exists to remove. Both must arrive classified and
   * retryable.
   */
  for (const billingStatus of ['renewal_verification_pending', 'renewal_verification_failed'] as const) {
    it(`a tier-0 row carrying ${billingStatus} denies as RETRYABLE, not as an upsell`, async () => {
      installFetchStub(okRow({ ...FREE_ROW, billingStatus, retryAfterSeconds: 7 }));

      const identity = await resolvePremiumCallerIdentity(
        markerRequest(`user_${billingStatus}`),
      );

      assert.equal(identity.isPremium, false);
      assert.equal(identity.billingDenial?.code, billingStatus);
      assert.equal(identity.billingDenial?.retryable, true);
      assert.equal(identity.billingDenial?.retryAfterSeconds, 7);
      assert.equal(identity.billingDenial?.status, 503);
    });
  }

  it('a provider-CONFIRMED lapse denies as TERMINAL — classified, but not retryable', async () => {
    installFetchStub(okRow({ ...FREE_ROW, billingStatus: 'subscription_lapsed' }));

    const identity = await resolvePremiumCallerIdentity(markerRequest('user_lapsed'));

    assert.equal(identity.isPremium, false);
    assert.equal(identity.billingDenial?.code, 'subscription_lapsed');
    assert.equal(
      identity.billingDenial?.retryable,
      false,
      'a confirmed lapse must never be presented as retryable',
    );
    assert.equal(identity.billingDenial?.status, 403);
  });

  it('a CONFIRMED free row denies WITHOUT any classification — that is a real verdict', async () => {
    installFetchStub(okRow(FREE_ROW));

    const identity = await resolvePremiumCallerIdentity(markerRequest('user_confirmed_free'));
    assert.equal(identity.isPremium, false);
    assert.equal(
      identity.billingDenial,
      undefined,
      'marking a confirmed free user retryable would replace a clean upsell with a spinner',
    );
  });

  it('a 4xx from Convex is a lookup that did not happen — classified, never an upsell (#5619)', async () => {
    // A 4xx (bad shared secret, contract rejection) is a deploy defect rather
    // than a blip, and retrying cannot fix it. It is still not a statement
    // about this account's plan, so it must not reach the wire as one.
    installFetchStub(async () => new Response('forbidden', { status: 403 }));

    const identity = await resolvePremiumCallerIdentity(markerRequest('user_convex_4xx'));
    assert.equal(identity.isPremium, false);
    assert.equal(identity.billingDenial?.code, 'entitlement_verification_unavailable');
    assert.equal(identity.unauthenticated, undefined, 'the caller was identified — only the lookup failed');
  });

  it('a genuine Pro row is still premium — the marker path did not disturb the allow case', async () => {
    installFetchStub(okRow(PRO_ROW));

    const identity = await resolvePremiumCallerIdentity(markerRequest('user_real_pro'));
    assert.equal(identity.isPremium, true);
    assert.equal(identity.kind, 'internal-mcp');
    assert.equal(identity.userId, 'user_real_pro');
  });

  it('an unverifiable answer is NOT premium — the tag changes wording, never authorization', async () => {
    installFetchStub(async () => new Response('upstream error', { status: 503 }));
    assert.equal(await isCallerPremium(markerRequest('user_boolean_view')), false);
  });

  it('isCallerPremium reports false identically for confirmed-free and unverifiable', async () => {
    // The documented, deliberate lossiness: a boolean cannot carry the reason.
    // Callers that turn `false` into a terminal 403 must use the identity API.
    installFetchStub(okRow(FREE_ROW));
    assert.equal(await isCallerPremium(markerRequest('user_lossy_free')), false);
    installFetchStub(async () => new Response('upstream error', { status: 503 }));
    assert.equal(await isCallerPremium(markerRequest('user_lossy_unavailable')), false);
  });

  it('an unverified marker never reaches the entitlement lookup at all', async () => {
    // A spoofed marker falls through to the normal auth flow; with no other
    // credentials that is a plain deny, and the reason is about the credential.
    installFetchStub(async () => {
      throw new Error('getEntitlements must not run for a spoofed marker');
    });
    const req = new Request('https://api.worldmonitor.app/api/chat-analyst', {
      method: 'POST',
      headers: {
        [INTERNAL_MCP_VERIFIED_HEADER]: '1',
        [TRUSTED_USER_ID_HEADER]: 'user_spoofed',
      },
    });

    const identity = await resolvePremiumCallerIdentity(req);
    assert.equal(identity.isPremium, false);
    // `verificationUnavailable` was the field name an earlier draft of #5622
    // used; asserting it here could never fail. The identity carries
    // `billingDenial`, and a denial with no lookup behind it carries none —
    // it is a credential denial (#5619).
    assert.equal(identity.billingDenial, undefined);
    assert.equal(identity.unauthenticated, true);
  });
});

/**
 * The marker is only worth adding if a caller acts on it. `api/chat-analyst.ts`
 * is the adopting caller, driven here as the real handler so the assertion covers
 * the wiring and not just the predicate — a source-level check on this branch
 * would pass with the 403 restored.
 */
describe('api/chat-analyst adopts the retryable posture (#5622)', () => {
  const analystRequest = (userId: string) =>
    new Request('https://api.worldmonitor.app/api/chat-analyst', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://worldmonitor.app',
        [INTERNAL_MCP_VERIFIED_HEADER]: VERIFIED_NONCE,
        [TRUSTED_USER_ID_HEADER]: userId,
      },
      body: JSON.stringify({ query: 'what is happening in the strait of hormuz' }),
    });

  it('answers an unverifiable entitlement with the shared retryable 503, not the upsell 403', async () => {
    installFetchStub(async () => new Response('upstream error', { status: 503 }));
    const { default: handler } = await import('../api/chat-analyst.ts');

    const res = await handler(analystRequest('user_analyst_unavailable'));

    assert.equal(res.status, 503);
    assert.equal(res.headers.get('X-Billing-Verification'), 'entitlement_verification_unavailable');
    assert.equal(res.headers.get('Retry-After'), '5');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    // CORS must survive — the panel is cross-origin and an opaque failure is
    // indistinguishable from a crash.
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://worldmonitor.app');
    assert.deepEqual(await res.json(), {
      error: 'Unable to verify API access',
      code: 'entitlement_verification_unavailable',
    });
  });

  it('a CONFIRMED free caller still gets the honest 403 upsell', async () => {
    installFetchStub(okRow(FREE_ROW));
    const { default: handler } = await import('../api/chat-analyst.ts');

    const res = await handler(analystRequest('user_analyst_free'));

    assert.equal(res.status, 403);
    assert.equal(res.headers.get('X-Billing-Verification'), null);
    assert.deepEqual(await res.json(), { error: 'Pro subscription required' });
  });

  /**
   * The four billing states must reach the wire distinctly. An earlier version of
   * this route hand-built `{ verificationUnavailable: true }` to re-enter the
   * classifier, which rendered ALL of them as the same
   * `entitlement_verification_unavailable` / Retry-After: 5 — losing the
   * provider's own delay on the renewal codes and, worse, turning a confirmed
   * lapse into a retryable 503 that tells a lapsed subscriber to wait forever.
   */
  it('renders the provider delay for a renewal re-check, not a flattened default', async () => {
    installFetchStub(okRow({
      ...FREE_ROW,
      billingStatus: 'renewal_verification_pending',
      retryAfterSeconds: 3,
    }));
    const { default: handler } = await import('../api/chat-analyst.ts');

    const res = await handler(analystRequest('user_analyst_renewal'));

    assert.equal(res.status, 503);
    assert.equal(res.headers.get('X-Billing-Verification'), 'renewal_verification_pending');
    assert.equal(res.headers.get('Retry-After'), '3');
    assert.deepEqual(await res.json(), {
      error: 'Renewal verification pending',
      code: 'renewal_verification_pending',
    });
  });

  it('keeps a provider-confirmed lapse a terminal 403 with no Retry-After', async () => {
    installFetchStub(okRow({ ...FREE_ROW, billingStatus: 'subscription_lapsed' }));
    const { default: handler } = await import('../api/chat-analyst.ts');

    const res = await handler(analystRequest('user_analyst_lapsed'));

    assert.equal(res.status, 403);
    assert.equal(res.headers.get('X-Billing-Verification'), 'subscription_lapsed');
    assert.equal(res.headers.get('Retry-After'), null);
    assert.deepEqual(await res.json(), {
      error: 'Subscription lapsed',
      code: 'subscription_lapsed',
    });
  });
});
