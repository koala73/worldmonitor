/**
 * #5600: the notification-channels POST gate flattened every sub-tier-1
 * entitlement into a hard `pro_required` 403 — including the transient
 * `verificationUnavailable` marker and the renewal-verification statuses that
 * the shared contract (server/_shared/entitlement-check.ts) requires be
 * answered with a retryable 503 + Retry-After.
 *
 * That is the surface the day-0 Pro activation wizard writes through, so a
 * paying customer whose entitlement lookup was momentarily unverifiable saw
 * "Real-time alerts are available on the Pro plan." and the client treated the
 * denial as final.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

async function importFreshNotificationChannels() {
  process.env.CONVEX_SITE_URL = 'https://convex.test';
  process.env.RELAY_SHARED_SECRET = 'relay-secret';
  process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
  return import(`../api/notification-channels.ts?test=${Date.now()}-${Math.random()}`);
}

function makeSetChannelRequest(): Request {
  return new Request('https://worldmonitor.app/api/notification-channels', {
    method: 'POST',
    headers: {
      Origin: 'https://worldmonitor.app',
      Authorization: 'Bearer clerk-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: 'set-channel',
      channelType: 'email',
      email: 'buyer@example.com',
    }),
  });
}

function freeShapedEntitlements(extra: Record<string, unknown>) {
  return {
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
    ...extra,
  };
}

const ctx = { waitUntil: (_promise: Promise<unknown>) => {} };

type Capture = { message: string; level?: string; tags?: Record<string, string> };

/**
 * Injectable stand-in for captureSilentError.
 *
 * The real transport cannot be observed here: api/_sentry-common.js's parseDsn()
 * returns early when process.env.NODE_TEST_CONTEXT is set — which node:test always
 * sets — so captureSilentError is a complete no-op under the runner. Before this
 * seam existed, the entire capture branch (including the
 * `code !== 'subscription_lapsed'` decision) could be deleted with every case in
 * this file still green.
 */
function makeCaptureSpy(into: Capture[]) {
  return (err: unknown, opts?: { level?: string; tags?: Record<string, string> }) => {
    into.push({
      message: err instanceof Error ? err.message : String(err),
      level: opts?.level,
      tags: opts?.tags,
    });
  };
}

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  restoreEnv();
});

describe('/api/notification-channels POST billing-verification capture', () => {
  it('reports a transient denial to Sentry at warning level, tagged and deduped', async () => {
    const mod = await importFreshNotificationChannels();
    const captures: Capture[] = [];
    mod.__resetDenialCaptureDedupForTests();
    mod.__setNotificationChannelsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: 'user-capture' }),
      getEntitlements: async () => freeShapedEntitlements({ verificationUnavailable: true }),
      fetch: async () => {
        throw new Error('relay must not be reached for a denied request');
      },
      captureSilentError: makeCaptureSpy(captures),
    });
    mock.method(console, 'warn', () => {});

    const res = await mod.default(makeSetChannelRequest(), ctx);
    assert.equal(res.status, 503);

    assert.equal(captures.length, 1);
    // `level` is the field buildEnvelope actually reads (api/_sentry-common.js);
    // a `severity` tag alone leaves the event at the 'error' default, which pages
    // on-call for an expected transient denial.
    assert.equal(captures[0]?.level, 'warning');
    assert.equal(captures[0]?.tags?.code, 'entitlement_verification_unavailable');
    assert.equal(captures[0]?.tags?.route, 'api/notification-channels');
    assert.equal(captures[0]?.tags?.step, 'billing-verification-denial');

    // Dedup: the capture sits downstream of the entitlement cache, so a repeat
    // request inside the window must not emit a second event.
    const again = await mod.default(makeSetChannelRequest(), ctx);
    assert.equal(again.status, 503);
    assert.equal(captures.length, 1, 'second denial inside the dedup window must not re-emit');
  });

  it('does NOT report a confirmed lapse — that is ordinary churn, already visible in Convex', async () => {
    const mod = await importFreshNotificationChannels();
    const captures: Capture[] = [];
    mod.__resetDenialCaptureDedupForTests();
    mod.__setNotificationChannelsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: 'user-lapsed-nocapture' }),
      getEntitlements: async () => freeShapedEntitlements({ billingStatus: 'subscription_lapsed' }),
      fetch: async () => {
        throw new Error('relay must not be reached for a denied request');
      },
      captureSilentError: makeCaptureSpy(captures),
    });
    mock.method(console, 'warn', () => {});

    const res = await mod.default(makeSetChannelRequest(), ctx);
    assert.equal(res.status, 403);
    assert.deepEqual(captures, []);
  });

  it('does NOT report a plain tier-0 free user', async () => {
    const mod = await importFreshNotificationChannels();
    const captures: Capture[] = [];
    mod.__resetDenialCaptureDedupForTests();
    mod.__setNotificationChannelsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: 'user-free-nocapture' }),
      getEntitlements: async () => freeShapedEntitlements({}),
      fetch: async () => {
        throw new Error('relay must not be reached for a denied request');
      },
      captureSilentError: makeCaptureSpy(captures),
    });
    mock.method(console, 'warn', () => {});

    const res = await mod.default(makeSetChannelRequest(), ctx);
    assert.equal(res.status, 403);
    assert.deepEqual(captures, []);
  });
});

describe('/api/notification-channels POST billing-verification contract', () => {
  it('answers a transient verification failure with a retryable 503, not pro_required', async () => {
    const mod = await importFreshNotificationChannels();
    const relayFetch = mock.fn(async () => {
      throw new Error('relay must not be reached for a denied request');
    });
    mod.__setNotificationChannelsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: 'user-verification-unavailable' }),
      getEntitlements: async () => freeShapedEntitlements({ verificationUnavailable: true }),
      fetch: relayFetch,
    });
    mock.method(console, 'warn', () => {});

    const res = await mod.default(makeSetChannelRequest(), ctx);

    assert.equal(res.status, 503);
    assert.equal(res.headers.get('X-Billing-Verification'), 'entitlement_verification_unavailable');
    assert.equal(res.headers.get('Retry-After'), '5');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://worldmonitor.app');
    assert.deepEqual(await res.json(), {
      error: 'Unable to verify API access',
      code: 'entitlement_verification_unavailable',
      requiredTier: 1,
    });
    assert.equal(relayFetch.mock.calls.length, 0);
  });

  it('answers a pending renewal verification with a retryable 503 carrying the provider hint', async () => {
    const mod = await importFreshNotificationChannels();
    mod.__setNotificationChannelsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: 'user-renewal-pending' }),
      getEntitlements: async () => freeShapedEntitlements({
        billingStatus: 'renewal_verification_pending',
        retryAfterSeconds: 11,
      }),
      fetch: async () => {
        throw new Error('relay must not be reached for a denied request');
      },
    });
    mock.method(console, 'warn', () => {});

    const res = await mod.default(makeSetChannelRequest(), ctx);

    assert.equal(res.status, 503);
    assert.equal(res.headers.get('X-Billing-Verification'), 'renewal_verification_pending');
    assert.equal(res.headers.get('Retry-After'), '11');
    assert.deepEqual(await res.json(), {
      error: 'Renewal verification pending',
      code: 'renewal_verification_pending',
      requiredTier: 1,
    });
  });

  it('keeps the lapsed subscription denial a 403 with its own code', async () => {
    const mod = await importFreshNotificationChannels();
    mod.__setNotificationChannelsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: 'user-lapsed' }),
      getEntitlements: async () => freeShapedEntitlements({
        billingStatus: 'subscription_lapsed',
      }),
      fetch: async () => {
        throw new Error('relay must not be reached for a denied request');
      },
    });
    mock.method(console, 'warn', () => {});

    const res = await mod.default(makeSetChannelRequest(), ctx);

    assert.equal(res.status, 403);
    assert.equal(res.headers.get('X-Billing-Verification'), 'subscription_lapsed');
    assert.deepEqual(await res.json(), {
      error: 'Subscription lapsed',
      code: 'subscription_lapsed',
      requiredTier: 1,
    });
  });

  it('answers a failed renewal verification with a retryable 503', async () => {
    const mod = await importFreshNotificationChannels();
    mod.__setNotificationChannelsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: 'user-renewal-failed' }),
      getEntitlements: async () => freeShapedEntitlements({
        billingStatus: 'renewal_verification_failed',
        retryAfterSeconds: 60,
      }),
      fetch: async () => {
        throw new Error('relay must not be reached for a denied request');
      },
    });
    mock.method(console, 'warn', () => {});

    const res = await mod.default(makeSetChannelRequest(), ctx);

    assert.equal(res.status, 503);
    assert.equal(res.headers.get('X-Billing-Verification'), 'renewal_verification_failed');
    assert.equal(res.headers.get('Retry-After'), '60');
    assert.deepEqual(await res.json(), {
      error: 'Renewal verification failed',
      code: 'renewal_verification_failed',
      requiredTier: 1,
    });
  });

  it('leaves the day-0 no-history marker on the terminal 403 path', async () => {
    // Scope pin for #5600: the poisoned-marker cohort arrives as a PLAIN tier-0
    // answer — `renewalVerificationFreshness` is not part of
    // getBillingVerificationDenial's input, so it cannot and must not become a
    // 503 here (that would hand every never-subscribed free user a retryable
    // error instead of a clean upsell). This endpoint deliberately keeps the
    // 403; the wrongful-denial window is bounded by
    // NOT_APPLICABLE_VERIFICATION_TTL_SECONDS instead. If someone later widens
    // the helper to react to this marker, this test tells them it was a choice.
    const mod = await importFreshNotificationChannels();
    mod.__setNotificationChannelsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: 'user-day0-marker' }),
      getEntitlements: async () => freeShapedEntitlements({
        renewalVerificationFreshness: { status: 'not_applicable', checkedAt: Date.now() },
      }),
      fetch: async () => {
        throw new Error('relay must not be reached for a denied request');
      },
    });
    mock.method(console, 'warn', () => {});

    const res = await mod.default(makeSetChannelRequest(), ctx);

    assert.equal(res.status, 403);
    assert.equal(res.headers.get('X-Billing-Verification'), null);
    assert.deepEqual(await res.json(), {
      error: 'pro_required',
      message: 'Real-time alerts are available on the Pro plan.',
      upgradeUrl: 'https://worldmonitor.app/pro',
    });
  });

  it('still hard-denies a genuine free user with the pro_required upsell', async () => {
    const mod = await importFreshNotificationChannels();
    mod.__setNotificationChannelsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: 'user-free' }),
      getEntitlements: async () => freeShapedEntitlements({}),
      fetch: async () => {
        throw new Error('relay must not be reached for a denied request');
      },
    });
    mock.method(console, 'warn', () => {});

    const res = await mod.default(makeSetChannelRequest(), ctx);

    assert.equal(res.status, 403);
    assert.equal(res.headers.get('X-Billing-Verification'), null);
    assert.deepEqual(await res.json(), {
      error: 'pro_required',
      message: 'Real-time alerts are available on the Pro plan.',
      upgradeUrl: 'https://worldmonitor.app/pro',
    });
  });

  it('fails closed with pro_required when the entitlement lookup returns null', async () => {
    const mod = await importFreshNotificationChannels();
    mod.__setNotificationChannelsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: 'user-null-entitlement' }),
      getEntitlements: async () => null,
      fetch: async () => {
        throw new Error('relay must not be reached for a denied request');
      },
    });
    mock.method(console, 'warn', () => {});

    const res = await mod.default(makeSetChannelRequest(), ctx);

    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), {
      error: 'pro_required',
      message: 'Real-time alerts are available on the Pro plan.',
      upgradeUrl: 'https://worldmonitor.app/pro',
    });
  });
});
