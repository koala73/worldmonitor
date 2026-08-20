/**
 * Agent-friendly HTML-origin 404s (ora.ai / orank `agent-friendly-404`).
 *
 * Unknown extensionless paths used to fall through to Vercel's default
 * NOT_FOUND page (plain/HTML) or, if rewritten to a static markdown file,
 * come back as HTTP 200 — scanners then treat every URL as a real page.
 * Middleware returns this body with a real 404 so agents can stop and
 * follow the indexes below instead of crawling the app shell.
 *
 * Do not wire this through a vercel.json rewrite: Vercel rewrites preserve
 * the destination body but surface HTTP 200 for a successful proxy, which
 * is the exact soft-404 this check penalizes.
 */

export const AGENT_NOT_FOUND_STATUS = 404 as const;
export const AGENT_NOT_FOUND_CONTENT_TYPE = 'text/markdown; charset=utf-8';

export const AGENT_NOT_FOUND_INDEXES = {
  llmsTxt: 'https://www.worldmonitor.app/llms.txt',
  sitemap: 'https://www.worldmonitor.app/sitemap.xml',
  docs: 'https://www.worldmonitor.app/docs/documentation',
} as const;

// Prefix match is `path === prefix || path.startsWith(prefix + '/')`.
// Keep this list in the same place as the drift test in
// tests/agent-friendly-404.test.mts so a new vercel.json route cannot
// silently 404.
export const AGENT_NOT_FOUND_PASSTHROUGH_PREFIXES = [
  '/a2a',
  '/about',
  '/agent',
  '/api-reference',
  '/ask',
  '/blog',
  '/changelog',
  '/chokepoints',
  '/contact',
  '/countries',
  '/crises',
  '/dashboard',
  '/data',
  '/developers',
  '/docs',
  '/embed',
  '/end-user-license-agreement',
  '/eula',
  '/favico',
  '/help',
  '/legal',
  '/map-styles',
  '/mcp',
  '/mcp-grant',
  '/oauth',
  '/pricing',
  '/privacy',
  '/privacy-policy',
  '/pro',
  '/reference',
  '/research',
  '/research-assets',
  '/sandbox',
  '/sources',
  '/stocks',
  '/story',
  '/support',
  '/terms',
  '/terms-of-service',
  '/textures',
  '/tos',
  '/tools',
  '/use-cases',
  '/welcome',
  '/zh',
  '/.well-known',
] as const;

function normalizePath(path: string): string {
  if (!path) return '/';
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
}

function sanitizePathForMarkdown(path: string): string {
  const normalized = normalizePath(path).slice(0, 200);
  return normalized.replace(/[`<>]/g, '');
}

export function isKnownPublicPagePath(path: string): boolean {
  const normalized = normalizePath(path);
  if (normalized === '/') return true;
  if (normalized.startsWith('/api/') || normalized === '/api') return true;
  return AGENT_NOT_FOUND_PASSTHROUGH_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

export function buildAgentNotFoundMarkdown(path: string): string {
  const safePath = sanitizePathForMarkdown(path);
  return [
    '# Not found',
    '',
    `\`${safePath}\` is not a page on World Monitor.`,
    '',
    'Use these indexes instead of guessing URLs:',
    '',
    `- [llms.txt](${AGENT_NOT_FOUND_INDEXES.llmsTxt}) — agent briefing`,
    `- [sitemap.xml](${AGENT_NOT_FOUND_INDEXES.sitemap}) — crawlable URL list`,
    `- [Documentation](${AGENT_NOT_FOUND_INDEXES.docs}) — docs index`,
    '',
  ].join('\n');
}

export function agentNotFoundResponse(path: string, method: string): Response {
  const markdown = buildAgentNotFoundMarkdown(path);
  const headers = {
    'Content-Type': AGENT_NOT_FOUND_CONTENT_TYPE,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
  };
  if (method === 'HEAD') {
    return new Response(null, { status: AGENT_NOT_FOUND_STATUS, headers });
  }
  return new Response(markdown, { status: AGENT_NOT_FOUND_STATUS, headers });
}
