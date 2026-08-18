/**
 * Partner-embed entitlement: keyed to the embedding account's API key, never
 * to the page visitor's World Monitor session.
 */

import {
  parseEmbedPanelId,
  panelRequiresEmbeddingApiKey,
  type EmbedPanelId,
} from '../../shared/embed-panels';
import type { CachedEntitlements } from './entitlement-check';
import { isUserApiKeyUnavailableError } from './user-api-key';

export interface EmbedEntitlementBody {
  allowed: boolean;
  panel?: EmbedPanelId;
  public?: boolean;
  accountId?: string;
  error?: string;
}

export interface EmbedEntitlementResult {
  status: 200 | 401 | 403 | 404 | 503;
  body: EmbedEntitlementBody;
}

export interface EmbedEntitlementDeps {
  getValidEnterpriseKeys: () => string[];
  timingSafeIncludes: (candidate: string, keys: readonly string[]) => Promise<boolean>;
  validateUserApiKey: (key: string) => Promise<{ userId: string } | null>;
  getEntitlements: (userId: string) => Promise<CachedEntitlements | null>;
  isEntitlementBackendConfigured: () => boolean;
}

export function parseEnterpriseApiKeys(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((key) => key.trim()).filter(Boolean);
}

export async function evaluateEmbedEntitlement(
  panelParam: string | null,
  apiKey: string | null,
  deps: EmbedEntitlementDeps,
): Promise<EmbedEntitlementResult> {
  const panel = parseEmbedPanelId(panelParam);
  if (!panel) {
    return { status: 404, body: { allowed: false, error: 'unknown_panel' } };
  }

  if (!panelRequiresEmbeddingApiKey(panel)) {
    return { status: 200, body: { allowed: true, panel, public: true } };
  }

  if (!apiKey) {
    return { status: 401, body: { allowed: false, error: 'embedding_api_key_required' } };
  }
  if (apiKey.startsWith('wms_')) {
    return { status: 401, body: { allowed: false, error: 'session_token_not_allowed' } };
  }

  const enterpriseKeys = deps.getValidEnterpriseKeys();
  if (enterpriseKeys.length > 0 && await deps.timingSafeIncludes(apiKey, enterpriseKeys)) {
    return { status: 200, body: { allowed: true, panel, public: false, accountId: 'enterprise' } };
  }

  try {
    const userKey = await deps.validateUserApiKey(apiKey);
    if (!userKey) {
      return { status: 401, body: { allowed: false, error: 'invalid_embedding_api_key' } };
    }
    const entitlements = await deps.getEntitlements(userKey.userId);
    if (entitlements?.verificationUnavailable) {
      return { status: 503, body: { allowed: false, error: 'entitlement_verification_unavailable' } };
    }
    if (!entitlements) {
      if (!deps.isEntitlementBackendConfigured()) {
        return { status: 503, body: { allowed: false, error: 'entitlement_verification_unavailable' } };
      }
      return { status: 403, body: { allowed: false, error: 'embed_not_entitled' } };
    }
    // Match gateway `apiAccessCovered`: apiAccess alone is not coverage.
    // A lapsed row with apiAccess still true must 403, not 200.
    if (
      entitlements.features.apiAccess === true &&
      (entitlements.validUntil ?? 0) >= Date.now()
    ) {
      return { status: 200, body: { allowed: true, panel, public: false, accountId: userKey.userId } };
    }
    return { status: 403, body: { allowed: false, error: 'embed_not_entitled' } };
  } catch (error) {
    if (isUserApiKeyUnavailableError(error)) {
      return { status: 503, body: { allowed: false, error: 'key_validation_unavailable' } };
    }
    throw error;
  }
}
