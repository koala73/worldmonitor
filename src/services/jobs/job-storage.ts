/**
 * Job Storage Service
 *
 * Handles CRUD operations for job listings using Upstash Redis.
 * Storage schema:
 * - jobs:list -> Set of job IDs
 * - jobs:{id} -> Job JSON
 * - jobs:saved:{userId} -> Set of saved job IDs
 * - jobs:stats -> Job statistics JSON
 */

import type {
  Job,
  JobFilters,
  JobSearchResponse,
  SavedJob,
  JobStats,
  IrishLocation,
} from '@/types/job';

// Use dynamic imports for Redis to support both server and client contexts
let redisClient: {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, options?: { ex?: number }) => Promise<void>;
  del: (key: string) => Promise<void>;
  sadd: (key: string, ...members: string[]) => Promise<void>;
  srem: (key: string, ...members: string[]) => Promise<void>;
  smembers: (key: string) => Promise<string[]>;
  scard: (key: string) => Promise<number>;
} | null = null;

/**
 * Initialize Redis client (lazy initialization)
 */
async function getRedis() {
  if (redisClient) return redisClient;

  const url = typeof process !== 'undefined' ? process.env?.UPSTASH_REDIS_REST_URL : undefined;
  const token = typeof process !== 'undefined' ? process.env?.UPSTASH_REDIS_REST_TOKEN : undefined;

  if (!url || !token) {
    console.warn('[JobStorage] Redis not configured, using mock storage');
    return null;
  }

  try {
    const { Redis } = await import('@upstash/redis');
    redisClient = new Redis({ url, token }) as unknown as typeof redisClient;
    return redisClient;
  } catch (e) {
    console.error('[JobStorage] Failed to initialize Redis:', e);
    return null;
  }
}

/**
 * Generate a unique job ID
 */
function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Storage key helpers
 */
const keys = {
  jobList: () => 'jobs:list',
  job: (id: string) => `jobs:${id}`,
  savedJobs: (userId: string) => `jobs:saved:${userId}`,
  stats: () => 'jobs:stats',
  byCompany: (company: string) => `jobs:company:${company.toLowerCase().replace(/\s+/g, '-')}`,
  byLocation: (location: string) => `jobs:location:${location.toLowerCase()}`,
};

/**
 * Job Storage class for managing jobs in Redis
 */
export class JobStorage {
  /**
   * Add or update a job listing
   */
  async upsertJob(job: Omit<Job, 'id' | 'fetchedAt'> & { id?: string }): Promise<Job> {
    const redis = await getRedis();
    if (!redis) {
      throw new Error('Redis not configured');
    }

    const jobId = job.id || generateJobId();
    const now = new Date().toISOString();

    const fullJob: Job = {
      ...job,
      id: jobId,
      fetchedAt: now,
      isActive: job.isActive ?? true,
    };

    // Save job
    await redis.set(keys.job(jobId), JSON.stringify(fullJob));
    await redis.sadd(keys.jobList(), jobId);

    // Index by company and location for faster filtering
    await redis.sadd(keys.byCompany(fullJob.company), jobId);
    await redis.sadd(keys.byLocation(fullJob.location), jobId);

    return fullJob;
  }

  /**
   * Get a job by ID
   */
  async getJob(id: string): Promise<Job | null> {
    const redis = await getRedis();
    if (!redis) return null;

    const data = await redis.get(keys.job(id));
    if (!data) return null;

    try {
      return JSON.parse(data) as Job;
    } catch {
      return null;
    }
  }

  /**
   * Search jobs with filters
   */
  async searchJobs(filters: JobFilters = {}): Promise<JobSearchResponse> {
    const redis = await getRedis();
    if (!redis) {
      return { jobs: [], total: 0, filters };
    }

    // Get all job IDs
    const allJobIds = await redis.smembers(keys.jobList());
    if (!allJobIds.length) {
      return { jobs: [], total: 0, filters };
    }

    // Fetch all jobs
    const jobs: Job[] = [];
    for (const id of allJobIds) {
      const job = await this.getJob(id);
      if (job && job.isActive) {
        jobs.push(job);
      }
    }

    // Apply filters
    let filtered = jobs;

    if (filters.q) {
      const q = filters.q.toLowerCase();
      filtered = filtered.filter(
        (j) =>
          j.title.toLowerCase().includes(q) ||
          j.company.toLowerCase().includes(q) ||
          j.description.toLowerCase().includes(q)
      );
    }

    if (filters.location) {
      filtered = filtered.filter((j) => j.location === filters.location);
    }

    if (filters.employmentType) {
      filtered = filtered.filter((j) => j.employmentType === filters.employmentType);
    }

    if (filters.experienceLevel) {
      filtered = filtered.filter((j) => j.experienceLevel === filters.experienceLevel);
    }

    if (filters.salaryMin !== undefined && filters.salaryMin > 0) {
      filtered = filtered.filter(
        (j) => j.salaryRange && j.salaryRange.max >= filters.salaryMin!
      );
    }

    if (filters.salaryMax !== undefined && filters.salaryMax > 0) {
      filtered = filtered.filter(
        (j) => j.salaryRange && j.salaryRange.min <= filters.salaryMax!
      );
    }

    if (filters.techStack && filters.techStack.length > 0) {
      const techLower = filters.techStack.map((t) => t.toLowerCase());
      filtered = filtered.filter((j) =>
        j.techStack.some((t) => techLower.includes(t.toLowerCase()))
      );
    }

    if (filters.company) {
      const companyLower = filters.company.toLowerCase();
      filtered = filtered.filter((j) => j.company.toLowerCase().includes(companyLower));
    }

    // Sort
    const sortBy = filters.sortBy || 'postedAt';
    const sortOrder = filters.sortOrder || 'desc';

    filtered.sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'postedAt') {
        cmp = new Date(a.postedAt).getTime() - new Date(b.postedAt).getTime();
      } else if (sortBy === 'salary') {
        const salaryA = a.salaryRange?.max || 0;
        const salaryB = b.salaryRange?.max || 0;
        cmp = salaryA - salaryB;
      }
      return sortOrder === 'desc' ? -cmp : cmp;
    });

    const total = filtered.length;

    // Pagination
    const offset = filters.offset || 0;
    const limit = filters.limit || 20;
    filtered = filtered.slice(offset, offset + limit);

    return { jobs: filtered, total, filters };
  }

  /**
   * Delete a job
   */
  async deleteJob(id: string): Promise<boolean> {
    const redis = await getRedis();
    if (!redis) return false;

    const job = await this.getJob(id);
    if (job) {
      await redis.del(keys.job(id));
      await redis.srem(keys.jobList(), id);
      await redis.srem(keys.byCompany(job.company), id);
      await redis.srem(keys.byLocation(job.location), id);
    }

    return true;
  }

  /**
   * Save a job for a user
   */
  async saveJob(userId: string, jobId: string, notes?: string): Promise<SavedJob> {
    const redis = await getRedis();
    if (!redis) {
      throw new Error('Redis not configured');
    }

    // Check job exists
    const job = await this.getJob(jobId);
    if (!job) {
      throw new Error('Job not found');
    }

    // Check saved limit
    const savedCount = await redis.scard(keys.savedJobs(userId));
    if (savedCount >= 50) {
      throw new Error('Maximum 50 saved jobs');
    }

    const savedJob: SavedJob = {
      jobId,
      savedAt: new Date().toISOString(),
      notes,
    };

    await redis.sadd(keys.savedJobs(userId), JSON.stringify(savedJob));

    return savedJob;
  }

  /**
   * Get saved jobs for a user
   */
  async getSavedJobs(userId: string): Promise<Array<SavedJob & { job: Job | null }>> {
    const redis = await getRedis();
    if (!redis) return [];

    const savedData = await redis.smembers(keys.savedJobs(userId));
    const result: Array<SavedJob & { job: Job | null }> = [];

    for (const data of savedData) {
      try {
        const saved = JSON.parse(data) as SavedJob;
        const job = await this.getJob(saved.jobId);
        result.push({ ...saved, job });
      } catch {
        // Skip invalid entries
      }
    }

    return result.sort(
      (a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime()
    );
  }

  /**
   * Remove a saved job
   */
  async unsaveJob(userId: string, jobId: string): Promise<boolean> {
    const redis = await getRedis();
    if (!redis) return false;

    const savedData = await redis.smembers(keys.savedJobs(userId));
    for (const data of savedData) {
      try {
        const saved = JSON.parse(data) as SavedJob;
        if (saved.jobId === jobId) {
          await redis.srem(keys.savedJobs(userId), data);
          return true;
        }
      } catch {
        // Skip
      }
    }

    return false;
  }

  /**
   * Get job statistics
   */
  async getStats(): Promise<JobStats | null> {
    const redis = await getRedis();
    if (!redis) return null;

    // Try cached stats first
    const cached = await redis.get(keys.stats());
    if (cached) {
      try {
        return JSON.parse(cached) as JobStats;
      } catch {
        // Fall through to calculate
      }
    }

    // Calculate stats
    const allJobIds = await redis.smembers(keys.jobList());
    const jobs: Job[] = [];

    for (const id of allJobIds) {
      const job = await this.getJob(id);
      if (job && job.isActive) {
        jobs.push(job);
      }
    }

    const byLocation: Record<IrishLocation, number> = {
      Dublin: 0,
      Cork: 0,
      Galway: 0,
      Limerick: 0,
      Remote: 0,
      Other: 0,
    };

    const companyCount: Record<string, number> = {};
    const techCount: Record<string, number> = {};
    let salarySum = { min: 0, max: 0, count: 0 };

    for (const job of jobs) {
      byLocation[job.location] = (byLocation[job.location] || 0) + 1;
      companyCount[job.company] = (companyCount[job.company] || 0) + 1;

      for (const tech of job.techStack) {
        techCount[tech] = (techCount[tech] || 0) + 1;
      }

      if (job.salaryRange) {
        salarySum.min += job.salaryRange.min;
        salarySum.max += job.salaryRange.max;
        salarySum.count++;
      }
    }

    const topCompanies = Object.entries(companyCount)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([company, count]) => ({ company, count }));

    const topTechStack = Object.entries(techCount)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([tech, count]) => ({ tech, count }));

    const stats: JobStats = {
      totalJobs: jobs.length,
      byLocation,
      topCompanies,
      topTechStack,
      avgSalary: {
        min: salarySum.count > 0 ? Math.round(salarySum.min / salarySum.count) : 0,
        max: salarySum.count > 0 ? Math.round(salarySum.max / salarySum.count) : 0,
      },
      lastSyncAt: new Date().toISOString(),
    };

    // Cache stats for 1 hour
    await redis.set(keys.stats(), JSON.stringify(stats), { ex: 3600 });

    return stats;
  }
}

// Export singleton instance
export const jobStorage = new JobStorage();
