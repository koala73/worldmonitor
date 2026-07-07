// NLWeb /ask endpoint (Microsoft NLWeb protocol, github.com/microsoft/NLWeb)
// — natural-language queries over WorldMonitor's public agent surface.
//
// Answers are the same honest, anonymous, quota-free material the A2A
// concierge serves: the live MCP tool catalog (what tools/list publishes
// anonymously) ranked by transparent token overlap, plus fixed discovery
// links. It never touches gated data surfaces, so it cannot become a
// Pro-quota bypass (the GHSA-hcq5 class).
//
// Non-streaming responses carry the NLWeb `_meta` envelope
// ({response_type, version}); streaming (prefer.streaming / streaming /
// Accept: text/event-stream) emits SSE with the NLWeb event types
// start → result (one per item) → complete.

import { suggestTools } from './_agent-tool-suggest';
import { ENDPOINT_RATE_POLICIES, checkScopedRateLimit, getClientIp } from '../server/_shared/rate-limit';

export const config = { runtime: 'edge' };

const RATE_LIMIT_SCOPE = '/api/ask';
const RATE_LIMIT_POLICY = ENDPOINT_RATE_POLICIES[RATE_LIMIT_SCOPE];
if (!RATE_LIMIT_POLICY) {
  // Module-load failure — better to crash the function cold-start with a
  // loud message than to silently fall back to "no rate limit" if someone
  // accidentally deletes the registry entry.
  throw new Error(
    `[ask] missing ENDPOINT_RATE_POLICIES['${RATE_LIMIT_SCOPE}'] — see server/_shared/rate-limit.ts`,
  );
}
const RATE_LIMIT_MAX = RATE_LIMIT_POLICY.limit;
const RATE_LIMIT_WINDOW = RATE_LIMIT_POLICY.window;

const NLWEB_VERSION = '0.1';
const SITE = 'worldmonitor.app';
const TOOLS_DOC_URL = 'https://www.worldmonitor.app/docs/mcp-tools-reference';
const MCP_ENDPOINT = 'https://worldmonitor.app/mcp';
const MAX_QUERY_CHARS = 2048;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const JSON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  ...CORS_HEADERS,
};

interface NlwebResult {
  url: string;
  name: string;
  site: string;
  score: number;
  description: string;
  schema_object: Record<string, unknown>;
}

function buildMeta(responseType: string): { response_type: string; version: string } {
  return { response_type: responseType, version: NLWEB_VERSION };
}

export function buildResults(query: string): NlwebResult[] {
  const suggestions = suggestTools(query);
  const maxScore = suggestions[0]?.score ?? 1;
  const results: NlwebResult[] = suggestions.map((s) => ({
    url: TOOLS_DOC_URL,
    name: s.name,
    site: SITE,
    score: Number((s.score / maxScore).toFixed(3)),
    description: s.description,
    schema_object: {
      '@context': 'https://schema.org',
      '@type': 'WebAPI',
      name: s.name,
      description: s.description,
      documentation: TOOLS_DOC_URL,
      // The actionable endpoint: call the tool via MCP tools/call.
      url: MCP_ENDPOINT,
      provider: { '@type': 'Organization', name: 'World Monitor', url: 'https://www.worldmonitor.app' },
    },
  }));
  if (results.length === 0) {
    // Honest fallback: point the asker at the discovery surfaces instead of
    // fabricating a match.
    results.push({
      url: 'https://worldmonitor.app/llms.txt',
      name: 'World Monitor agent guidance (llms.txt)',
      site: SITE,
      score: 0,
      description:
        'No specific tool matched that query. World Monitor covers conflicts, sanctions, country risk, markets, commodities, energy, maritime/aviation activity, chokepoints, cyber threats, natural disasters, forecasts and prediction markets — start from the agent guidance, or issue tools/list on the MCP server for the full catalog.',
      schema_object: {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: 'World Monitor',
        url: 'https://www.worldmonitor.app',
      },
    });
  }
  return results;
}

interface AskParams {
  query: string;
  queryId: string;
  streaming: boolean;
  mode: string;
}

async function extractParams(req: Request): Promise<AskParams | null> {
  const url = new URL(req.url);
  let body: Record<string, unknown> = {};
  if (req.method === 'POST') {
    const contentType = req.headers.get('content-type') ?? '';
    try {
      if (contentType.includes('application/x-www-form-urlencoded')) {
        body = Object.fromEntries(new URLSearchParams(await req.text()));
      } else {
        body = (await req.json()) as Record<string, unknown>;
      }
    } catch {
      return null; // malformed body
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  }
  const rawQuery = typeof body.query === 'string' ? body.query : (url.searchParams.get('query') ?? '');
  const query = rawQuery.trim().slice(0, MAX_QUERY_CHARS);
  const prefer = body.prefer as { streaming?: unknown } | undefined;
  const streaming =
    body.streaming === true ||
    body.streaming === 'true' ||
    prefer?.streaming === true ||
    url.searchParams.get('streaming') === 'true' ||
    url.searchParams.get('prefer.streaming') === 'true' ||
    (req.headers.get('accept') ?? '').includes('text/event-stream');
  const queryId =
    (typeof body.query_id === 'string' && body.query_id.slice(0, 128)) || crypto.randomUUID();
  const mode = typeof body.mode === 'string' ? body.mode : 'list';
  return { query, queryId, streaming, mode };
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamingResponse(params: AskParams, results: NlwebResult[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          sseFrame('start', {
            message_type: 'start',
            query_id: params.queryId,
            _meta: buildMeta(params.mode),
          }),
        ),
      );
      for (const result of results) {
        controller.enqueue(encoder.encode(sseFrame('result', { message_type: 'result', ...result })));
      }
      controller.enqueue(
        encoder.encode(sseFrame('complete', { message_type: 'complete', query_id: params.queryId })),
      );
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...CORS_HEADERS,
    },
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST' && req.method !== 'GET') {
    return new Response(
      JSON.stringify({ _meta: buildMeta('error'), error: 'Use GET or POST with a natural-language `query`.' }),
      { status: 405, headers: { ...JSON_HEADERS, Allow: 'GET, POST, OPTIONS' } },
    );
  }

  const ip = getClientIp(req);
  // Redis-degraded scoped limits intentionally stay availability-first here:
  // this surface is anonymous, quota-free, and cheap (pure token matching
  // over the public tool catalog — no gated data, no amplification to
  // protect). checkScopedRateLimit logs/Sentry-captures the degraded path.
  const scoped = await checkScopedRateLimit(RATE_LIMIT_SCOPE, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW, ip);
  if (!scoped.allowed) {
    const retryAfter = Math.max(1, Math.ceil((scoped.reset - Date.now()) / 1000));
    return new Response(
      JSON.stringify({
        _meta: buildMeta('error'),
        error: `Rate limit exceeded. Max ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW} per IP.`,
      }),
      { status: 429, headers: { ...JSON_HEADERS, 'Retry-After': String(retryAfter) } },
    );
  }

  const params = await extractParams(req);
  if (params === null) {
    return new Response(
      JSON.stringify({ _meta: buildMeta('error'), error: 'Request body must be valid JSON (or form-encoded).' }),
      { status: 400, headers: JSON_HEADERS },
    );
  }
  if (!params.query) {
    // A query-less probe gets a 200 with a conformant, self-describing NLWeb
    // envelope (empty results + usage) rather than a 4xx — scanners and
    // agents doing a bare existence check read a 4xx as "no endpoint here"
    // (orank's nlweb-ask detector did exactly that). When the probe asks for
    // streaming, honour it: the same usage envelope goes out as SSE
    // (start → complete) so a query-less streaming capability check sees
    // text/event-stream, not JSON.
    if (params.streaming) {
      return streamingResponse(params, []);
    }
    return new Response(
      JSON.stringify({
        _meta: buildMeta(params.mode),
        query_id: params.queryId,
        results: [],
        message:
          'Send a natural-language query: POST {"query": "..."} (JSON or form-encoded), or GET /ask?query=... . Set prefer.streaming=true (or Accept: text/event-stream) for SSE with start/result/complete events.',
      }),
      { status: 200, headers: JSON_HEADERS },
    );
  }

  const results = buildResults(params.query);
  if (params.streaming) {
    return streamingResponse(params, results);
  }
  return new Response(
    JSON.stringify({
      _meta: buildMeta(params.mode),
      query_id: params.queryId,
      query: params.query,
      results,
    }),
    { status: 200, headers: JSON_HEADERS },
  );
}
