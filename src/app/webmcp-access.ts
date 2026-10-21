import { WEBMCP_UI_READY_TIMEOUT_MS } from '@/app/webmcp-dashboard';
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
import { evaluateExportGate, evaluateTabCap } from '@/services/gates/export';
import { hasPremiumAccess } from '@/services/panel-gating';
import {
  buildWebMcpAccessContext,
  resolveWebMcpOpenSignIn,
  type OpenSignInDecision,
} from '@/services/webmcp-access-snapshot';
import {
  raceWebMcpAbort,
  throwIfWebMcpAborted,
  type AccessContextSnapshot,
  type OpenSignInResult,
} from '@/services/webmcp';

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
  freeTierFallbackActive: boolean;
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
    freeTierFallbackActive: options.freeTierFallbackActive === true,
    dataExport: evaluateExportGate(auth).locked === false,
  });
}

async function loadClerkForSignIn(
  signal?: AbortSignal,
): Promise<'ready' | 'failed' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Do not abort or null Clerk's shared loadPromise — a cancelled or timed-out
  // tool must leave an in-flight SDK load running for the rest of the tab.
  const loaded = initClerk()
    .then((): 'ready' => 'ready')
    .catch((): 'failed' => 'failed');
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), WEBMCP_UI_READY_TIMEOUT_MS);
  });
  try {
    return await raceWebMcpAbort(Promise.race([loaded, timeout]), signal);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function openWebMcpSignIn(signal?: AbortSignal): Promise<OpenSignInResult> {
  throwIfWebMcpAborted(signal);
  let decision = currentOpenSignInDecision();
  if ('reason' in decision) return decision;

  if (decision.action === 'load_and_open') {
    const outcome = await loadClerkForSignIn(signal);
    decision = currentOpenSignInDecision(outcome !== 'ready' || !isClerkReady());
    if ('reason' in decision) return decision;
  }

  throwIfWebMcpAborted(signal);
  const opened = await raceWebMcpAbort(openSignInAndWait(signal), signal);
  if (!opened) return { ok: false, status: 'denied', reason: 'clerk_unavailable' };
  return { ok: true, status: 'opened' };
}
