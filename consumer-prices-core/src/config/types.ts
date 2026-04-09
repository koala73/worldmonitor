import { z } from 'zod';

export const AcquisitionConfigSchema = z.object({
  provider: z.enum(['playwright', 'exa', 'firecrawl', 'p0']),
  fallback: z.enum(['playwright', 'exa', 'firecrawl', 'p0']).optional(),
  options: z
    .object({
      waitForSelector: z.string().optional(),
      timeout: z.number().optional(),
      retries: z.number().optional(),
    })
    .optional(),
  searchMode: z.boolean().optional(),
  searchQueryTemplate: z.string().optional(),
});

export const RateLimitSchema = z.object({
  requestsPerMinute: z.number().default(30),
  maxConcurrency: z.number().default(2),
  delayBetweenRequestsMs: z.number().default(2_000),
});

export const ProductCardSelectorsSchema = z.object({
  container: z.string(),
  title: z.string(),
  price: z.string(),
  listPrice: z.string().optional(),
  url: z.string(),
  imageUrl: z.string().optional(),
  sizeText: z.string().optional(),
  inStock: z.string().optional(),
  sku: z.string().optional(),
  brand: z.string().optional(),
});

export const ProductPageSelectorsSchema = z.object({
  title: z.string(),
  sku: z.string().optional(),
  categoryPath: z.string().optional(),
  jsonld: z.string().optional(),
  price: z.string().optional(),
  brand: z.string().optional(),
  sizeText: z.string().optional(),
});

export const DiscoverySeedSchema = z.object({
  id: z.string(),
  url: z.string(),
  category: z.string().optional(),
});

export const SearchConfigSchema = z.object({
  numResults: z.number().default(3),
  queryTemplate: z.string().optional(),
  urlPathContains: z.string().optional(),
  inStockFromPrice: z.boolean().default(false),
});

export const RetailerConfigSchema = z.object({
  retailer: z.object({
    slug: z.string(),
    name: z.string(),
    marketCode: z.string().length(2),
    currencyCode: z.string().length(3),
    adapter: z.enum(['generic', 'exa-search', 'search', 'custom']).default('generic'),
    baseUrl: z.string().url(),
    rateLimit: RateLimitSchema.optional(),
    acquisition: AcquisitionConfigSchema.optional(),
    searchConfig: SearchConfigSchema.optional(),
    discovery: z.object({
      mode: z.enum(['category_urls', 'sitemap', 'search']).default('category_urls'),
      seeds: z.array(DiscoverySeedSchema),
      paginationSelector: z.string().optional(),
      maxPages: z.number().default(20),
    }),
    extraction: z.object({
      productCard: ProductCardSelectorsSchema.optional(),
      productPage: ProductPageSelectorsSchema.optional(),
      priceFormat: z
        .object({
          decimalSeparator: z.string().default('.'),
          thousandsSeparator: z.string().default(','),
          currencySymbols: z.array(z.string()).default([]),
        })
        .optional(),
    }).optional(),
    enabled: z.boolean().default(true),
  }),
});

export type RetailerConfig = z.infer<typeof RetailerConfigSchema>['retailer'];
export type SearchConfig = z.infer<typeof SearchConfigSchema>;

export const BasketItemSchema = z.object({
  id: z.string(),
  category: z.string(),
  canonicalName: z.string(),
  weight: z.number().min(0).max(1),
  baseUnit: z.string(),
  substitutionGroup: z.string().optional(),
  minBaseQty: z.number().optional(),
  maxBaseQty: z.number().optional(),
  qualificationRules: z.record(z.string(), z.unknown()).optional(),
});

export const BasketConfigSchema = z.object({
  basket: z.object({
    slug: z.string(),
    name: z.string(),
    marketCode: z.string().length(2),
    methodology: z.enum(['fixed', 'value']),
    baseDate: z.string(),
    description: z.string().optional(),
    items: z.array(BasketItemSchema),
  }),
});

export type BasketConfig = z.infer<typeof BasketConfigSchema>['basket'];
export type BasketItem = z.infer<typeof BasketItemSchema>;
