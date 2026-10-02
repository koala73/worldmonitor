import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserApiKeyUnavailableError } from '../server/_shared/user-api-key';
import { EmbedKeyUnavailableError } from '../server/_shared/embed-key';
import { evaluateEmbedEntitlement, type EmbedEntitlementDeps } from '../server/_shared/embed-entitlement';

const __dirname = dirname(fileURLToPath(import.meta.url));

function deps(overrides: Partial<EmbedEntitlementDeps> = {}): EmbedEntitlementDeps {
  return {
    getValidEnterpriseKeys: () => [],
    timingSafeIncludes: async () => false,
    validateUserApiKey: async () => null,
    validateEmbedKey: async () => null,
    getEntitlements: async () => null,
    getAccountPlan: async () => 'free',
    isEntitlementBackendConfigured: () => true,
    ...overrides,
  };
}

describe('embed entitlement', () => {
  it('allows the public map without a key', async () => {
    const result = await evaluateEmbedEntitlement(null, null, deps());
    assert.equal(result.status, 200);
    assert.equal(result.body.allowed, true);
    assert.equal(result.body.panel, 'map');
    assert.equal(result.body.public, true);
  });

  it('rejects unknown panels', async () => {
    const result = await evaluateEmbedEntitlement('intel', 'wm_0123456789abcdef0123456789abcdef01234567', deps());
    assert.equal(result.status, 404);
    assert.equal(result.body.error, 'unknown_panel');
  });

  it('requires an embedding API key for keyed panels and rejects session tokens', async () => {
    const missing = await evaluateEmbedEntitlement('fear-greed', null, deps());
    assert.equal(missing.status, 401);
    assert.equal(missing.body.error, 'embedding_api_key_required');

    const session = await evaluateEmbedEntitlement('chokepoint-strip', 'wms_anonymous', deps());
    assert.equal(session.status, 401);
    assert.equal(session.body.error, 'session_token_not_allowed');
  });

  it('accepts an enterprise embedding key and a user key with embedAccess', async () => {
    const enterprise = await evaluateEmbedEntitlement('fear-greed', 'enterprise-key', deps({
      getValidEnterpriseKeys: () => ['enterprise-key'],
      timingSafeIncludes: async (candidate, keys) => keys.includes(candidate),
    }));
    assert.equal(enterprise.status, 200);
    assert.equal(enterprise.body.accountId, 'enterprise');
    assert.equal(enterprise.body.public, false);

    const user = await evaluateEmbedEntitlement('chokepoint-strip', 'wm_0123456789abcdef0123456789abcdef01234567', deps({
      validateUserApiKey: async () => ({ userId: 'user_abc' }),
      getEntitlements: async () => ({
        planKey: 'api_starter',
        features: { tier: 2, apiAccess: true, embedAccess: true, apiRateLimit: 60, maxDashboards: 1, prioritySupport: false, exportFormats: [] },
        validUntil: Date.now() + 86_400_000,
      }),
    }));
    assert.equal(user.status, 200);
    assert.equal(user.body.accountId, 'user_abc');
  });

  it('accepts a paid plan carrying embedAccess without REST apiAccess', async () => {
    // Embedding is its own catalog entitlement now: a Pro plan that never sold
    // REST access may still put a panel on a partner page.
    const result = await evaluateEmbedEntitlement('fear-greed', 'wm_0123456789abcdef0123456789abcdef01234567', deps({
      validateUserApiKey: async () => ({ userId: 'user_pro' }),
      getEntitlements: async () => ({
        planKey: 'pro_monthly',
        features: { tier: 1, apiAccess: false, embedAccess: true, apiRateLimit: 0, maxDashboards: 1, prioritySupport: false, exportFormats: [] },
        validUntil: Date.now() + 86_400_000,
      }),
    }));
    assert.equal(result.status, 200);
    assert.equal(result.body.accountId, 'user_pro');
  });

  it('accepts a Clerk-role PRO account without a Convex entitlement row', async () => {
    const result = await evaluateEmbedEntitlement('fear-greed', 'wm_0123456789abcdef0123456789abcdef01234567', deps({
      validateUserApiKey: async () => ({ userId: 'user_role_pro' }),
      getEntitlements: async () => null,
      getAccountPlan: async () => 'pro',
    }));

    assert.equal(result.status, 200);
    assert.equal(result.body.accountId, 'user_role_pro');
  });

  it('lets current embed coverage win before verification markers', async () => {
    let roleLookups = 0;
    const result = await evaluateEmbedEntitlement('chokepoint-strip', 'wm_0123456789abcdef0123456789abcdef01234567', deps({
      validateUserApiKey: async () => ({ userId: 'user_current_embed' }),
      getEntitlements: async () => ({
        planKey: 'pro_monthly',
        features: { tier: 1, apiAccess: false, embedAccess: true, apiRateLimit: 0, maxDashboards: 1, prioritySupport: false, exportFormats: [] },
        validUntil: Date.now() + 86_400_000,
        verificationUnavailable: true,
      }),
      getAccountPlan: async () => {
        roleLookups += 1;
        return 'unavailable';
      },
    }));

    assert.equal(result.status, 200);
    assert.equal(roleLookups, 0);
  });

  it('returns 503 when Clerk role lookup is unavailable and Convex cannot prove access', async () => {
    const result = await evaluateEmbedEntitlement('fear-greed', 'wm_0123456789abcdef0123456789abcdef01234567', deps({
      validateUserApiKey: async () => ({ userId: 'user_unknown' }),
      getEntitlements: async () => null,
      getAccountPlan: async () => 'unavailable',
    }));

    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'account_verification_unavailable');
  });

  it('denies an apiAccess row that does not carry embedAccess', async () => {
    // Fail-closed on the missing flag: a legacy row written before the catalog
    // field existed must not mint a publishable embed off REST access alone.
    const legacy = await evaluateEmbedEntitlement('fear-greed', 'wm_0123456789abcdef0123456789abcdef01234567', deps({
      validateUserApiKey: async () => ({ userId: 'user_legacy' }),
      getEntitlements: async () => ({
        planKey: 'api_starter',
        features: { tier: 2, apiAccess: true, apiRateLimit: 60, maxDashboards: 1, prioritySupport: false, exportFormats: [] },
        validUntil: Date.now() + 86_400_000,
      }),
    }));
    assert.equal(legacy.status, 403);
    assert.equal(legacy.body.error, 'embed_not_entitled');

    const revoked = await evaluateEmbedEntitlement('fear-greed', 'wm_0123456789abcdef0123456789abcdef01234567', deps({
      validateUserApiKey: async () => ({ userId: 'user_revoked' }),
      getEntitlements: async () => ({
        planKey: 'api_starter',
        features: { tier: 2, apiAccess: true, embedAccess: false, apiRateLimit: 60, maxDashboards: 1, prioritySupport: false, exportFormats: [] },
        validUntil: Date.now() + 86_400_000,
      }),
    }));
    assert.equal(revoked.status, 403);
    assert.equal(revoked.body.error, 'embed_not_entitled');
  });

  it('denies free-tier user keys and fails closed on validation outages', async () => {
    const denied = await evaluateEmbedEntitlement('fear-greed', 'wm_0123456789abcdef0123456789abcdef01234567', deps({
      validateUserApiKey: async () => ({ userId: 'user_free' }),
      getEntitlements: async () => ({
        planKey: 'free',
        features: { tier: 0, apiAccess: false, apiRateLimit: 0, maxDashboards: 1, prioritySupport: false, exportFormats: [] },
        validUntil: 0,
      }),
    }));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'embed_not_entitled');

    const unavailable = await evaluateEmbedEntitlement('fear-greed', 'wm_0123456789abcdef0123456789abcdef01234567', deps({
      validateUserApiKey: async () => {
        throw new UserApiKeyUnavailableError('convex down');
      },
    }));
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.error, 'key_validation_unavailable');
  });

  it('rejects an expired embedAccess entitlement the same way the gateway does', async () => {
    const expired = await evaluateEmbedEntitlement('fear-greed', 'wm_0123456789abcdef0123456789abcdef01234567', deps({
      validateUserApiKey: async () => ({ userId: 'user_lapsed' }),
      getEntitlements: async () => ({
        planKey: 'api_starter',
        features: { tier: 2, apiAccess: true, embedAccess: true, apiRateLimit: 60, maxDashboards: 1, prioritySupport: false, exportFormats: [] },
        validUntil: Date.now() - 1,
      }),
    }));
    assert.equal(expired.status, 403);
    assert.equal(expired.body.error, 'embed_not_entitled');
  });

  it('fails closed with 503 when the entitlement backend is unconfigured', async () => {
    const result = await evaluateEmbedEntitlement('fear-greed', 'wm_0123456789abcdef0123456789abcdef01234567', deps({
      validateUserApiKey: async () => ({ userId: 'user_abc' }),
      getEntitlements: async () => null,
      isEntitlementBackendConfigured: () => false,
    }));
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'entitlement_verification_unavailable');
  });

  it('returns 403 when Convex is configured but the account has no entitlements', async () => {
    const result = await evaluateEmbedEntitlement('fear-greed', 'wm_0123456789abcdef0123456789abcdef01234567', deps({
      validateUserApiKey: async () => ({ userId: 'user_free' }),
      getEntitlements: async () => null,
      isEntitlementBackendConfigured: () => true,
    }));
    assert.equal(result.status, 403);
    assert.equal(result.body.error, 'embed_not_entitled');
  });

  it('returns 401 for an invalid embedding API key', async () => {
    const result = await evaluateEmbedEntitlement(
      'fear-greed',
      'wm_0123456789abcdef0123456789abcdef01234567',
      deps(),
    );
    assert.equal(result.status, 401);
    assert.equal(result.body.error, 'invalid_embedding_api_key');
  });

  // ---- wme_ embed keys on the two paid panels -----------------------------

  const EMBED_KEY = `wme_${'a1b2c3d4e5'.repeat(4)}`;
  const paidEntitlement = (overrides: Record<string, unknown> = {}) => ({
    planKey: 'pro_monthly',
    features: { tier: 1, apiAccess: false, embedAccess: true, apiRateLimit: 0, maxDashboards: 1, prioritySupport: false, exportFormats: [] },
    validUntil: Date.now() + 86_400_000,
    ...overrides,
  });

  it('accepts a wme_ key and never routes it through the wm_ validator', async () => {
    let userValidatorCalls = 0;
    const result = await evaluateEmbedEntitlement('chokepoint-strip', EMBED_KEY, deps({
      validateEmbedKey: async () => ({ userId: 'user_embed' }),
      validateUserApiKey: async () => { userValidatorCalls += 1; return null; },
      getEntitlements: async () => paidEntitlement(),
    }));
    assert.equal(result.status, 200);
    assert.equal(result.body.accountId, 'user_embed');
    assert.equal(result.body.public, false);
    assert.equal(userValidatorCalls, 0, 'a wme_ key must never reach the userApiKeys table');
  });

  it('marks the wm_ and enterprise paths deprecated but keeps them working', async () => {
    // Partners are running these right now. The response says "this credential
    // does more than embed", it does not deny.
    const userKey = await evaluateEmbedEntitlement('fear-greed', 'wm_0123456789abcdef0123456789abcdef01234567', deps({
      validateUserApiKey: async () => ({ userId: 'user_legacy' }),
      getEntitlements: async () => paidEntitlement(),
    }));
    assert.equal(userKey.status, 200);
    assert.equal(userKey.body.deprecatedCredential, 'user_api_key');

    const enterprise = await evaluateEmbedEntitlement('fear-greed', 'enterprise-key', deps({
      getValidEnterpriseKeys: () => ['enterprise-key'],
      timingSafeIncludes: async (candidate, keys) => keys.includes(candidate),
    }));
    assert.equal(enterprise.status, 200);
    assert.equal(enterprise.body.deprecatedCredential, 'enterprise_key');
  });

  it('leaves the deprecation marker off a wme_ answer', async () => {
    const result = await evaluateEmbedEntitlement('fear-greed', EMBED_KEY, deps({
      validateEmbedKey: async () => ({ userId: 'user_embed' }),
      getEntitlements: async () => paidEntitlement(),
    }));
    assert.equal(result.body.deprecatedCredential, undefined);
  });

  it('applies the same entitlement rule to a wme_ key as to a wm_ one', async () => {
    // Migrating a partner off wm_ must not change who is entitled, so the
    // lapsed and unentitled answers have to match the legacy path exactly.
    const lapsed = await evaluateEmbedEntitlement('fear-greed', EMBED_KEY, deps({
      validateEmbedKey: async () => ({ userId: 'user_lapsed' }),
      getEntitlements: async () => paidEntitlement({ validUntil: Date.now() - 1 }),
    }));
    assert.equal(lapsed.status, 403);
    assert.equal(lapsed.body.error, 'embed_not_entitled');

    const noFlag = await evaluateEmbedEntitlement('fear-greed', EMBED_KEY, deps({
      validateEmbedKey: async () => ({ userId: 'user_free' }),
      getEntitlements: async () => paidEntitlement({
        features: { tier: 0, apiAccess: false, apiRateLimit: 0, maxDashboards: 1, prioritySupport: false, exportFormats: [] },
      }),
    }));
    assert.equal(noFlag.status, 403);
    assert.equal(noFlag.body.error, 'embed_not_entitled');
  });

  it('401s an unknown wme_ key and 503s a wme_ validation outage', async () => {
    const unknown = await evaluateEmbedEntitlement('fear-greed', EMBED_KEY, deps({
      validateEmbedKey: async () => null,
    }));
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error, 'invalid_embedding_api_key');

    const unavailable = await evaluateEmbedEntitlement('fear-greed', EMBED_KEY, deps({
      validateEmbedKey: async () => { throw new EmbedKeyUnavailableError('convex down'); },
    }));
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.error, 'key_validation_unavailable');
  });

  it('keeps the free map tier keyless even when a wme_ key is presented', async () => {
    let embedValidatorCalls = 0;
    const result = await evaluateEmbedEntitlement('map', EMBED_KEY, deps({
      validateEmbedKey: async () => { embedValidatorCalls += 1; return null; },
    }));
    assert.equal(result.status, 200);
    assert.equal(result.body.public, true);
    assert.equal(embedValidatorCalls, 0, 'the free tier answers before any credential lookup');
  });

  it('strips cookies and ignores viewer bearers in the entitlement edge handler', () => {
    const source = readFileSync(resolve(__dirname, '../api/embed/entitlement.ts'), 'utf-8');
    assert.match(source, /headers\.delete\('cookie'\)/);
    assert.match(source, /checkEndpointRateLimit/);
    assert.match(source, /X-WorldMonitor-Key/);
    assert.match(source, /isEntitlementBackendConfigured/);
    assert.equal(source.includes('validateBearerToken'), false);
    assert.equal(source.includes('getCookie'), false);
  });
});
