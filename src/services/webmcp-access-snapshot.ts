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
 * Bounded, PII-free access snapshot for WebMCP. Capability flags come from the
 * same entitlement and premium-access sources the dashboard uses.
 */
export function buildWebMcpAccessContext(
  input: WebMcpAccessContextInput,
): AccessContextSnapshot {
  const accountState = input.auth.isPending
    ? 'loading'
    : input.auth.user
      ? 'signed_in'
      : 'signed_out';

  const clerk = !input.clerkEnabled
    ? 'unavailable'
    : input.clerkReady
      ? 'ready'
      : input.auth.isPending
        ? 'loading'
        : 'unavailable';

  const productTier = accountState === 'loading'
    ? 'unknown'
    : input.premiumAccess
      ? 'pro'
      : accountState === 'signed_in'
        ? 'free'
        : 'anonymous';

  const features = input.entitlement?.features;
  const loading = accountState === 'loading';
  const panelCap = loading || input.premiumAccess ? null : input.freePanelCap;
  const tabCap = loading ? null : input.tabCap.cap;

  return {
    accountState,
    clerk,
    productTier,
    capabilities: {
      premiumAccess: input.premiumAccess === true,
      apiAccess: features?.apiAccess === true,
      mcpAccess: features?.mcpAccess === true,
      dataExport: features?.dataExport === true,
    },
    limits: {
      enabledPanels: {
        used: nonNegativeCount(input.enabledPanelUsed),
        cap: panelCap,
      },
      dashboardTabs: {
        used: nonNegativeCount(input.dashboardTabCount),
        cap: tabCap,
        canCreate: loading || input.tabCap.allowed,
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
