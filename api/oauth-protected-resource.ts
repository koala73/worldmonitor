/**
 * GET /.well-known/oauth-protected-resource (rewritten to /api/oauth-protected-resource)
 *
 * RFC 9728 OAuth Protected Resource Metadata, served dynamically so every
 * host that terminates the request (apex worldmonitor.app, www, or
 * api.worldmonitor.app) returns self-consistent `resource` +
 * `authorization_servers` pointing at itself.
 *
 * Why dynamic: scanners like isitagentready.com (and Cloudflare's reference
 * at mcp.cloudflare.com) enforce that `authorization_servers[*]` share
 * origin with `resource`. A single static file served from 3 hosts can only
 * satisfy one origin at a time; deriving both fields from the request Host
 * header makes the response correct regardless of which host is scanned.
 *
 * RFC 9728 §3 permits split origins, but the scanner is stricter — and
 * same-origin by construction is simpler than arguing with scanner authors.
 *
 * The Host is client-controlled, so the origin is derived through
 * `resolveMetadataOrigin` (apex + subdomain allowlist, apex fallback) so a
 * spoofed Host cannot be reflected into `resource`/`authorization_servers`.
 */

import { guardMetadataMethod, resolveMetadataOrigin } from './_agent-metadata';

export const config = { runtime: 'edge' };

export default function handler(req: Request): Response {
  const guarded = guardMetadataMethod(req);
  if (guarded) return guarded;

  const origin = resolveMetadataOrigin(req);

  const body = JSON.stringify({
    resource: origin,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
  });

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
      // Response body varies by Host (resource/authorization_servers derived
      // from it). Any intermediate cache keying on path alone could serve
      // wrong-origin metadata across hosts. Vercel's own router is per-host,
      // but this is belt-and-braces against downstream caches.
      'Vary': 'Host',
    },
  });
}
