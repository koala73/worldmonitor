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

// RFC 9728 §3.1: a resource identifier carrying a path publishes its metadata
// with that path appended to the well-known URI, so `/mcp` is described at
// `/.well-known/oauth-protected-resource/mcp` and names `https://<host>/mcp`.
// A client that builds that URL itself — instead of following the
// `WWW-Authenticate` pointer — used to get the SPA 404 and abandon sign-in.
// The rewrite carries `?resource=mcp` because a rewritten request may not
// expose the original path; the path check covers direct invocation and tests.
// Both transport paths are real: `/mcp` is the canonical URL and `/api/mcp` is
// the deployed route (api/mcp.ts) that docs/usage-quickstart.mdx publishes. The
// MCP SDK accepts an advertised resource only when the requested path starts
// with it, so each path needs its own document — `/api/mcp` is not under `/mcp`.
const RESOURCE_PATHS = new Set(['mcp', 'api/mcp']);

function resolveResourcePath(req: Request): string | null {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  // The origin-wide well-known URL names the origin, whatever query a caller
  // appends to it. Only the rewrite's own destination carries a resource flag.
  if (path.endsWith('/.well-known/oauth-protected-resource')) return '';
  const flag = url.searchParams.get('resource');
  // A present query is the production rewrite path. Unknown values must 404
  // rather than fall through: after rewrite the pathname is the handler, so
  // treating a missing suffix as origin-wide would publish the root document
  // for `/.well-known/oauth-protected-resource/not-a-resource`.
  if (flag !== null) return RESOURCE_PATHS.has(flag) ? `/${flag}` : null;
  // Only a suffix under the well-known URI names a specific resource. Anything
  // else — including the rewrite destination path — is the origin-wide document.
  const suffix = url.pathname.replace(/\/+$/, '').match(/\/oauth-protected-resource\/(.+)$/)?.[1];
  if (suffix === undefined) return '';
  return RESOURCE_PATHS.has(suffix) ? `/${suffix}` : null;
}

export default function handler(req: Request): Response {
  const guarded = guardMetadataMethod(req);
  if (guarded) return guarded;

  const resourcePath = resolveResourcePath(req);
  if (resourcePath === null) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const origin = resolveMetadataOrigin(req);

  const body = JSON.stringify({
    resource: `${origin}${resourcePath}`,
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
