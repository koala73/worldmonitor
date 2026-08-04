import Exa from 'exa-js';
import type { AcquisitionProvider, ExtractResult, ExtractSchema, FetchOptions, FetchResult, SearchOptions, SearchResult } from './types.js';

export class ExaProvider implements AcquisitionProvider {
  readonly name = 'exa' as const;

  private readonly apiKey: string;
  private readonly baseUrl = 'https://api.exa.ai';
  private client: Exa;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.client = new Exa(apiKey);
  }

  async fetch(url: string, _opts: FetchOptions = {}): Promise<FetchResult> {
    const result = await this.client.getContents([url], {
      text: { maxCharacters: 100_000 },
      highlights: { numSentences: 5, highlightsPerUrl: 3 },
    });

    const item = result.results[0];
    if (!item) throw new Error(`Exa returned no content for ${url}`);

    return {
      url,
      html: item.text ?? '',
      markdown: item.text ?? '',
      statusCode: 200,
      provider: this.name,
      fetchedAt: new Date(),
      metadata: { highlights: item.highlights },
    };
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const result = await this.request<{
      results?: Array<{
        url: string;
        title?: string;
        text?: string;
        highlights?: string[];
        score?: number;
        publishedDate?: string;
      }>;
    }>('/search', {
      query,
      numResults: opts.numResults ?? 10,
      type: opts.type ?? 'neural',
      includeDomains: opts.includeDomains,
      startPublishedDate: opts.startPublishedDate,
      useAutoprompt: true,
    }, opts.timeout);

    return (result.results ?? []).map((r) => ({
      url: r.url,
      title: r.title ?? '',
      text: r.text,
      highlights: r.highlights,
      score: r.score,
      publishedDate: r.publishedDate,
    }));
  }

  async extract<T = Record<string, unknown>>(
    url: string,
    schema: ExtractSchema,
    opts: FetchOptions = {},
  ): Promise<ExtractResult<T>> {
    const prompt = `${schema.prompt ? `${schema.prompt} ` : ''}Extract the following fields from this product page: ${Object.entries(schema.fields)
      .map(([k, v]) => `${k} (${v.type}): ${v.description}`)
      .join(', ')}`;
    const outputSchema = {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(schema.fields).map(([key, field]) => [
          key,
          {
            type: field.nullable ? [field.type, 'null'] : field.type,
            description: field.description,
          },
        ]),
      ),
      required: Object.entries(schema.fields)
        .filter(([, field]) => field.required !== false)
        .map(([key]) => key),
      additionalProperties: false,
    };

    // exa-js does not expose an AbortSignal for getContents, so use the API
    // directly here to keep the opt-in fallback genuinely bounded.
    const result = await this.request<{ results?: Array<{ summary?: unknown }> }>('/contents', {
      urls: [url],
      summary: { query: prompt, schema: outputSchema },
    }, opts.timeout);
    const item = result.results?.[0];
    if (!item) throw new Error(`Exa returned no content for ${url}`);
    const data = parseStructuredSummary<T>(item.summary);
    if (data === null) throw new Error(`Exa returned malformed structured summary for ${url}`);

    return {
      url,
      data,
      provider: this.name,
      fetchedAt: new Date(),
    };
  }

  async validate(): Promise<boolean> {
    try {
      await this.client.search('test', { numResults: 1 });
      return true;
    } catch {
      return false;
    }
  }

  private async request<T>(endpoint: string, body: Record<string, unknown>, timeout = 30_000): Promise<T> {
    const response = await globalThis.fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'worldmonitor-consumer-prices/1.0',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Exa ${endpoint.slice(1)} failed HTTP ${response.status}: ${detail.slice(0, 120)}`);
    }

    return (await response.json()) as T;
  }
}

function parseStructuredSummary<T>(summary: unknown): T | null {
  if (summary && typeof summary === 'object') return summary as T;
  if (typeof summary !== 'string') return null;

  const trimmed = summary.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? (parsed as T) : null;
  } catch {
    return null;
  }
}
