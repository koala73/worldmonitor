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

  /**
   * #5622 — the Clerk `role === 'pro'` decision, pinned as the DENIAL it is.
   *
   * The issue asked for this either way: honor the allowance that
   * `checkEntitlementDetailed` grants for tier <= 1, or say why notification
   * writes require a billed row. The answer is the second one, and the reason is
   * not a preference — it is that this gate is not the only enforcement point.
   * Convex checks `tier >= 1` against the entitlements table inside the
   * mutations themselves (`assertProEntitlement`, convex/alertRules.ts:36 and
   * convex/notificationChannels.ts:64).
   *
   * So an edge-only allowance cannot grant access. It only moves the denial one
   * hop later and makes it worse: for `set-channel` — the call the day-0
   * activation wizard makes — Convex's 402 is not the 503 case in the relay
   * error arm, so it degrades to `500 Operation failed` instead of the clean
   * `403 pro_required` with an upgradeUrl.
   *
   * These tests pin the decision so a future reader does not "fix" the
   * inconsistency at the edge alone and reintroduce that 500. Granting Pro
   * notification delivery to role-only accounts has to change the Convex gates
   * too — #5646.
   */
  it('a Clerk role=pro session with no billed row still gets the clean upsell, not a deferred failure', async () => {
    const mod = await importFreshNotificationChannels();
    mod.__setNotificationChannelsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: 'user-clerk-pro', role: 'pro' }),
      getEntitlements: async () => freeShapedEntitlements({}),
      fetch: async () => {
        throw new Error(
          'the relay must not be reached: Convex would reject with PRO_REQUIRED, '
          + 'which degrades to 500 on this action',
        );
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

  it('the Clerk role never changes this gate — every role value reads the entitlement', async () => {
    // The gate must not branch on `role` at all. If a future edit reintroduces an
    // allowance, the lookup would be skipped for one of these and the assertion
    // on entitlementCalls fails.
    for (const role of ['pro', 'free', undefined, 'PRO'] as const) {
      const mod = await importFreshNotificationChannels();
      const entitlementCalls: string[] = [];
      mod.__setNotificationChannelsDepsForTests({
        validateBearerToken: async () => ({
          valid: true,
          userId: `user-role-${String(role)}`,
          ...(role === undefined ? {} : { role: role as never }),
        }),
        getEntitlements: async (userId: string) => {
          entitlementCalls.push(userId);
          return freeShapedEntitlements({});
        },
        fetch: async () => {
          throw new Error('relay must not be reached for a denied request');
        },
      });
      mock.method(console, 'warn', () => {});

      const res = await mod.default(makeSetChannelRequest(), ctx);

      assert.equal(res.status, 403, `role=${String(role)} must still be denied`);
      assert.deepEqual(
        entitlementCalls,
        [`user-role-${String(role)}`],
        `role=${String(role)} must not short-circuit the entitlement lookup`,
      );
      mock.restoreAll();
    }
  });

  it('a Clerk role=pro session with a BILLED row is allowed, as any tier-1 user is', async () => {
    // The complement: the denial above is about the missing row, not about the
    // role. A role-only account and a billed account must not be conflated in
    // either direction.
    const mod = await importFreshNotificationChannels();
    // Real relay shape for set-channel: the durable-welcome capability probe must
    // acknowledge `durableWelcomeScheduling: true`, then the mutation re-acks it.
    // Stubbing it properly lets this assert a 200 rather than "not 403", which a
    // 500 regression would also satisfy.
    const relayFetch = mock.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string };
      if (body.action === 'welcome-scheduling-capability') {
        return new Response(JSON.stringify({ durableWelcomeScheduling: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ isNew: true, welcomeScheduled: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    mod.__setNotificationChannelsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: 'user-clerk-pro-billed', role: 'pro' }),
      getEntitlements: async () => ({
        ...freeShapedEntitlements({}),
        features: { ...freeShapedEntitlements({}).features, tier: 1 },
        validUntil: Date.now() + 86_400_000,
      }),
      fetch: relayFetch as never,
    });
    mock.method(console, 'warn', () => {});

    const res = await mod.default(makeSetChannelRequest(), ctx);

    assert.equal(
      res.status,
      200,
      'a billed tier-1 row must pass the gate AND complete — notEqual(403) would '
      + 'also accept a 500 regression',
    );
    assert.ok(relayFetch.mock.calls.length > 0, 'the write must reach the relay');
  });

  /**
   * Load-bearing invariant, pinned because a whole other design depends on it.
   *
   * GET is ungated, so it can never answer a retryable billing 503. That is what
   * makes it safe for `getChannelsData` to be the ONE notification-channels call
   * the activation wizard wraps in a 5s deadline
   * (ACTIVATION_CONTEXT_TIMEOUT_MS, src/components/ProActivationInterstitial.ts)
   * while the client's retry waits up to 10s: the two can never meet. If GET were
   * ever gated, that read would abort on every transient denial instead of
   * retrying, and nothing else in the suite would notice.
   */
  it('GET stays ungated, so the timed context read can never meet the retry path', async () => {
    const mod = await importFreshNotificationChannels();
    const entitlementCalls: string[] = [];
    mod.__setNotificationChannelsDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: 'user-get-ungated' }),
      getEntitlements: async (userId: string) => {
        entitlementCalls.push(userId);
        return freeShapedEntitlements({ verificationUnavailable: true });
      },
      fetch: async () => new Response(JSON.stringify({ channels: [], alertRules: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    });
    mock.method(console, 'warn', () => {});

    const res = await mod.default(
      new Request('https://worldmonitor.app/api/notification-channels', {
        method: 'GET',
        headers: { Origin: 'https://worldmonitor.app', Authorization: 'Bearer clerk-token' },
      }),
      ctx,
    );

    assert.equal(res.status, 200, 'a GET must not be gated even for an unverifiable entitlement');
    assert.equal(res.headers.get('X-Billing-Verification'), null);
    assert.deepEqual(
      entitlementCalls,
      [],
      'the GET path must not consult entitlements at all',
    );
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
