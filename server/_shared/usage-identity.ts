/**
 * Resolves the UsageIdentity for API telemetry from the incoming request.
 *
 * auth_kind drives the "who" dimension of the usage event.
 * principal_id is the stable identifier (org or user id depending on auth_kind).
 * customer_id is the Convex org reference used for billing aggregation.
 * tier is the current entitlement tier (0 = free, 1 = pro, etc.).
 */

export interface UsageIdentity {
  auth_kind: 'clerk_jwt' | 'user_api_key' | 'enterprise_api_key' | 'widget_key' | 'anon';
  principal_id: string | null;
  customer_id: string | null;
  tier: number;
}

let enterpriseKeyMap: Record<string, { principal_id: string; customer_id: string }> | null = null;

function getEnterpriseKeyMap(): Record<string, { principal_id: string; customer_id: string }> {
  if (enterpriseKeyMap) return enterpriseKeyMap;
  const envKey = process.env.WORLDMONITOR_VALID_KEYS ?? '';
  if (!envKey) return {};
  const keys = envKey.split(',').filter(Boolean);
  enterpriseKeyMap = {};
  for (const k of keys) {
    enterpriseKeyMap[k] = {
      principal_id: 'enterprise-internal',
      customer_id: process.env.ENTERPRISE_CUSTOMER_ID ?? 'enterprise-internal',
    };
  }
  return enterpriseKeyMap;
}

async function resolveTier(sessionUserId: string | null, fromApiKey: boolean): Promise<number> {
  if (!sessionUserId) return 0;
  if (fromApiKey) return 0;
  try {
    const { getEntitlements } = await import('./entitlement-check');
    const ent = await getEntitlements(sessionUserId);
    if (!ent) return 0;
    const tier = ent.features.tier;
    return typeof tier === 'number' ? tier : 0;
  } catch {
    return 0;
  }
}

export async function resolveUsageIdentity(
  request: Request,
  sessionUserId: string | null,
  isUserApiKey: boolean,
): Promise<UsageIdentity> {
  const authHeader = request.headers.get('Authorization') ?? '';
  const wmKey =
    request.headers.get('X-WorldMonitor-Key') ??
    request.headers.get('X-Api-Key') ??
    '';

  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    let orgId: string | null = null;
    try {
      const { jwtVerify } = await import('jose');
      const { getJWKS } = await import('../auth-session');
      const jwks = getJWKS();
      if (jwks) {
        const issuerDomain = process.env.CLERK_JWT_ISSUER_DOMAIN ?? '';
        const { payload } = await jwtVerify(token, jwks, {
          issuer: issuerDomain,
          algorithms: ['RS256'],
        });
        const ext = (payload as Record<string, unknown>).__raw as Record<string, unknown> | undefined;
        const orgClaim = ext?.org as Record<string, unknown> | undefined;
        orgId = typeof orgClaim?.id === 'string' ? orgClaim.id : null;
        if (!orgId) {
          orgId = typeof (payload as Record<string, unknown>).org_id === 'string'
            ? (payload as Record<string, unknown>).org_id as string
            : null;
        }
      }
    } catch { /* Clerk org id not critical */ }

    const tier = await resolveTier(sessionUserId, false);
    return {
      auth_kind: 'clerk_jwt',
      principal_id: sessionUserId,
      customer_id: orgId,
      tier,
    };
  }

  if (wmKey.startsWith('wm_')) {
    let customerRef: string | null = null;
    try {
      const { getCachedJson } = await import('./redis');
      const keyHash = await sha256Hex(wmKey);
      const cached = await getCachedJson(`user-api-key:${keyHash}`);
      if (cached && typeof cached === 'object') {
        customerRef = (cached as Record<string, unknown>).userId as string | undefined ?? null;
      }
    } catch { /* non-critical */ }

    const tier = await resolveTier(sessionUserId, isUserApiKey);
    return {
      auth_kind: 'user_api_key',
      principal_id: sessionUserId,
      customer_id: customerRef,
      tier,
    };
  }

  if (wmKey) {
    const map = getEnterpriseKeyMap();
    const entry = map[wmKey];
    if (entry) {
      return {
        auth_kind: 'enterprise_api_key',
        principal_id: entry.principal_id,
        customer_id: entry.customer_id,
        tier: 999,
      };
    }
  }

  const widgetKey = request.headers.get('X-Widget-Key') ??
    request.headers.get('x-widget-key') ??
    '';
  if (widgetKey) {
    return {
      auth_kind: 'widget_key',
      principal_id: null,
      customer_id: widgetKey,
      tier: 0,
    };
  }

  return {
    auth_kind: 'anon',
    principal_id: null,
    customer_id: null,
    tier: 0,
  };
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}