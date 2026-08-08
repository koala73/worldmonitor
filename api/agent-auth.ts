/**
 * GET /agent/auth (rewritten to /api/agent-auth)
 *
 * RFC 9728 agent-auth discovery affordance. An unauthenticated agent (or an
 * agent-readiness scanner) that probes this endpoint with a plain GET receives a
 * 401 whose `WWW-Authenticate: Bearer … resource_metadata="…"` header points at
 * the OAuth Protected Resource Metadata (/.well-known/oauth-protected-resource),
 * from which it discovers the authorization server and completes an OAuth 2.1 +
 * PKCE flow — or it can pass an API key via `X-WorldMonitor-Key`.
 *
 * Why a dedicated endpoint: WorldMonitor's real protected resource is /mcp, and
 * `POST /mcp` (tools/call) ALREADY emits this exact 401 + WWW-Authenticate. But a
 * bare `GET /mcp` must stay 405 for the Streamable-HTTP SSE handshake (an MCP SDK
 * client treats 405 as the graceful "no standalone stream" signal; 401 there
 * makes connect() fail and regresses the protocol-handshake check), so a
 * GET-probing agent never sees the challenge on /mcp. This endpoint surfaces the
 * same RFC 9728 hint on a path that answers GET.
 *
 * `resource_metadata` is host-derived (resolveMetadataOrigin) so the pointer is
 * self-consistent across apex/www/variant hosts and a spoofed Host cannot be
 * reflected into it. The WWW-Authenticate string matches wwwAuthHeader() in
 * api/mcp/auth.ts byte-for-byte so both surfaces present one identical challenge.
 */

import { resolveMetadataOrigin } from './_agent-metadata';

export const config = { runtime: 'edge' };

export default function handler(req: Request): Response {
  const cors: Record<string, string> = { 'Access-Control-Allow-Origin': '*' };

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, X-WorldMonitor-Key',
      },
    });
  }

  const origin = resolveMetadataOrigin(req);
  const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource`;

  const body = JSON.stringify({
    error: 'unauthorized',
    error_description:
      'Authentication required. Discover the authorization server via the protected-resource metadata, then obtain a bearer token (OAuth 2.1 + PKCE) — or pass an API key via the X-WorldMonitor-Key header.',
    resource_metadata: resourceMetadataUrl,
    authorization_server: `${origin}/.well-known/oauth-authorization-server`,
    skill: `${origin}/auth.md`,
  });

  return new Response(body, {
    status: 401,
    headers: {
      ...cors,
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer realm="worldmonitor", resource_metadata="${resourceMetadataUrl}"`,
      'Cache-Control': 'no-store',
      // Body varies by Host (resource_metadata derived from it). Belt-and-braces
      // against a downstream cache keying on path alone.
      'Vary': 'Host',
    },
  });
}
