/**
 * Trend Types for Trend Dashboard
 *
 * Data structures for trend analysis and visualization.
 */

/** Time period for trend analysis */
export type TrendPeriod = 30 | 90;

/**
 * Topic/keyword trend item
 */
export interface TrendTopic {
  /** Keyword/topic */
  keyword: string;
  /** Occurrence count */
  count: number;
  /** Change from previous period (percentage) */
  change: number;
  /** Sentiment score (-1 to 1) */
  sentiment?: number;
}

/**
 * Funding timeline data point
 */
export interface FundingDataPoint {
  /** Date (YYYY-MM-DD) */
  date: string;
  /** Funding amount in EUR */
  amount: number;
  /** Number of deals */
  deals: number;
}

/**
 * Funding trend data
 */
export interface FundingTrend {
  /** Total funding in period */
  total: string;
  /** Total number of deals */
  deals: number;
  /** Average deal size */
  averageDealSize: string;
  /** Timeline data for chart */
  timeline: FundingDataPoint[];
  /** Week-over-week change percentage */
  weekOverWeek: number;
}

/**
 * Industry distribution item
 */
export interface IndustryDistribution {
  /** Industry name */
  name: string;
  /** Percentage of total */
  percentage: number;
  /** News article count */
  newsCount: number;
  /** Funding amount if available */
  fundingAmount?: string;
}

/**
 * M&A activity data
 */
export interface MATrend {
  /** Total M&A deals */
  totalDeals: number;
  /** Total deal value */
  totalValue: string;
  /** Deals by month */
  timeline: Array<{
    month: string;
    deals: number;
    value: number;
  }>;
}

/**
 * Trend summary for dashboard
 */
export interface TrendSummary {
  /** Total news articles in period */
  totalNews: number;
  /** Total funding amount */
  totalFunding: string;
  /** Most active industry */
  topIndustry: string;
  /** Most trending topic */
  trendingTopic: string;
  /** Week-over-week changes */
  weekOverWeek: {
    news: number;
    funding: number;
  };
  /** Period analyzed */
  period: {
    start: string;
    end: string;
    days: TrendPeriod;
  };
  /** Last updated timestamp */
  updatedAt: string;
}

/**
 * Topics API response
 */
export interface TopicsResponse {
  success: boolean;
  topics?: TrendTopic[];
  period?: { start: string; end: string };
  error?: string;
}

/**
 * Funding API response
 */
export interface FundingResponse {
  success: boolean;
  funding?: FundingTrend;
  error?: string;
}

/**
 * Industry API response
 */
export interface IndustryResponse {
  success: boolean;
  industries?: IndustryDistribution[];
  error?: string;
}

/**
 * Summary API response
 */
export interface SummaryResponse {
  success: boolean;
  summary?: TrendSummary;
  error?: string;
}

// Constants
export const TREND_LIMITS = {
  /** Maximum topics to return */
  MAX_TOPICS: 20,
  /** Default topics count */
  DEFAULT_TOPICS: 10,
  /** Cache TTL (1 hour) */
  CACHE_TTL_SECONDS: 3600,
  /** Valid periods */
  VALID_PERIODS: [30, 90] as const,
};

/**
 * Common tech keywords for topic extraction
 */
export const TECH_KEYWORDS = [
  'AI', 'artificial intelligence', 'machine learning', 'ML',
  'funding', 'investment', 'venture capital', 'VC',
  'acquisition', 'merger', 'M&A', 'IPO',
  'startup', 'unicorn', 'scale-up',
  'fintech', 'healthtech', 'biotech', 'cleantech',
  'cloud', 'SaaS', 'data center',
  'semiconductor', 'chip', 'manufacturing',
  'hiring', 'jobs', 'layoffs', 'expansion',
  'revenue', 'growth', 'profit',
  'Dublin', 'Cork', 'Galway', 'Ireland',
  'EMEA', 'Europe', 'headquarters',
];
