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
  type OpenSignInDecision,
} from '@/services/webmcp-access-snapshot';
import type { AccessContextSnapshot, OpenSignInResult } from '@/services/webmcp';

function currentOpenSignInDecision(loadFailed = false): OpenSignInDecision {
  const clerkReady = isClerkReady();
  return resolveWebMcpOpenSignIn({
    clerkEnabled: isClerkAuthEnabled(),
    clerkReady,
    alreadyOpen: clerkReady && isClerkSignInOpen(),
    loadFailed,
  });
}

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
  let decision = currentOpenSignInDecision();
  if ('reason' in decision) return decision;

  if (decision.action === 'load_and_open') {
    let loadFailed = false;
    try {
      await initClerk();
    } catch {
      loadFailed = true;
    }
    decision = currentOpenSignInDecision(loadFailed || !isClerkReady());
    if ('reason' in decision) return decision;
  }

  const opened = await openSignInAndWait();
  if (!opened) return { ok: false, status: 'denied', reason: 'clerk_unavailable' };
  return { ok: true, status: 'opened' };
}
