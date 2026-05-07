// @ts-expect-error — JS module, no declaration file
import { validateApiKey } from '../../api/_api-key.js';
import { validateBearerToken } from '../auth-session';
import { getEntitlements } from './entitlement-check';
import { validateUserApiKey } from './user-api-key';

/**
 * Returns true when the caller has a valid API key OR a PRO bearer token.
 * Used by handlers where the RPC endpoint is public but certain fields
 * (e.g. framework/systemAppend) should only be honored for premium callers.
 */
export async function isCallerPremium(request: Request): Promise<boolean> {
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
