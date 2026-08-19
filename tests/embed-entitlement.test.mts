import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserApiKeyUnavailableError } from '../server/_shared/user-api-key';
import { evaluateEmbedEntitlement, type EmbedEntitlementDeps } from '../server/_shared/embed-entitlement';

const __dirname = dirname(fileURLToPath(import.meta.url));

function deps(overrides: Partial<EmbedEntitlementDeps> = {}): EmbedEntitlementDeps {
  return {
    getValidEnterpriseKeys: () => [],
    timingSafeIncludes: async () => false,
    validateUserApiKey: async () => null,
    getEntitlements: async () => null,
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

  it('accepts an enterprise embedding key and a user key with apiAccess', async () => {
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
        features: { tier: 2, apiAccess: true, apiRateLimit: 60, maxDashboards: 1, prioritySupport: false, exportFormats: [] },
        validUntil: Date.now() + 86_400_000,
      }),
    }));
    assert.equal(user.status, 200);
    assert.equal(user.body.accountId, 'user_abc');
  });

  it('denies user keys without apiAccess and fails closed on validation outages', async () => {
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

  it('rejects an expired apiAccess entitlement the same way the gateway does', async () => {
    const expired = await evaluateEmbedEntitlement('fear-greed', 'wm_0123456789abcdef0123456789abcdef01234567', deps({
      validateUserApiKey: async () => ({ userId: 'user_lapsed' }),
      getEntitlements: async () => ({
        planKey: 'api_starter',
        features: { tier: 2, apiAccess: true, apiRateLimit: 60, maxDashboards: 1, prioritySupport: false, exportFormats: [] },
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
