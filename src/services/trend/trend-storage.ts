/**
 * Trend Storage Service
 *
 * Handles caching of trend data in Redis.
 * Storage schema:
 * - trends:topics:{days} -> Topics JSON
 * - trends:funding:{days} -> Funding JSON
 * - trends:industry:{days} -> Industry JSON
 * - trends:summary:{days} -> Summary JSON
 */

import type {
  TrendTopic,
  FundingTrend,
  IndustryDistribution,
  TrendSummary,
  TrendPeriod,
} from '@/types/trend';
import { TREND_LIMITS } from '@/types/trend';

// Redis client (lazy initialization)
let redisClient: {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, options?: { ex?: number }) => Promise<void>;
} | null = null;

/**
 * Initialize Redis client
 */
async function getRedis() {
  if (redisClient) return redisClient;

  const url = typeof process !== 'undefined' ? process.env?.UPSTASH_REDIS_REST_URL : undefined;
  const token = typeof process !== 'undefined' ? process.env?.UPSTASH_REDIS_REST_TOKEN : undefined;

  if (!url || !token) {
    console.warn('[TrendStorage] Redis not configured');
    return null;
  }

  try {
    const { Redis } = await import('@upstash/redis');
    redisClient = new Redis({ url, token }) as unknown as typeof redisClient;
    return redisClient;
  } catch (e) {
    console.error('[TrendStorage] Failed to initialize Redis:', e);
    return null;
  }
}

/**
 * Storage key helpers
 */
const keys = {
  topics: (days: TrendPeriod) => `trends:topics:${days}`,
  funding: (days: TrendPeriod) => `trends:funding:${days}`,
  industry: (days: TrendPeriod) => `trends:industry:${days}`,
  summary: (days: TrendPeriod) => `trends:summary:${days}`,
};

/**
 * Trend Storage class
 */
export class TrendStorage {
  /**
   * Get cached topics
   */
  async getTopics(days: TrendPeriod): Promise<TrendTopic[] | null> {
    const redis = await getRedis();
    if (!redis) return null;

    const data = await redis.get(keys.topics(days));
    if (!data) return null;

    try {
      return JSON.parse(data) as TrendTopic[];
    } catch {
      return null;
    }
  }

  /**
   * Cache topics
   */
  async setTopics(days: TrendPeriod, topics: TrendTopic[]): Promise<void> {
    const redis = await getRedis();
    if (!redis) return;

    await redis.set(keys.topics(days), JSON.stringify(topics), {
      ex: TREND_LIMITS.CACHE_TTL_SECONDS,
    });
  }

  /**
   * Get cached funding trend
   */
  async getFunding(days: TrendPeriod): Promise<FundingTrend | null> {
    const redis = await getRedis();
    if (!redis) return null;

    const data = await redis.get(keys.funding(days));
    if (!data) return null;

    try {
      return JSON.parse(data) as FundingTrend;
    } catch {
      return null;
    }
  }

  /**
   * Cache funding trend
   */
  async setFunding(days: TrendPeriod, funding: FundingTrend): Promise<void> {
    const redis = await getRedis();
    if (!redis) return;

    await redis.set(keys.funding(days), JSON.stringify(funding), {
      ex: TREND_LIMITS.CACHE_TTL_SECONDS,
    });
  }

  /**
   * Get cached industry distribution
   */
  async getIndustry(days: TrendPeriod): Promise<IndustryDistribution[] | null> {
    const redis = await getRedis();
    if (!redis) return null;

    const data = await redis.get(keys.industry(days));
    if (!data) return null;

    try {
      return JSON.parse(data) as IndustryDistribution[];
    } catch {
      return null;
    }
  }

  /**
   * Cache industry distribution
   */
  async setIndustry(days: TrendPeriod, industries: IndustryDistribution[]): Promise<void> {
    const redis = await getRedis();
    if (!redis) return;

    await redis.set(keys.industry(days), JSON.stringify(industries), {
      ex: TREND_LIMITS.CACHE_TTL_SECONDS,
    });
  }

  /**
   * Get cached summary
   */
  async getSummary(days: TrendPeriod): Promise<TrendSummary | null> {
    const redis = await getRedis();
    if (!redis) return null;

    const data = await redis.get(keys.summary(days));
    if (!data) return null;

    try {
      return JSON.parse(data) as TrendSummary;
    } catch {
      return null;
    }
  }

  /**
   * Cache summary
   */
  async setSummary(days: TrendPeriod, summary: TrendSummary): Promise<void> {
    const redis = await getRedis();
    if (!redis) return;

    await redis.set(keys.summary(days), JSON.stringify(summary), {
      ex: TREND_LIMITS.CACHE_TTL_SECONDS,
    });
  }
}

// Export singleton
export const trendStorage = new TrendStorage();
