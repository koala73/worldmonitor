import type { AcquisitionProvider, ExtractResult, ExtractSchema, FetchOptions, FetchResult, SearchOptions, SearchResult } from './types.js';

interface FirecrawlScrapeResponse {
  success: boolean;
  data?: {
    html?: string;
    markdown?: string;
    metadata?: Record<string, unknown>;
  };
  error?: string;
}

interface FirecrawlSearchResponse {
  success: boolean;
  data?: Array<{ url: string; title: string; description?: string; markdown?: string }>;
}

interface FirecrawlExtractResponse {
  success: boolean;
  data?: {
    extract?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };
  error?: string;
}

/** Transport headroom added to a server-side render budget. */
export const ABORT_HEADROOM_MS = 5_000;

/**
 * Client abort deadline for an extraction call.
 *
 * Must be strictly greater than the render budget sent in the request body:
 * the client clock starts before the request leaves the process and also
 * covers DNS, TLS, Firecrawl's queueing and the response transfer, so with
 * equal deadlines the client always wins. A page that uses its full render
 * allowance would then be aborted before its successful response could
 * arrive, Firecrawl's own timeout error would be unreachable, and two such
 * pages open the caller's per-scrape Firecrawl cooldown.
 */
export function extractAbortMs(timeoutMs?: number): number {
  return (timeoutMs ?? 30_000) + ABORT_HEADROOM_MS;
}

export class FirecrawlProvider implements AcquisitionProvider {
  readonly name = 'firecrawl' as const;

  private readonly baseUrl = 'https://api.firecrawl.dev/v1';

  constructor(private readonly apiKey: string) {}

  private headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'worldmonitor-consumer-prices/1.0',
    };
  }

  async fetch(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
    const resp = await fetch(`${this.baseUrl}/scrape`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        url,
        formats: ['html', 'markdown'],
        waitFor: opts.waitForSelector ? 2000 : 0,
        timeout: opts.timeout ?? 30_000,
        headers: opts.headers,
      }),
      signal: AbortSignal.timeout((opts.timeout ?? 30_000) + 5_000),
    });

    if (!resp.ok) throw new Error(`Firecrawl scrape failed: HTTP ${resp.status}`);

    const data = (await resp.json()) as FirecrawlScrapeResponse;
    if (!data.success || !data.data) {
      throw new Error(`Firecrawl error: ${data.error ?? 'unknown'}`);
    }

    return {
      url,
      html: data.data.html ?? '',
      markdown: data.data.markdown ?? '',
      statusCode: 200,
      provider: this.name,
      fetchedAt: new Date(),
      metadata: data.data.metadata,
    };
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const resp = await fetch(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        query,
        limit: opts.numResults ?? 10,
        includeDomains: opts.includeDomains,
        scrapeOptions: { formats: ['markdown'] },
      }),
    });

    if (!resp.ok) throw new Error(`Firecrawl search failed: HTTP ${resp.status}`);

    const data = (await resp.json()) as FirecrawlSearchResponse;
    return (data.data ?? []).map((r) => ({
      url: r.url,
      title: r.title,
      text: r.description ?? r.markdown,
    }));
  }

  async extract<T = Record<string, unknown>>(
    url: string,
    schema: ExtractSchema,
    opts: FetchOptions = {},
  ): Promise<ExtractResult<T>> {
    // Nullable is encoded DIFFERENTLY here than in ExaProvider.extract, and the
    // divergence is deliberate — do not "unify" these without re-testing both
    // providers live. Firecrawl accepts the JSON Schema `type: [T,'null']`
    // union (verified: HTTP 200, extract returned). Exa's /contents validator
    // rejects an array `type` outright with HTTP 400 INVALID_REQUEST_BODY, so
    // it must use `anyOf` instead (#6182 — that mismatch silently disabled
    // every Exa extraction call and, after two failures, the whole fallback).
    const jsonSchema: Record<string, unknown> = {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(schema.fields).map(([k, v]) => [
          k,
          { type: v.nullable ? [v.type, 'null'] : v.type, description: v.description },
        ]),
      ),
      ...(Object.values(schema.fields).some((field) => field.required !== undefined)
        ? { required: Object.entries(schema.fields).filter(([, field]) => field.required !== false).map(([key]) => key) }
        : {}),
    };

    const resp = await fetch(`${this.baseUrl}/scrape`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        url,
        formats: ['extract'],
        extract: { schema: jsonSchema, ...(schema.prompt ? { prompt: schema.prompt } : {}) },
        timeout: opts.timeout ?? 30_000,
      }),
      signal: AbortSignal.timeout(extractAbortMs(opts.timeout)),
    });

    if (!resp.ok) throw new Error(`Firecrawl extract failed: HTTP ${resp.status}`);

    const data = (await resp.json()) as FirecrawlExtractResponse;
    // Throw ONLY for a provider-side failure (quota exhausted, rate limited,
    // bad request) — those are transport conditions the caller's cooldown
    // should count. A successful call that simply found nothing to extract is
    // a PAGE-level outcome: return empty so the caller records `missing-price`
    // and moves to the next candidate URL without accruing an outage streak.
    // Conflating the two lets two ordinary no-product pages disable Firecrawl
    // for the rest of the scrape, on every retailer, not just opted-in ones.
    if (!data.success) {
      throw new Error(`Firecrawl extract error: ${data.error ?? 'unknown'}`);
    }

    return {
      url,
      data: (data.data?.extract ?? {}) as T,
      provider: this.name,
      fetchedAt: new Date(),
    };
  }

  async validate(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/scrape`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ url: 'https://example.com', formats: ['markdown'] }),
        signal: AbortSignal.timeout(10_000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }
}
