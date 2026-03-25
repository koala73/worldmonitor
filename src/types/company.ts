/**
 * Company Types for Company Profile Pages
 *
 * Data structures for Irish tech company profiles.
 */

/** Company industry categories */
export type CompanyIndustry =
  | 'Fintech'
  | 'AI/ML'
  | 'SaaS'
  | 'E-commerce'
  | 'Healthcare'
  | 'Gaming'
  | 'Semiconductor'
  | 'Data Center'
  | 'Cybersecurity'
  | 'Cloud'
  | 'Enterprise'
  | 'Consumer'
  | 'Other';

/** Employee count ranges */
export type EmployeeRange =
  | '1-10'
  | '11-50'
  | '51-200'
  | '201-500'
  | '501-1000'
  | '1001-5000'
  | '5001-10000'
  | '10000+';

/** Company tags */
export type CompanyTag =
  | 'unicorn'
  | 'tech-hq'
  | 'data-center'
  | 'semiconductor'
  | 'startup'
  | 'multinational'
  | 'irish-founded'
  | 'ai-company'
  | 'university';

/** Relation type between companies */
export type CompanyRelation = 'parent' | 'subsidiary' | 'competitor' | 'partner';

/**
 * Company funding information
 */
export interface CompanyFunding {
  /** Total funding amount */
  total: string;
  /** Last funding round type */
  lastRound?: string;
  /** Last round date (YYYY-MM) */
  lastRoundDate?: string;
  /** Notable investors */
  investors?: string[];
}

/**
 * Key person in the company
 */
export interface CompanyPerson {
  /** Person's name */
  name: string;
  /** Job title */
  title: string;
  /** LinkedIn profile URL */
  linkedin?: string;
  /** Profile image URL */
  image?: string;
}

/**
 * Related company reference
 */
export interface RelatedCompany {
  /** Company slug for linking */
  slug: string;
  /** Company name */
  name: string;
  /** Relationship type */
  relation: CompanyRelation;
}

/**
 * Complete company profile
 */
export interface Company {
  /** Unique company ID */
  id: string;
  /** URL-friendly slug (e.g., "stripe") */
  slug: string;
  /** Official company name */
  name: string;
  /** Company logo URL */
  logo?: string;
  /** Company description */
  description?: string;
  /** Year founded */
  founded?: number;
  /** Headquarters location */
  headquarters: string;
  /** Primary industry */
  industry: CompanyIndustry;
  /** Employee count range */
  employeeCount?: EmployeeRange;
  /** Official website */
  website?: string;
  /** LinkedIn company page */
  linkedin?: string;
  /** Twitter/X handle */
  twitter?: string;
  /** Funding information */
  funding?: CompanyFunding;
  /** Key people */
  people?: CompanyPerson[];
  /** Related companies */
  relatedCompanies?: RelatedCompany[];
  /** Tags for categorization */
  tags?: CompanyTag[];
  /** Map coordinates [longitude, latitude] */
  coordinates?: [number, number];
  /** Irish office address */
  address?: string;
  /** When data was last updated */
  updatedAt?: string;
}

/**
 * Company news item
 */
export interface CompanyNewsItem {
  /** News article ID */
  id: string;
  /** Article title */
  title: string;
  /** Article summary */
  summary: string;
  /** Article URL */
  url: string;
  /** Publication date */
  publishedAt: string;
  /** News source */
  source: string;
}

/**
 * Company search filters
 */
export interface CompanyFilters {
  /** Search query (name, description) */
  q?: string;
  /** Filter by industry */
  industry?: CompanyIndustry;
  /** Filter by tag */
  tag?: CompanyTag;
  /** Filter by location */
  location?: string;
  /** Pagination offset */
  offset?: number;
  /** Pagination limit */
  limit?: number;
}

/**
 * Company search response
 */
export interface CompanySearchResponse {
  /** List of matching companies */
  companies: Company[];
  /** Total count */
  total: number;
  /** Applied filters */
  filters: CompanyFilters;
}

/**
 * Company API response
 */
export interface CompanyResponse {
  success: boolean;
  company?: Company;
  error?: string;
}

/**
 * Company news API response
 */
export interface CompanyNewsResponse {
  success: boolean;
  news?: CompanyNewsItem[];
  total?: number;
  error?: string;
}

// Constants
export const COMPANY_LIMITS = {
  /** Maximum companies per search */
  MAX_SEARCH_RESULTS: 50,
  /** Default page size */
  DEFAULT_PAGE_SIZE: 20,
  /** Maximum news items per company */
  MAX_NEWS_ITEMS: 50,
  /** Company cache TTL (1 hour) */
  CACHE_TTL_SECONDS: 3600,
};
