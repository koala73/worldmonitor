/**
 * GET /api/desktop-key/status
 *
 * Whether the `wm_` key in `X-WorldMonitor-Key` currently grants desktop scope
 * (plan 2026-11-04-001 U2 / KTD3). A self-hosted sidecar asks this before it
 * unlocks Pro for a browser that entered its own desktop key, and again when
 * its cached verdict expires. It is a verdict, not a premium call: the key may
 * be lapsed or revoked, so the route is not premium-gated, and it never charges
 * the owner's desktop-key daily meter.
 *
 * The verdict composes the same steps as the desktop arm of
 * `server/_shared/premium-check.ts`, so this answer and the gateway's admission
 * cannot disagree:
 *
 *   validateUserApiKeyPrincipal → null           → 200 { verdict: 'invalid' }
 *   principal.keyKind === 'api'                  → 200 { verdict: 'not_desktop_key' }  (R6)
 *   resolveUserKeyEntitlement → null             → 503 unavailable
 *   resolveUserKeyScope → desktop                → 200 { verdict: 'active', planFamily }
 *   resolveUserKeyScope → denied over_cap        → 200 { verdict: 'over_cap' }
 *   resolveUserKeyScope → denied rank_unknown    → 503 unavailable
 *   resolveUserKeyScope → denied not_covered     → classifyBillingVerification:
 *       retryable (pending / failed / lookup unavailable) → 503 unavailable
 *       terminal lapse or no billing marker               → 200 { verdict: 'lapsed' }
 *   UserApiKeyUnavailableError                    → 503 unavailable
 *
 * Every verdict is a 200 so a 401/403 from anything in front of this route
 * (firewall, edge proof) can never be read as one; only a 200 carrying a known
 * `verdict` is a verdict. 503 and 429 carry Retry-After and no verdict.
 *
 * Rate limits (KTD3): resolved keys spend a per-owner bucket. Missing,
 * malformed and invalid keys spend a per-IP bucket, the enumeration case; a
 * valid key is never charged per IP, because every user of a hosted install
 * reaches the cloud from that install's one server IP. A generous per-IP
 * ceiling (the gateway's own default) runs before the lookup so the route
 * cannot become a Convex amplifier beyond what the gateway already allows.
 * A degraded per-IP ceiling fails closed with 503: it alone bounds the Convex
 * lookup, and a self-host sidecar keeps serving its last known verdict through
 * a 503. The buckets after the lookup (Redis-degraded scoped limits
 * intentionally stay availability-first there) cannot amplify anything.
 *
 * Called server-to-server with no browser Origin; CORS follows
 * api/embed/entitlement.ts. Responses are `no-store` and carry no owner id,
 * key id or key hash.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from '../_cors.js';
import {
  checkIpScopedEdgeProof,
  checkScopedRateLimit,
  getClientRateLimitKey,
  scopedTooManyRequestsResponse,
  type ScopedRateLimitResult,
} from '../../server/_shared/rate-limit';
import { classifyBillingVerification } from '../../server/_shared/entitlement-check';
import { validateUserApiKeyPrincipal, type UserKeyPrincipal } from '../../server/_shared/user-api-key';
import { resolveUserKeyEntitlement, resolveUserKeyScope } from '../../server/_shared/desktop-key-principal';

export const DESKTOP_KEY_STATUS_PATH = '/api/desktop-key/status';

/** Per owner, for keys that resolved. A sidecar caches each verdict for 5 minutes. */
export const DESKTOP_KEY_STATUS_OWNER_LIMIT = { limit: 30, window: '60 s' } as const;
/** Per IP, spent only by missing, malformed and invalid keys. */
export const DESKTOP_KEY_STATUS_IP_INVALID_LIMIT = { limit: 20, window: '10 m' } as const;
/** Per IP, every request, before any lookup: the gateway's default per-IP budget. */
export const DESKTOP_KEY_STATUS_IP_CEILING = { limit: 600, window: '60 s' } as const;

const SCOPE_OWNER = `${DESKTOP_KEY_STATUS_PATH}#owner`;
const SCOPE_IP_INVALID = `${DESKTOP_KEY_STATUS_PATH}#ip-invalid`;
const SCOPE_IP_CEILING = `${DESKTOP_KEY_STATUS_PATH}#ip`;

/** Seconds a sidecar waits after an unavailable answer that names no wait of its own. */
const DEFAULT_RETRY_AFTER_SECONDS = 5;

export type DesktopKeyVerdict = 'active' | 'invalid' | 'not_desktop_key' | 'over_cap' | 'lapsed';
export type DesktopKeyPlanFamily = 'pro' | 'pro_business' | 'api' | 'enterprise';

type DesktopKeyStatusDeps = {
  checkScopedRateLimit: typeof checkScopedRateLimit;
};

function createDefaultDeps(): DesktopKeyStatusDeps {
  return { checkScopedRateLimit };
}

let deps = createDefaultDeps();

export function __setDesktopKeyStatusDepsForTests(overrides: Partial<DesktopKeyStatusDeps> | null): void {
  deps = overrides ? { ...createDefaultDeps(), ...overrides } : createDefaultDeps();
}

/** Coarse family only: enough for copy ("your Pro key"), never the exact plan or billing cadence. */
export function planFamilyOf(planKey: string | undefined): DesktopKeyPlanFamily | undefined {
  if (!planKey) return undefined;
  if (planKey.startsWith('pro_business')) return 'pro_business';
  if (planKey.startsWith('pro_')) return 'pro';
  if (planKey.startsWith('api_')) return 'api';
  if (planKey === 'enterprise') return 'enterprise';
  return undefined;
}

export default async function handler(req: Request): Promise<Response> {
  const cors = getCorsHeaders(req, 'GET, OPTIONS') as Record<string, string>;
  const jsonHeaders = { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const json = (body: Record<string, unknown>, status: number, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { ...jsonHeaders, ...extra } });
  const verdict = (value: DesktopKeyVerdict, planFamily?: DesktopKeyPlanFamily) =>
    json(planFamily ? { verdict: value, planFamily } : { verdict: value }, 200);
  const unavailable = (retryAfterSeconds = DEFAULT_RETRY_AFTER_SECONDS) =>
    json({ error: 'unavailable' }, 503, { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) });
  const limited = (result: ScopedRateLimitResult, window: typeof DESKTOP_KEY_STATUS_OWNER_LIMIT.window | typeof DESKTOP_KEY_STATUS_IP_INVALID_LIMIT.window) => {
    // Keep the shared 429 header contract (Retry-After, RateLimit-*), with this
    // route's body and no-store.
    const shared = scopedTooManyRequestsResponse(result, window, cors);
    const headers = new Headers(shared.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429, headers });
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'GET') {
    return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET, OPTIONS' });
  }

  // Every per-IP bucket needs a trustworthy IP: an unproven cf-connecting-ip
  // would let a caller rotate buckets per request.
  const proofDenied = checkIpScopedEdgeProof(req, cors);
  if (proofDenied) {
    const headers = new Headers(proofDenied.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(proofDenied.body, { status: proofDenied.status, headers });
  }
  const ipKey = getClientRateLimitKey(req);

  const ceiling = await deps.checkScopedRateLimit(
    SCOPE_IP_CEILING,
    DESKTOP_KEY_STATUS_IP_CEILING.limit,
    DESKTOP_KEY_STATUS_IP_CEILING.window,
    ipKey,
  );
  if (!ceiling.allowed) return limited(ceiling, DESKTOP_KEY_STATUS_IP_CEILING.window);
  // The ceiling is the only bound in front of the Convex key lookup, and
  // rotating keys miss its per-hash negative cache. While the limiter cannot
  // count, refuse as the gateway does; a sidecar keeps its last verdict.
  if (ceiling.degraded) return unavailable();

  const invalid = async (): Promise<Response> => {
    const ip = await deps.checkScopedRateLimit(
      SCOPE_IP_INVALID,
      DESKTOP_KEY_STATUS_IP_INVALID_LIMIT.limit,
      DESKTOP_KEY_STATUS_IP_INVALID_LIMIT.window,
      ipKey,
    );
    if (!ip.allowed) return limited(ip, DESKTOP_KEY_STATUS_IP_INVALID_LIMIT.window);
    return verdict('invalid');
  };

  // Header only: no cookie, query string or Authorization fallback. A missing
  // or malformed key is rejected by the validator before any hash, Redis or
  // Convex work, so it costs only the per-IP bucket.
  const key = req.headers.get('X-WorldMonitor-Key') ?? '';
  let principal: UserKeyPrincipal | null;
  try {
    principal = await validateUserApiKeyPrincipal(key);
  } catch {
    // UserApiKeyUnavailableError (or anything else that kept the lookup from
    // completing) says nothing about the key. Never report it as invalid.
    return unavailable();
  }
  if (!principal) return invalid();

  const owner = await deps.checkScopedRateLimit(
    SCOPE_OWNER,
    DESKTOP_KEY_STATUS_OWNER_LIMIT.limit,
    DESKTOP_KEY_STATUS_OWNER_LIMIT.window,
    principal.userId,
  );
  if (!owner.allowed) return limited(owner, DESKTOP_KEY_STATUS_OWNER_LIMIT.window);

  // R6: only desktop-kind keys unlock a self-hosted install. An API key would
  // put relayed dashboard traffic on the owner's REST meter.
  if (principal.keyKind !== 'desktop') return verdict('not_desktop_key');

  let ent: Awaited<ReturnType<typeof resolveUserKeyEntitlement>>;
  try {
    ent = await resolveUserKeyEntitlement(principal.userId, principal);
  } catch {
    return unavailable();
  }
  // No row is not a verdict about the account: an unconfigured backend returns
  // null before any lookup, and a fail-closed null must not lock a paying owner.
  if (!ent) return unavailable();

  const scope = resolveUserKeyScope(principal, ent);
  if (scope.scope === 'desktop') return verdict('active', planFamilyOf(ent.planKey));
  // A desktop-kind key never resolves to API scope; keep the R6 answer if it ever does.
  if (scope.scope === 'api') return verdict('not_desktop_key');
  if (scope.reason === 'over_cap') return verdict('over_cap');
  // Convex did not report the key's rank: the cap decision could not be made.
  if (scope.reason === 'rank_unknown') return unavailable();

  // not_covered. A retryable billing state (verification pending or failed,
  // entitlement lookup unavailable) is a statement about the verification,
  // not the subscription (#5600), so it is not a lapse.
  const billing = classifyBillingVerification(ent);
  if (billing?.retryable) return unavailable(billing.retryAfterSeconds);
  return verdict('lapsed');
}
