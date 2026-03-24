/**
 * Job Matcher Service
 *
 * Matches job listings to user preferences for alerts.
 * Extracts tech stack from job descriptions.
 */

import type { Job, ExperienceLevel, EmploymentType } from '@/types/job';
import { TECH_STACK_KEYWORDS } from '@/types/job';

/**
 * Extract tech stack keywords from text
 */
export function extractTechStack(text: string): string[] {
  const found: string[] = [];
  const lowerText = text.toLowerCase();

  for (const tech of TECH_STACK_KEYWORDS) {
    // Match whole words only (with some flexibility for variations)
    const pattern = new RegExp(`\\b${tech.toLowerCase().replace(/[.+]/g, '\\$&')}\\b`, 'i');
    if (pattern.test(lowerText)) {
      found.push(tech);
    }
  }

  return [...new Set(found)]; // Remove duplicates
}

/**
 * Infer experience level from title/description
 */
export function inferExperienceLevel(title: string, description: string): ExperienceLevel {
  const text = `${title} ${description}`.toLowerCase();

  if (
    text.includes('lead') ||
    text.includes('principal') ||
    text.includes('staff') ||
    text.includes('architect')
  ) {
    return 'Lead';
  }

  if (
    text.includes('senior') ||
    text.includes('sr.') ||
    text.includes('sr ') ||
    text.includes('5+ years') ||
    text.includes('5 years')
  ) {
    return 'Senior';
  }

  if (
    text.includes('junior') ||
    text.includes('entry') ||
    text.includes('graduate') ||
    text.includes('intern') ||
    text.includes('0-2 years') ||
    text.includes('1-2 years')
  ) {
    return 'Entry';
  }

  return 'Mid';
}

/**
 * Infer employment type from text
 */
export function inferEmploymentType(text: string): EmploymentType {
  const lower = text.toLowerCase();

  if (lower.includes('contract') || lower.includes('contractor')) {
    return 'Contract';
  }

  if (lower.includes('part-time') || lower.includes('part time')) {
    return 'Part-time';
  }

  if (lower.includes('internship') || lower.includes('intern')) {
    return 'Internship';
  }

  return 'Full-time';
}

/**
 * Parse salary from text
 */
export function parseSalary(text: string): { min: number; max: number; currency: 'EUR' } | null {
  // Match patterns like "€60,000 - €80,000" or "60k-80k" or "€70,000"
  const patterns = [
    /€(\d{1,3}(?:,\d{3})*|\d+k?)\s*[-–]\s*€?(\d{1,3}(?:,\d{3})*|\d+k?)/i,
    /(\d{1,3}(?:,\d{3})*|\d+k?)\s*[-–]\s*(\d{1,3}(?:,\d{3})*|\d+k?)\s*(?:EUR|euro|€)/i,
    /€(\d{1,3}(?:,\d{3})*|\d+k?)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const parseNum = (s: string): number => {
        const cleaned = s.replace(/,/g, '').toLowerCase();
        if (cleaned.endsWith('k')) {
          return parseInt(cleaned, 10) * 1000;
        }
        return parseInt(cleaned, 10);
      };

      if (match[2] && match[1]) {
        return { min: parseNum(match[1]), max: parseNum(match[2]), currency: 'EUR' };
      } else if (match[1]) {
        const val = parseNum(match[1]);
        return { min: val, max: val, currency: 'EUR' };
      }
    }
  }

  return null;
}

/**
 * Calculate relevance score for a job based on filters
 */
export function calculateRelevance(job: Job, query: string): number {
  let score = 0;
  const queryLower = query.toLowerCase();
  const titleLower = job.title.toLowerCase();
  const companyLower = job.company.toLowerCase();

  // Title match (highest weight)
  if (titleLower.includes(queryLower)) {
    score += 100;
  }

  // Company match
  if (companyLower.includes(queryLower)) {
    score += 50;
  }

  // Tech stack match
  for (const tech of job.techStack) {
    if (tech.toLowerCase().includes(queryLower)) {
      score += 30;
    }
  }

  // Description match
  if (job.description.toLowerCase().includes(queryLower)) {
    score += 10;
  }

  // Recency bonus (newer jobs score higher)
  const daysOld = (Date.now() - new Date(job.postedAt).getTime()) / (1000 * 60 * 60 * 24);
  score += Math.max(0, 20 - daysOld);

  // Salary disclosure bonus
  if (job.salaryRange) {
    score += 5;
  }

  return score;
}

/**
 * Job Matcher class
 */
export class JobMatcher {
  /**
   * Enrich a job listing with inferred data
   */
  enrichJob(job: Partial<Job>): Partial<Job> {
    const text = `${job.title || ''} ${job.description || ''}`;

    return {
      ...job,
      techStack: job.techStack?.length ? job.techStack : extractTechStack(text),
      experienceLevel: job.experienceLevel || inferExperienceLevel(job.title || '', job.description || ''),
      employmentType: job.employmentType || inferEmploymentType(text),
      salaryRange: job.salaryRange || parseSalary(text) || undefined,
    };
  }

  /**
   * Check if a job matches user preferences
   */
  matchesPreferences(
    job: Job,
    preferences: {
      techStack?: string[];
      locations?: string[];
      minSalary?: number;
      experienceLevels?: ExperienceLevel[];
    }
  ): boolean {
    // Tech stack match
    if (preferences.techStack && preferences.techStack.length > 0) {
      const jobTechLower = job.techStack.map((t) => t.toLowerCase());
      const hasMatch = preferences.techStack.some((t) =>
        jobTechLower.includes(t.toLowerCase())
      );
      if (!hasMatch) return false;
    }

    // Location match
    if (preferences.locations && preferences.locations.length > 0) {
      if (!preferences.locations.includes(job.location)) return false;
    }

    // Salary match
    if (preferences.minSalary && preferences.minSalary > 0) {
      if (!job.salaryRange || job.salaryRange.max < preferences.minSalary) {
        return false;
      }
    }

    // Experience level match
    if (preferences.experienceLevels && preferences.experienceLevels.length > 0) {
      if (!preferences.experienceLevels.includes(job.experienceLevel)) {
        return false;
      }
    }

    return true;
  }
}

// Export singleton instance
export const jobMatcher = new JobMatcher();
