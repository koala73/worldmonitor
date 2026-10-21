// Filesystem catch-all for otherwise-unmatched `/api/*` paths.
//
// Serves the structured JSON 404 from `./not-found`. As a root-level catch-all
// (`[...slug]`) this has the LOWEST dynamic-route precedence, so concrete
// functions (`api/health.ts`) and nested dynamic gateways
// (`api/<service>/v1/[rpc].ts`, `api/v2/shipping/[rpc].ts`) always resolve
// FIRST — only a path with no more-specific match falls through to here.
//
// It replaces the `{ "source": "/api/:path*", "destination": "/api/not-found" }`
// rewrite added in #4698. That was an afterFiles rewrite, which Vercel applies
// BEFORE resolving dynamic filesystem routes: concrete functions survived but
// every dynamic `[rpc].ts` gateway was shadowed → HTTP 404 for the entire
// versioned REST surface (#4724). A filesystem catch-all runs AFTER all
// more-specific routes, fixing the shadow while preserving the JSON 404 body.

import handler from './not-found';

export const config = { runtime: 'edge' };

export default handler;
