/**
 * GET /.well-known/oauth-authorization-server (rewritten to /api/oauth-authorization-server)
 *
 * RFC 8414 OAuth Authorization Server Metadata, served dynamically so every
 * host that terminates the request (apex worldmonitor.app, www, or
 * api.worldmonitor.app) returns self-consistent metadata whose `issuer` and
 * endpoints point back at the request origin.
 *
 * Why dynamic (was a static file at public/.well-known/oauth-authorization-server):
 * the RFC 9728 protected-resource metadata (api/oauth-protected-resource.ts) is
 * already host-derived, so its `authorization_servers[*]` equals the request
 * origin. RFC 8414 requires `issuer` to equal the origin the document is served
 * from, and agent-readiness scanners (ora.ai/orank) cross-check that the PRM
 * `authorization_servers` entry resolves to an AS document whose `issuer`
 * matches. A single static file with a hardcoded `issuer` can only satisfy one
 * origin; deriving `issuer` + every endpoint from the Host header keeps PRM and
 * AS metadata aligned on whichever host is scanned, while the same-origin
 * construction also satisfies isitagentready.com / mcp.cloudflare.com.
 *
 * The `agent_auth` block follows the WorkOS auth.md spec
 * (https://workos.com/auth-md). WorldMonitor supports anonymous agent
 * registration: an agent registers a public client via RFC 7591 Dynamic Client
 * Registration (`register_uri`) and completes an OAuth 2.1 authorization_code +
 * PKCE (S256) flow to obtain a bearer access token — no pre-asserted user
 * identity (identity is established interactively during authorization). WM does
 * not implement ID-JAG identity assertion endpoints, so only `anonymous` is
 * advertised. The `skill` field round-trips to the published /auth.md.
 *
 * The Host is client-controlled, so the origin is derived through
 * `resolveMetadataOrigin` (apex + subdomain allowlist, apex fallback) so a
 * spoofed Host cannot be reflected into `issuer`/`token_endpoint`.
 */

import { guardMetadataMethod, resolveMetadataOrigin } from './_agent-metadata';

export const config = { runtime: 'edge' };

export default function handler(req: Request): Response {
  const guarded = guardMetadataMethod(req);
  if (guarded) return guarded;

  const origin = resolveMetadataOrigin(req);

  const body = JSON.stringify({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    grant_types_supported: ['authorization_code', 'refresh_token'],
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
    agent_auth: {
      skill: `${origin}/auth.md`,
      register_uri: `${origin}/oauth/register`,
      identity_types_supported: ['anonymous'],
      anonymous: {
        credential_types_supported: ['access_token'],
      },
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
      // Response body varies by Host (issuer/endpoints derived from it). Any
      // intermediate cache keying on path alone could serve wrong-origin
      // metadata across hosts. Belt-and-braces against downstream caches;
      // Vercel's own router is already per-host.
      'Vary': 'Host',
    },
  });
}
