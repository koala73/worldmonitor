/**
 * Parallel P0 acquisition provider.
 * P0 is a high-throughput scraping API that handles JS rendering,
 * anti-bot, and proxy rotation. Compatible with its REST API.
 */
import type { AcquisitionProvider, FetchOptions, FetchResult, SearchOptions, SearchResult } from './types.js';

interface P0ScrapeResponse {
  success: boolean;
  html?: string;
  markdown?: string;
  statusCode?: number;
  error?: string;
}

interface P0SearchResponse {
  results?: Array<{ url: string; title: string; snippet?: string }>;
}

export class P0Provider implements AcquisitionProvider {
  readonly name = 'p0' as const;

  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    baseUrl = 'https://api.parallelai.dev/v1',
  ) {
    this.baseUrl = baseUrl;
  }

  private headers() {
    return {
      'x-api-key': this.apiKey,
      'Content-Type': 'application/json',
    };
  }

  async fetch(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
    const resp = await fetch(`${this.baseUrl}/scrape`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        url,
        render_js: true,
        wait_for: opts.waitForSelector,
        timeout: Math.floor((opts.timeout ?? 30_000) / 1_000),
        output_format: 'html',
        premium_proxy: true,
      }),
      signal: AbortSignal.timeout((opts.timeout ?? 30_000) + 10_000),
    });

    if (!resp.ok) throw new Error(`P0 scrape failed: HTTP ${resp.status}`);

    const data = (await resp.json()) as P0ScrapeResponse;
    if (!data.success && !data.html) {
      throw new Error(`P0 error: ${data.error ?? 'no content'}`);
    }

    return {
      url,
      html: data.html ?? '',
      markdown: data.markdown,
      statusCode: data.statusCode ?? 200,
      provider: this.name,
      fetchedAt: new Date(),
    };
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const resp = await fetch(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        query,
        num_results: opts.numResults ?? 10,
        include_domains: opts.includeDomains,
      }),
    });

    if (!resp.ok) throw new Error(`P0 search failed: HTTP ${resp.status}`);

    const data = (await resp.json()) as P0SearchResponse;
    return (data.results ?? []).map((r) => ({
      url: r.url,
      title: r.title,
      text: r.snippet,
    }));
  }

  async validate(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5_000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }
}
