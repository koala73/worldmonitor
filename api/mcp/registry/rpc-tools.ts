import COUNTRY_BBOXES from '../../../shared/country-bboxes.js';
// @ts-expect-error — generated JS module, no declaration file
import MINING_SITES_RAW from '../../../shared/mining-sites.js';
// @ts-expect-error — JS module, no declaration file
import { readJsonFromUpstash } from '../../_upstash-json.js';
import { buildAuthHeaders } from '../auth';
import { SUPPORTED_CONSUMER_PRICES_COUNTRIES } from '../constants';
import { evaluateFreshness } from '../freshness';
import type { FreshnessCheck, ToolDef } from '../types';
import { buildPublicTool, TOOL_REGISTRY } from './index';

type McpBriefSource = {
  title: string;
  source: string;
  url: string;
  publishedAt?: string;
};

type DigestItemForBrief = {
  title?: string;
  snippet?: string;
  source?: string;
  link?: string;
  url?: string;
  publishedAt?: string | number;
  pubDate?: string | number;
  date?: string | number;
};

function clipBriefText(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? `${text.slice(0, maxLen - 1).trim()}...` : text;
}

function normalizeBriefUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function normalizeBriefDate(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countryTermIndex(text: string, term: string): number {
  const normalizedTerm = term.trim().toLowerCase();
  if (!normalizedTerm) return -1;
  const match = new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalizedTerm)}(?=$|[^a-z0-9])`, 'i').exec(text);
  return match ? match.index + (match[1] ?? '').length : -1;
}

function includesCountryTerm(text: string, term: string): boolean {
  return countryTermIndex(text, term) !== -1;
}

function collectMcpBriefSources(items: DigestItemForBrief[], maxSources = 6): McpBriefSource[] {
  const out: McpBriefSource[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const url = normalizeBriefUrl(item.link ?? item.url);
    const title = clipBriefText(item.title, 160);
    const source = clipBriefText(item.source, 80);
    if (!url || !title || !source || seen.has(url)) continue;
    const publishedAt = normalizeBriefDate(item.publishedAt ?? item.pubDate ?? item.date);
    out.push(publishedAt ? { title, source, url, publishedAt } : { title, source, url });
    seen.add(url);
    if (out.length >= maxSources) break;
  }
  return out;
}

function briefSourceContextLines(sources: McpBriefSource[]): string[] {
  return sources.map((source, index) => {
    const payload = source.publishedAt
      ? { title: source.title, source: source.source, url: source.url, publishedAt: source.publishedAt }
      : { title: source.title, source: source.source, url: source.url };
    return `Source [${index + 1}]: ${JSON.stringify(payload)}`;
  });
}

function countryBriefSearchTerms(countryCode: string): string[] {
  const terms = [countryCode.toLowerCase()];
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode);
    if (name) terms.push(name.toLowerCase());
  } catch {
    /* Intl.DisplayNames can be missing in constrained runtimes. */
  }
  return [...new Set(terms.filter(Boolean))];
}

export const RPC_TOOLS: ToolDef[] = [
  {
    name: 'get_world_brief',
    _outputBudgetBytes: 65536,
    description: 'AI-generated world intelligence brief. Fetches the latest geopolitical headlines along with their RSS article bodies and produces a grounded LLM-summarized brief. Supply an optional geo_context to focus on a region or topic.',
    inputSchema: {
      type: 'object',
      properties: {
        geo_context: { type: 'string', description: 'Optional focus context (e.g. "Middle East tensions", "US-China trade war")' },
      },
      required: [],
    },
    // RPC tool: returns the raw body of /api/news/v1/summarize-article (LLM brief).
    outputSchema: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'LLM-summarized geopolitical brief.' },
        summary: { type: 'string', description: 'Alternate naming used by some upstream variants.' },
        headlines: { type: 'array', items: { type: 'string' } },
        provider: { type: 'string' },
        model: { type: 'string' },
        generatedAt: { type: ['string', 'number', 'null'] },
        sources: {
          type: 'array',
          description: 'Original feed articles used as grounding inputs for this brief.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              url: { type: 'string' },
              source: { type: 'string' },
              publishedAt: { type: 'string' },
            },
          },
        },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _execute: async (params, base, context) => {
      const UA = 'worldmonitor-mcp-edge/1.0';
      // Step 1: fetch current geopolitical headlines (budget: 6 s, leaves ~24 s for LLM).
      // `full` is the documented geopolitical/default digest variant.
      const digestUrl = `${base}/api/news/v1/list-feed-digest?variant=full&lang=en`;
      const digestAuth = await buildAuthHeaders(context, 'GET', digestUrl, null);
      const digestRes = await fetch(digestUrl, {
        headers: { ...digestAuth, 'User-Agent': UA },
        signal: AbortSignal.timeout(6_000),
      });
      if (!digestRes.ok) throw new Error(`feed-digest HTTP ${digestRes.status}`);
      type DigestPayload = { categories?: Record<string, { items?: DigestItemForBrief[] }> };
      const digest = await digestRes.json() as DigestPayload;
      // Pair headlines with their RSS snippets so the LLM grounds per-story
      // on article bodies instead of hallucinating across unrelated titles.
      const pairs = Object.values(digest.categories ?? {})
        .flatMap(cat => cat.items ?? [])
        .map(item => ({
          title: item.title ?? '',
          snippet: item.snippet ?? '',
          source: item.source ?? '',
          link: item.link ?? item.url ?? '',
          publishedAt: item.publishedAt ?? item.pubDate ?? item.date,
        }))
        .filter(p => p.title.length > 0)
        .slice(0, 10);
      const headlines = pairs.map(p => p.title);
      const bodies = pairs.map(p => p.snippet);
      const sources = collectMcpBriefSources(pairs, 6);
      // Step 2: summarize with LLM (budget: 18 s — combined 24 s, well under 30 s edge ceiling)
      const briefUrl = `${base}/api/news/v1/summarize-article`;
      const briefBody = JSON.stringify({
        provider: 'openrouter',
        headlines,
        bodies,
        mode: 'brief',
        geoContext: String(params.geo_context ?? ''),
        variant: 'full',
        lang: 'en',
      });
      const briefAuth = await buildAuthHeaders(context, 'POST', briefUrl, briefBody);
      const briefRes = await fetch(briefUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...briefAuth, 'User-Agent': UA },
        body: briefBody,
        signal: AbortSignal.timeout(18_000),
      });
      if (!briefRes.ok) throw new Error(`summarize-article HTTP ${briefRes.status}`);
      const result = await briefRes.json() as Record<string, unknown>;
      return { ...result, headlines, sources };
    },
    _apiPaths: [
      "GET /api/news/v1/list-feed-digest",
      "POST /api/news/v1/summarize-article",
    ],
  },
  {
    name: 'get_country_brief',
    _outputBudgetBytes: 65536,
    description: 'AI-generated per-country intelligence brief. Produces an LLM-analyzed geopolitical and economic assessment for the given country. Supports analytical frameworks for structured lenses.',
    inputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string', description: 'ISO 3166-1 alpha-2 country code, e.g. "US", "DE", "CN", "IR"' },
        framework: { type: 'string', description: 'Optional analytical framework instructions to shape the analysis lens (e.g. Ray Dalio debt cycle, PMESII-PT)' },
      },
      required: ['country_code'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string' },
        brief: { type: 'string', description: 'LLM-synthesized country intelligence brief.' },
        framework: { type: 'string' },
        generatedAt: { type: ['string', 'number', 'null'] },
        provider: { type: 'string' },
        model: { type: 'string' },
        sources: {
          type: 'array',
          description: 'Original feed articles used as grounding inputs for this brief.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              url: { type: 'string' },
              source: { type: 'string' },
              publishedAt: { type: 'string' },
            },
          },
        },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _execute: async (params, base, context) => {
      const UA = 'worldmonitor-mcp-edge/1.0';
      const countryCode = String(params.country_code ?? '').toUpperCase().slice(0, 2);

      // Fetch current geopolitical headlines to ground the LLM (budget: 2 s — cached endpoint).
      // Without context the model hallucinates events — real headlines anchor it.
      // 2 s + 22 s brief = 24 s worst-case; 6 s margin before the 30 s Edge kill.
      let contextParam = '';
      let sources: McpBriefSource[] = [];
      try {
        const digestUrl = `${base}/api/news/v1/list-feed-digest?variant=full&lang=en`;
        const digestAuth = await buildAuthHeaders(context, 'GET', digestUrl, null);
        const digestRes = await fetch(digestUrl, {
          headers: { ...digestAuth, 'User-Agent': UA },
          signal: AbortSignal.timeout(2_000),
        });
        if (digestRes.ok) {
          type DigestPayload = { categories?: Record<string, { items?: DigestItemForBrief[] }> };
          const digest = await digestRes.json() as DigestPayload;
          const allItems = Object.values(digest.categories ?? {})
            .flatMap(cat => cat.items ?? [])
            .filter(item => typeof item.title === 'string' && item.title.length > 0);
          const terms = countryBriefSearchTerms(countryCode);
          const countryItems = allItems.filter((item) => {
            const text = `${item.title ?? ''} ${item.snippet ?? ''}`.toLowerCase();
            return terms.some(term => includesCountryTerm(text, term));
          });
          const groundingItems = (countryItems.length > 0 ? countryItems : allItems).slice(0, 15);
          sources = collectMcpBriefSources(groundingItems, 6);
          const sourceLines = sources.length > 0 ? ['Brief source articles:', ...briefSourceContextLines(sources)] : [];
          const headlineLines = groundingItems.map(item => item.title ?? '').filter(Boolean);
          const contextLines = [...sourceLines, 'Headlines:', ...headlineLines].join('\n');
          if (contextLines.trim()) contextParam = encodeURIComponent(contextLines.slice(0, 4000));
        }
      } catch { /* proceed without context — better than failing */ }

      const briefUrl = contextParam
        ? `${base}/api/intelligence/v1/get-country-intel-brief?context=${contextParam}`
        : `${base}/api/intelligence/v1/get-country-intel-brief`;

      const briefBody = JSON.stringify({ country_code: countryCode, framework: String(params.framework ?? '') });
      const briefAuth = await buildAuthHeaders(context, 'POST', briefUrl, briefBody);
      const res = await fetch(briefUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...briefAuth, 'User-Agent': UA },
        body: briefBody,
        signal: AbortSignal.timeout(22_000),
      });
      if (!res.ok) throw new Error(`get-country-intel-brief HTTP ${res.status}`);
      const result = await res.json() as Record<string, unknown>;
      const resultSources = collectMcpBriefSources(Array.isArray(result.sources) ? result.sources as DigestItemForBrief[] : [], 6);
      return { ...result, sources: resultSources.length > 0 ? resultSources : sources };
    },
    // METHOD DRIFT: _execute POSTs above but OpenAPI declares only GET on this
    // path (verified against docs/api/IntelligenceService.openapi.json). The
    // gateway routes by path, not method, so POST works at runtime. We declare
    // GET here because OpenAPI is the parity test's source-of-truth — fixing
    // the spec to add POST (or migrating the handler to GET) is out of scope.
    _apiPaths: [
      "GET /api/intelligence/v1/get-country-intel-brief",
    ],
  },
  {
    name: 'get_country_risk',
    _outputBudgetBytes: 262144,
    description: 'Structured risk intelligence for a specific country: Composite Instability Index (CII) score 0-100, component breakdown (unrest/conflict/security/news), travel advisory level, and OFAC sanctions exposure. Fast Redis read — no LLM. Use for quantitative risk screening or to answer "how risky is X right now?"',
    inputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string', description: 'ISO 3166-1 alpha-2 country code, e.g. "RU", "IR", "CN", "UA"' },
      },
      required: ['country_code'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string' },
        cii: { type: ['number', 'null'], description: 'Composite Instability Index 0-100.' },
        components: {
          type: 'object',
          properties: {
            unrest: { type: ['number', 'null'] },
            conflict: { type: ['number', 'null'] },
            security: { type: ['number', 'null'] },
            news: { type: ['number', 'null'] },
          },
        },
        travelAdvisory: { type: ['object', 'string', 'null'] },
        sanctionsExposure: { type: ['object', 'array', 'null'] },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params, base, context) => {
      const code = String(params.country_code ?? '').toUpperCase().slice(0, 2);
      const url = `${base}/api/intelligence/v1/get-country-risk?country_code=${encodeURIComponent(code)}`;
      const auth = await buildAuthHeaders(context, 'GET', url, null);
      const res = await fetch(url, {
        headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`get-country-risk HTTP ${res.status}`);
      return res.json();
    },
    _apiPaths: [
      "GET /api/intelligence/v1/get-country-risk",
    ],
  },
  {
    name: 'get_consumer_prices',
    _outputBudgetBytes: 262144,
    description: "Per-country consumer-prices intelligence: 30-day overview, category-level inflation, retailer spread (essentials basket), top movers, and source freshness. Requires country_code (currently only 'ae' is seeded).",
    inputSchema: {
      type: 'object',
      properties: {
        country_code: {
          type: 'string',
          description: 'ISO 3166-1 alpha-2 country code. Currently supported: AE (case-insensitive).',
        },
      },
      required: ['country_code'],
    },
    // Hybrid _execute — success path returns the envelope below; missing/unknown
    // country_code returns `{error: "..."}` instead (result-level user-input error).
    outputSchema: {
      type: 'object',
      properties: {
        cached_at: { type: ['string', 'null'] },
        stale: { type: 'boolean' },
        country_code: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            overview: { type: ['object', 'null'] },
            categories: { type: ['object', 'array', 'null'] },
            movers: { type: ['object', 'array', 'null'] },
            retailerSpread: { type: ['object', 'array', 'null'] },
            freshness: { type: ['object', 'null'] },
          },
        },
        error: { type: 'string', description: 'Present only on user-input failure (missing/unknown country_code).' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    // Hybrid _execute (not a pure cache tool) because the cache keys are
    // parameterised by country. Mirrors api/health.js::BOOTSTRAP_KEYS:55-59
    // exactly so the U7 Tier-3 parity test treats every key as covered.
    _coverageKeys: [
      'consumer-prices:overview:ae',
      'consumer-prices:categories:ae:30d',
      'consumer-prices:movers:ae:30d',
      'consumer-prices:retailer-spread:ae:essentials-ae',
      'consumer-prices:freshness:ae',
    ],
    _execute: async (params) => {
      // Result-level errors (NOT throws) for user-input issues — the dispatcher
      // maps thrown errors to JSON-RPC -32603 "Internal error", which is
      // misleading for a clearly-user-side fault like a missing/unknown
      // country_code. Returning {error: ...} surfaces a usable message via
      // the normal tools/call result envelope.
      if (!params.country_code || typeof params.country_code !== 'string') {
        return { error: 'country_code is required' };
      }
      const code = params.country_code.toLowerCase();
      // Strict ISO 3166-1 alpha-2 shape: exactly two lowercase letters.
      // Without this, .slice(0,2) would silently truncate inputs like
      // "aexxx" or "AE-DXB" to "ae" and serve AE data — masking client bugs.
      if (!/^[a-z]{2}$/.test(code)) {
        return { error: 'country_code must be a two-letter ISO code (e.g. "ae")' };
      }
      if (!SUPPORTED_CONSUMER_PRICES_COUNTRIES.has(code)) {
        return { error: 'Country not yet supported. Available: ae' };
      }

      const dataKeys = [
        `consumer-prices:overview:${code}`,
        `consumer-prices:categories:${code}:30d`,
        `consumer-prices:movers:${code}:30d`,
        `consumer-prices:retailer-spread:${code}:essentials-${code}`,
        `consumer-prices:freshness:${code}`,
      ];

      // Freshness checks use the producer's actual meta keys. Note the spread
      // entry: scripts/seed-consumer-prices.mjs:151 writes
      // `seed-meta:consumer-prices:spread:<code>` (NO `retailer-` prefix,
      // NO `:essentials-<code>` suffix). api/health.js:337 has the documented
      // drift bug (expects `retailer-spread:<code>:essentials-<code>` which
      // never exists) and so would always report stale; we deliberately
      // diverge from health.js here to match the actual producer.
      const freshnessChecks: FreshnessCheck[] = [
        { key: `seed-meta:consumer-prices:overview:${code}`,      maxStaleMin: 1500 }, // 25h = 24h cron + 1h grace
        { key: `seed-meta:consumer-prices:categories:${code}:30d`, maxStaleMin: 1500 },
        { key: `seed-meta:consumer-prices:movers:${code}:30d`,     maxStaleMin: 1500 },
        { key: `seed-meta:consumer-prices:spread:${code}`,         maxStaleMin: 1500 }, // producer's actual key shape
        { key: `seed-meta:consumer-prices:freshness:${code}`,      maxStaleMin: 1500 },
      ];

      const [dataResults, metaResults] = await Promise.all([
        Promise.all(dataKeys.map((k) => readJsonFromUpstash(k))),
        Promise.all(freshnessChecks.map((c) => readJsonFromUpstash(c.key))),
      ]);

      // F6 contract parity with the cache-tool path (executeTool, ~line 1139):
      // if every data read is null/undefined, this is a degenerate-empty
      // response (Redis transient / stampede / pre-seed). Throw so
      // dispatchToolsCall's catch fires proRollback — without this, the Pro
      // user's daily MCP counter increments by 1 for a useless result while
      // every other cache-tool refunds via the same code path.
      if (dataResults.every((v: unknown) => v === null || v === undefined)) {
        throw new Error('cache_all_null');
      }

      const { cached_at, stale } = evaluateFreshness(freshnessChecks, metaResults);

      return {
        cached_at,
        stale,
        country_code: code,
        data: {
          overview: dataResults[0],
          categories: dataResults[1],
          movers: dataResults[2],
          retailerSpread: dataResults[3],
          freshness: dataResults[4],
        },
      };
    },
    // Hybrid tool covers the consumer-prices domain via direct Redis reads
    // of the same keys the per-method handlers expose via the API. The
    // OpenAPI ops listed here read parameterized keys (the audit's
    // manual-mapping case); this MCP tool wraps the 'ae'-instance equivalent.
    //
    // NOTE: `get-consumer-price-basket-series` is NOT covered here — that
    // handler reads `consumer-prices:basket-series:${market}:${basket}:${range}`
    // which is a separate parameterized time-series key, NOT in this tool's
    // `_coverageKeys`. Excluded as `deferred-to-future-tool` in
    // tests/mcp-api-parity.test.mjs until a future expanded_consumer_prices
    // tool exposes the basket-series time series.
    _apiPaths: [
      'GET /api/consumer-prices/v1/get-consumer-price-freshness',
      'GET /api/consumer-prices/v1/get-consumer-price-overview',
      'GET /api/consumer-prices/v1/list-consumer-price-categories',
      'GET /api/consumer-prices/v1/list-consumer-price-movers',
      'GET /api/consumer-prices/v1/list-retailer-price-spreads',
    ],
  },
  {
    name: 'get_airspace',
    _outputBudgetBytes: 262144,
    description: 'Live ADS-B aircraft over a country. Returns civilian flights (OpenSky) and identified military aircraft with callsigns, positions, altitudes, and headings. Answers questions like "how many planes are over the UAE right now?" or "are there military aircraft over Taiwan?"',
    inputSchema: {
      type: 'object',
      properties: {
        country_code: {
          type: 'string',
          description: 'ISO 3166-1 alpha-2 country code (e.g. "AE", "US", "GB", "JP")',
        },
        type: {
          type: 'string',
          enum: ['all', 'civilian', 'military'],
          description: 'Filter: all flights (default), civilian only, or military only',
        },
      },
      required: ['country_code'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string' },
        bounding_box: { type: 'object', properties: {
          sw_lat: { type: 'number' }, sw_lon: { type: 'number' },
          ne_lat: { type: 'number' }, ne_lon: { type: 'number' },
        } },
        civilian_count: { type: 'number' },
        military_count: { type: 'number' },
        civilian_flights: { type: 'array', items: { type: 'object', properties: {
          callsign: { type: 'string' }, icao24: { type: 'string' },
          lat: { type: 'number' }, lon: { type: 'number' },
          altitude_m: { type: ['number', 'null'] }, speed_kts: { type: ['number', 'null'] },
          heading_deg: { type: ['number', 'null'] }, on_ground: { type: 'boolean' },
        } } },
        military_flights: { type: 'array', items: { type: 'object', properties: {
          callsign: { type: 'string' }, hex_code: { type: 'string' },
          aircraft_type: { type: 'string' }, aircraft_model: { type: 'string' },
          operator: { type: 'string' }, operator_country: { type: 'string' },
          lat: { type: ['number', 'null'] }, lon: { type: ['number', 'null'] },
          altitude: { type: ['number', 'null'] }, heading: { type: ['number', 'null'] },
          speed: { type: ['number', 'null'] }, is_interesting: { type: 'boolean' }, note: { type: 'string' },
        } } },
        partial: { type: 'boolean', description: 'True if one of the two upstream sources failed.' },
        warnings: { type: 'array', items: { type: 'string' } },
        source: { type: 'string' },
        updated_at: { type: 'string' },
        error: { type: 'string', description: 'Present only on unknown country_code.' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _execute: async (params, base, context) => {
      const code = String(params.country_code ?? '').toUpperCase().slice(0, 2);
      const bbox = COUNTRY_BBOXES[code];
      if (!bbox) return { error: `Unknown country code: ${code}. Use ISO 3166-1 alpha-2 (e.g. "AE", "US", "GB").` };
      const [sw_lat, sw_lon, ne_lat, ne_lon] = bbox;
      const type = String(params.type ?? 'all');
      const UA = 'worldmonitor-mcp-edge/1.0';
      const bboxQ = `sw_lat=${sw_lat}&sw_lon=${sw_lon}&ne_lat=${ne_lat}&ne_lon=${ne_lon}`;

      type CivilianResp = {
        positions?: { callsign: string; icao24: string; lat: number; lon: number; altitude_m: number; ground_speed_kts: number; track_deg: number; on_ground: boolean }[];
        source?: string;
        updated_at?: number;
      };
      type MilResp = {
        flights?: { callsign: string; hex_code: string; aircraft_type: string; aircraft_model: string; operator: string; operator_country: string; location?: { latitude: number; longitude: number }; altitude: number; heading: number; speed: number; is_interesting: boolean; note: string }[];
      };

      const civUrl = `${base}/api/aviation/v1/track-aircraft?${bboxQ}`;
      const milUrl = `${base}/api/military/v1/list-military-flights?${bboxQ}&page_size=100`;
      const civAuth = type === 'military' ? null : await buildAuthHeaders(context, 'GET', civUrl, null);
      const milAuth = type === 'civilian' ? null : await buildAuthHeaders(context, 'GET', milUrl, null);

      const [civResult, milResult] = await Promise.allSettled([
        type === 'military' || !civAuth
          ? Promise.resolve(null)
          : fetch(civUrl, { headers: { ...civAuth, 'User-Agent': UA }, signal: AbortSignal.timeout(8_000) })
              .then(r => r.ok ? r.json() as Promise<CivilianResp> : Promise.reject(new Error(`HTTP ${r.status}`))),
        type === 'civilian' || !milAuth
          ? Promise.resolve(null)
          : fetch(milUrl, { headers: { ...milAuth, 'User-Agent': UA }, signal: AbortSignal.timeout(8_000) })
              .then(r => r.ok ? r.json() as Promise<MilResp> : Promise.reject(new Error(`HTTP ${r.status}`))),
      ]);

      const civOk = type === 'military' || civResult.status === 'fulfilled';
      const milOk = type === 'civilian' || milResult.status === 'fulfilled';

      // Both sources down — total outage, don't return misleading empty data
      if (!civOk && !milOk) throw new Error('Airspace data unavailable: both civilian and military sources failed');

      const civ = civResult.status === 'fulfilled' ? civResult.value : null;
      const mil = milResult.status === 'fulfilled' ? milResult.value : null;
      const warnings: string[] = [];
      if (!civOk) warnings.push('civilian ADS-B data unavailable');
      if (!milOk) warnings.push('military flight data unavailable');

      const civilianFlights = (civ?.positions ?? []).slice(0, 100).map(p => ({
        callsign: p.callsign, icao24: p.icao24,
        lat: p.lat, lon: p.lon,
        altitude_m: p.altitude_m, speed_kts: p.ground_speed_kts,
        heading_deg: p.track_deg, on_ground: p.on_ground,
      }));
      const militaryFlights = (mil?.flights ?? []).slice(0, 100).map(f => ({
        callsign: f.callsign, hex_code: f.hex_code,
        aircraft_type: f.aircraft_type, aircraft_model: f.aircraft_model,
        operator: f.operator, operator_country: f.operator_country,
        lat: f.location?.latitude, lon: f.location?.longitude,
        altitude: f.altitude, heading: f.heading, speed: f.speed,
        is_interesting: f.is_interesting, ...(f.note ? { note: f.note } : {}),
      }));

      return {
        country_code: code,
        bounding_box: { sw_lat, sw_lon, ne_lat, ne_lon },
        civilian_count: civilianFlights.length,
        military_count: militaryFlights.length,
        ...(type !== 'military' && { civilian_flights: civilianFlights }),
        ...(type !== 'civilian' && { military_flights: militaryFlights }),
        ...(warnings.length > 0 && { partial: true, warnings }),
        source: civ?.source ?? 'opensky',
        updated_at: civ?.updated_at ? new Date(civ.updated_at).toISOString() : new Date().toISOString(),
      };
    },
    _apiPaths: [
      "GET /api/aviation/v1/track-aircraft",
      "GET /api/military/v1/list-military-flights",
    ],
  },
  {
    name: 'get_maritime_activity',
    _outputBudgetBytes: 262144,
    description: "Live vessel traffic and maritime disruptions for a country's waters. Returns AIS density zones (ships-per-day, intensity score), dark ship events, and chokepoint congestion from AIS tracking.",
    inputSchema: {
      type: 'object',
      properties: {
        country_code: {
          type: 'string',
          description: 'ISO 3166-1 alpha-2 country code (e.g. "AE", "SA", "JP", "EG")',
        },
      },
      required: ['country_code'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string' },
        bounding_box: { type: 'object', properties: {
          sw_lat: { type: 'number' }, sw_lon: { type: 'number' },
          ne_lat: { type: 'number' }, ne_lon: { type: 'number' },
        } },
        snapshot_at: { type: 'string' },
        total_zones: { type: 'number' },
        total_disruptions: { type: 'number' },
        density_zones: { type: 'array', items: { type: 'object', properties: {
          name: { type: 'string' }, intensity: { type: ['number', 'null'] },
          ships_per_day: { type: ['number', 'null'] }, delta_pct: { type: ['number', 'null'] }, note: { type: 'string' },
        } } },
        disruptions: { type: 'array', items: { type: 'object', properties: {
          name: { type: 'string' }, type: { type: 'string' }, severity: { type: 'string' },
          dark_ships: { type: ['number', 'null'] }, vessel_count: { type: ['number', 'null'] },
          region: { type: 'string' }, description: { type: 'string' },
        } } },
        error: { type: 'string', description: 'Present only on unknown country_code.' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _execute: async (params, base, context) => {
      const code = String(params.country_code ?? '').toUpperCase().slice(0, 2);
      const bbox = COUNTRY_BBOXES[code];
      if (!bbox) return { error: `Unknown country code: ${code}. Use ISO 3166-1 alpha-2 (e.g. "AE", "SA", "JP").` };
      const [sw_lat, sw_lon, ne_lat, ne_lon] = bbox;
      // Deliberately NO bbox on the inner fetch: the handler rejects any bbox
      // dimension >10° (BboxValidationError → HTTP 400), and 67 of the 167
      // COUNTRY_BBOXES exceed that (US, JP, AU, BR, …) — WORLDMONITOR-T8.
      // The relay's density/disruption sets are global regardless of bbox
      // (bbox only scopes tanker/candidate reports, which this tool never
      // requests), so we take the cached global snapshot and filter to the
      // country bbox here using each item's coordinates.
      const url = `${base}/api/maritime/v1/get-vessel-snapshot`;
      const auth = await buildAuthHeaders(context, 'GET', url, null);

      // Wire shape is the generated sebuf JSON — camelCase field names with
      // nested `location` (the previous snake_case reads matched nothing, so
      // density_zones was permanently empty).
      type VesselLoc = { latitude?: number; longitude?: number };
      type VesselResp = {
        snapshot?: {
          snapshotAt?: number;
          densityZones?: { name?: string; location?: VesselLoc; intensity?: number; shipsPerDay?: number; deltaPct?: number; note?: string }[];
          disruptions?: { name?: string; type?: string; severity?: string; location?: VesselLoc; darkShips?: number; vesselCount?: number; region?: string; description?: string }[];
        };
      };

      const res = await fetch(url, {
        headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        throw new Error(`get-vessel-snapshot HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
      }
      const data = await res.json() as VesselResp;
      const snap = data.snapshot ?? {};

      // 3° pad: maritime zones sit offshore, outside land bboxes (e.g. the
      // Strait of Hormuz at 26.6N/56.3E vs AE's ne corner at 26.06/56.38).
      // (0,0) is the handler's default for missing coordinates → exclude.
      const PAD_DEG = 3;
      const inCountryBbox = (loc?: VesselLoc): boolean => {
        const lat = loc?.latitude ?? 0;
        const lon = loc?.longitude ?? 0;
        if (lat === 0 && lon === 0) return false;
        if (lat < sw_lat - PAD_DEG || lat > ne_lat + PAD_DEG) return false;
        const lo = sw_lon - PAD_DEG;
        // Source boxes stored wrapped (sw_lon > ne_lon) span the dateline;
        // unwrap to a monotonic interval before reasoning about the pad.
        const hi = (sw_lon > ne_lon ? ne_lon + 360 : ne_lon) + PAD_DEG;
        // Pad widened the interval to the full circle — AQ and RU are stored
        // as -180..180 spans, so every longitude matches.
        if (hi - lo >= 360) return true;
        // The pad itself can push a ±180-adjacent box past the dateline
        // (FJ ne_lon=180 → hi=183; NZ 178.29 → 181.29): points just across
        // it (e.g. -179) must still match, so renormalize the overflowing
        // end into [-180,180] and compare on the wrapped complement.
        const wraps = lo < -180 || hi > 180;
        const loN = lo < -180 ? lo + 360 : lo;
        const hiN = hi > 180 ? hi - 360 : hi;
        return wraps ? lon >= loN || lon <= hiN : lon >= loN && lon <= hiN;
      };

      const zones = (snap.densityZones ?? []).filter(z => inCountryBbox(z.location));
      const disruptions = (snap.disruptions ?? []).filter(d => inCountryBbox(d.location));

      return {
        country_code: code,
        bounding_box: { sw_lat, sw_lon, ne_lat, ne_lon },
        snapshot_at: snap.snapshotAt ? new Date(snap.snapshotAt).toISOString() : new Date().toISOString(),
        total_zones: zones.length,
        total_disruptions: disruptions.length,
        density_zones: zones.map(z => ({
          name: z.name, intensity: z.intensity, ships_per_day: z.shipsPerDay,
          delta_pct: z.deltaPct, ...(z.note ? { note: z.note } : {}),
        })),
        disruptions: disruptions.map(d => ({
          name: d.name, type: d.type, severity: d.severity,
          dark_ships: d.darkShips, vessel_count: d.vesselCount,
          region: d.region, description: d.description,
        })),
      };
    },
    _apiPaths: [
      "GET /api/maritime/v1/get-vessel-snapshot",
    ],
  },
  {
    name: 'analyze_situation',
    _outputBudgetBytes: 65536,
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
    outputSchema: {
      type: 'object',
      properties: {
        deduction: { type: 'string', description: 'LLM-generated analytical deduction.' },
        analysis: { type: 'string', description: 'Alternate naming for the body.' },
        confidence: { type: ['number', 'string', 'null'] },
        signals: { type: ['array', 'object', 'null'] },
        framework: { type: 'string' },
        generatedAt: { type: ['string', 'number', 'null'] },
        provider: { type: 'string' },
        model: { type: 'string' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _execute: async (params, base, context) => {
      const url = `${base}/api/intelligence/v1/deduct-situation`;
      const body = JSON.stringify({ query: String(params.query ?? ''), geoContext: String(params.context ?? ''), framework: String(params.framework ?? '') });
      const auth = await buildAuthHeaders(context, 'POST', url, body);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        body,
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`deduct-situation HTTP ${res.status}`);
      return res.json();
    },
    _apiPaths: [
      "POST /api/intelligence/v1/deduct-situation",
    ],
  },
  {
    name: 'generate_forecasts',
    _outputBudgetBytes: 65536,
    description: 'Generate live AI geopolitical and economic forecasts. Unlike get_forecast_predictions (pre-computed cache), this calls the forecasting model directly for fresh probability estimates. Note: slower than cache tools.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Forecast domain: "geopolitical", "economic", "military", "climate", or empty for all domains' },
        region: { type: 'string', description: 'Geographic region filter, e.g. "Middle East", "Europe", "Asia Pacific", or empty for global' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        forecasts: { type: 'array', items: { type: 'object', properties: {
          domain: { type: 'string' }, region: { type: 'string' },
          probability: { type: ['number', 'null'] }, title: { type: 'string' }, rationale: { type: 'string' },
        } } },
        generatedAt: { type: ['string', 'number', 'null'] },
        provider: { type: 'string' },
        model: { type: 'string' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _execute: async (params, base, context) => {
      // 25 s — stays within Vercel Edge's ~30 s hard ceiling (was 60 s, which exceeded the limit)
      const url = `${base}/api/forecast/v1/get-forecasts`;
      const body = JSON.stringify({ domain: String(params.domain ?? ''), region: String(params.region ?? '') });
      const auth = await buildAuthHeaders(context, 'POST', url, body);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        body,
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`get-forecasts HTTP ${res.status}`);
      return res.json();
    },
    _apiPaths: [],
  },
  {
    name: 'search_flights',
    _outputBudgetBytes: 262144,
    description: 'Search Google Flights for real-time flight options between two airports on a specific date. Returns available flights with prices, stops, airline, and segment details. Use IATA airport codes (e.g. "JFK", "LHR", "DXB").',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'IATA code for the departure airport, e.g. "JFK"' },
        destination: { type: 'string', description: 'IATA code for the arrival airport, e.g. "LHR"' },
        departure_date: { type: 'string', description: 'Departure date in YYYY-MM-DD format' },
        return_date: { type: 'string', description: 'Return date in YYYY-MM-DD format for round trips (optional)' },
        cabin_class: { type: 'string', description: 'Cabin class: "economy", "premium_economy", "business", or "first" (optional, default economy)' },
        max_stops: { type: 'string', description: 'Max stops: "0" or "non_stop" for nonstop, "1" or "one_stop" for max one stop, or omit for any (optional)' },
        passengers: { type: 'number', description: 'Number of passengers (1-9, default 1)' },
        sort_by: { type: 'string', description: 'Sort order: "price" (cheapest), "duration", "departure", or "arrival" (optional)' },
      },
      required: ['origin', 'destination', 'departure_date'],
    },
    // Proxies SerpAPI Google Flights. Shape mirrors that upstream's JSON
    // envelope — keep schema permissive on field types since SerpAPI rotates.
    outputSchema: {
      type: 'object',
      properties: {
        flights: { type: 'array', items: { type: 'object', properties: {
          price: { type: ['number', 'string', 'null'] }, currency: { type: 'string' },
          stops: { type: ['number', 'null'] }, airline: { type: 'string' },
          total_duration: { type: ['number', 'string', 'null'] },
          segments: { type: 'array', items: { type: 'object' } },
        } } },
        search_metadata: { type: ['object', 'null'] },
        error: { type: 'string', description: 'Present when upstream returned a usable error message.' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _execute: async (params, base, context) => {
      const qs = new URLSearchParams({
        origin: String(params.origin ?? ''),
        destination: String(params.destination ?? ''),
        departure_date: String(params.departure_date ?? ''),
        ...(params.return_date ? { return_date: String(params.return_date) } : {}),
        // Default to economy when the LLM omits cabin_class. The relay /
        // upstream SerpAPI returns ZERO flights for some popular routes
        // (e.g. JFK→LHR) when cabin_class is unset, even though the tool
        // description advertises "default economy". Diagnosis: live probe
        // showed empty `flights` with no error AND no degraded flag; adding
        // `cabin_class=economy` to the same call returned 10+ real flights.
        // This restores the advertised contract.
        cabin_class: String(params.cabin_class ?? 'economy'),
        ...(params.max_stops ? { max_stops: String(params.max_stops) } : {}),
        ...(params.sort_by ? { sort_by: String(params.sort_by) } : {}),
        passengers: String(Math.max(1, Math.min(Number(params.passengers ?? 1), 9))),
      });
      const url = `${base}/api/aviation/v1/search-google-flights?${qs}`;
      const auth = await buildAuthHeaders(context, 'GET', url, null);
      const res = await fetch(url, {
        headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`search-google-flights HTTP ${res.status}`);
      return res.json();
    },
    _apiPaths: [
      "GET /api/aviation/v1/search-google-flights",
    ],
  },
  {
    name: 'search_flight_prices_by_date',
    _outputBudgetBytes: 262144,
    description: 'Search Google Flights date-grid pricing across a date range. Returns cheapest prices for each departure date between two airports. Useful for finding the cheapest day to fly. Use IATA airport codes.',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'IATA code for the departure airport, e.g. "JFK"' },
        destination: { type: 'string', description: 'IATA code for the arrival airport, e.g. "LHR"' },
        start_date: { type: 'string', description: 'Start of the date range in YYYY-MM-DD format' },
        end_date: { type: 'string', description: 'End of the date range in YYYY-MM-DD format' },
        is_round_trip: { type: 'boolean', description: 'Whether to search round-trip prices (default false). Requires trip_duration when true.' },
        trip_duration: { type: 'number', description: 'Trip duration in days — required when is_round_trip is true (e.g. 7 for a one-week trip)' },
        cabin_class: { type: 'string', description: 'Cabin class: "economy", "premium_economy", "business", or "first" (optional, default economy)' },
        passengers: { type: 'number', description: 'Number of passengers (1-9, default 1)' },
        sort_by_price: { type: 'boolean', description: 'Sort results by price ascending (default false, sorts by date)' },
      },
      required: ['origin', 'destination', 'start_date', 'end_date'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        prices: { type: 'array', items: { type: 'object', properties: {
          date: { type: 'string' }, price: { type: ['number', 'string', 'null'] },
          currency: { type: 'string' },
        } } },
        search_metadata: { type: ['object', 'null'] },
        error: { type: 'string' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _execute: async (params, base, context) => {
      const qs = new URLSearchParams({
        origin: String(params.origin ?? ''),
        destination: String(params.destination ?? ''),
        start_date: String(params.start_date ?? ''),
        end_date: String(params.end_date ?? ''),
        is_round_trip: String(params.is_round_trip ?? false),
        ...(params.trip_duration ? { trip_duration: String(params.trip_duration) } : {}),
        // Mirror search_flights: default to economy when omitted. Same
        // upstream-empty-on-missing-cabin-class issue.
        cabin_class: String(params.cabin_class ?? 'economy'),
        sort_by_price: String(params.sort_by_price ?? false),
        passengers: String(Math.max(1, Math.min(Number(params.passengers ?? 1), 9))),
      });
      const url = `${base}/api/aviation/v1/search-google-dates?${qs}`;
      const auth = await buildAuthHeaders(context, 'GET', url, null);
      const res = await fetch(url, {
        headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`search-google-dates HTTP ${res.status}`);
      return res.json();
    },
    _apiPaths: [
      "GET /api/aviation/v1/search-google-dates",
    ],
  },
  {
    name: 'get_commodity_geo',
    _outputBudgetBytes: 262144,
    description: 'Global mining sites with coordinates, operator, mineral type, and production status. Covers 71 major mines spanning gold, silver, copper, lithium, uranium, coal, and other minerals worldwide.',
    inputSchema: {
      type: 'object',
      properties: {
        mineral: { type: 'string', description: 'Filter by mineral type (e.g. "Gold", "Copper", "Lithium")' },
        country: { type: 'string', description: 'Filter by country name (e.g. "Australia", "Chile")' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      required: ['sites', 'total'],
      properties: {
        sites: { type: 'array', items: { type: 'object', properties: {
          id: { type: 'string' }, name: { type: 'string' },
          lat: { type: 'number' }, lon: { type: 'number' },
          mineral: { type: 'string' }, country: { type: 'string' },
          operator: { type: 'string' }, status: { type: 'string' }, significance: { type: 'string' },
          annualOutput: { type: 'string' }, productionRank: { type: 'number' },
          openPitOrUnderground: { type: 'string' },
        } } },
        total: { type: 'number' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params: Record<string, unknown>) => {
      type MineSite = { id: string; name: string; lat: number; lon: number; mineral: string; country: string; operator: string; status: string; significance: string; annualOutput?: string; productionRank?: number; openPitOrUnderground?: string };
      let sites = MINING_SITES_RAW as MineSite[];
      if (params.mineral) sites = sites.filter((s) => s.mineral === String(params.mineral));
      if (params.country) sites = sites.filter((s) => s.country.toLowerCase().includes(String(params.country).toLowerCase()));
      return { sites, total: sites.length };
    },
    _apiPaths: [],
  },
  {
    // describe_tool (v1.5.0) — on-demand escape hatch for the full
    // uncompressed tool definition. tools/list (default) emits each tool's
    // description compressed to ≤TOOL_DESCRIPTION_MAX_BYTES (first sentence
    // or byte-truncated); the LLM calls describe_tool with a tool_name to
    // get the full v1.4.0-shape tool object — same public shape, just with
    // long-form text in `description`. Uses the SAME buildPublicTool helper
    // as tools/list so the two surfaces can never drift.
    name: 'describe_tool',
    _outputBudgetBytes: 8192,
    description: 'Return the full uncompressed definition of one tool by name. Use when the compressed tools/list entry is ambiguous about behaviour or argument semantics.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'Exact tool name from tools/list.' },
      },
      required: ['tool_name'],
    },
    // Returns either the public Tool shape (see PublicToolShape) or one of the
    // two structured error envelopes — both are tools/call results, not JSON-RPC errors.
    outputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        annotations: { type: 'object' },
        error: { type: 'string', enum: ['missing_tool_name', 'unknown_tool'], description: 'Present only on user-input failure.' },
        hint: { type: 'string' },
        requested: { type: 'string' },
        available: { type: 'array', items: { type: 'string' } },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params: Record<string, unknown>) => {
      const name = params.tool_name;
      if (typeof name !== 'string' || name.length === 0) {
        return { error: 'missing_tool_name', hint: 'Pass tool_name as a non-empty string matching a tool from tools/list.' };
      }
      const tool = TOOL_REGISTRY.find((t) => t.name === name);
      if (!tool) {
        return {
          error: 'unknown_tool',
          requested: name,
          available: TOOL_REGISTRY.map((t) => t.name).sort(),
        };
      }
      return buildPublicTool(tool, { compressDescriptions: false });
    },
    _apiPaths: [],
  },
];
