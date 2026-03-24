/**
 * Trends API
 *
 * Trend analysis data for Irish tech ecosystem dashboard.
 * V1 uses mock data with optional Redis caching.
 *
 * Routes:
 * - GET /api/trends/topics - Get trending topics
 * - GET /api/trends/funding - Get funding trends
 * - GET /api/trends/industry - Get industry distribution
 * - GET /api/trends/summary - Get trend summary
 */

import { jsonResponse } from './_json-response.js';
import { withCors } from './_cors.js';

// Constants
const VALID_PERIODS = [30, 90];
const DEFAULT_PERIOD = 30;
const DEFAULT_TOPICS = 10;
const MAX_TOPICS = 20;
const CACHE_TTL = 3600;

// Redis helpers
async function redisGet(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const cmdUrl = `${url}/get/${encodeURIComponent(key)}`;
  const resp = await fetch(cmdUrl, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3000),
  });
  if (!resp.ok) return null;

  const data = await resp.json();
  if (!data.result) return null;

  try {
    return JSON.parse(data.result);
  } catch {
    return null;
  }
}

async function redisSetEx(key, seconds, value) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;

  const cmdUrl = `${url}/setex/${encodeURIComponent(key)}/${seconds}/${encodeURIComponent(JSON.stringify(value))}`;
  await fetch(cmdUrl, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

// Helper functions
function formatCurrency(amount) {
  if (amount >= 1_000_000_000) return `€${(amount / 1_000_000_000).toFixed(1)}B`;
  if (amount >= 1_000_000) return `€${(amount / 1_000_000).toFixed(0)}M`;
  if (amount >= 1_000) return `€${(amount / 1_000).toFixed(0)}K`;
  return `€${amount}`;
}

function getDateRange(days) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  return {
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0],
  };
}

// Mock data generators
function generateTopics(days, limit) {
  const scale = days === 90 ? 3 : 1;
  const topics = [
    { keyword: 'AI', count: 145, change: 25 },
    { keyword: 'funding', count: 98, change: 12 },
    { keyword: 'Dublin', count: 87, change: 5 },
    { keyword: 'fintech', count: 76, change: 18 },
    { keyword: 'expansion', count: 65, change: -3 },
    { keyword: 'hiring', count: 58, change: 8 },
    { keyword: 'semiconductor', count: 52, change: 15 },
    { keyword: 'startup', count: 48, change: 2 },
    { keyword: 'cloud', count: 45, change: 10 },
    { keyword: 'acquisition', count: 42, change: -5 },
    { keyword: 'data center', count: 38, change: 20 },
    { keyword: 'EMEA', count: 35, change: 3 },
    { keyword: 'IPO', count: 28, change: -8 },
    { keyword: 'unicorn', count: 25, change: 5 },
    { keyword: 'Cork', count: 22, change: 12 },
  ];

  return topics.slice(0, limit).map((t) => ({
    ...t,
    count: t.count * scale,
  }));
}

function generateTimeline(days) {
  const timeline = [];
  const end = new Date();
  const interval = days === 30 ? 1 : 7;

  for (let i = days; i >= 0; i -= interval) {
    const date = new Date(end);
    date.setDate(date.getDate() - i);
    timeline.push({
      date: date.toISOString().split('T')[0],
      amount: Math.round(10_000_000 + Math.random() * 90_000_000),
      deals: Math.floor(1 + Math.random() * 4),
    });
  }

  return timeline;
}

function generateFunding(days) {
  const timeline = generateTimeline(days);
  const totalAmount = timeline.reduce((sum, d) => sum + d.amount, 0);
  const totalDeals = timeline.reduce((sum, d) => sum + d.deals, 0);

  return {
    total: formatCurrency(totalAmount),
    deals: totalDeals,
    averageDealSize: formatCurrency(totalAmount / totalDeals),
    timeline,
    weekOverWeek: Math.round(-10 + Math.random() * 30),
  };
}

function generateIndustries(days) {
  const scale = days === 90 ? 3 : 1;

  return [
    { name: 'Fintech', percentage: 28, newsCount: 120 * scale, fundingAmount: '€180M' },
    { name: 'AI/ML', percentage: 22, newsCount: 95 * scale, fundingAmount: '€150M' },
    { name: 'SaaS', percentage: 18, newsCount: 78 * scale, fundingAmount: '€80M' },
    { name: 'Cloud', percentage: 12, newsCount: 52 * scale, fundingAmount: '€45M' },
    { name: 'Semiconductor', percentage: 10, newsCount: 43 * scale, fundingAmount: '€120M' },
    { name: 'Healthcare', percentage: 6, newsCount: 26 * scale, fundingAmount: '€25M' },
    { name: 'Other', percentage: 4, newsCount: 17 * scale },
  ];
}

function generateSummary(days) {
  const topics = generateTopics(days, 1);
  const funding = generateFunding(days);
  const industries = generateIndustries(days);
  const range = getDateRange(days);
  const totalNews = industries.reduce((sum, i) => sum + i.newsCount, 0);

  return {
    totalNews,
    totalFunding: funding.total,
    topIndustry: industries[0].name,
    trendingTopic: topics[0].keyword,
    weekOverWeek: {
      news: Math.round(-5 + Math.random() * 20),
      funding: funding.weekOverWeek,
    },
    period: { start: range.start, end: range.end, days },
    updatedAt: new Date().toISOString(),
  };
}

// Handler
async function handler(request) {
  const reqUrl = new URL(request.url);
  const method = request.method;
  const pathParts = reqUrl.pathname.split('/').filter(Boolean);

  if (method !== 'GET') {
    return jsonResponse({ success: false, error: 'Method not allowed' }, { status: 405 });
  }

  // Parse period parameter
  let days = parseInt(reqUrl.searchParams.get('days') || String(DEFAULT_PERIOD), 10);
  if (!VALID_PERIODS.includes(days)) {
    days = DEFAULT_PERIOD;
  }

  const endpoint = pathParts[1] || '';

  try {
    // GET /api/trends/topics
    if (endpoint === 'topics') {
      let limit = parseInt(reqUrl.searchParams.get('limit') || String(DEFAULT_TOPICS), 10);
      if (limit > MAX_TOPICS) limit = MAX_TOPICS;

      // Try cache
      const cacheKey = `trends:topics:${days}:${limit}`;
      const cached = await redisGet(cacheKey);
      if (cached) {
        return jsonResponse({
          success: true,
          topics: cached,
          period: getDateRange(days),
          cached: true,
        });
      }

      const topics = generateTopics(days, limit);
      await redisSetEx(cacheKey, CACHE_TTL, topics);

      return jsonResponse({
        success: true,
        topics,
        period: getDateRange(days),
      });
    }

    // GET /api/trends/funding
    if (endpoint === 'funding') {
      const cacheKey = `trends:funding:${days}`;
      const cached = await redisGet(cacheKey);
      if (cached) {
        return jsonResponse({ success: true, funding: cached, cached: true });
      }

      const funding = generateFunding(days);
      await redisSetEx(cacheKey, CACHE_TTL, funding);

      return jsonResponse({ success: true, funding });
    }

    // GET /api/trends/industry
    if (endpoint === 'industry') {
      const cacheKey = `trends:industry:${days}`;
      const cached = await redisGet(cacheKey);
      if (cached) {
        return jsonResponse({ success: true, industries: cached, cached: true });
      }

      const industries = generateIndustries(days);
      await redisSetEx(cacheKey, CACHE_TTL, industries);

      return jsonResponse({ success: true, industries });
    }

    // GET /api/trends/summary
    if (endpoint === 'summary') {
      const cacheKey = `trends:summary:${days}`;
      const cached = await redisGet(cacheKey);
      if (cached) {
        return jsonResponse({ success: true, summary: cached, cached: true });
      }

      const summary = generateSummary(days);
      await redisSetEx(cacheKey, CACHE_TTL, summary);

      return jsonResponse({ success: true, summary });
    }

    // Default: return overview of available endpoints
    return jsonResponse({
      success: true,
      message: 'Trend API',
      endpoints: [
        '/api/trends/topics?days=30&limit=10',
        '/api/trends/funding?days=30',
        '/api/trends/industry?days=30',
        '/api/trends/summary?days=30',
      ],
      validPeriods: VALID_PERIODS,
    });
  } catch (e) {
    console.error('[trends API] Error:', e);
    return jsonResponse({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

export default withCors(handler);

export const config = {
  runtime: 'edge',
};
