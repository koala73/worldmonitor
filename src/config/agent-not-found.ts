/**
 * Origin 404s for unknown HTML-site paths.
 *
 * Agents (curl, SDKs, Accept: text/markdown, missing Accept) get a real
 * HTTP 404 with heading-led markdown pointing at llms.txt / sitemap / docs
 * (ora.ai / orank `agent-friendly-404`). Browsers that send Accept: text/html
 * get a human HTML 404 — #6955 served the agent body to everyone and replaced
 * public/404.html with markdown.
 *
 * Do not wire the agent body through a vercel.json rewrite: Vercel rewrites
 * preserve the destination body but surface HTTP 200 for a successful proxy,
 * which is the exact soft-404 the scanner penalizes. Files with extensions
 * skip the middleware matcher and fall through to public/404.html.
 */

export const AGENT_NOT_FOUND_STATUS = 404 as const;
export const AGENT_NOT_FOUND_CONTENT_TYPE = 'text/markdown; charset=utf-8';
export const HUMAN_NOT_FOUND_CONTENT_TYPE = 'text/html; charset=utf-8';

export const AGENT_NOT_FOUND_INDEXES = {
  llmsTxt: 'https://www.worldmonitor.app/llms.txt',
  sitemap: 'https://www.worldmonitor.app/sitemap.xml',
  docs: 'https://www.worldmonitor.app/docs/documentation',
} as const;

export const HUMAN_NOT_FOUND_LINKS = {
  home: '/',
  dashboard: '/dashboard',
  docs: '/docs/documentation',
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
  '/data-processing-agreement',
  '/dpa',
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

function sanitizePathForHtml(path: string): string {
  return escapeHtml(normalizePath(path).slice(0, 200));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function acceptQuality(header: string | null | undefined, type: string): number | null {
  if (header == null) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  const wanted = type.toLowerCase();
  const [wantedMain] = wanted.split('/');
  let best: number | null = null;
  for (const rawPart of trimmed.split(',')) {
    const tokens = rawPart.split(';').map((part) => part.trim().toLowerCase()).filter(Boolean);
    const media = tokens[0];
    if (!media) continue;
    // curl's default Accept is */* — do not treat that as text/html.
    if (media === '*/*') continue;
    const [main, sub] = media.split('/');
    if (media !== wanted && !(main === wantedMain && sub === '*')) continue;
    const qToken = tokens.find((token) => token.startsWith('q='));
    const q = qToken ? Number(qToken.slice(2)) : 1;
    if (!Number.isFinite(q) || q < 0) continue;
    if (best === null || q > best) best = q;
  }
  return best;
}

/**
 * True when the request should get the agent markdown 404.
 * Browsers send Accept: text/html; curl and SDKs send a catch-all Accept or omit it.
 */
export function prefersAgentNotFound(acceptHeader: string | null | undefined): boolean {
  const htmlQ = acceptQuality(acceptHeader, 'text/html');
  const markdownQ = acceptQuality(acceptHeader, 'text/markdown');
  if (markdownQ !== null && markdownQ > (htmlQ ?? -1)) return true;
  if (htmlQ !== null && htmlQ > 0) return false;
  return true;
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

export function buildHumanNotFoundHtml(path?: string): string {
  const pathLine = path
    ? `<p><code>${sanitizePathForHtml(path)}</code> is not a page on World Monitor.</p>`
    : '<p>This path is not a page on World Monitor.</p>';
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="UTF-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '  <meta name="robots" content="noindex">',
    '  <title>Page not found — World Monitor</title>',
    '  <style>',
    '    body { background: #0a0f0a; color: #e0e0e0; font-family: system-ui;',
    '           display: flex; align-items: center; justify-content: center;',
    '           min-height: 100vh; margin: 0; }',
    '    .c { text-align: center; padding: 2rem; max-width: 36rem; }',
    '    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }',
    '    p { color: #888; font-size: 0.9rem; }',
    '    a { color: #4ade80; }',
    '    code { color: #e0e0e0; }',
    '    nav { margin-top: 1.25rem; }',
    '    nav a { margin: 0 0.5rem; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <div class="c">',
    '    <h1>Page not found</h1>',
    `    ${pathLine}`,
    '    <nav>',
    `      <a href="${HUMAN_NOT_FOUND_LINKS.dashboard}">Dashboard</a>`,
    `      <a href="${HUMAN_NOT_FOUND_LINKS.docs}">Docs</a>`,
    `      <a href="${HUMAN_NOT_FOUND_LINKS.home}">Home</a>`,
    '    </nav>',
    '  </div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function notFoundHeaders(contentType: string, cors: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (cors) headers['Access-Control-Allow-Origin'] = '*';
  return headers;
}

export function agentNotFoundResponse(path: string, method: string): Response {
  const markdown = buildAgentNotFoundMarkdown(path);
  const headers = notFoundHeaders(AGENT_NOT_FOUND_CONTENT_TYPE, true);
  if (method === 'HEAD') {
    return new Response(null, { status: AGENT_NOT_FOUND_STATUS, headers });
  }
  return new Response(markdown, { status: AGENT_NOT_FOUND_STATUS, headers });
}

export function humanNotFoundResponse(path: string, method: string): Response {
  const html = buildHumanNotFoundHtml(path);
  const headers = notFoundHeaders(HUMAN_NOT_FOUND_CONTENT_TYPE, false);
  if (method === 'HEAD') {
    return new Response(null, { status: AGENT_NOT_FOUND_STATUS, headers });
  }
  return new Response(html, { status: AGENT_NOT_FOUND_STATUS, headers });
}

export function originNotFoundResponse(path: string, request: Request): Response {
  if (prefersAgentNotFound(request.headers.get('accept'))) {
    return agentNotFoundResponse(path, request.method);
  }
  return humanNotFoundResponse(path, request.method);
}
