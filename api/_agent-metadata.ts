/**
 * Shared helpers for the host-derived agent-readiness discovery documents:
 * the RFC 9728 protected-resource metadata (`oauth-protected-resource.ts`) and
 * the RFC 8414 authorization-server metadata (`oauth-authorization-server.ts`).
 *
 * Both derive their `resource`/`issuer` + endpoint origin from the request Host
 * so PRM and AS metadata stay self-consistent per host (apex, www, api, variant
 * subdomains). The Host header is client-controlled, so `resolveMetadataOrigin`
 * validates it against the worldmonitor.app apex + single-level subdomain
 * allowlist and falls back to the apex for anything else. Without this, a
 * spoofed `Host: evil.com` would be reflected into `issuer`/`token_endpoint` —
 * metadata a non-Host-aware downstream cache could serve to an agent, pointing
 * its token exchange at an attacker origin.
 */

// apex + exactly one DNS label (www, api, tech, finance, …). Rejects
// `evil.com`, `worldmonitor.app.evil.com`, `evilworldmonitor.app`, and any
// host carrying a port.
const ALLOWED_HOST = /^(?:[a-z0-9-]+\.)?worldmonitor\.app$/;
const FALLBACK_ORIGIN = 'https://worldmonitor.app';

export function resolveMetadataOrigin(req: Request): string {
  const url = new URL(req.url);
  const host = (req.headers.get('host') ?? url.host).toLowerCase();
  return ALLOWED_HOST.test(host) ? `https://${host}` : FALLBACK_ORIGIN;
}

/**
 * These documents are read-only. Answer CORS preflights, allow GET/HEAD, and
 * reject everything else with a spec-correct 405 + Allow. Returns null when the
 * request should proceed to the metadata handler.
 */
export function guardMetadataMethod(req: Request): Response | null {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const cors: Record<string, string> = { 'Access-Control-Allow-Origin': '*' };
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' },
    });
  }
  return new Response(null, { status: 405, headers: { ...cors, Allow: 'GET, HEAD, OPTIONS' } });
}
