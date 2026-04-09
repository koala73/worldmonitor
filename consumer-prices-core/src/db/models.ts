export interface Retailer {
  id: string;
  slug: string;
  name: string;
  marketCode: string;
  countryCode: string;
  currencyCode: string;
  adapterKey: string;
  baseUrl: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface RetailerTarget {
  id: string;
  retailerId: string;
  targetType: 'category_url' | 'product_url' | 'search_query';
  targetRef: string;
  categorySlug: string;
  enabled: boolean;
  lastScrapedAt: Date | null;
}

export interface CanonicalProduct {
  id: string;
  canonicalName: string;
  brandNorm: string | null;
  category: string;
  variantNorm: string | null;
  sizeValue: number | null;
  sizeUnit: string | null;
  baseQuantity: number | null;
  baseUnit: string | null;
  active: boolean;
  createdAt: Date;
}

export interface RetailerProduct {
  id: string;
  retailerId: string;
  retailerSku: string | null;
  canonicalProductId: string | null;
  sourceUrl: string;
  rawTitle: string;
  rawBrand: string | null;
  rawSizeText: string | null;
  imageUrl: string | null;
  categoryText: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  active: boolean;
}

export interface PriceObservation {
  id: string;
  retailerProductId: string;
  scrapeRunId: string;
  observedAt: Date;
  price: number;
  listPrice: number | null;
  promoPrice: number | null;
  currencyCode: string;
  unitPrice: number | null;
  unitBasisQty: number | null;
  unitBasisUnit: string | null;
  inStock: boolean;
  promoText: string | null;
  rawPayloadJson: Record<string, unknown>;
  rawHash: string;
}

export interface ScrapeRun {
  id: string;
  retailerId: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: 'running' | 'completed' | 'failed' | 'partial';
  triggerType: 'scheduled' | 'manual';
  pagesAttempted: number;
  pagesSucceeded: number;
  errorsCount: number;
  configVersion: string;
}

export interface ProductMatch {
  id: string;
  retailerProductId: string;
  canonicalProductId: string;
  basketItemId: string | null;
  matchScore: number;
  matchStatus: 'auto' | 'review' | 'approved' | 'rejected';
  evidenceJson: Record<string, unknown>;
  reviewedBy: string | null;
  reviewedAt: Date | null;
}

export interface ComputedIndex {
  id: string;
  basketId: string;
  retailerId: string | null;
  category: string | null;
  metricDate: Date;
  metricKey: string;
  metricValue: number;
  methodologyVersion: string;
}

export interface DataSourceHealth {
  retailerId: string;
  lastSuccessfulRunAt: Date | null;
  lastRunStatus: string | null;
  parseSuccessRate: number | null;
  avgFreshnessMinutes: number | null;
  updatedAt: Date;
}
