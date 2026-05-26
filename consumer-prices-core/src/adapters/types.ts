import type { RetailerConfig } from '../config/types.js';

export interface ParsedProduct {
  sourceUrl: string;
  rawTitle: string;
  rawBrand: string | null;
  rawSizeText: string | null;
  imageUrl: string | null;
  categoryText: string | null;
  retailerSku: string | null;
  price: number;
  listPrice: number | null;
  promoPrice: number | null;
  promoText: string | null;
  inStock: boolean;
  rawPayload: Record<string, unknown>;
}

export interface AdapterContext {
  config: RetailerConfig;
  runId: string;
  logger: { info: (msg: string, ...args: unknown[]) => void; warn: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void };
  retailerId?: string;
  pinnedUrls?: Map<string, { sourceUrl: string; productId: string; matchId: string }>;
}

export interface Target {
  id: string;
  url: string;
  category: string;
  metadata?: Record<string, unknown>;
}

export interface FetchResult {
  url: string;
  html: string;
  markdown?: string;
  statusCode: number;
  fetchedAt: Date;
}

export interface RetailerAdapter {
  readonly key: string;

  discoverTargets(ctx: AdapterContext): Promise<Target[]>;
  fetchTarget(ctx: AdapterContext, target: Target): Promise<FetchResult>;
  parseListing(ctx: AdapterContext, result: FetchResult): Promise<ParsedProduct[]>;
  parseProduct(ctx: AdapterContext, result: FetchResult): Promise<ParsedProduct>;
  validateConfig(config: RetailerConfig): Promise<string[]>;
}
