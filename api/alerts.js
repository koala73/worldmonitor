/**
 * Smart Alert API
 *
 * CRUD operations for user alerts.
 * Uses Upstash REST API for Edge Function compatibility.
 *
 * Routes:
 * - GET /api/alerts?userId=xxx - List alerts for user
 * - POST /api/alerts - Create new alert
 * - PATCH /api/alerts?id=xxx&userId=xxx - Update alert
 * - DELETE /api/alerts?id=xxx&userId=xxx - Delete alert
 */

import { jsonResponse } from './_json-response.js';
import { withCors } from './_cors.js';

// Redis key helpers
const keys = {
  alertList: (userId) => `alerts:${userId}:list`,
  alert: (userId, alertId) => `alerts:${userId}:${alertId}`,
  userProfile: (userId) => `alerts:users:${userId}`,
};

// Generate unique IDs
function generateAlertId() {
  return `alert_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function generateUserId() {
  return `user_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

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

async function redisSet(key, value) {
  return redisCmd('set', key, JSON.stringify(value));
}

async function redisDel(key) {
  return redisCmd('del', key);
}

async function redisSadd(key, member) {
  return redisCmd('sadd', key, member);
}

async function redisSrem(key, member) {
  return redisCmd('srem', key, member);
}

async function redisSmembers(key) {
  const result = await redisCmd('smembers', key);
  return result || [];
}

async function redisScard(key) {
  const result = await redisCmd('scard', key);
  return parseInt(result, 10) || 0;
}

// Validate alert request
function validateCreateRequest(body) {
  if (!body.keyword || typeof body.keyword !== 'string') {
    return 'keyword is required';
  }
  const keyword = body.keyword.trim();
  if (keyword.length < 2) {
    return 'keyword must be at least 2 characters';
  }
  if (keyword.length > 100) {
    return 'keyword must be at most 100 characters';
  }
  return null;
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

  try {
    // GET - List alerts
    if (method === 'GET') {
      const userId = reqUrl.searchParams.get('userId');
      if (!userId) {
        return jsonResponse({ success: false, error: 'userId required' }, { status: 400 });
      }

      const alertIds = await redisSmembers(keys.alertList(userId));
      const alerts = [];

      for (const alertId of alertIds) {
        const data = await redisGet(keys.alert(userId, alertId));
        if (data) {
          alerts.push(data);
        }
      }

      // Sort by createdAt descending
      alerts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      return jsonResponse({ success: true, alerts });
    }

    // POST - Create alert
    if (method === 'POST') {
      const body = await request.json();
      const error = validateCreateRequest(body);
      if (error) {
        return jsonResponse({ success: false, error }, { status: 400 });
      }

      // Generate or use provided userId
      const userId = body.userId || generateUserId();
      const keyword = body.keyword.trim();

      // Check alert limit
      const count = await redisScard(keys.alertList(userId));
      if (count >= 20) {
        return jsonResponse({ success: false, error: 'Maximum 20 alerts per user' }, { status: 400 });
      }

      // Check for duplicate
      const existingIds = await redisSmembers(keys.alertList(userId));
      for (const id of existingIds) {
        const existing = await redisGet(keys.alert(userId, id));
        if (existing && existing.keyword.toLowerCase() === keyword.toLowerCase()) {
          return jsonResponse({ success: false, error: 'Alert with this keyword already exists' }, { status: 400 });
        }
      }

      const alertId = generateAlertId();
      const now = new Date().toISOString();

      const alert = {
        id: alertId,
        userId,
        keyword,
        priorityFilter: body.priorityFilter || ['CRITICAL', 'HIGH', 'NORMAL'],
        channels: body.channels || ['email'],
        isActive: true,
        createdAt: now,
        updatedAt: now,
      };

      await redisSet(keys.alert(userId, alertId), alert);
      await redisSadd(keys.alertList(userId), alertId);

      // Save user profile if email/telegram provided
      if (body.email || body.telegramChatId) {
        const existingProfile = await redisGet(keys.userProfile(userId)) || { userId, preferences: { digestMode: false } };

        if (body.email) existingProfile.email = body.email;
        if (body.telegramChatId) existingProfile.telegramChatId = body.telegramChatId;

        await redisSet(keys.userProfile(userId), existingProfile);
      }

      return jsonResponse({ success: true, alert, userId });
    }

    // PATCH - Update alert
    if (method === 'PATCH') {
      const alertId = reqUrl.searchParams.get('id');
      const userId = reqUrl.searchParams.get('userId');

      if (!alertId || !userId) {
        return jsonResponse({ success: false, error: 'id and userId required' }, { status: 400 });
      }

      const existing = await redisGet(keys.alert(userId, alertId));
      if (!existing) {
        return jsonResponse({ success: false, error: 'Alert not found' }, { status: 404 });
      }

      const body = await request.json();

      const updated = {
        ...existing,
        ...(body.keyword !== undefined && { keyword: body.keyword.trim() }),
        ...(body.priorityFilter !== undefined && { priorityFilter: body.priorityFilter }),
        ...(body.channels !== undefined && { channels: body.channels }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
        updatedAt: new Date().toISOString(),
      };

      await redisSet(keys.alert(userId, alertId), updated);

      return jsonResponse({ success: true, alert: updated });
    }

    // DELETE - Delete alert
    if (method === 'DELETE') {
      const alertId = reqUrl.searchParams.get('id');
      const userId = reqUrl.searchParams.get('userId');

      if (!alertId || !userId) {
        return jsonResponse({ success: false, error: 'id and userId required' }, { status: 400 });
      }

      await redisDel(keys.alert(userId, alertId));
      await redisSrem(keys.alertList(userId), alertId);

      return jsonResponse({ success: true });
    }

    return jsonResponse({ success: false, error: 'Method not allowed' }, { status: 405 });
  } catch (e) {
    console.error('[alerts API] Error:', e);
    return jsonResponse({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

export default withCors(handler);

export const config = {
  runtime: 'edge',
};
