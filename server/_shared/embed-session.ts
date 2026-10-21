/**
 * The `wme_` key → `wmg_` grant exchange, as a decision over injected
 * dependencies. Transport lives in `api/embed/session.ts`.
 *
 * Split the same way `embed-entitlement.ts` is: the interesting part is which
 * entitlement states may mint, and that is worth testing without a Response,
 * a Convex round-trip, or an edge runtime.
 */

import { parseEmbedPanelId, type EmbedPanelId } from '../../shared/embed-panels';
import { hasAccountEmbedAccess, hasEmbedAccess } from '../../shared/embed-access';
import type { ClerkPlanLookupResult } from '../auth-session';
import { classifyBillingVerification, type CachedEntitlements } from './entitlement-check';
import { isEmbedKeyUnavailableError } from './embed-key';

export interface EmbedSessionBody {
  granted: boolean;
  panel?: EmbedPanelId;
  /** The `wmg_` token. Present only on 200. */
  grant?: string;
  expiresAt?: number;
  accountId?: string;
  error?: string;
}

export interface EmbedSessionResult {
  status: 200 | 401 | 403 | 404 | 503;
  body: EmbedSessionBody;
  /** Set on every 503 so the frame can back off rather than hammer. */
  retryAfterSeconds?: number;
}

export interface EmbedSessionDeps {
  validateEmbedKey: (key: string) => Promise<{ userId: string } | null>;
  getEntitlements: (userId: string) => Promise<CachedEntitlements | null>;
  getAccountPlan: (userId: string) => Promise<ClerkPlanLookupResult>;
  isEntitlementBackendConfigured: () => boolean;
  mintGrant: (
    claims: { panel: EmbedPanelId; accountId: string },
  ) => Promise<{ token: string; expiresAt: number }>;
  now: () => number;
}

const DEFAULT_RETRY_AFTER_SECONDS = 60;

/**
 * Exchange a partner embed key for a panel-scoped grant.
 *
 * The two failure shapes are load-bearing and the frame branches on them:
 *
 *   403 — terminal. The account cannot embed this panel and retrying will not
 *         change that, so the frame falls back to the free tier (or, for a
 *         paid-only panel, shows the denial).
 *   503 — retryable. We could not find out. The frame keeps whatever it is
 *         already showing; blanking a customer's wall display over a
 *         transient billing lookup is a worse outcome than stale data.
 *
 * `subscription_lapsed` is the only billing state that lands in the first
 * bucket (`classifyBillingVerification`); every other one is a lookup we owe
 * the customer another attempt at.
 */
export async function evaluateEmbedSession(
  panelParam: string | null,
  embedKey: string | null,
  deps: EmbedSessionDeps,
): Promise<EmbedSessionResult> {
  const panel = parseEmbedPanelId(panelParam);
  if (!panel) {
    return { status: 404, body: { granted: false, error: 'unknown_panel' } };
  }

  if (!embedKey) {
    return { status: 401, body: { granted: false, panel, error: 'embed_key_required' } };
  }
  // `validateEmbedKey` would reject these on shape anyway; naming them keeps a
  // partner who pasted the wrong token out of a blind debugging session.
  if (embedKey.startsWith('wms_')) {
    return { status: 401, body: { granted: false, panel, error: 'session_token_not_allowed' } };
  }
  if (embedKey.startsWith('wm_')) {
    return { status: 401, body: { granted: false, panel, error: 'api_key_not_allowed' } };
  }

  let key: { userId: string } | null;
  try {
    key = await deps.validateEmbedKey(embedKey);
  } catch (error) {
    if (isEmbedKeyUnavailableError(error)) {
      return {
        status: 503,
        body: { granted: false, panel, error: 'key_validation_unavailable' },
        retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
      };
    }
    throw error;
  }
  if (!key) {
    return { status: 401, body: { granted: false, panel, error: 'invalid_embed_key' } };
  }

  const entitlements = await deps.getEntitlements(key.userId);
  const now = deps.now();
  if (!hasEmbedAccess(entitlements, now)) {
    const accountPlan = await deps.getAccountPlan(key.userId);
    if (accountPlan === 'unavailable') {
      return {
        status: 503,
        body: { granted: false, panel, error: 'account_verification_unavailable' },
        retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
      };
    }

    if (!hasAccountEmbedAccess(accountPlan, entitlements, now)) {
      const denial = entitlements ? classifyBillingVerification(entitlements) : null;
      if (denial?.retryable) {
        return {
          status: 503,
          body: { granted: false, panel, error: denial.code },
          retryAfterSeconds: denial.retryAfterSeconds || DEFAULT_RETRY_AFTER_SECONDS,
        };
      }
      if (denial) {
        return { status: 403, body: { granted: false, panel, error: denial.code } };
      }
      if (!entitlements && !deps.isEntitlementBackendConfigured()) {
        return {
          status: 503,
          body: { granted: false, panel, error: 'entitlement_verification_unavailable' },
          retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
        };
      }
      return { status: 403, body: { granted: false, panel, error: 'embed_not_entitled' } };
    }
  }

  const grant = await deps.mintGrant({ panel, accountId: key.userId });
  return {
    status: 200,
    body: {
      granted: true,
      panel,
      grant: grant.token,
      expiresAt: grant.expiresAt,
      accountId: key.userId,
    },
  };
}
