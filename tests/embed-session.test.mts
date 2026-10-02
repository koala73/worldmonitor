import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EmbedKeyUnavailableError } from '../server/_shared/embed-key';
import { evaluateEmbedSession, type EmbedSessionDeps } from '../server/_shared/embed-session';
import type { CachedEntitlements } from '../server/_shared/entitlement-check';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOW = 1_700_000_000_000;
const EMBED_KEY = `wme_${'a'.repeat(40)}`;

function entitled(overrides: Partial<CachedEntitlements> = {}): CachedEntitlements {
  return {
    planKey: 'pro_monthly',
    features: {
      tier: 1,
      apiAccess: false,
      embedAccess: true,
      apiRateLimit: 0,
      maxDashboards: 1,
      prioritySupport: false,
      exportFormats: [],
    },
    validUntil: NOW + 86_400_000,
    ...overrides,
  };
}

function deps(overrides: Partial<EmbedSessionDeps> = {}): EmbedSessionDeps {
  return {
    validateEmbedKey: async () => ({ userId: 'user_partner' }),
    getEntitlements: async () => entitled(),
    getAccountPlan: async () => 'free',
    isEntitlementBackendConfigured: () => true,
    mintGrant: async ({ panel, accountId }) => ({
      token: `wmg_test.${panel}.${accountId}`,
      expiresAt: NOW + 30 * 60 * 1000,
    }),
    now: () => NOW,
    ...overrides,
  };
}

describe('embed grant exchange', () => {
  it('mints a panel-scoped grant for an entitled embed key', async () => {
    const result = await evaluateEmbedSession('map', EMBED_KEY, deps());
    assert.equal(result.status, 200);
    assert.equal(result.body.granted, true);
    assert.equal(result.body.panel, 'map');
    assert.equal(result.body.grant, 'wmg_test.map.user_partner');
    assert.equal(result.body.expiresAt, NOW + 30 * 60 * 1000);
    assert.equal(result.body.accountId, 'user_partner');
    assert.equal(result.retryAfterSeconds, undefined);
  });

  it('mints for a Clerk-role PRO account without a Convex entitlement row', async () => {
    const result = await evaluateEmbedSession('map', EMBED_KEY, deps({
      getEntitlements: async () => null,
      getAccountPlan: async () => 'pro',
    }));

    assert.equal(result.status, 200);
    assert.equal(result.body.grant, 'wmg_test.map.user_partner');
  });

  it('lets current embed coverage win before stronger-plan billing markers', async () => {
    let roleLookups = 0;
    for (const billingStatus of ['subscription_lapsed', 'renewal_verification_pending'] as const) {
      const result = await evaluateEmbedSession('map', EMBED_KEY, deps({
        getEntitlements: async () => entitled({ billingStatus }),
        getAccountPlan: async () => {
          roleLookups += 1;
          return 'unavailable';
        },
      }));
      assert.equal(result.status, 200, billingStatus);
    }
    assert.equal(roleLookups, 0);
  });

  it('returns retryable 503 when neither account authority can be verified', async () => {
    const result = await evaluateEmbedSession('map', EMBED_KEY, deps({
      getEntitlements: async () => null,
      getAccountPlan: async () => 'unavailable',
    }));

    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'account_verification_unavailable');
    assert.ok((result.retryAfterSeconds ?? 0) > 0);
  });

  it('scopes the grant to the requested panel', async () => {
    const result = await evaluateEmbedSession('fear_greed', EMBED_KEY, deps());
    assert.equal(result.status, 200);
    assert.equal(result.body.panel, 'fear-greed');
    assert.equal(result.body.grant, 'wmg_test.fear-greed.user_partner');
  });

  it('rejects unknown panels before touching the credential', async () => {
    let validated = false;
    const result = await evaluateEmbedSession('x-feed', EMBED_KEY, deps({
      validateEmbedKey: async () => {
        validated = true;
        return { userId: 'user_partner' };
      },
    }));
    assert.equal(result.status, 404);
    assert.equal(result.body.error, 'unknown_panel');
    assert.equal(validated, false);
  });

  it('names the wrong credential family instead of a generic 401', async () => {
    const missing = await evaluateEmbedSession('map', null, deps());
    assert.equal(missing.status, 401);
    assert.equal(missing.body.error, 'embed_key_required');

    const session = await evaluateEmbedSession('map', 'wms_abc.def', deps());
    assert.equal(session.status, 401);
    assert.equal(session.body.error, 'session_token_not_allowed');

    const apiKey = await evaluateEmbedSession('map', `wm_${'0'.repeat(40)}`, deps());
    assert.equal(apiKey.status, 401);
    assert.equal(apiKey.body.error, 'api_key_not_allowed');
  });

  it('does not validate a wm_ API key against the embed key table', async () => {
    let validated = false;
    const result = await evaluateEmbedSession('map', `wm_${'0'.repeat(40)}`, deps({
      validateEmbedKey: async () => {
        validated = true;
        return { userId: 'user_partner' };
      },
    }));
    assert.equal(result.status, 401);
    assert.equal(validated, false, 'a wm_ key must never reach the embed key path');
  });

  it('rejects an unknown or revoked embed key', async () => {
    const result = await evaluateEmbedSession('map', EMBED_KEY, deps({
      validateEmbedKey: async () => null,
    }));
    assert.equal(result.status, 401);
    assert.equal(result.body.error, 'invalid_embed_key');
  });

  it('denies a paid account whose plan does not carry embedAccess', async () => {
    const result = await evaluateEmbedSession('map', EMBED_KEY, deps({
      getEntitlements: async () => entitled({
        features: {
          tier: 2,
          apiAccess: true,
          apiRateLimit: 60,
          maxDashboards: 1,
          prioritySupport: false,
          exportFormats: [],
        },
      }),
    }));
    assert.equal(result.status, 403);
    assert.equal(result.body.error, 'embed_not_entitled');
  });

  it('denies an expired entitlement', async () => {
    const result = await evaluateEmbedSession('map', EMBED_KEY, deps({
      getEntitlements: async () => entitled({ validUntil: NOW - 1 }),
    }));
    assert.equal(result.status, 403);
    assert.equal(result.body.error, 'embed_not_entitled');
  });

  it('returns a terminal 403 for a confirmed free account', async () => {
    const result = await evaluateEmbedSession('map', EMBED_KEY, deps({
      getEntitlements: async () => null,
      isEntitlementBackendConfigured: () => true,
    }));
    assert.equal(result.status, 403);
    assert.equal(result.body.error, 'embed_not_entitled');
    assert.equal(result.retryAfterSeconds, undefined);
  });

  describe('lapse handling', () => {
    it('treats subscription_lapsed as terminal so the frame can drop to the free tier', async () => {
      const result = await evaluateEmbedSession('map', EMBED_KEY, deps({
        getEntitlements: async () => entitled({
          billingStatus: 'subscription_lapsed',
          validUntil: NOW - 1,
        }),
      }));
      assert.equal(result.status, 403);
      assert.equal(result.body.error, 'subscription_lapsed');
      assert.equal(result.retryAfterSeconds, undefined);
    });

    it('treats renewal_verification_pending as retryable so the frame keeps its last frame', async () => {
      const result = await evaluateEmbedSession('map', EMBED_KEY, deps({
        getEntitlements: async () => entitled({
          billingStatus: 'renewal_verification_pending',
          retryAfterSeconds: 30,
          validUntil: NOW - 1,
        }),
      }));
      assert.equal(result.status, 503);
      assert.equal(result.body.error, 'renewal_verification_pending');
      assert.equal(result.retryAfterSeconds, 30);
    });

    it('honours the shared 60s Retry-After ceiling rather than inventing its own', async () => {
      const result = await evaluateEmbedSession('map', EMBED_KEY, deps({
        getEntitlements: async () => entitled({
          billingStatus: 'renewal_verification_pending',
          retryAfterSeconds: 3_600,
          validUntil: NOW - 1,
        }),
      }));
      assert.equal(result.retryAfterSeconds, 60);
    });

    it('treats an unverifiable entitlement as retryable, never as a denial', async () => {
      const result = await evaluateEmbedSession('map', EMBED_KEY, deps({
        getEntitlements: async () => entitled({
          verificationUnavailable: true,
          retryAfterSeconds: 30,
          validUntil: NOW - 1,
        }),
      }));
      assert.equal(result.status, 503);
      assert.equal(result.body.error, 'entitlement_verification_unavailable');
      assert.equal(result.retryAfterSeconds, 30);
    });

    it('is retryable when the entitlement backend is unconfigured', async () => {
      const result = await evaluateEmbedSession('map', EMBED_KEY, deps({
        getEntitlements: async () => null,
        isEntitlementBackendConfigured: () => false,
      }));
      assert.equal(result.status, 503);
      assert.equal(result.body.error, 'entitlement_verification_unavailable');
      assert.ok((result.retryAfterSeconds ?? 0) > 0);
    });

    it('is retryable when embed key validation itself is unavailable', async () => {
      const result = await evaluateEmbedSession('map', EMBED_KEY, deps({
        validateEmbedKey: async () => {
          throw new EmbedKeyUnavailableError('convex down');
        },
      }));
      assert.equal(result.status, 503);
      assert.equal(result.body.error, 'key_validation_unavailable');
      assert.ok((result.retryAfterSeconds ?? 0) > 0);
    });

    it('every 503 carries a Retry-After budget', async () => {
      const retryables = await Promise.all([
        evaluateEmbedSession('map', EMBED_KEY, deps({
          getEntitlements: async () => entitled({
            billingStatus: 'renewal_verification_pending',
            validUntil: NOW - 1,
          }),
        })),
        evaluateEmbedSession('map', EMBED_KEY, deps({
          getEntitlements: async () => entitled({
            verificationUnavailable: true,
            validUntil: NOW - 1,
          }),
        })),
        evaluateEmbedSession('map', EMBED_KEY, deps({
          getEntitlements: async () => null,
          isEntitlementBackendConfigured: () => false,
        })),
      ]);
      for (const result of retryables) {
        assert.equal(result.status, 503);
        assert.ok(
          (result.retryAfterSeconds ?? 0) > 0,
          `503 ${result.body.error} must carry a retry budget`,
        );
      }
    });

    it('never leaks a grant on any denial', async () => {
      const denials = await Promise.all([
        evaluateEmbedSession('x-feed', EMBED_KEY, deps()),
        evaluateEmbedSession('map', null, deps()),
        evaluateEmbedSession('map', EMBED_KEY, deps({ validateEmbedKey: async () => null })),
        evaluateEmbedSession('map', EMBED_KEY, deps({ getEntitlements: async () => null })),
        evaluateEmbedSession('map', EMBED_KEY, deps({
          getEntitlements: async () => entitled({
            billingStatus: 'subscription_lapsed',
            validUntil: NOW - 1,
          }),
        })),
        evaluateEmbedSession('map', EMBED_KEY, deps({
          getEntitlements: async () => entitled({
            verificationUnavailable: true,
            validUntil: NOW - 1,
          }),
        })),
      ]);
      for (const result of denials) {
        assert.equal(result.body.granted, false);
        assert.equal(result.body.grant, undefined);
        assert.equal(result.body.expiresAt, undefined);
        assert.equal(result.body.accountId, undefined);
      }
    });
  });

  it('keeps the edge handler POST-only, cookie-free and uncacheable', () => {
    const source = readFileSync(resolve(__dirname, '../api/embed/session.ts'), 'utf-8');
    assert.match(source, /headers\.delete\('cookie'\)/);
    assert.match(source, /checkEndpointRateLimit/);
    assert.match(source, /'private, no-store'/);
    assert.match(source, /method !== 'POST'/);
    assert.match(source, /Retry-After/);
    // The grant is minted from the embed key path only — a wm_ user key must
    // not be able to reach it.
    assert.match(source, /validateEmbedKey/);
    assert.equal(source.includes('validateUserApiKey'), false);
    assert.equal(source.includes('getCookie'), false);
  });

  it('declares a fail-closed per-IP rate policy for the mint path', async () => {
    const { ENDPOINT_RATE_POLICIES, FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED } =
      await import('../server/_shared/rate-limit');
    assert.ok(ENDPOINT_RATE_POLICIES['/api/embed/session'], 'mint path needs a rate policy');
    assert.ok(
      FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED['/api/embed/session'],
      'a credential-issuing path must fail closed on a Redis outage',
    );
  });
});
