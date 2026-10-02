/**
 * Partner-embed entitlement: keyed to the embedding account's API key, never
 * to the page visitor's World Monitor session.
 */

import {
  parseEmbedPanelId,
  getEmbedPanelFreeTier,
  type EmbedPanelId,
} from '../../shared/embed-panels';
import { hasAccountEmbedAccess, hasEmbedAccess } from '../../shared/embed-access';
import type { ClerkPlanLookupResult } from '../auth-session';
import type { CachedEntitlements } from './entitlement-check';
import { isUserApiKeyUnavailableError } from './user-api-key';
import { isEmbedKeyUnavailableError } from './embed-key';

export interface EmbedEntitlementBody {
  allowed: boolean;
  panel?: EmbedPanelId;
  public?: boolean;
  accountId?: string;
  error?: string;
  /**
   * Set when the credential that WON is one this endpoint still honours but
   * would rather not: a `wm_` user key or an enterprise key, both of which do
   * far more than embed and are sitting in the partner's public HTML.
   *
   * Absent for a `wme_` embed key. Deliberately not an error and deliberately
   * carrying no sunset date — the frame turns it into a console warning, and
   * when the path closes is a commercial decision, not this module's.
   */
  deprecatedCredential?: 'user_api_key' | 'enterprise_key';
}

export interface EmbedEntitlementResult {
  status: 200 | 401 | 403 | 404 | 503;
  body: EmbedEntitlementBody;
}

export interface EmbedEntitlementDeps {
  getValidEnterpriseKeys: () => string[];
  timingSafeIncludes: (candidate: string, keys: readonly string[]) => Promise<boolean>;
  validateUserApiKey: (key: string) => Promise<{ userId: string } | null>;
  validateEmbedKey: (key: string) => Promise<{ userId: string } | null>;
  getEntitlements: (userId: string) => Promise<CachedEntitlements | null>;
  getAccountPlan: (userId: string) => Promise<ClerkPlanLookupResult>;
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

  // A panel with a free tier clears its own floor keylessly, so this endpoint
  // answers `public` without touching the credential — including when one was
  // supplied. Upgrading to the paid tier is `POST /api/embed/session`'s job,
  // which keeps key validation and lapse handling on ONE path; answering it
  // here too would mean a partner whose key lapsed loses the free render they
  // are still entitled to.
  if (getEmbedPanelFreeTier(panel) !== null) {
    return { status: 200, body: { allowed: true, panel, public: true } };
  }

  if (!apiKey) {
    return { status: 401, body: { allowed: false, error: 'embedding_api_key_required' } };
  }
  if (apiKey.startsWith('wms_')) {
    return { status: 401, body: { allowed: false, error: 'session_token_not_allowed' } };
  }

  // A `wme_` key is the credential this endpoint WANTS: it authorises embedding
  // and nothing else, which is the only safe thing to publish in page HTML.
  // Checked first, and on its own path — a wm_ key and a wme_ key must never
  // resolve through the same validator, table or cache namespace.
  if (apiKey.startsWith('wme_')) {
    try {
      const embedKey = await deps.validateEmbedKey(apiKey);
      if (!embedKey) {
        return { status: 401, body: { allowed: false, error: 'invalid_embedding_api_key' } };
      }
      return await answerForAccount(panel, embedKey.userId, deps);
    } catch (error) {
      if (isEmbedKeyUnavailableError(error)) {
        return { status: 503, body: { allowed: false, error: 'key_validation_unavailable' } };
      }
      throw error;
    }
  }

  const enterpriseKeys = deps.getValidEnterpriseKeys();
  if (enterpriseKeys.length > 0 && await deps.timingSafeIncludes(apiKey, enterpriseKeys)) {
    return {
      status: 200,
      body: {
        allowed: true,
        panel,
        public: false,
        accountId: 'enterprise',
        deprecatedCredential: 'enterprise_key',
      },
    };
  }

  try {
    const userKey = await deps.validateUserApiKey(apiKey);
    if (!userKey) {
      return { status: 401, body: { allowed: false, error: 'invalid_embedding_api_key' } };
    }
    return await answerForAccount(panel, userKey.userId, deps, 'user_api_key');
  } catch (error) {
    if (isUserApiKeyUnavailableError(error)) {
      return { status: 503, body: { allowed: false, error: 'key_validation_unavailable' } };
    }
    throw error;
  }
}

/**
 * The entitlement half of the answer, once a credential has resolved an
 * account — identical whichever key kind got us here, which is the point:
 * migrating a partner from `wm_` to `wme_` must not change who is entitled.
 *
 * `hasEmbedAccess` rather than `apiAccess`: embedding is its own catalog
 * entitlement, so any paid tier carrying it may embed even without REST API
 * access. It keeps the coverage rule the previous `apiAccess` check encoded —
 * a lapsed row with the flag still true fails on `validUntil` and 403s.
 */
async function answerForAccount(
  panel: EmbedPanelId,
  accountId: string,
  deps: EmbedEntitlementDeps,
  deprecatedCredential?: 'user_api_key' | 'enterprise_key',
): Promise<EmbedEntitlementResult> {
  const entitlements = await deps.getEntitlements(accountId);
  const now = Date.now();
  if (!hasEmbedAccess(entitlements, now)) {
    const accountPlan = await deps.getAccountPlan(accountId);
    if (accountPlan === 'unavailable') {
      return { status: 503, body: { allowed: false, error: 'account_verification_unavailable' } };
    }
    if (!hasAccountEmbedAccess(accountPlan, entitlements, now)) {
      if (entitlements?.verificationUnavailable || (!entitlements && !deps.isEntitlementBackendConfigured())) {
        return { status: 503, body: { allowed: false, error: 'entitlement_verification_unavailable' } };
      }
      return { status: 403, body: { allowed: false, error: 'embed_not_entitled' } };
    }
  }
  return {
    status: 200,
    body: {
      allowed: true,
      panel,
      public: false,
      accountId,
      ...(deprecatedCredential ? { deprecatedCredential } : {}),
    },
  };
}
