export type AcquisitionProviderName = 'playwright' | 'exa' | 'firecrawl' | 'p0';

export interface FetchOptions {
  waitForSelector?: string;
  timeout?: number;
  headers?: Record<string, string>;
  retries?: number;
  userAgent?: string;
}

export interface SearchOptions {
  numResults?: number;
  includeDomains?: string[];
  startPublishedDate?: string;
  type?: 'keyword' | 'neural';
}

export interface ExtractSchema {
  fields: Record<string, { description: string; type: 'string' | 'number' | 'boolean' | 'array' }>;
  prompt?: string;
}

export interface FetchResult {
  url: string;
  html: string;
  markdown?: string;
  statusCode: number;
  provider: AcquisitionProviderName;
  fetchedAt: Date;
  metadata?: Record<string, unknown>;
}

export interface SearchResult {
  url: string;
  title: string;
  text?: string;
  highlights?: string[];
  score?: number;
  publishedDate?: string;
}

export interface ExtractResult<T = Record<string, unknown>> {
  url: string;
  data: T;
  provider: AcquisitionProviderName;
  fetchedAt: Date;
}

export interface AcquisitionProvider {
  readonly name: AcquisitionProviderName;

  /** Fetch a URL, returning HTML content. */
  fetch(url: string, opts?: FetchOptions): Promise<FetchResult>;

  /** Search for pages matching a query (Exa primary, others may not support). */
  search?(query: string, opts?: SearchOptions): Promise<SearchResult[]>;

  /** Extract structured data from a URL using a schema hint. */
  extract?<T = Record<string, unknown>>(url: string, schema: ExtractSchema, opts?: FetchOptions): Promise<ExtractResult<T>>;

  /** Validate provider is configured and reachable. */
  validate(): Promise<boolean>;

  /** Clean up resources (close browser, etc.) */
  teardown?(): Promise<void>;
}

export interface AcquisitionConfig {
  /** Primary acquisition provider. */
  provider: AcquisitionProviderName;
  /** Fallback provider if primary fails. */
  fallback?: AcquisitionProviderName;
  /** Provider-specific options. */
  options?: FetchOptions;
  /** Use search mode instead of direct URL fetch (Exa only). */
  searchMode?: boolean;
  /** Query template for search mode: use {category}, {product}, {market} tokens. */
  searchQueryTemplate?: string;
}
