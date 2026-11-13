/**
 * Generic markdown URL-fallback handler.
 *
 * Vercel afterFiles rewrites unmatched `/{page}.md` (except static files,
 * /docs/*, /index.md, and /api/*) here. The handler fetches the sibling page
 * and returns heading-led text/markdown so agent-readiness scanners that
 * probe arbitrary content URLs get a .md twin, not a JSON/HTML 404.
 *
 * The sibling is fetched over HTTP, so it must be a site page. A path that
 * names or rewrites onto an API function (`?path=api/...`, `/ask`, `/mcp`)
 * answers 404: API twins are served by the domain gateway, in-process, where
 * the caller's own limits and origin rules apply.
 */

import {
  buildMarkdownTwinResponse,
  isPageTwinSibling,
  resolveMarkdownTwinPath,
} from './_md-url-twin';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const markdownPath = resolveMarkdownTwinPath(req);
  if (!markdownPath) {
    return new Response('# Not found\n\nNo markdown twin path was provided.\n', {
      status: 404,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
  return buildMarkdownTwinResponse(req, markdownPath, globalThis.fetch, {
    isAllowedSibling: isPageTwinSibling,
  });
}
