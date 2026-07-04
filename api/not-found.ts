// Structured JSON 404 for unmatched `/api/*` paths.
//
// Vercel serves its native `text/plain` "NOT_FOUND" body for any `/api/...`
// path that doesn't resolve to a function. Agents (and agent-readiness
// scanners) can't parse an HTML/plain error page, so a `vercel.json` rewrite
// funnels every otherwise-unmatched `/api/*` request here to return a
// machine-readable JSON error with a code, a message, and a resolution hint.
//
// Filesystem precedence guarantees this only ever runs for paths with NO real
// function: Vercel matches concrete + dynamic function routes before applying
// `rewrites` (verified against production), so a live endpoint is never
// shadowed by this catch-all.

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getPublicCorsHeaders } from './_cors.js';

export default function handler(req: Request): Response {
  const corsHeaders = getPublicCorsHeaders('GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const pathname = (() => {
    try {
      return new URL(req.url).pathname;
    } catch {
      return req.url;
    }
  })();

  const body = {
    error: {
      code: 'not_found',
      message: `No API endpoint matches ${pathname}.`,
      hint: 'Check the endpoint path against the OpenAPI spec at https://worldmonitor.app/openapi.yaml or the API reference at https://www.worldmonitor.app/docs/api-reference.',
    },
    documentation: 'https://www.worldmonitor.app/docs/api-reference',
  };

  return new Response(JSON.stringify(body), {
    status: 404,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // The body echoes the requested pathname (JSON-escaped, so no injection);
      // nosniff stops a client from content-type-sniffing it to HTML anyway.
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      ...corsHeaders,
    },
  });
}
