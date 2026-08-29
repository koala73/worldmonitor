import type { AuthSession } from '@/services/auth-state';
import type { EntitlementState } from '@/services/entitlements';
import type { TabCapVerdict } from '@/services/gates/export-resolver';
import type { AccessContextSnapshot } from '@/services/webmcp';

/** Keys that must never appear on a WebMCP access snapshot or bounded result. */
export const ACCESS_CONTEXT_PRIVACY_KEYS = [
  'email',
  'name',
  'userId',
  'id',
  'token',
  'sessionId',
  'image',
  'session',
] as const;

export interface WebMcpAccessContextInput {
  auth: AuthSession;
  clerkEnabled: boolean;
  clerkReady: boolean;
  premiumAccess: boolean;
  entitlement: EntitlementState | null;
  tabCap: TabCapVerdict;
  enabledPanelUsed: number;
  dashboardTabCount: number;
  freePanelCap: number;
  /** True after FreeTierGate's AUTH_SETTLE_GRACE_MS backstop has fired. */
  freeTierFallbackActive: boolean;
  dataExport: boolean;
}

export interface OpenSignInDecisionInput {
  clerkEnabled: boolean;
  clerkReady: boolean;
  alreadyOpen: boolean;
  loadFailed?: boolean;
}

export type OpenSignInDecision =
  | { action: 'open' }
  | { action: 'load_and_open' }
  | { ok: true; status: 'already_open'; reason: 'already_open' }
  | { ok: false; status: 'denied'; reason: 'clerk_unavailable' };

function nonNegativeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Bounded, PII-free access snapshot for WebMCP. apiAccess/mcpAccess stay
 * fail-closed on the entitlement feature flags. dataExport is supplied by the
 * live export-gate reader so it matches the dashboard export lock.
 */
export function buildWebMcpAccessContext(
  input: WebMcpAccessContextInput,
): AccessContextSnapshot {
  const accountState = input.auth.isPending
    ? 'loading'
    : input.auth.user
      ? 'signed_in'
      : 'signed_out';

  let clerk: AccessContextSnapshot['clerk'];
  if (!input.clerkEnabled) clerk = 'unavailable';
  else if (input.clerkReady) clerk = 'ready';
  else if (input.auth.isPending) clerk = 'loading';
  else clerk = 'unavailable';

  const entitlementUnknown = accountState === 'signed_in' && input.entitlement == null;

  let productTier: AccessContextSnapshot['productTier'];
  if (accountState === 'loading' || (entitlementUnknown && !input.premiumAccess)) {
    productTier = 'unknown';
  } else if (input.premiumAccess) {
    productTier = 'pro';
  } else if (accountState === 'signed_in') {
    productTier = 'free';
  } else {
    productTier = 'anonymous';
  }

  const features = input.entitlement?.features;
  const deferLimits = accountState === 'loading' || entitlementUnknown;
  // Panel enforcement stops deferring at the 8s backstop even when the
  // Convex snapshot never arrives. Tab caps stay deferred: evaluateTabCap
  // remains uncapped while features are still null.
  const deferPanelCap = deferLimits && !input.freeTierFallbackActive;
  const panelCap = deferPanelCap || input.premiumAccess ? null : input.freePanelCap;
  const tabCap = deferLimits ? null : input.tabCap.cap;

  return {
    accountState,
    clerk,
    productTier,
    capabilities: {
      premiumAccess: input.premiumAccess === true,
      apiAccess: features?.apiAccess === true,
      mcpAccess: features?.mcpAccess === true,
      dataExport: input.dataExport === true,
    },
    limits: {
      enabledPanels: {
        used: nonNegativeCount(input.enabledPanelUsed),
        cap: panelCap,
      },
      dashboardTabs: {
        used: nonNegativeCount(input.dashboardTabCount),
        cap: tabCap,
        canCreate: deferLimits || input.tabCap.allowed,
      },
    },
  };
}

export function resolveWebMcpOpenSignIn(
  input: OpenSignInDecisionInput,
): OpenSignInDecision {
  if (!input.clerkEnabled || input.loadFailed === true) {
    return { ok: false, status: 'denied', reason: 'clerk_unavailable' };
  }
  if (input.alreadyOpen) {
    return { ok: true, status: 'already_open', reason: 'already_open' };
  }
  return input.clerkReady ? { action: 'open' } : { action: 'load_and_open' };
}
