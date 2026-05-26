// @ts-expect-error — JS module, no declaration file
import { validateApiKey } from '../../api/_api-key.js';
import { validateBearerToken } from '../auth-session';
import { getEntitlements } from './entitlement-check';
import {
  INTERNAL_MCP_VERIFIED_HEADER,
  TRUSTED_USER_ID_HEADER,
  getInternalMcpVerifiedNonce,
} from './mcp-internal-hmac';
import { validateUserApiKey } from './user-api-key';

/**
 * Returns true when the caller has a valid API key OR a PRO bearer token.
 * Used by handlers where the RPC endpoint is public but certain fields
 * (e.g. framework/systemAppend) should only be honored for premium callers.
 */
export async function isCallerPremium(request: Request): Promise<boolean> {
  // Internal-MCP context: trusted markers are set by the gateway AFTER an
  // HMAC verification on `X-WM-MCP-Internal` succeeds. Inbound copies of
  // these headers are stripped at the gateway entry (defense-in-depth) so
  // a client cannot reach this branch by injecting them directly.
  //
  // The verified-marker value is a per-process-startup random nonce. We
  // compare with timing-safe equality, not just `=== '1'`, so an attacker
  // hitting a direct (non-gateway-routed) edge function with a spoofed
  // marker fails closed — the gateway is the ONLY entity that knows the
  // nonce, and only it produces the value.
  //
  // Defensive re-fetch of getEntitlements (cache-hot, ~free): catches any
  // future code path where someone forgets to verify upstream, and any
  // mid-request entitlement lapse (tier just dropped to 0). The gateway
  // already entitlement-checks before propagating, so this is belt-and-
  // suspenders — but cheap and worth it for a security-critical gate.
  const verifiedMarker = request.headers.get(INTERNAL_MCP_VERIFIED_HEADER);
  const trustedUserId = request.headers.get(TRUSTED_USER_ID_HEADER);
  if (verifiedMarker && trustedUserId) {
    const expectedNonce = getInternalMcpVerifiedNonce();
    // Length-safe-then-byte-compare. JS strings cannot leak per-char timing
    // the way C strcmp does, but we still avoid early-exit branches.
    let diff = verifiedMarker.length ^ expectedNonce.length;
    const len = Math.max(verifiedMarker.length, expectedNonce.length);
    for (let i = 0; i < len; i++) {
      const a = i < verifiedMarker.length ? verifiedMarker.charCodeAt(i) : 0;
      const b = i < expectedNonce.length ? expectedNonce.charCodeAt(i) : 0;
      diff |= a ^ b;
    }
    if (diff === 0) {
      const ent = await getEntitlements(trustedUserId);
      if (
        ent &&
        ent.features.tier >= 1 &&
        // mcpAccess lands in U10. Until then the field is undefined for
        // existing entitlement rows; treat undefined as false (fail-closed)
        // so a misconfigured / pre-U10 row cannot grant premium semantics
        // through the internal-MCP path.
        (ent.features as { mcpAccess?: boolean }).mcpAccess === true
      ) {
        return true;
      }
      return false;
    }
    // Marker present but nonce mismatch: do NOT short-circuit. Fall
    // through to the normal auth flow — an attacker spoofing the marker
    // gets exactly the same auth surface as one without the marker, no
    // information leak about the nonce.
  }

  // Browser tester keys — validateApiKey returns required:false for trusted origins
  // even when a valid key is present, so we check the header directly first.
  const wmKey =
    request.headers.get('X-WorldMonitor-Key') ??
    request.headers.get('X-Api-Key') ??
    '';
  if (wmKey) {
    const validKeys = (process.env.WORLDMONITOR_VALID_KEYS ?? '')
      .split(',').map((k) => k.trim()).filter(Boolean);
    if (validKeys.length > 0 && validKeys.includes(wmKey)) return true;

    // Check user-owned API keys (wm_ prefix) via Convex lookup.
    // Key existence alone is not sufficient — verify the owner's entitlement.
    const userKey = await validateUserApiKey(wmKey);
    if (userKey) {
      const ent = await getEntitlements(userKey.userId);
      if (ent && ent.features.apiAccess === true) return true;
      return false;
    }
  }

  const keyCheck = (await validateApiKey(request, {})) as { valid: boolean; required: boolean };
  // Only treat as premium when an explicit API key was validated (required: true).
  // Trusted-origin short-circuits (required: false) do NOT imply PRO entitlement.
  if (keyCheck.valid && keyCheck.required) return true;

  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const session = await validateBearerToken(authHeader.slice(7));
    if (!session.valid) return false;
    if (session.role === 'pro') return true;
    // Clerk role isn't 'pro' — check Dodo entitlement tier as second signal.
    // A Dodo subscriber (tier >= 1) is premium regardless of Clerk role.
    if (session.userId) {
      const ent = await getEntitlements(session.userId);
      if (ent && ent.features.tier >= 1) return true;
    }
  }
  return false;
}
