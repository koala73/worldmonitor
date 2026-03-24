/**
 * Job Types for Ireland Tech Job Aggregation
 *
 * Data structures for job listings from various sources.
 */

/** Employment type options */
export type EmploymentType = 'Full-time' | 'Part-time' | 'Contract' | 'Internship';

/** Experience level options */
export type ExperienceLevel = 'Entry' | 'Mid' | 'Senior' | 'Lead';

/** Data source for job listings */
export type JobSource = 'linkedin' | 'irishjobs' | 'indeed' | 'company' | 'manual';

/** Irish locations */
export type IrishLocation = 'Dublin' | 'Cork' | 'Galway' | 'Limerick' | 'Remote' | 'Other';

/**
 * Salary range structure
 */
export interface SalaryRange {
  min: number;
  max: number;
  currency: 'EUR' | 'USD' | 'GBP';
}

/**
 * Job listing data structure
 */
export interface Job {
  /** Unique job ID */
  id: string;
  /** Job title */
  title: string;
  /** Company name */
  company: string;
  /** Location (city or Remote) */
  location: IrishLocation;
  /** Full address if available */
  address?: string;
  /** Employment type */
  employmentType: EmploymentType;
  /** Required experience level */
  experienceLevel: ExperienceLevel;
  /** Required/preferred tech stack */
  techStack: string[];
  /** Salary range if disclosed */
  salaryRange?: SalaryRange;
  /** Job description */
  description: string;
  /** Short summary for list view */
  summary?: string;
  /** URL to apply */
  applyUrl: string;
  /** Data source */
  source: JobSource;
  /** When the job was posted */
  postedAt: string;
  /** When the job expires (if known) */
  expiresAt?: string;
  /** When we fetched this listing */
  fetchedAt: string;
  /** Is the job still active */
  isActive: boolean;
  /** Company logo URL */
  companyLogo?: string;
}

/**
 * Job search filters
 */
export interface JobFilters {
  /** Search query (title, company, description) */
  q?: string;
  /** Filter by location */
  location?: IrishLocation;
  /** Filter by employment type */
  employmentType?: EmploymentType;
  /** Filter by experience level */
  experienceLevel?: ExperienceLevel;
  /** Minimum salary */
  salaryMin?: number;
  /** Maximum salary */
  salaryMax?: number;
  /** Filter by tech stack (comma-separated) */
  techStack?: string[];
  /** Filter by company */
  company?: string;
  /** Sort by field */
  sortBy?: 'postedAt' | 'salary' | 'relevance';
  /** Sort direction */
  sortOrder?: 'asc' | 'desc';
  /** Pagination offset */
  offset?: number;
  /** Pagination limit */
  limit?: number;
}

/**
 * Job search response
 */
export interface JobSearchResponse {
  /** List of matching jobs */
  jobs: Job[];
  /** Total count (for pagination) */
  total: number;
  /** Applied filters */
  filters: JobFilters;
}

/**
 * Saved job reference
 */
export interface SavedJob {
  /** Job ID */
  jobId: string;
  /** When saved */
  savedAt: string;
  /** Optional notes */
  notes?: string;
}

/**
 * Job statistics for dashboard
 */
export interface JobStats {
  /** Total active jobs */
  totalJobs: number;
  /** Jobs by location */
  byLocation: Record<IrishLocation, number>;
  /** Jobs by company (top 10) */
  topCompanies: Array<{ company: string; count: number }>;
  /** Most in-demand tech stack */
  topTechStack: Array<{ tech: string; count: number }>;
  /** Average salary range */
  avgSalary: { min: number; max: number };
  /** Last sync time */
  lastSyncAt: string;
}

// Constants
export const JOB_LIMITS = {
  /** Maximum jobs to return per search */
  MAX_SEARCH_RESULTS: 100,
  /** Default page size */
  DEFAULT_PAGE_SIZE: 20,
  /** Maximum saved jobs per user */
  MAX_SAVED_JOBS: 50,
  /** Days after which job is considered stale */
  STALE_DAYS: 30,
};

/** Common tech stack keywords */
export const TECH_STACK_KEYWORDS = [
  'JavaScript', 'TypeScript', 'React', 'Vue', 'Angular', 'Node.js',
  'Python', 'Django', 'FastAPI', 'Java', 'Spring', 'Kotlin',
  'Go', 'Rust', 'C++', 'C#', '.NET',
  'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes',
  'PostgreSQL', 'MySQL', 'MongoDB', 'Redis',
  'GraphQL', 'REST', 'gRPC',
  'Machine Learning', 'AI', 'TensorFlow', 'PyTorch',
  'iOS', 'Android', 'React Native', 'Flutter',
];
