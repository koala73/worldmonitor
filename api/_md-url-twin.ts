/**
 * Markdown URL-fallback twins for agent-readiness scanners.
 *
 * The protocol is site-wide: GET /{page} has a twin at GET /{page}.md with
 * text/markdown (or a heading-led non-HTML body). Static files under public/
 * win. Everything else is generated from the sibling URL.
 *
 * The sibling is asked for text/markdown first, so a prerendered page comes
 * back as Vercel's own markdown conversion instead of a scrape of its HTML.
 * Same-origin redirects are followed (every content URL here 308s /x to /x/)
 * and the twin inherits the final target's status, so an invented path is a
 * 404 rather than an indexable stub. The canonical names the final HTML page,
 * never the .md twin and never an /api/ endpoint, and only a response that
 * carries the real document is left indexable.
 *
 * Loop-prevention: sibling fetches send x-wm-md-twin so a .md handler never
 * fetches another .md handler, and a redirect onto a .md path is not followed.
 */

// @ts-expect-error — JS module, no declaration file
import { getPublicCorsHeaders } from './_cors.js';
import { appendDeprecationPolicyLinkToRecord, DEPRECATION_POLICY_LINK } from '../server/_shared/deprecation-policy';

export const MD_TWIN_LOOP_HEADER = 'x-wm-md-twin';
const MAX_TWIN_CHARS = 512_000;
export const MAX_TWIN_BYTES = 512_000;
const MAX_SIBLING_REDIRECTS = 3;
// Every response that is not the sibling's own document carries these: a
// stub must never be cached as if it were the page, nor indexed as one.
const NOT_A_DOCUMENT = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } as const;
const SIBLING_FETCH_TIMEOUT_MS = 8_000;
const SIBLING_USER_AGENT = 'WorldMonitor-MarkdownTwin/1.0';
const FORWARDED_RESPONSE_HEADERS = [
  'allow',
  'location',
  'retry-after',
  'www-authenticate',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
] as const;

export function isMarkdownTwinPath(pathname: string): boolean {
  return (
    pathname.startsWith('/') &&
    pathname.endsWith('.md') &&
    pathname.length > 4 &&
    !pathname.includes('..') &&
    !pathname.includes('//') &&
    !pathname.includes('\\')
  );
}

export function siblingPathFromMarkdown(markdownPath: string): string | null {
  if (!isMarkdownTwinPath(markdownPath)) return null;
  if (markdownPath.startsWith('/api/md-twin')) return null;
  const sibling = markdownPath.slice(0, -3);
  return sibling.length > 0 ? sibling : null;
}

export function sanitizeMarkdownTwinPath(raw: string): string | null {
  let candidate = raw.trim();
  if (!candidate.startsWith('/')) candidate = `/${candidate}`;
  if (!candidate.endsWith('.md')) candidate += '.md';
  if (!isMarkdownTwinPath(candidate)) return null;
  if (candidate.startsWith('/api/md-twin')) return null;
  return candidate;
}

export function resolveMarkdownTwinPath(req: Request): string | null {
  const url = new URL(req.url);
  const pathname = url.pathname;
  if (pathname === '/api/md-twin' || pathname === '/api/md-twin/') {
    const queryPath = url.searchParams.get('path') ?? url.searchParams.get('mdPath');
    if (!queryPath || queryPath === '$1') return null;
    return sanitizeMarkdownTwinPath(queryPath);
  }
  if (isMarkdownTwinPath(pathname)) return pathname;
  return null;
}

const HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(nbsp|amp|lt|gt|quot|apos|#(x[\da-f]+|\d+));/gi, (_, entity: string, code: string | undefined) => {
    if (code === undefined) return HTML_ENTITIES[entity.toLowerCase()]!;
    // `fromCodePoint`, not `fromCharCode`: the latter coerces with ToUint16, so
    // a code point above 0xFFFF wraps back under the `>= 32` guard after passing
    // it — `&#65596;` yielded a literal `<` and `&#65536;` a NUL. It also
    // truncates astral characters, decoding `&#128512;` to a private-use glyph
    // instead of the emoji. Same reasoning as src/utils/html-entities.ts.
    const n = /^x/i.test(code) ? Number.parseInt(code.slice(1), 16) : Number(code);
    const decodable = Number.isInteger(n) && n >= 32 && n <= 0x10ffff
      && !(n >= 0xd800 && n <= 0xdfff);
    return decodable ? String.fromCodePoint(n) : '';
  });
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function withoutTrackingParams(href: string): string {
  const hashIndex = href.indexOf('#');
  const pathAndQuery = hashIndex < 0 ? href : href.slice(0, hashIndex);
  const hash = hashIndex < 0 ? '' : href.slice(hashIndex);
  const queryIndex = pathAndQuery.indexOf('?');
  if (queryIndex < 0) return href;
  // Preserve functional parameters and their URL encoding.
  const params = pathAndQuery.slice(queryIndex + 1).split('&')
    .filter(param => !/^utm_/i.test(new URLSearchParams(param).keys().next().value ?? ''));
  const query = params.join('&');
  return `${pathAndQuery.slice(0, queryIndex)}${query ? `?${query}` : ''}${hash}`;
}

export function htmlToMarkdown(html: string, fallbackTitle: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = decodeHtmlEntities(stripTags(titleMatch?.[1] ?? '')) || fallbackTitle;

  const body = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script(?:[\t\n\f\r ][^>]*|\/[^>]*)?>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style(?:[\t\n\f\r ][^>]*|\/[^>]*)?>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript(?:[\t\n\f\r ][^>]*|\/[^>]*)?>/gi, ' ');

  const main = body.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? body;

  let text = main
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (_m, inner: string) => `\n\n# ${stripTags(inner)}\n\n`)
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (_m, inner: string) => `\n\n## ${stripTags(inner)}\n\n`)
    .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, (_m, inner: string) => `\n\n### ${stripTags(inner)}\n\n`)
    .replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, (_m, inner: string) => `\n\n#### ${stripTags(inner)}\n\n`)
    .replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, (_m, inner: string) => `\n\n##### ${stripTags(inner)}\n\n`)
    .replace(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi, (_m, inner: string) => `\n\n###### ${stripTags(inner)}\n\n`)
    .replace(
      /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href: string, inner: string) => {
        const label = stripTags(inner) || href;
        // Parse decoded separators, then protect the URL from tag stripping and
        // the document's final entity pass so each reference is decoded once.
        const target = withoutTrackingParams(decodeHtmlEntities(href))
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const link = `[${label}](${target})`;
        return /<div\b/i.test(inner) ? `\n\n${link}\n\n` : link;
      },
    )
    .replace(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi,
      (_m, label: string, value: string) => `\n- ${stripTags(label)}: ${stripTags(value)}\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${stripTags(inner)}`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  text = decodeHtmlEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  if (!/^# /m.test(text)) {
    text = text.length > 0 ? `# ${title}\n\n${text}` : `# ${title}`;
  }

  return text.slice(0, MAX_TWIN_CHARS);
}

function jsonToMarkdown(raw: string, heading: string): string {
  let pretty = raw.trim();
  try {
    const reserialised = JSON.stringify(JSON.parse(raw) as unknown, null, 2);
    // Indenting can multiply a body that is already at the cap, so keep the
    // expanded form only when it fits and otherwise fence the raw text.
    if (reserialised.length <= MAX_TWIN_CHARS) pretty = reserialised;
  } catch {
    // Keep the original text when the body is not JSON.
  }
  return `# ${heading}\n\n\`\`\`json\n${pretty}\n\`\`\``.slice(0, MAX_TWIN_CHARS);
}

const FRONT_MATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/;
const FRONT_MATTER_KEY = /^([A-Za-z0-9_.-]+):(?:\s|$)/;

/**
 * `---` opens a thematic break as well as a front-matter block, so a document
 * that merely starts with a horizontal rule must not have its prose spliced
 * into metadata. Require the captured block to read as a flat YAML mapping.
 */
function frontMatterOf(markdown: string): { block: string; lines: string[] } | null {
  const match = markdown.match(FRONT_MATTER);
  if (!match) return null;
  const lines = (match[1] ?? '').split('\n');
  const isMapping =
    lines.some((line) => FRONT_MATTER_KEY.test(line)) &&
    lines.every((line) => line.trim() === '' || line.startsWith(' ') || FRONT_MATTER_KEY.test(line));
  return isMapping ? { block: match[0], lines } : null;
}

/**
 * Re-emit `key: value` with the value quoted. Vercel's generated front-matter
 * leaves values bare, and its descriptions routinely contain ": " (live
 * 2026-09-08 on /dashboard and /chokepoints/strait-of-hormuz/), which a plain
 * YAML scalar cannot hold — so copying the block through unchanged would ship
 * a metadata block no consumer can parse, canonical included.
 */
function quoteFrontMatterValue(line: string): string {
  const entry = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
  if (!entry) return line;
  const [, key, value = ''] = entry;
  if (value === '' || /^(["']).*\1$/.test(value)) return line;
  return `${key}: ${JSON.stringify(value)}`;
}

function withHeading(markdown: string, heading: string): string {
  if (/^# /m.test(markdown)) return markdown;
  // Asking the sibling for markdown makes a front-matter-led body the common
  // case, and a heading prepended above the opening `---` would swallow the
  // whole block into the document text.
  const block = frontMatterOf(markdown)?.block;
  return block
    ? `${block}\n# ${heading}\n\n${markdown.slice(block.length)}`
    : `# ${heading}\n\n${markdown}`;
}

function withMarkdownMetadata(markdown: string, canonical: string | null, fallbackTitle: string): string {
  const frontMatter = frontMatterOf(markdown);
  if (frontMatter) {
    if (!canonical) return markdown;
    const lines = frontMatter.lines
      .filter((line) => !line.startsWith('canonical:'))
      .map(quoteFrontMatterValue);
    lines.push(`canonical: ${JSON.stringify(canonical)}`);
    return `---\n${lines.join('\n')}\n---\n${markdown.slice(frontMatter.block.length)}`;
  }
  const title = markdown.match(/^# (.+)$/m)?.[1] ?? fallbackTitle;
  const canonicalLine = canonical ? `\ncanonical: ${JSON.stringify(canonical)}` : '';
  return `---\ntitle: ${JSON.stringify(title)}${canonicalLine}\n---\n\n${markdown}`;
}

function markdownHeaders(canonical: string | null, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Content-Type': 'text/markdown; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'public, max-age=3600',
    // The loop-guard header is the only request header that changes the twin
    // response (loop requests get a 404 stub). CORS is `*` (no Origin echo),
    // the outbound Accept is fixed, and auth/cookie/UA are never forwarded, so
    // no other variance needs declaring.
    Vary: MD_TWIN_LOOP_HEADER,
    ...getPublicCorsHeaders('GET, HEAD, OPTIONS'),
    Link: canonical ? `<${canonical}>; rel="canonical", ${DEPRECATION_POLICY_LINK}` : DEPRECATION_POLICY_LINK,
    ...extra,
  };
}

function headingFromPath(pathname: string): string {
  const leaf = pathname.split('/').filter(Boolean).pop() ?? pathname;
  return leaf.replace(/[-_]+/g, ' ');
}

async function readSiblingBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TWIN_BYTES) {
    try {
      void response.body?.cancel('Sibling response exceeds the markdown twin byte limit').catch(() => {});
    } catch {
      // The declared size is already enough to reject the response.
    }
    throw new Error('Sibling response exceeds the markdown twin byte limit');
  }

  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_TWIN_BYTES) {
        try {
          void reader.cancel('Sibling response exceeds the markdown twin byte limit').catch(() => {});
        } catch {
          // The stream may already be errored; the size failure is authoritative.
        }
        throw new Error('Sibling response exceeds the markdown twin byte limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function forwardedResponseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

export async function buildMarkdownTwinResponse(
  req: Request,
  markdownPath: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Response> {
  const corsHeaders = getPublicCorsHeaders('GET, HEAD, OPTIONS');

  if (req.method === 'OPTIONS') {
    appendDeprecationPolicyLinkToRecord(corsHeaders);
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('# Method not allowed\n', {
      status: 405,
      headers: markdownHeaders(null, { Allow: 'GET, HEAD, OPTIONS', 'X-Robots-Tag': 'noindex' }),
    });
  }

  if (req.headers.get(MD_TWIN_LOOP_HEADER) === '1') {
    return new Response('# Not found\n', {
      status: 404,
      headers: markdownHeaders(null, { ...NOT_A_DOCUMENT }),
    });
  }

  const sibling = siblingPathFromMarkdown(markdownPath);
  if (!sibling) {
    return new Response('# Not found\n', {
      status: 404,
      headers: markdownHeaders(null, { ...NOT_A_DOCUMENT }),
    });
  }

  const heading = headingFromPath(sibling);
  const requestUrl = new URL(req.url);
  let siblingUrl = new URL(sibling, requestUrl);
  siblingUrl.search = requestUrl.search;
  if (requestUrl.pathname === '/api/md-twin' || requestUrl.pathname === '/api/md-twin/') {
    // `path`/`mdPath` belong to the afterFiles rewrite, not to the caller.
    siblingUrl.searchParams.delete('path');
    siblingUrl.searchParams.delete('mdPath');
  }

  const outbound = new Headers();
  outbound.set('user-agent', SIBLING_USER_AGENT);
  outbound.set(MD_TWIN_LOOP_HEADER, '1');
  outbound.set('accept', 'text/markdown, text/html;q=0.9, application/json;q=0.8, text/plain;q=0.7, */*;q=0.1');

  // One deadline for the whole chain, not one per hop: a fresh signal each hop
  // would multiply the budget by the hop count and overrun the edge runtime's
  // execution ceiling before any of this handler's own error branches ran.
  const deadline = AbortSignal.timeout(SIBLING_FETCH_TIMEOUT_MS);

  let siblingRes: Response;
  for (let hops = 0; ; hops += 1) {
    let redirectTarget: URL | null;
    try {
      siblingRes = await fetchImpl(siblingUrl, {
        method: req.method,
        headers: outbound,
        redirect: 'manual',
        signal: deadline,
      });
      const location = siblingRes.headers.get('location');
      redirectTarget =
        siblingRes.status >= 300 && siblingRes.status < 400 && location ? new URL(location, siblingUrl) : null;
    } catch {
      return new Response(`# ${heading}\n\nThe sibling page at \`${sibling}\` could not be fetched.\n`, {
        status: 502,
        headers: markdownHeaders(null, { ...NOT_A_DOCUMENT }),
      });
    }
    if (!redirectTarget) break;

    if (redirectTarget.origin !== requestUrl.origin) {
      const body = `# ${heading}\n\nThis resource redirects to [${redirectTarget.href}](${redirectTarget.href}).\n`;
      return new Response(req.method === 'HEAD' ? null : withMarkdownMetadata(body, null, heading), {
        status: 200,
        headers: markdownHeaders(null, { 'X-Robots-Tag': 'noindex' }),
      });
    }

    // A .md target would re-enter this handler; the hop budget bounds the
    // chain even when every hop is a legitimate same-origin redirect.
    if (hops >= MAX_SIBLING_REDIRECTS || isMarkdownTwinPath(redirectTarget.pathname)) {
      return new Response('# Not found\n', {
        status: 404,
        headers: markdownHeaders(null, { ...NOT_A_DOCUMENT }),
      });
    }
    siblingUrl = redirectTarget;
  }

  const isFailure = !siblingRes.ok;
  const siblingStatus = isFailure ? siblingRes.status : 200;
  // Query-less, matching what the sibling's own <link rel="canonical"> emits:
  // /countries/iran/?foo=1 canonicalises to /countries/iran/. Carrying the
  // query here would chain one canonical into another and let query params
  // reopen the unbounded twin space this handler exists to close.
  //
  // An /api/ sibling gets none at all. Those endpoints are not canonical web
  // pages, and many need their query to mean anything, so the query-less form
  // would name a different, degenerate resource than the one served.
  const canonical =
    isFailure || siblingUrl.pathname.startsWith('/api/')
      ? null
      : `${siblingUrl.origin}${siblingUrl.pathname}`;
  const responseHeaders: Record<string, string> = {
    ...(isFailure ? NOT_A_DOCUMENT : {}),
    ...forwardedResponseHeaders(siblingRes),
  };

  if (req.method === 'HEAD') {
    return new Response(null, {
      status: siblingStatus,
      headers: markdownHeaders(canonical, responseHeaders),
    });
  }

  if (siblingStatus === 304) {
    return new Response(null, {
      status: siblingStatus,
      headers: markdownHeaders(canonical, responseHeaders),
    });
  }

  let markdown: string;
  try {
    const contentType = siblingRes.headers.get('content-type') ?? '';
    const raw = await readSiblingBody(siblingRes);

    if (/markdown|text\/plain/i.test(contentType) && (/^# /m.test(raw) || FRONT_MATTER.test(raw))) {
      markdown = raw.slice(0, MAX_TWIN_CHARS);
    } else if (/json/i.test(contentType) || raw.trim().startsWith('{') || raw.trim().startsWith('[')) {
      markdown = jsonToMarkdown(raw, heading);
    } else if (/html/i.test(contentType) || /<html|<body|<title/i.test(raw)) {
      markdown = htmlToMarkdown(raw, heading);
    } else if (raw.trim().length === 0) {
      markdown = `# ${heading}\n`;
    } else {
      markdown = /^# /m.test(raw) ? raw.slice(0, MAX_TWIN_CHARS) : `# ${heading}\n\n${raw}`.slice(0, MAX_TWIN_CHARS);
    }

    markdown = withHeading(markdown, heading);
  } catch {
    return new Response(`# ${heading}\n\nThe sibling page at \`${sibling}\` could not be read.\n`, {
      status: 502,
      headers: markdownHeaders(null, { ...NOT_A_DOCUMENT }),
    });
  }

  return new Response(withMarkdownMetadata(markdown, canonical, heading), {
    status: siblingStatus,
    headers: markdownHeaders(canonical, responseHeaders),
  });
}
