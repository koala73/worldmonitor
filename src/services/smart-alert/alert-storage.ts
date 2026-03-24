/**
 * Alert Storage Service
 *
 * Handles CRUD operations for Smart Alerts using Upstash Redis.
 * Storage schema:
 * - alerts:{userId}:list -> Set of alert IDs
 * - alerts:{userId}:{alertId} -> Alert JSON
 * - alerts:users:{userId} -> User profile JSON
 * - alerts:notifications:{alertId}:last -> Last notification timestamp
 */

import type {
  SmartAlert,
  AlertUserProfile,
  CreateAlertRequest,
} from '@/types/smart-alert';

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

  // Check for environment variables
  const url = typeof process !== 'undefined' ? process.env?.UPSTASH_REDIS_REST_URL : undefined;
  const token = typeof process !== 'undefined' ? process.env?.UPSTASH_REDIS_REST_TOKEN : undefined;

  if (!url || !token) {
    console.warn('[AlertStorage] Redis not configured, using mock storage');
    return null;
  }

  try {
    const { Redis } = await import('@upstash/redis');
    redisClient = new Redis({ url, token }) as unknown as typeof redisClient;
    return redisClient;
  } catch (e) {
    console.error('[AlertStorage] Failed to initialize Redis:', e);
    return null;
  }
}

/**
 * Generate a unique alert ID
 */
function generateAlertId(): string {
  return `alert_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Generate a unique user ID (for anonymous users)
 */
export function generateUserId(): string {
  return `user_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Storage key helpers
 */
const keys = {
  alertList: (userId: string) => `alerts:${userId}:list`,
  alert: (userId: string, alertId: string) => `alerts:${userId}:${alertId}`,
  userProfile: (userId: string) => `alerts:users:${userId}`,
  lastNotification: (alertId: string) => `alerts:notifications:${alertId}:last`,
};

/**
 * Alert Storage class for managing alerts in Redis
 */
export class AlertStorage {
  /**
   * Create a new alert
   */
  async createAlert(userId: string, request: CreateAlertRequest): Promise<SmartAlert | null> {
    const redis = await getRedis();
    if (!redis) return null;

    // Validate keyword
    const keyword = request.keyword.trim();
    if (keyword.length < 2 || keyword.length > 100) {
      throw new Error('Keyword must be between 2 and 100 characters');
    }

    // Check alert limit
    const count = await redis.scard(keys.alertList(userId));
    if (count >= 20) {
      throw new Error('Maximum 20 alerts per user');
    }

    // Check for duplicate keyword
    const existingAlerts = await this.listAlerts(userId);
    const duplicate = existingAlerts.find(
      (a) => a.keyword.toLowerCase() === keyword.toLowerCase()
    );
    if (duplicate) {
      throw new Error('Alert with this keyword already exists');
    }

    const alertId = generateAlertId();
    const now = new Date().toISOString();

    const alert: SmartAlert = {
      id: alertId,
      userId,
      keyword,
      priorityFilter: request.priorityFilter || ['CRITICAL', 'HIGH', 'NORMAL'],
      channels: request.channels || ['email'],
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    // Save alert
    await redis.set(keys.alert(userId, alertId), JSON.stringify(alert));
    await redis.sadd(keys.alertList(userId), alertId);

    // Update user profile if email/telegram provided
    if (request.email || request.telegramChatId) {
      await this.updateUserProfile(userId, {
        userId,
        email: request.email,
        telegramChatId: request.telegramChatId,
        preferences: { digestMode: false },
      });
    }

    return alert;
  }

  /**
   * Get a single alert by ID
   */
  async getAlert(userId: string, alertId: string): Promise<SmartAlert | null> {
    const redis = await getRedis();
    if (!redis) return null;

    const data = await redis.get(keys.alert(userId, alertId));
    if (!data) return null;

    try {
      return JSON.parse(data) as SmartAlert;
    } catch {
      return null;
    }
  }

  /**
   * List all alerts for a user
   */
  async listAlerts(userId: string): Promise<SmartAlert[]> {
    const redis = await getRedis();
    if (!redis) return [];

    const alertIds = await redis.smembers(keys.alertList(userId));
    if (!alertIds.length) return [];

    const alerts: SmartAlert[] = [];
    for (const alertId of alertIds) {
      const alert = await this.getAlert(userId, alertId);
      if (alert) alerts.push(alert);
    }

    return alerts.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  /**
   * Update an existing alert
   */
  async updateAlert(
    userId: string,
    alertId: string,
    updates: Partial<Pick<SmartAlert, 'keyword' | 'priorityFilter' | 'channels' | 'isActive'>>
  ): Promise<SmartAlert | null> {
    const redis = await getRedis();
    if (!redis) return null;

    const existing = await this.getAlert(userId, alertId);
    if (!existing) return null;

    const updated: SmartAlert = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    await redis.set(keys.alert(userId, alertId), JSON.stringify(updated));
    return updated;
  }

  /**
   * Delete an alert
   */
  async deleteAlert(userId: string, alertId: string): Promise<boolean> {
    const redis = await getRedis();
    if (!redis) return false;

    await redis.del(keys.alert(userId, alertId));
    await redis.srem(keys.alertList(userId), alertId);
    return true;
  }

  /**
   * Get user profile
   */
  async getUserProfile(userId: string): Promise<AlertUserProfile | null> {
    const redis = await getRedis();
    if (!redis) return null;

    const data = await redis.get(keys.userProfile(userId));
    if (!data) return null;

    try {
      return JSON.parse(data) as AlertUserProfile;
    } catch {
      return null;
    }
  }

  /**
   * Update user profile
   */
  async updateUserProfile(userId: string, profile: Partial<AlertUserProfile>): Promise<AlertUserProfile> {
    const redis = await getRedis();
    if (!redis) {
      return { userId, preferences: { digestMode: false }, ...profile } as AlertUserProfile;
    }

    const existing = await this.getUserProfile(userId);
    const updated: AlertUserProfile = {
      userId,
      preferences: { digestMode: false },
      ...existing,
      ...profile,
    };

    await redis.set(keys.userProfile(userId), JSON.stringify(updated));
    return updated;
  }

  /**
   * Get all active alerts (for matching service)
   * Note: In production, this should be paginated or use a different data structure
   */
  async getAllActiveAlerts(): Promise<Array<{ alert: SmartAlert; userProfile: AlertUserProfile | null }>> {
    // This is a simplified implementation
    // In production, you'd want to use Redis SCAN or a separate index
    console.warn('[AlertStorage] getAllActiveAlerts is not optimized for production');
    return [];
  }

  /**
   * Check if notification was recently sent (rate limiting)
   */
  async wasRecentlyNotified(alertId: string): Promise<boolean> {
    const redis = await getRedis();
    if (!redis) return false;

    const lastTs = await redis.get(keys.lastNotification(alertId));
    if (!lastTs) return false;

    const lastTime = parseInt(lastTs, 10);
    const hourAgo = Date.now() - 60 * 60 * 1000;

    return lastTime > hourAgo;
  }

  /**
   * Record notification sent (for rate limiting)
   */
  async recordNotificationSent(alertId: string): Promise<void> {
    const redis = await getRedis();
    if (!redis) return;

    await redis.set(keys.lastNotification(alertId), Date.now().toString(), { ex: 3600 });
  }
}

// Export singleton instance
export const alertStorage = new AlertStorage();
