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

export const HUMAN_NOT_FOUND_DASHBOARD = '/dashboard';
export const HUMAN_NOT_FOUND_SUPPORT = '/docs/support';

export interface NotFoundSection {
  readonly href: string;
  readonly label: string;
  readonly description: string;
  /** First path segments a reader typing this section's URL might use. */
  readonly aliases: readonly string[];
}

/**
 * Where a lost reader can go next, and what they were likely reaching for.
 * Every href is the final URL, never a redirect source, so a guess costs the
 * reader one click and costs a crawler no extra hop.
 */
export const HUMAN_NOT_FOUND_SECTIONS: readonly NotFoundSection[] = [
  {
    href: '/countries/',
    label: 'Countries',
    description: 'Risk briefs and live signals, country by country.',
    aliases: ['countries', 'country'],
  },
  {
    href: '/crises/',
    label: 'Crises',
    description: 'Trackers for active conflicts and emergencies.',
    aliases: ['crises', 'crisis', 'conflicts'],
  },
  {
    href: '/chokepoints/',
    label: 'Chokepoints',
    description: 'Status of the straits and canals that trade depends on.',
    aliases: ['chokepoints', 'chokepoint', 'straits'],
  },
  {
    href: '/compare/',
    label: 'Compare',
    description: 'How World Monitor compares with other monitors.',
    aliases: ['compare', 'comparison', 'comparisons', 'alternatives'],
  },
  {
    href: '/docs/documentation',
    label: 'Documentation',
    description: 'Methods, data sources, the API and MCP.',
    aliases: ['docs', 'doc', 'documentation'],
  },
  {
    href: '/blog/',
    label: 'Blog',
    description: 'Analysis and product notes from the team.',
    aliases: ['blog', 'blogs', 'posts'],
  },
];

/** Shorter segments match too many things by accident (`/'to` is 3). */
const MIN_FUZZY_SEGMENT_LENGTH = 4;
const MAX_FUZZY_DISTANCE = 2;

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1);
      current.push(Math.min(previous[column]! + 1, current[column - 1]! + 1, substitution));
    }
    previous = current;
  }
  return previous[right.length]!;
}

/**
 * The section a missing path's first segment was most likely reaching for:
 * an exact alias (`/country/iran`), or a near-miss typo (`/countri/iran`).
 */
export function suggestNotFoundSection(path: string): NotFoundSection | null {
  const [first = ''] = normalizePath(path).split('/').filter(Boolean);
  let segment = first.toLowerCase();
  try {
    segment = decodeURIComponent(segment);
  } catch {
    // A malformed escape is still a usable literal segment.
  }
  if (!segment) return null;
  const exact = HUMAN_NOT_FOUND_SECTIONS.find((section) => section.aliases.includes(segment));
  if (exact) return exact;
  if (segment.length < MIN_FUZZY_SEGMENT_LENGTH) return null;
  let best: { section: NotFoundSection; distance: number } | null = null;
  for (const section of HUMAN_NOT_FOUND_SECTIONS) {
    for (const alias of section.aliases) {
      // Lengths further apart than the budget can never match, and skipping
      // them keeps an arbitrarily long unknown path from costing CPU.
      if (Math.abs(segment.length - alias.length) > MAX_FUZZY_DISTANCE) continue;
      const distance = editDistance(segment, alias);
      if (distance <= MAX_FUZZY_DISTANCE && (!best || distance < best.distance)) {
        best = { section, distance };
      }
    }
  }
  return best?.section ?? null;
}

// Prefix match is `path === prefix || path.startsWith(prefix + '/')`.
// Keep this list in the same place as the drift test in
// tests/agent-friendly-404.test.mts so a new vercel.json route cannot
// silently 404.
export const AGENT_NOT_FOUND_PASSTHROUGH_PREFIXES = [
  '/a2a',
  '/about',
  '/accuracy',
  '/agent',
  '/api-reference',
  '/ask',
  '/blog',
  '/changelog',
  '/chokepoints',
  '/compare',
  '/contact',
  '/country-instability-index',
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

// Catch-all ranges are opt-in: the agent 404 treats curl's */* as no HTML preference.
export function acceptQuality(header: string | null | undefined, type: string, includeWildcard = false): number | null {
  if (header == null) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  const wanted = type.toLowerCase();
  const [wantedMain] = wanted.split('/');
  let best: number | null = null;
  let specificity = -1;
  for (const rawPart of trimmed.split(',')) {
    const tokens = rawPart.split(';').map((part) => part.trim().toLowerCase()).filter(Boolean);
    const media = tokens[0];
    if (!media) continue;
    const wildcard = media === '*/*' && includeWildcard;
    const [main, sub] = media.split('/');
    if (media !== wanted && !(main === wantedMain && sub === '*') && !wildcard) continue;
    const qToken = tokens.find((token) => token.startsWith('q='));
    const q = qToken ? Number(qToken.slice(2)) : 1;
    if (!Number.isFinite(q) || q < 0) continue;
    const matchSpecificity = media === wanted ? 2 : wildcard ? 0 : 1;
    if (matchSpecificity > specificity) {
      best = q;
      specificity = matchSpecificity;
    } else if (matchSpecificity === specificity && (best === null || q > best)) {
      best = q;
    }
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

/**
 * The page a browser sees for a missing URL. It reuses the reference pages'
 * tokens and header so a reader arriving from a stale link lands somewhere
 * that looks like the site, and it leads with the most likely destination
 * before listing every section. No script: the page must work under the
 * static-file CSP too, because public/404.html is this output verbatim.
 */
export function buildHumanNotFoundHtml(path?: string): string {
  const suggestion = path ? suggestNotFoundSection(path) : null;
  const lede = path
    ? `<code>${sanitizePathForHtml(path)}</code> doesn’t match a page. The link may be mistyped, or the page may have moved.`
    : 'The link may be mistyped, or the page may have moved.';
  // The likely destination is the one action worth a button. Without one, the
  // live dashboard is the product's front door.
  const actions = suggestion
    ? [
      `    <a class="cta" href="${suggestion.href}">Go to ${suggestion.label} <span aria-hidden="true">→</span></a>`,
      `    <a class="secondary" href="${HUMAN_NOT_FOUND_DASHBOARD}">or open the live dashboard</a>`,
    ]
    : [`    <a class="cta" href="${HUMAN_NOT_FOUND_DASHBOARD}">Open the live dashboard <span aria-hidden="true">→</span></a>`];
  const cards = HUMAN_NOT_FOUND_SECTIONS.map((section) => [
    `        <a class="card" href="${section.href}">`,
    `          <strong>${section.label}</strong>`,
    `          <span>${section.description}</span>`,
    '        </a>',
  ].join('\n'));
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="UTF-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '  <meta name="robots" content="noindex">',
    '  <title>Page not found — World Monitor</title>',
    '  <style>',
    '    :root { color-scheme: dark; --bg: #050807; --panel: #0c1210; --text: #eef8f0; --muted: #a8b8ad; --line: #1b2b22; --accent: #4ade80; }',
    '    * { box-sizing: border-box; }',
    '    body { margin: 0; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.55; }',
    '    a { color: var(--accent); text-decoration: none; }',
    '    a:hover { text-decoration: underline; }',
    '    a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 4px; }',
    '    header, main, footer { max-width: 960px; margin: 0 auto; padding: 0 20px; }',
    '    header { padding-top: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }',
    '    nav { display: flex; gap: 4px 18px; flex-wrap: wrap; font-size: 14px; }',
    '    nav a { display: inline-flex; align-items: center; min-height: 44px; }',
    '    nav .home { color: var(--text); font-weight: 700; margin-right: auto; }',
    '    main { padding-top: 48px; padding-bottom: 56px; }',
    '    .eyebrow { margin: 0 0 12px; color: var(--accent); text-transform: uppercase; letter-spacing: 0.08em; font-size: 12px; font-weight: 700; }',
    '    h1 { font-size: clamp(30px, 5vw, 48px); line-height: 1.05; margin: 0 0 16px; letter-spacing: -0.01em; }',
    '    .lede { margin: 0; max-width: 640px; color: var(--muted); font-size: 18px; }',
    '    .lede code { color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 1px 6px; font-size: 0.9em; overflow-wrap: anywhere; -webkit-box-decoration-break: clone; box-decoration-break: clone; }',
    '    .actions { display: flex; align-items: center; gap: 8px 20px; flex-wrap: wrap; margin-top: 28px; }',
    '    .cta { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 12px 18px; border-radius: 8px; background: var(--accent); color: #04170c; font-weight: 700; font-size: 15px; }',
    '    .cta:hover { text-decoration: none; filter: brightness(1.08); }',
    '    .secondary { display: inline-flex; align-items: center; min-height: 44px; font-size: 15px; }',
    '    h2 { margin: 48px 0 0; font-size: 14px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }',
    '    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-top: 16px; }',
    '    .card { display: grid; gap: 4px; padding: 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); transition: border-color 150ms ease-out; }',
    '    .card:hover { border-color: var(--accent); text-decoration: none; }',
    '    .card strong { color: var(--text); font-size: 16px; }',
    '    .card span { color: var(--muted); font-size: 14px; }',
    '    footer { border-top: 1px solid var(--line); padding-top: 20px; padding-bottom: 28px; color: var(--muted); font-size: 14px; }',
    '    footer p { margin: 0; }',
    '    @media (max-width: 420px) { nav { gap: 0 11px; font-size: 13px; } }',
    '    @media (prefers-reduced-motion: reduce) { .card { transition: none; } }',
    '  </style>',
    '</head>',
    '<body>',
    '  <header>',
    '    <nav aria-label="Primary">',
    '      <a class="home" href="/">World Monitor</a>',
    `      <a href="${HUMAN_NOT_FOUND_DASHBOARD}">Dashboard</a>`,
    '      <a href="/countries/">Countries</a>',
    '      <a href="/crises/">Crises</a>',
    '      <a href="/docs/documentation">Docs</a>',
    '    </nav>',
    '  </header>',
    '  <main>',
    '    <p class="eyebrow">404 · Page not found</p>',
    '    <h1>This page isn’t on World Monitor</h1>',
    `    <p class="lede">${lede}</p>`,
    '    <div class="actions">',
    ...actions.map((line) => `  ${line}`),
    '    </div>',
    '    <h2>Or start from a section</h2>',
    '    <div class="grid">',
    ...cards.map((card) => card.replace(/^ {4}/gm, '')),
    '    </div>',
    '  </main>',
    '  <footer>',
    `    <p>Followed a World Monitor link here? <a href="${HUMAN_NOT_FOUND_SUPPORT}">Tell us where it was</a> so we can fix it.</p>`,
    '  </footer>',
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
