import { buildAuthHeaders } from '../auth';
import { assertToolFetchOk } from '../billing-denial';
import type { ToolDef } from '../types';

export const COMPANY_INTEL_VIEWS = [
  'enrichment',
  'signals',
  'filings-search',
  'material-events',
] as const;

// Must remain above EDGAR_UPSTREAM_TIMEOUT_MS so the REST route can finish its
// own bounded EFTS call and return an honest unavailable envelope.
export const COMPANY_INTEL_SEARCH_TIMEOUT_MS = 15_000;

const secFilingSchema = {
  type: 'object',
  properties: {
    form: { type: 'string' },
    fileDate: { type: 'string' },
    description: { type: 'string' },
    url: { type: 'string' },
    items: { type: 'array', items: { type: 'string' } },
  },
};

const earningsSchema = {
  type: 'object',
  properties: {
    period: { type: 'string' },
    actualEps: { type: 'number' },
    estimateEps: { type: 'number' },
    surprise: { type: 'number' },
    surprisePercent: { type: 'number' },
    year: { type: 'number' },
    quarter: { type: 'number' },
  },
};

const newsMentionSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    url: { type: 'string' },
    source: { type: 'string' },
    publishedAtMs: { type: 'number' },
  },
};

const companySignalSchema = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    url: { type: 'string' },
    source: { type: 'string' },
    sourceTier: { type: 'number' },
    timestampMs: { type: 'number' },
    strength: { type: 'string' },
  },
};

const filingSearchHitSchema = {
  type: 'object',
  properties: {
    company: { type: 'string' },
    cik: { type: 'string' },
    form: { type: 'string' },
    fileDate: { type: 'string' },
    items: { type: 'array', items: { type: 'string' } },
    url: { type: 'string' },
    accession: { type: 'string' },
  },
};

const materialEventSchema = {
  type: 'object',
  properties: {
    company: { type: 'string' },
    cik: { type: 'string' },
    form: { type: 'string' },
    accession: { type: 'string' },
    filedAtMs: { type: 'number' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
    url: { type: 'string' },
  },
};

function addStringParam(query: URLSearchParams, name: string, value: unknown): void {
  if (typeof value === 'string' && value.trim()) query.set(name, value.trim());
}

export const COMPANY_INTEL_TOOL: ToolDef = {
  name: 'get_company_intelligence',
  _outputBudgetBytes: 65536,
  description: 'Per-company corporate intelligence from SEC EDGAR and market data. Views: enrichment (SEC identity, recent filings, market profile, earnings surprises, news mentions), signals (classified 8-K material events + news), filings-search (EDGAR full-text search with form/date filters), material-events (market-wide stream of recent material 8-K filings). Company identity resolves through the SEC ticker registry — unresolvable companies return empty envelopes, never guessed attribution.',
  inputSchema: {
    type: 'object',
    properties: {
      view: { type: 'string', enum: [...COMPANY_INTEL_VIEWS], description: 'Defaults to enrichment.' },
      ticker: { type: 'string', description: 'Exchange ticker symbol, such as AAPL. Preferred company key for enrichment and signals.' },
      name: { type: 'string', description: 'Company name fallback when no ticker is known; case-insensitive exact SEC title match only, and only when that title maps to a single CIK. Prefer ticker.' },
      query: { type: 'string', description: 'filings-search only: full-text query. Required for that view.' },
      forms: { type: 'string', description: 'filings-search only: comma-separated form filter, such as "8-K" or "10-K,10-Q".' },
      start_date: { type: 'string', description: 'filings-search only: earliest filing date (YYYY-MM-DD).' },
      end_date: { type: 'string', description: 'filings-search only: latest filing date (YYYY-MM-DD).' },
      item_code: { type: 'string', description: 'material-events only: filter to one 8-K item code, such as "5.02".' },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Result cap. Honored up to 25 for filings-search and up to 100 for material-events; a value above the view\'s own maximum is rejected rather than silently clamped. Ignored by the enrichment and signals views.' },
    },
    required: [],
  },
  outputSchema: {
    type: 'object',
    required: ['view'],
    properties: {
      view: { type: 'string', enum: [...COMPANY_INTEL_VIEWS] },
      error: { type: 'string', enum: ['ticker_or_name_required', 'query_required', 'limit_out_of_range'], description: 'Present only on user-input failure.' },
      enrichment: {
        type: 'object',
        properties: {
          company: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              domain: { type: 'string' },
              description: { type: 'string' },
              location: { type: 'string' },
              website: { type: 'string' },
              founded: { type: 'number', deprecated: true },
              cik: { type: 'string' },
              ticker: { type: 'string' },
            },
          },
          github: { type: 'object', deprecated: true },
          techStack: { type: 'array', items: { type: 'object' }, deprecated: true },
          secFilings: {
            type: 'object',
            properties: {
              totalFilings: { type: 'number' },
              recentFilings: { type: 'array', items: secFilingSchema },
            },
          },
          hackerNewsMentions: { type: 'array', items: { type: 'object' }, deprecated: true },
          market: {
            type: 'object',
            properties: {
              exchange: { type: 'string' },
              industry: { type: 'string' },
              marketCapMusd: { type: 'number' },
              ipoDate: { type: 'string' },
              logoUrl: { type: 'string' },
              country: { type: 'string' },
              currency: { type: 'string' },
            },
          },
          earningsSurprises: { type: 'array', items: earningsSchema },
          newsMentions: { type: 'array', items: newsMentionSchema },
          sources: {
            type: 'array',
            items: { type: 'string' },
            description: 'Sources that returned data. Empty is not an identity signal — combine with company.cik and unavailable.',
          },
          enrichedAtMs: { type: 'number' },
          unavailable: {
            type: 'boolean',
            description: 'True when the SEC registry was unreadable or every enrichment source failed. False with an empty CIK means the filer was not found.',
          },
        },
      },
      signals: {
        type: 'object',
        properties: {
          company: { type: 'string' },
          domain: { type: 'string', deprecated: true },
          cik: { type: 'string', description: 'Resolved SEC filer CIK. Empty + unavailable false = not in registry; empty + unavailable true = registry down.' },
          signals: { type: 'array', items: companySignalSchema },
          summary: {
            type: 'object',
            properties: {
              totalSignals: { type: 'number' },
              byType: { type: 'object', additionalProperties: { type: 'number' } },
              strongestSignal: companySignalSchema,
              signalDiversity: { type: 'number' },
            },
          },
          discoveredAtMs: { type: 'number' },
          unavailable: {
            type: 'boolean',
            description: 'True when the registry or authoritative SEC submissions source failed. A response can contain partial news signals.',
          },
        },
      },
      search: {
        type: 'object',
        properties: {
          results: { type: 'array', items: filingSearchHitSchema },
          total: { type: 'number' },
          unavailable: { type: 'boolean' },
          fetchedAtMs: { type: 'number' },
        },
      },
      events: {
        type: 'object',
        properties: {
          events: { type: 'array', items: materialEventSchema },
          unavailable: { type: 'boolean' },
          fetchedAtMs: { type: 'number' },
        },
      },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _execute: async (params, base, context) => {
    const view = typeof params.view === 'string' && (COMPANY_INTEL_VIEWS as readonly string[]).includes(params.view)
      ? params.view
      : 'enrichment';
    const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    const limit = Number.isInteger(params.limit) && (params.limit as number) > 0 ? (params.limit as number) : 0;

    const call = async (path: string, query: URLSearchParams, timeoutMs: number) => {
      const url = `${base}${path}?${query}`;
      const auth = await buildAuthHeaders(context, 'GET', url, null);
      const response = await fetch(url, {
        headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      assertToolFetchOk(response, path.split('/').pop() ?? path);
      return response.json();
    };

    const limitWithinRange = (max: number) => !limit || limit <= max;

    if (view === 'filings-search') {
      const query = str(params.query);
      if (!query) return { view, error: 'query_required' };
      if (!limitWithinRange(25)) return { view, error: 'limit_out_of_range' };
      const search = new URLSearchParams({ query });
      addStringParam(search, 'forms', params.forms);
      addStringParam(search, 'start_date', params.start_date);
      addStringParam(search, 'end_date', params.end_date);
      if (limit) search.set('limit', String(limit));
      return { view, search: await call('/api/intelligence/v1/search-sec-filings', search, COMPANY_INTEL_SEARCH_TIMEOUT_MS) };
    }

    if (view === 'material-events') {
      if (!limitWithinRange(100)) return { view, error: 'limit_out_of_range' };
      const search = new URLSearchParams();
      addStringParam(search, 'item_code', params.item_code);
      if (limit) search.set('limit', String(limit));
      return { view, events: await call('/api/intelligence/v1/list-material-events', search, 8_000) };
    }

    const ticker = str(params.ticker);
    const name = str(params.name);
    if (!ticker && !name) return { view, error: 'ticker_or_name_required' };

    if (view === 'signals') {
      const search = new URLSearchParams();
      if (ticker) search.set('ticker', ticker);
      if (name) search.set('company', name);
      return { view, signals: await call('/api/intelligence/v1/list-company-signals', search, 20_000) };
    }

    const search = new URLSearchParams();
    if (ticker) search.set('ticker', ticker);
    if (name) search.set('name', name);
    return { view, enrichment: await call('/api/intelligence/v1/get-company-enrichment', search, 20_000) };
  },
  _coverageKeys: [
    'intelligence:sec-cik-map:v1',
    'intelligence:sec-8k-stream:v1',
  ],
  _apiPaths: [
    'GET /api/intelligence/v1/get-company-enrichment',
    'GET /api/intelligence/v1/list-company-signals',
    'GET /api/intelligence/v1/search-sec-filings',
    'GET /api/intelligence/v1/list-material-events',
  ],
};
