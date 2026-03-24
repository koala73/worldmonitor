/**
 * Jobs API
 *
 * Job listing aggregation for Irish tech companies.
 * Uses Upstash REST API for Edge Function compatibility.
 *
 * Routes:
 * - GET /api/jobs - Search jobs with filters
 * - GET /api/jobs?id=xxx - Get single job
 * - GET /api/jobs?saved=true&userId=xxx - Get saved jobs
 * - POST /api/jobs/save - Save a job
 * - DELETE /api/jobs/save?jobId=xxx&userId=xxx - Unsave a job
 */

import { jsonResponse } from './_json-response.js';
import { withCors } from './_cors.js';

// Redis key helpers
const keys = {
  jobList: () => 'jobs:list',
  job: (id) => `jobs:${id}`,
  savedJobs: (userId) => `jobs:saved:${userId}`,
  stats: () => 'jobs:stats',
};

// Upstash REST API helpers
async function redisCmd(cmd, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const cmdUrl = `${url}/${[cmd, ...args.map(encodeURIComponent)].join('/')}`;
  const resp = await fetch(cmdUrl, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) return null;

  const data = await resp.json();
  return data.result;
}

async function redisGet(key) {
  const result = await redisCmd('get', key);
  if (!result) return null;
  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
}

async function redisSmembers(key) {
  const result = await redisCmd('smembers', key);
  return result || [];
}

async function redisSadd(key, member) {
  return redisCmd('sadd', key, member);
}

async function redisSrem(key, member) {
  return redisCmd('srem', key, member);
}

async function redisScard(key) {
  const result = await redisCmd('scard', key);
  return parseInt(result, 10) || 0;
}

// Handler
async function handler(request) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return jsonResponse({ success: false, error: 'Storage not configured' }, { status: 503 });
  }

  const reqUrl = new URL(request.url);
  const method = request.method;
  const path = reqUrl.pathname;

  try {
    // POST /api/jobs/save - Save a job
    if (method === 'POST' && path.endsWith('/save')) {
      const body = await request.json();
      const { userId, jobId, notes } = body;

      if (!userId || !jobId) {
        return jsonResponse({ success: false, error: 'userId and jobId required' }, { status: 400 });
      }

      // Check job exists
      const job = await redisGet(keys.job(jobId));
      if (!job) {
        return jsonResponse({ success: false, error: 'Job not found' }, { status: 404 });
      }

      // Check limit
      const savedCount = await redisScard(keys.savedJobs(userId));
      if (savedCount >= 50) {
        return jsonResponse({ success: false, error: 'Maximum 50 saved jobs' }, { status: 400 });
      }

      const savedJob = {
        jobId,
        savedAt: new Date().toISOString(),
        notes: notes || null,
      };

      await redisSadd(keys.savedJobs(userId), JSON.stringify(savedJob));

      return jsonResponse({ success: true, savedJob });
    }

    // DELETE /api/jobs/save - Unsave a job
    if (method === 'DELETE' && path.endsWith('/save')) {
      const jobId = reqUrl.searchParams.get('jobId');
      const userId = reqUrl.searchParams.get('userId');

      if (!userId || !jobId) {
        return jsonResponse({ success: false, error: 'userId and jobId required' }, { status: 400 });
      }

      const savedData = await redisSmembers(keys.savedJobs(userId));
      for (const data of savedData) {
        try {
          const saved = JSON.parse(data);
          if (saved.jobId === jobId) {
            await redisSrem(keys.savedJobs(userId), data);
            return jsonResponse({ success: true });
          }
        } catch {
          // Skip
        }
      }

      return jsonResponse({ success: true }); // Already not saved
    }

    // GET requests
    if (method === 'GET') {
      // Get single job by ID
      const jobId = reqUrl.searchParams.get('id');
      if (jobId) {
        const job = await redisGet(keys.job(jobId));
        if (!job) {
          return jsonResponse({ success: false, error: 'Job not found' }, { status: 404 });
        }
        return jsonResponse({ success: true, job });
      }

      // Get saved jobs
      const saved = reqUrl.searchParams.get('saved');
      const userId = reqUrl.searchParams.get('userId');
      if (saved === 'true' && userId) {
        const savedData = await redisSmembers(keys.savedJobs(userId));
        const savedJobs = [];

        for (const data of savedData) {
          try {
            const savedInfo = JSON.parse(data);
            const job = await redisGet(keys.job(savedInfo.jobId));
            savedJobs.push({ ...savedInfo, job });
          } catch {
            // Skip invalid
          }
        }

        // Sort by savedAt desc
        savedJobs.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));

        return jsonResponse({ success: true, savedJobs });
      }

      // Search jobs
      const filters = {
        q: reqUrl.searchParams.get('q') || undefined,
        location: reqUrl.searchParams.get('location') || undefined,
        employmentType: reqUrl.searchParams.get('type') || undefined,
        experienceLevel: reqUrl.searchParams.get('level') || undefined,
        salaryMin: reqUrl.searchParams.get('salaryMin') ? parseInt(reqUrl.searchParams.get('salaryMin'), 10) : undefined,
        salaryMax: reqUrl.searchParams.get('salaryMax') ? parseInt(reqUrl.searchParams.get('salaryMax'), 10) : undefined,
        techStack: reqUrl.searchParams.get('tech') ? reqUrl.searchParams.get('tech').split(',') : undefined,
        company: reqUrl.searchParams.get('company') || undefined,
        sortBy: reqUrl.searchParams.get('sortBy') || 'postedAt',
        sortOrder: reqUrl.searchParams.get('sortOrder') || 'desc',
        offset: reqUrl.searchParams.get('offset') ? parseInt(reqUrl.searchParams.get('offset'), 10) : 0,
        limit: reqUrl.searchParams.get('limit') ? parseInt(reqUrl.searchParams.get('limit'), 10) : 20,
      };

      // Get all jobs
      const allJobIds = await redisSmembers(keys.jobList());
      let jobs = [];

      for (const id of allJobIds) {
        const job = await redisGet(keys.job(id));
        if (job && job.isActive) {
          jobs.push(job);
        }
      }

      // Apply filters
      if (filters.q) {
        const q = filters.q.toLowerCase();
        jobs = jobs.filter(
          (j) =>
            j.title.toLowerCase().includes(q) ||
            j.company.toLowerCase().includes(q) ||
            (j.description && j.description.toLowerCase().includes(q))
        );
      }

      if (filters.location) {
        jobs = jobs.filter((j) => j.location === filters.location);
      }

      if (filters.employmentType) {
        jobs = jobs.filter((j) => j.employmentType === filters.employmentType);
      }

      if (filters.experienceLevel) {
        jobs = jobs.filter((j) => j.experienceLevel === filters.experienceLevel);
      }

      if (filters.salaryMin) {
        jobs = jobs.filter((j) => j.salaryRange && j.salaryRange.max >= filters.salaryMin);
      }

      if (filters.salaryMax) {
        jobs = jobs.filter((j) => j.salaryRange && j.salaryRange.min <= filters.salaryMax);
      }

      if (filters.techStack && filters.techStack.length > 0) {
        const techLower = filters.techStack.map((t) => t.toLowerCase());
        jobs = jobs.filter((j) =>
          j.techStack && j.techStack.some((t) => techLower.includes(t.toLowerCase()))
        );
      }

      if (filters.company) {
        const companyLower = filters.company.toLowerCase();
        jobs = jobs.filter((j) => j.company.toLowerCase().includes(companyLower));
      }

      // Sort
      jobs.sort((a, b) => {
        let cmp = 0;
        if (filters.sortBy === 'postedAt') {
          cmp = new Date(a.postedAt) - new Date(b.postedAt);
        } else if (filters.sortBy === 'salary') {
          const salaryA = a.salaryRange?.max || 0;
          const salaryB = b.salaryRange?.max || 0;
          cmp = salaryA - salaryB;
        }
        return filters.sortOrder === 'desc' ? -cmp : cmp;
      });

      const total = jobs.length;

      // Pagination
      jobs = jobs.slice(filters.offset, filters.offset + filters.limit);

      return jsonResponse({ success: true, jobs, total, filters });
    }

    return jsonResponse({ success: false, error: 'Method not allowed' }, { status: 405 });
  } catch (e) {
    console.error('[jobs API] Error:', e);
    return jsonResponse({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

export default withCors(handler);

export const config = {
  runtime: 'edge',
};
