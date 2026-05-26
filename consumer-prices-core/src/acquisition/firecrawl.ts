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
}

export class FirecrawlProvider implements AcquisitionProvider {
  readonly name = 'firecrawl' as const;

  private readonly baseUrl = 'https://api.firecrawl.dev/v1';

  constructor(private readonly apiKey: string) {}

  private headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
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
    const jsonSchema: Record<string, unknown> = {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(schema.fields).map(([k, v]) => [
          k,
          { type: v.type, description: v.description },
        ]),
      ),
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
    });

    if (!resp.ok) throw new Error(`Firecrawl extract failed: HTTP ${resp.status}`);

    const data = (await resp.json()) as FirecrawlExtractResponse;

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
