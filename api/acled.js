// ACLED API proxy - keeps token server-side only
// Token is stored in ACLED_ACCESS_TOKEN (no VITE_ prefix)
export const config = { runtime: 'edge' };

// In-memory cache (edge function instance)
let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Rate limiting - track requests per IP
const rateLimits = new Map();
const RATE_LIMIT = 10; // requests per minute
const RATE_WINDOW = 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimits.get(ip);

  if (!record || now - record.windowStart > RATE_WINDOW) {
    rateLimits.set(ip, { count: 1, windowStart: now });
    return true;
  }

  if (record.count >= RATE_LIMIT) {
    return false;
  }

  record.count++;
  return true;
}

export default async function handler(req) {
  // Get client IP for rate limiting
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0] ||
             req.headers.get('x-real-ip') ||
             'unknown';

  // Check rate limit
  if (!checkRateLimit(ip)) {
    return Response.json({ error: 'Rate limited', data: [] }, {
      status: 429,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Retry-After': '60',
      },
    });
  }

  // Get token from server-side env (no VITE_ prefix)
  const token = process.env.ACLED_ACCESS_TOKEN;

  if (!token) {
    return Response.json({
      error: 'ACLED not configured',
      data: [],
      configured: false
    }, {
      status: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }

  // Check cache
  const now = Date.now();
  if (cache.data && now - cache.timestamp < CACHE_TTL) {
    return Response.json(cache.data, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
        'X-Cache': 'HIT',
      },
    });
  }

  try {
    // Calculate date range (last 30 days)
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const params = new URLSearchParams({
      event_type: 'Protests',
      event_date: `${startDate}|${endDate}`,
      event_date_where: 'BETWEEN',
      limit: '500',
      _format: 'json',
    });

    const response = await fetch(`https://acleddata.com/api/acled/read?${params}`, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return Response.json({
        error: `ACLED API error: ${response.status}`,
        details: text.substring(0, 200),
        data: [],
      }, {
        status: response.status,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }

    const rawData = await response.json();
    const events = rawData.data || [];

    // Return only needed fields to reduce payload and protect any sensitive data
    const sanitizedEvents = events.map(e => ({
      event_id_cnty: e.event_id_cnty,
      event_date: e.event_date,
      event_type: e.event_type,
      sub_event_type: e.sub_event_type,
      actor1: e.actor1,
      actor2: e.actor2,
      country: e.country,
      admin1: e.admin1,
      location: e.location,
      latitude: e.latitude,
      longitude: e.longitude,
      fatalities: e.fatalities,
      notes: e.notes?.substring(0, 500), // Truncate long notes
      source: e.source,
      tags: e.tags,
    }));

    const result = {
      success: true,
      count: sanitizedEvents.length,
      data: sanitizedEvents,
      cached_at: new Date().toISOString(),
    };

    // Update cache
    cache = { data: result, timestamp: now };

    return Response.json(result, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
        'X-Cache': 'MISS',
      },
    });
  } catch (error) {
    return Response.json({
      error: `Fetch failed: ${error.message}`,
      data: [],
    }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
}
