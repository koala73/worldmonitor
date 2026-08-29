import { FREE_MAX_PANELS } from '@/config/panels';
import { getAuthState } from '@/services/auth-state';
import {
  initClerk,
  isClerkAuthEnabled,
  isClerkReady,
  isClerkSignInOpen,
  openSignInAndWait,
} from '@/services/clerk';
import { getEntitlementState } from '@/services/entitlements';
import { evaluateTabCap } from '@/services/gates/export';
import { hasPremiumAccess } from '@/services/panel-gating';
import {
  buildWebMcpAccessContext,
  resolveWebMcpOpenSignIn,
} from '@/services/webmcp-access-snapshot';
import type { AccessContextSnapshot, OpenSignInResult } from '@/services/webmcp';

export {
  ACCESS_CONTEXT_PRIVACY_KEYS,
  buildWebMcpAccessContext,
  resolveWebMcpOpenSignIn,
} from '@/services/webmcp-access-snapshot';

export function getWebMcpAccessContext(options: {
  enabledPanelUsed: number;
  dashboardTabCount: number;
}): AccessContextSnapshot {
  const auth = getAuthState();
  return buildWebMcpAccessContext({
    auth,
    clerkEnabled: isClerkAuthEnabled(),
    clerkReady: isClerkReady(),
    premiumAccess: hasPremiumAccess(auth),
    entitlement: getEntitlementState(),
    tabCap: evaluateTabCap(auth, options.dashboardTabCount),
    enabledPanelUsed: options.enabledPanelUsed,
    dashboardTabCount: options.dashboardTabCount,
    freePanelCap: FREE_MAX_PANELS,
  });
}

export async function openWebMcpSignIn(): Promise<OpenSignInResult> {
  const decision = resolveWebMcpOpenSignIn({
    clerkEnabled: isClerkAuthEnabled(),
    clerkReady: isClerkReady(),
    alreadyOpen: isClerkSignInOpen(),
  });
  if ('reason' in decision) return decision;

  if (decision.action === 'load_and_open') {
    try {
      await initClerk();
    } catch {
      return { ok: false, status: 'denied', reason: 'clerk_unavailable' };
    }
    if (!isClerkReady()) {
      return { ok: false, status: 'denied', reason: 'clerk_unavailable' };
    }
    if (isClerkSignInOpen()) {
      return { ok: true, status: 'already_open', reason: 'already_open' };
    }
  }

  const opened = await openSignInAndWait();
  if (!opened) return { ok: false, status: 'denied', reason: 'clerk_unavailable' };
  return { ok: true, status: 'opened' };
}
