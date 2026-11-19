import { buildAuthHeaders } from '../auth';
import { fetchMcpDownstream } from '../downstream';
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
    form: { type: 'string', description: 'SEC form type, such as 8-K or 10-Q.' },
    fileDate: { type: 'string', description: 'Filing date, YYYY-MM-DD.' },
    description: { type: 'string', description: 'Plain-language meaning of the 8-K item codes; empty for other forms.' },
    url: { type: 'string', description: 'EDGAR document URL.' },
    items: { type: 'array', items: { type: 'string' }, description: '8-K item codes reported in the filing, such as 5.02.' },
  },
};

const earningsSchema = {
  type: 'object',
  properties: {
    period: { type: 'string', description: 'Fiscal period end date.' },
    actualEps: { type: 'number', description: 'Reported earnings per share, in the listing currency.' },
    estimateEps: { type: 'number', description: 'Consensus EPS estimate.' },
    surprise: { type: 'number', description: 'actualEps minus estimateEps.' },
    surprisePercent: { type: 'number', description: 'Surprise as a percentage of the absolute estimate.' },
    year: { type: 'number', description: 'Fiscal year.' },
    quarter: { type: 'number', description: 'Fiscal quarter, 1-4.' },
  },
};

const newsMentionSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Headline.' },
    url: { type: 'string', description: 'Article URL.' },
    source: { type: 'string', description: 'Publishing feed name.' },
    publishedAtMs: { type: 'number', description: 'Publication time, Unix epoch milliseconds.' },
  },
};

const companySignalSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', description: 'Signal class: an 8-K event type derived from its primary item, or News Mention.' },
    title: { type: 'string', description: 'Signal headline.' },
    url: { type: 'string', description: 'Filing or article URL.' },
    source: { type: 'string', description: 'Where the signal came from.' },
    sourceTier: { type: 'number', description: 'Source authority: 1 for SEC filings, 3 for news mentions; lower is more authoritative.' },
    timestampMs: { type: 'number', description: 'Event time, Unix epoch milliseconds.' },
    strength: { type: 'string', description: 'Strong (high-materiality 8-K item), Moderate (other 8-K item) or Emerging (news mention).' },
  },
};

const filingSearchHitSchema = {
  type: 'object',
  properties: {
    company: { type: 'string', description: 'Filer name.' },
    cik: { type: 'string', description: 'SEC Central Index Key of the filer.' },
    form: { type: 'string', description: 'SEC form type.' },
    fileDate: { type: 'string', description: 'Filing date, YYYY-MM-DD.' },
    items: { type: 'array', items: { type: 'string' }, description: '8-K item codes reported in the filing.' },
    url: { type: 'string', description: 'EDGAR document URL.' },
    accession: { type: 'string', description: 'EDGAR accession number identifying the filing.' },
  },
};

const materialEventSchema = {
  type: 'object',
  properties: {
    company: { type: 'string', description: 'Filer name.' },
    cik: { type: 'string', description: 'SEC Central Index Key of the filer.' },
    form: { type: 'string', description: 'SEC form type, such as 8-K.' },
    accession: { type: 'string', description: 'EDGAR accession number identifying the filing.' },
    filedAtMs: { type: 'number', description: 'Filing time, Unix epoch milliseconds.' },
    items: {
      type: 'array',
      description: '8-K items reported in the filing.',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '8-K item code, such as 5.02.' },
          description: { type: 'string', description: 'What the item code means.' },
        },
      },
    },
    url: { type: 'string', description: 'EDGAR document URL.' },
  },
};

function addStringParam(query: URLSearchParams, name: string, value: unknown): void {
  if (typeof value === 'string' && value.trim()) query.set(name, value.trim());
}

export const COMPANY_INTEL_TOOL: ToolDef = {
  name: 'get_company_intelligence',
  title: 'Company intelligence',
  _outputBudgetBytes: 65536,
  description: 'Return corporate intelligence for one company from SEC EDGAR and market data, selected by view: enrichment (SEC identity, recent filings, market profile, earnings surprises, news mentions; the default), signals (classified 8-K material events plus news), filings-search (EDGAR full-text search with forms and date filters; query required) or material-events (market-wide stream of recent material 8-K filings; no company needed). Identity resolves through the SEC ticker registry, so an unresolvable ticker or name returns an empty envelope rather than guessed attribution. Requires a paid plan; one live downstream fetch, weight 2 on API plans, up to 20 s. limit is honoured up to 25 for filings-search and 100 for material-events and ignored by the other views. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      view: { type: 'string', enum: [...COMPANY_INTEL_VIEWS], description: 'Which dataset to return: one company\'s profile (enrichment), its classified events (signals), EDGAR full-text search (filings-search) or the market-wide 8-K stream (material-events). Omitted: enrichment.' },
      ticker: { type: 'string', description: 'Exchange ticker symbol, such as AAPL. Preferred company key for enrichment and signals.' },
      name: { type: 'string', description: 'Company name fallback when no ticker is known; case-insensitive exact SEC title match only, and only when that title maps to a single CIK. Prefer ticker.' },
      query: { type: 'string', description: 'filings-search only: full-text query. Required for that view.' },
      forms: { type: 'string', description: 'filings-search only: comma-separated form filter, such as "8-K" or "10-K,10-Q".' },
      start_date: { type: 'string', description: 'filings-search only: earliest filing date (YYYY-MM-DD).' },
      end_date: { type: 'string', description: 'filings-search only: latest filing date (YYYY-MM-DD).' },
      item_code: { type: 'string', description: 'material-events only: keep filings that report this 8-K item number, written N.NN as in items[].code of returned events, such as "5.02" (officer departures and appointments) or "1.01" (material agreements). Omitted: all items.' },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Number of results to return. filings-search accepts at most 25 (omitted: 10); material-events uses the full range (omitted: 25). Above 25 on filings-search returns error limit_out_of_range. Ignored by the enrichment and signals views.' },
    },
    required: [],
  },
  outputSchema: {
    type: 'object',
    required: ['view'],
    properties: {
      view: { type: 'string', enum: [...COMPANY_INTEL_VIEWS], description: 'View that produced the result; the matching block (enrichment, signals, search or events) carries the data.' },
      error: { type: 'string', enum: ['ticker_or_name_required', 'query_required', 'limit_out_of_range'], description: 'Present only on user-input failure.' },
      enrichment: {
        type: 'object',
        properties: {
          company: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Registered company name.' },
              domain: { type: 'string', description: 'Company web domain.' },
              description: { type: 'string', description: 'SEC industry (SIC) description.' },
              location: { type: 'string', description: 'Business address city and state or country from SEC records.' },
              website: { type: 'string', description: 'Company website URL.' },
              founded: { type: 'number', deprecated: true },
              cik: { type: 'string', description: 'SEC Central Index Key; empty when the company was not resolved.' },
              ticker: { type: 'string', description: 'Exchange ticker.' },
            },
          },
          github: { type: 'object', deprecated: true },
          techStack: { type: 'array', items: { type: 'object' }, deprecated: true },
          secFilings: {
            type: 'object',
            properties: {
              totalFilings: { type: 'number', description: 'Number of recent filings on the SEC submissions record.' },
              recentFilings: { type: 'array', items: secFilingSchema, description: 'Most recent relevant filings, newest first.' },
            },
          },
          hackerNewsMentions: { type: 'array', items: { type: 'object' }, deprecated: true },
          market: {
            type: 'object',
            properties: {
              exchange: { type: 'string', description: 'Listing exchange.' },
              industry: { type: 'string', description: 'Industry classification.' },
              marketCapMusd: { type: 'number', description: 'Market capitalization in millions of the listing currency; 0 when unreported.' },
              ipoDate: { type: 'string', description: 'IPO date, YYYY-MM-DD.' },
              logoUrl: { type: 'string', description: 'Company logo image URL.' },
              country: { type: 'string', description: 'Company country from the market profile.' },
              currency: { type: 'string', description: 'Listing currency code.' },
            },
          },
          earningsSurprises: { type: 'array', items: earningsSchema, description: 'Reported versus estimated EPS by fiscal period, newest first.' },
          newsMentions: { type: 'array', items: newsMentionSchema, description: 'Recent news headlines naming the company.' },
          sources: {
            type: 'array',
            items: { type: 'string' },
            description: 'Sources that returned data. Empty is not an identity signal — combine with company.cik and unavailable.',
          },
          enrichedAtMs: { type: 'number', description: 'Oldest fetch time among the sources used, Unix epoch milliseconds.' },
          unavailable: {
            type: 'boolean',
            description: 'True when the SEC registry was unreadable or every enrichment source failed. False with an empty CIK means the filer was not found.',
          },
        },
      },
      signals: {
        type: 'object',
        properties: {
          company: { type: 'string', description: 'Resolved company name.' },
          domain: { type: 'string', deprecated: true },
          cik: { type: 'string', description: 'Resolved SEC filer CIK. Empty + unavailable false = not in registry; empty + unavailable true = registry down.' },
          signals: { type: 'array', items: companySignalSchema, description: '8-K material events and news mentions for the company.' },
          summary: {
            type: 'object',
            properties: {
              totalSignals: { type: 'number', description: 'Number of signals returned.' },
              byType: { type: 'object', additionalProperties: { type: 'number' }, description: 'Signal count per type.' },
              strongestSignal: { ...companySignalSchema, description: 'Highest-strength signal; ties go to the more authoritative source, then the newest.' },
              signalDiversity: { type: 'number', description: 'Number of distinct sources among the signals.' },
            },
          },
          discoveredAtMs: { type: 'number', description: 'When the signals were assembled, Unix epoch milliseconds.' },
          unavailable: {
            type: 'boolean',
            description: 'True when the registry or authoritative SEC submissions source failed. A response can contain partial news signals.',
          },
        },
      },
      search: {
        type: 'object',
        properties: {
          results: { type: 'array', items: filingSearchHitSchema, description: 'Matching filings, up to limit.' },
          total: { type: 'number', description: 'Total matches EDGAR reports, which can exceed the results returned.' },
          unavailable: { type: 'boolean', description: 'True when EDGAR full-text search failed; results is then empty.' },
          fetchedAtMs: { type: 'number', description: 'Fetch time, Unix epoch milliseconds.' },
        },
      },
      events: {
        type: 'object',
        properties: {
          events: { type: 'array', items: materialEventSchema, description: 'Recent 8-K filings that report at least one item, up to limit.' },
          unavailable: { type: 'boolean', description: 'True when the seeded 8-K stream could not be read; events is then empty.' },
          fetchedAtMs: { type: 'number', description: 'When the 8-K stream was last refreshed, Unix epoch milliseconds; 0 when unknown.' },
        },
      },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  _execute: async (params, base, context, execution) => {
    const view = typeof params.view === 'string' && (COMPANY_INTEL_VIEWS as readonly string[]).includes(params.view)
      ? params.view
      : 'enrichment';
    const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    const limit = Number.isInteger(params.limit) && (params.limit as number) > 0 ? (params.limit as number) : 0;

    const call = async (path: string, query: URLSearchParams, timeoutMs: number) => {
      const url = `${base}${path}?${query}`;
      const auth = await buildAuthHeaders(context, 'GET', url, null);
      const response = await fetchMcpDownstream(url, {
        headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(timeoutMs),
      }, execution);
      await assertToolFetchOk(response, path.split('/').pop() ?? path);
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
