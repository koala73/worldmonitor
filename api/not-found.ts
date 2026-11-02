// Structured JSON 404 for unmatched `/api/*` paths.
//
// Vercel serves its native `text/plain` "NOT_FOUND" body for any `/api/...`
// path that doesn't resolve to a function. Agents (and agent-readiness
// scanners) can't parse an HTML/plain error page, so this handler returns a
// machine-readable JSON error with a code, a message, and a resolution hint.
//
// It is mounted as the filesystem catch-all `api/[...notfound].ts`, which
// re-exports this handler. A root-level catch-all (`[...slug]`) has the LOWEST
// dynamic-route precedence, so concrete functions AND nested dynamic gateways
// (`api/<service>/v1/[rpc].ts`) resolve first — a live endpoint is never
// shadowed. It was previously wired via a `/api/:path*` rewrite, an afterFiles
// rewrite that Vercel applied BEFORE dynamic routes, which shadowed every
// `[rpc].ts` gateway and 404'd the whole versioned REST surface (#4724).

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, getPublicCorsHeaders, isDisallowedOrigin } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { checkRateLimit } from './_rate-limit.js';
import { appendDeprecationPolicyLinkToRecord } from '../server/_shared/deprecation-policy';
import { buildMarkdownTwinResponse, isMarkdownTwinPath } from './_md-url-twin';

// Legacy (non-gateway) API functions that get a `.md` twin. The twin fetches
// its sibling over HTTP, which reaches the sibling from the platform's egress
// address with no caller identity, so any per-IP limiter there would charge one
// bucket shared by every twin reader. Only the intentionally public, limiter-
// free discovery endpoints (middleware.ts PUBLIC_API_PATHS) qualify; every
// other legacy `.md` path answers 404. Versioned RPC twins are served by the
// domain gateway in-process and never reach this handler.
const LEGACY_MARKDOWN_TWIN_SIBLINGS = new Set(['/api/health', '/api/version', '/api/product-catalog']);

function markdownNotFound(corsHeaders: Record<string, string>): Response {
  return new Response('# Not found\n', {
    status: 404,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      ...corsHeaders,
    },
  });
}

async function legacyMarkdownTwin(req: Request, pathname: string): Promise<Response> {
  const corsHeaders = getCorsHeaders(req, 'GET, HEAD, OPTIONS');
  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders },
    });
  }
  if (!LEGACY_MARKDOWN_TWIN_SIBLINGS.has(pathname.slice(0, -3))) return markdownNotFound(corsHeaders);
  // The hop is a second function invocation on the caller's behalf: charge the
  // caller's own default budget for it, as a direct call to a limited sibling would.
  const limited = await checkRateLimit(req, corsHeaders);
  if (limited) return limited;
  return buildMarkdownTwinResponse(req, pathname, globalThis.fetch, {
    corsHeaders,
    isAllowedSibling: (sibling) => LEGACY_MARKDOWN_TWIN_SIBLINGS.has(sibling),
    inheritSiblingCacheControl: true,
  });
}

export default function handler(req: Request): Response | Promise<Response> {
  const corsHeaders = getPublicCorsHeaders('GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    appendDeprecationPolicyLinkToRecord(corsHeaders);
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const pathname = (() => {
    try {
      return new URL(req.url).pathname;
    } catch {
      return req.url;
    }
  })();

  // Unmatched /api/*.md is a markdown URL-fallback probe, not a missing JSON
  // RPC. Serve a heading-led text/markdown twin of an allowlisted sibling
  // instead of the structured JSON 404 (static public/api/*.md files still
  // win first).
  if (
    isMarkdownTwinPath(pathname) &&
    (req.method === 'GET' || req.method === 'HEAD')
  ) {
    return legacyMarkdownTwin(req, pathname);
  }

  const body = {
    error: {
      code: 'not_found',
      message: `No API endpoint matches ${pathname}.`,
      hint: 'Check the endpoint path against the OpenAPI spec at https://www.worldmonitor.app/openapi.yaml or the API reference at https://www.worldmonitor.app/docs/api-reference.',
    },
    documentation: 'https://www.worldmonitor.app/docs/api-reference',
  };

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    // The body echoes the requested pathname (JSON-escaped, so no injection);
    // nosniff stops a client from content-type-sniffing it to HTML anyway.
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...corsHeaders,
  };
  appendDeprecationPolicyLinkToRecord(headers);
  return new Response(JSON.stringify(body), {
    status: 404,
    headers,
  });
}
