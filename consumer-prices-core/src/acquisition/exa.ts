import Exa from 'exa-js';
import type { AcquisitionProvider, ExtractResult, ExtractSchema, FetchOptions, FetchResult, SearchOptions, SearchResult } from './types.js';

export class ExaProvider implements AcquisitionProvider {
  readonly name = 'exa' as const;

  private client: Exa;

  constructor(apiKey: string) {
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
    const result = await this.client.search(query, {
      numResults: opts.numResults ?? 10,
      type: opts.type ?? 'neural',
      includeDomains: opts.includeDomains,
      startPublishedDate: opts.startPublishedDate,
      useAutoprompt: true,
    });

    return result.results.map((r) => ({
      url: r.url,
      title: r.title ?? '',
      text: r.text,
      highlights: (r as Record<string, unknown>).highlights as string[] | undefined,
      score: r.score,
      publishedDate: r.publishedDate,
    }));
  }

  async extract<T = Record<string, unknown>>(
    url: string,
    schema: ExtractSchema,
    _opts: FetchOptions = {},
  ): Promise<ExtractResult<T>> {
    const prompt = `Extract the following fields from this product page: ${Object.entries(schema.fields)
      .map(([k, v]) => `${k} (${v.type}): ${v.description}`)
      .join(', ')}`;

    const result = await this.client.getContents([url], {
      text: { maxCharacters: 50_000 },
      summary: { query: prompt },
    });

    const item = result.results[0];
    if (!item) throw new Error(`Exa returned no content for ${url}`);

    return {
      url,
      data: (item as unknown as { summary?: T }).summary ?? ({} as T),
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
}
