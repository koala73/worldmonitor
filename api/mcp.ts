import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from './_json-response.js';
// @ts-expect-error — JS module, no declaration file
import { validateApiKey } from './_api-key.js';
// @ts-expect-error — JS module, no declaration file
import { readJsonFromUpstash } from './_upstash-json.js';

export const config = { runtime: 'edge' };

const MCP_PROTOCOL_VERSION = '2025-03-26';
const SERVER_NAME = 'worldmonitor';
const SERVER_VERSION = '1.0';

// ---------------------------------------------------------------------------
// Per-key rate limiter (60 calls/min per PRO API key)
// ---------------------------------------------------------------------------
let mcpRatelimit: Ratelimit | null = null;

function getMcpRatelimit(): Ratelimit | null {
  if (mcpRatelimit) return mcpRatelimit;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  mcpRatelimit = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(60, '60 s'),
    prefix: 'rl:mcp',
    analytics: false,
  });
  return mcpRatelimit;
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------
interface BaseToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required: string[] };
}

// Cache-read tool: reads one or more Redis keys and returns them with staleness info.
interface CacheToolDef extends BaseToolDef {
  _cacheKeys: string[];
  _seedMetaKey: string;
  _maxStaleMin: number;
  _execute?: never;
}

// AI inference tool: calls an internal RPC endpoint and returns the raw response.
interface RpcToolDef extends BaseToolDef {
  _cacheKeys?: never;
  _seedMetaKey?: never;
  _maxStaleMin?: never;
  _execute: (params: Record<string, unknown>, base: string, apiKey: string) => Promise<unknown>;
}

type ToolDef = CacheToolDef | RpcToolDef;

const TOOL_REGISTRY: ToolDef[] = [
  {
    name: 'get_market_data',
    description: 'Real-time equity quotes, commodity prices, crypto prices, sector performance, ETF flows, and Gulf market quotes from WorldMonitor\'s curated bootstrap cache.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: [
      'market:stocks-bootstrap:v1',
      'market:commodities-bootstrap:v1',
      'market:crypto:v1',
      'market:sectors:v1',
      'market:etf-flows:v1',
      'market:gulf-quotes:v1',
      'market:fear-greed:v1',
    ],
    _seedMetaKey: 'seed-meta:market:stocks',
    _maxStaleMin: 30,
  },
  {
    name: 'get_conflict_events',
    description: 'Active armed conflict events (UCDP, Iran), unrest events with geo-coordinates, and country risk scores. Covers ongoing conflicts, protests, and instability indices worldwide.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: [
      'conflict:ucdp-events:v1',
      'conflict:iran-events:v1',
      'unrest:events:v1',
      'risk:scores:sebuf:stale:v1',
    ],
    _seedMetaKey: 'seed-meta:conflict:ucdp-events',
    _maxStaleMin: 30,
  },
  {
    name: 'get_aviation_status',
    description: 'Airport delays, NOTAM airspace closures, and tracked military aircraft. Covers FAA delay data and active airspace restrictions.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['aviation:delays-bootstrap:v1'],
    _seedMetaKey: 'seed-meta:aviation:faa',
    _maxStaleMin: 90,
  },
  {
    name: 'get_news_intelligence',
    description: 'AI-classified geopolitical threat news summaries, GDELT intelligence signals, cross-source signals, and security advisories from WorldMonitor\'s intelligence layer.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: [
      'news:insights:v1',
      'intelligence:gdelt-intel:v1',
      'intelligence:cross-source-signals:v1',
      'intelligence:advisories-bootstrap:v1',
    ],
    _seedMetaKey: 'seed-meta:news:insights',
    _maxStaleMin: 30,
  },
  {
    name: 'get_natural_disasters',
    description: 'Recent earthquakes (USGS), active wildfires (NASA FIRMS), and natural hazard events. Includes magnitude, location, and threat severity.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: [
      'seismology:earthquakes:v1',
      'wildfire:fires:v1',
      'natural:events:v1',
    ],
    _seedMetaKey: 'seed-meta:seismology:earthquakes',
    _maxStaleMin: 30,
  },
  {
    name: 'get_military_posture',
    description: 'Theater posture assessment and military risk scores. Reflects aggregated military positioning and escalation signals across global theaters.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['theater_posture:sebuf:stale:v1'],
    _seedMetaKey: 'seed-meta:intelligence:risk-scores',
    _maxStaleMin: 120,
  },
  {
    name: 'get_cyber_threats',
    description: 'Active cyber threat intelligence: malware IOCs (URLhaus, Feodotracker), CISA known exploited vulnerabilities, and active command-and-control infrastructure.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['cyber:threats-bootstrap:v2'],
    _seedMetaKey: 'seed-meta:cyber:threats',
    _maxStaleMin: 240,
  },
  {
    name: 'get_economic_data',
    description: 'Macro economic indicators: Fed Funds rate (FRED), economic calendar events, fuel prices, ECB FX rates, EU yield curve, earnings calendar, COT positioning, and energy storage data.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: [
      'economic:fred:v1:FEDFUNDS:0',
      'economic:econ-calendar:v1',
      'economic:fuel-prices:v1',
      'economic:ecb-fx-rates:v1',
      'economic:yield-curve-eu:v1',
      'economic:spending:v1',
      'market:earnings-calendar:v1',
      'market:cot:v1',
    ],
    _seedMetaKey: 'seed-meta:economic:econ-calendar',
    _maxStaleMin: 1440,
  },
  {
    name: 'get_prediction_markets',
    description: 'Active Polymarket event contracts with current probabilities. Covers geopolitical, economic, and election prediction markets.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['prediction:markets-bootstrap:v1'],
    _seedMetaKey: 'seed-meta:prediction:markets',
    _maxStaleMin: 90,
  },
  {
    name: 'get_sanctions_data',
    description: 'OFAC SDN sanctioned entities list and sanctions pressure scores by country. Useful for compliance screening and geopolitical pressure analysis.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['sanctions:entities:v1', 'sanctions:pressure:v1'],
    _seedMetaKey: 'seed-meta:sanctions:entities',
    _maxStaleMin: 1440,
  },
  {
    name: 'get_climate_data',
    description: 'Climate anomalies (Open-Meteo temperature/precipitation deviations), weather alerts, and natural environmental events from NASA EONET.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['climate:anomalies:v1', 'weather:alerts:v1'],
    _seedMetaKey: 'seed-meta:climate:anomalies',
    _maxStaleMin: 120,
  },
  {
    name: 'get_infrastructure_status',
    description: 'Internet infrastructure health: Cloudflare Radar outages and service status for major cloud providers and internet services.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['infra:outages:v1'],
    _seedMetaKey: 'seed-meta:infra:outages',
    _maxStaleMin: 30,
  },
  {
    name: 'get_supply_chain_data',
    description: 'Dry bulk shipping stress index, customs revenue flows, and COMTRADE bilateral trade data. Tracks global supply chain pressure and trade disruptions.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: [
      'supply_chain:shipping_stress:v1',
      'trade:customs-revenue:v1',
      'comtrade:flows:v1',
    ],
    _seedMetaKey: 'seed-meta:trade:customs-revenue',
    _maxStaleMin: 2880,
  },
  {
    name: 'get_positive_events',
    description: 'Positive geopolitical events: diplomatic agreements, humanitarian aid, development milestones, and peace initiatives worldwide.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['positive_events:geo-bootstrap:v1'],
    _seedMetaKey: 'seed-meta:positive-events:geo',
    _maxStaleMin: 60,
  },
  {
    name: 'get_radiation_data',
    description: 'Radiation observation levels from global monitoring stations. Flags anomalous readings that may indicate nuclear incidents.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['radiation:observations:v1'],
    _seedMetaKey: 'seed-meta:radiation:observations',
    _maxStaleMin: 30,
  },
  {
    name: 'get_research_signals',
    description: 'Tech and research event signals: emerging technology events bootstrap data from curated research feeds.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['research:tech-events-bootstrap:v1'],
    _seedMetaKey: 'seed-meta:research:tech-events',
    _maxStaleMin: 480,
  },
  {
    name: 'get_forecast_predictions',
    description: 'AI-generated geopolitical and economic forecasts from WorldMonitor\'s predictive models. Covers upcoming risk events and probability assessments.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['forecast:predictions:v2'],
    _seedMetaKey: 'seed-meta:forecast:predictions',
    _maxStaleMin: 90,
  },

  // -------------------------------------------------------------------------
  // Social velocity — cache read (Reddit signals, seeded by relay)
  // -------------------------------------------------------------------------
  {
    name: 'get_social_velocity',
    description: 'Reddit geopolitical social velocity: top posts from worldnews, geopolitics, and related subreddits with engagement scores and trend signals.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['intelligence:social:reddit:v1'],
    _seedMetaKey: 'seed-meta:intelligence:social-reddit',
    _maxStaleMin: 30,
  },

  // -------------------------------------------------------------------------
  // AI inference tools — call LLM endpoints, not cached Redis reads
  // -------------------------------------------------------------------------
  {
    name: 'get_world_brief',
    description: 'AI-generated world intelligence brief. Fetches the latest geopolitical headlines and produces an LLM-summarized brief. Supply an optional geo_context to focus on a region or topic.',
    inputSchema: {
      type: 'object',
      properties: {
        geo_context: { type: 'string', description: 'Optional focus context (e.g. "Middle East tensions", "US-China trade war")' },
      },
      required: [],
    },
    _execute: async (params, base, apiKey) => {
      const UA = 'worldmonitor-mcp-edge/1.0';
      // Step 1: fetch current geopolitical headlines (budget: 6 s, leaves ~24 s for LLM)
      const digestRes = await fetch(`${base}/api/news/v1/list-feed-digest?variant=geo&lang=en`, {
        headers: { 'X-WorldMonitor-Key': apiKey, 'User-Agent': UA },
        signal: AbortSignal.timeout(6_000),
      });
      if (!digestRes.ok) throw new Error(`feed-digest HTTP ${digestRes.status}`);
      type DigestPayload = { categories?: Record<string, { items?: { title?: string }[] }> };
      const digest = await digestRes.json() as DigestPayload;
      const headlines = Object.values(digest.categories ?? {})
        .flatMap(cat => cat.items ?? [])
        .map(item => item.title ?? '')
        .filter(Boolean)
        .slice(0, 10);
      // Step 2: summarize with LLM (budget: 18 s — combined 24 s, well under 30 s edge ceiling)
      const briefRes = await fetch(`${base}/api/news/v1/summarize-article`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': apiKey, 'User-Agent': UA },
        body: JSON.stringify({
          provider: 'openrouter',
          headlines,
          mode: 'brief',
          geoContext: String(params.geo_context ?? ''),
          variant: 'geo',
          lang: 'en',
        }),
        signal: AbortSignal.timeout(18_000),
      });
      if (!briefRes.ok) throw new Error(`summarize-article HTTP ${briefRes.status}`);
      return briefRes.json();
    },
  },
  {
    name: 'get_country_brief',
    description: 'AI-generated per-country intelligence brief. Produces an LLM-analyzed geopolitical and economic assessment for the given country. Supports analytical frameworks for structured lenses.',
    inputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string', description: 'ISO 3166-1 alpha-2 country code, e.g. "US", "DE", "CN", "IR"' },
        framework: { type: 'string', description: 'Optional analytical framework instructions to shape the analysis lens (e.g. Ray Dalio debt cycle, PMESII-PT)' },
      },
      required: ['country_code'],
    },
    _execute: async (params, base, apiKey) => {
      const res = await fetch(`${base}/api/intelligence/v1/get-country-intel-brief`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': apiKey, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        body: JSON.stringify({ country_code: String(params.country_code ?? ''), framework: String(params.framework ?? '') }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`get-country-intel-brief HTTP ${res.status}`);
      return res.json();
    },
  },
  {
    name: 'analyze_situation',
    description: 'AI geopolitical situation analysis (DeductionPanel). Provide a query and optional geo-political context; returns an LLM-powered analytical deduction with confidence and supporting signals.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The question or situation to analyze, e.g. "What are the implications of the Taiwan strait escalation for semiconductor supply chains?"' },
        context: { type: 'string', description: 'Optional additional geo-political context to include in the analysis' },
        framework: { type: 'string', description: 'Optional analytical framework instructions to shape the analysis lens (e.g. Ray Dalio debt cycle, PMESII-PT, Porter\'s Five Forces)' },
      },
      required: ['query'],
    },
    _execute: async (params, base, apiKey) => {
      const res = await fetch(`${base}/api/intelligence/v1/deduct-situation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': apiKey, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        body: JSON.stringify({ query: String(params.query ?? ''), geoContext: String(params.context ?? ''), framework: String(params.framework ?? '') }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`deduct-situation HTTP ${res.status}`);
      return res.json();
    },
  },
  {
    name: 'generate_forecasts',
    description: 'Generate live AI geopolitical and economic forecasts. Unlike get_forecast_predictions (pre-computed cache), this calls the forecasting model directly for fresh probability estimates. Note: slower than cache tools.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Forecast domain: "geopolitical", "economic", "military", "climate", or empty for all domains' },
        region: { type: 'string', description: 'Geographic region filter, e.g. "Middle East", "Europe", "Asia Pacific", or empty for global' },
      },
      required: [],
    },
    _execute: async (params, base, apiKey) => {
      // 25 s — stays within Vercel Edge's ~30 s hard ceiling (was 60 s, which exceeded the limit)
      const res = await fetch(`${base}/api/forecast/v1/get-forecasts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': apiKey, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        body: JSON.stringify({ domain: String(params.domain ?? ''), region: String(params.region ?? '') }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`get-forecasts HTTP ${res.status}`);
      return res.json();
    },
  },
];

// Public shape for tools/list (strip internal _-prefixed fields)
const TOOL_LIST_RESPONSE = TOOL_REGISTRY.map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
}));

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------
function rpcOk(id: unknown, result: unknown, extraHeaders: Record<string, string> = {}): Response {
  return jsonResponse({ jsonrpc: '2.0', id: id ?? null, result }, 200, extraHeaders);
}

function rpcError(id: unknown, code: number, message: string): Response {
  return jsonResponse({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, 200);
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------
async function executeTool(tool: CacheToolDef): Promise<{ cached_at: string | null; stale: boolean; data: Record<string, unknown> }> {
  const reads = tool._cacheKeys.map(k => readJsonFromUpstash(k));
  const metaRead = readJsonFromUpstash(tool._seedMetaKey);
  const [results, meta] = await Promise.all([Promise.all(reads), metaRead]);

  let cached_at: string | null = null;
  let stale = true;
  if (meta && typeof meta === 'object' && 'fetchedAt' in meta) {
    const fetchedAt = (meta as { fetchedAt: number }).fetchedAt;
    cached_at = new Date(fetchedAt).toISOString();
    stale = (Date.now() - fetchedAt) / 60_000 > tool._maxStaleMin;
  }

  const data: Record<string, unknown> = {};
  // Walk backward through ':'-delimited segments, skipping non-informative suffixes
  // (version tags, bare numbers, internal format names) to produce a readable label.
  const NON_LABEL = /^(v\d+|\d+|stale|sebuf)$/;
  tool._cacheKeys.forEach((key, i) => {
    const parts = key.split(':');
    let label = '';
    for (let idx = parts.length - 1; idx >= 0; idx--) {
      const seg = parts[idx] ?? '';
      if (!NON_LABEL.test(seg)) { label = seg; break; }
    }
    data[label || (parts[0] ?? key)] = results[i];
  });

  return { cached_at, stale, data };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (isDisallowedOrigin(req)) {
    return rpcError(null, -32001, 'Origin not allowed');
  }

  // Auth — always require API key (MCP clients are never same-origin browser requests)
  const auth = validateApiKey(req, { forceKey: true });
  if (!auth.valid) {
    return rpcError(null, -32001, auth.error ?? 'API key required');
  }

  const apiKey = req.headers.get('X-WorldMonitor-Key') ?? '';

  // Per-key rate limit
  const rl = getMcpRatelimit();
  if (rl) {
    try {
      const { success } = await rl.limit(`key:${apiKey}`);
      if (!success) {
        return rpcError(null, -32029, 'Rate limit exceeded. Max 60 requests per minute per API key.');
      }
    } catch {
      // Upstash unavailable — allow through (graceful degradation)
    }
  }

  // Parse body
  let body: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
  try {
    body = await req.json();
  } catch {
    return rpcError(null, -32600, 'Invalid request: malformed JSON');
  }

  if (!body || typeof body.method !== 'string') {
    return rpcError(body?.id ?? null, -32600, 'Invalid request: missing method');
  }

  const { id, method, params } = body;

  // Dispatch
  switch (method) {
    case 'initialize': {
      const sessionId = crypto.randomUUID();
      return rpcOk(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }, { 'Mcp-Session-Id': sessionId, ...corsHeaders });
    }

    case 'notifications/initialized':
      return new Response(null, { status: 202, headers: corsHeaders });

    case 'tools/list':
      return rpcOk(id, { tools: TOOL_LIST_RESPONSE }, corsHeaders);

    case 'tools/call': {
      const p = params as { name?: string; arguments?: Record<string, unknown> } | null;
      if (!p || typeof p.name !== 'string') {
        return rpcError(id, -32602, 'Invalid params: missing tool name');
      }
      const tool = TOOL_REGISTRY.find(t => t.name === p.name);
      if (!tool) {
        return rpcError(id, -32602, `Unknown tool: ${p.name}`);
      }
      try {
        let result: unknown;
        if (tool._execute) {
          const origin = new URL(req.url).origin;
          result = await tool._execute(p.arguments ?? {}, origin, apiKey);
        } else {
          result = await executeTool(tool);
        }
        return rpcOk(id, {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        }, corsHeaders);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'data fetch failed';
        return rpcError(id, -32603, `Internal error: ${msg}`);
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
