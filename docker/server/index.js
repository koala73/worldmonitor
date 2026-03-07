const express = require('express');
const cors = require('cors');
const Redis = require('ioredis');

const app = express();
const PORT = process.env.PORT || 3001;

// ─────────────────────────────────────────
// Redis Connection
// ─────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379', {
  retryStrategy: (times) => Math.min(times * 50, 2000),
  maxRetriesPerRequest: 3,
});

redis.on('connect', () => console.log('✅ Redis connected'));
redis.on('error', (err) => console.error('❌ Redis error:', err.message));

// ─────────────────────────────────────────
// Circuit Breaker
// ─────────────────────────────────────────
const circuitBreakers = {};

function getCircuitBreaker(key) {
  if (!circuitBreakers[key]) {
    circuitBreakers[key] = { failures: 0, lastFailure: null, open: false };
  }
  return circuitBreakers[key];
}

function recordFailure(key) {
  const cb = getCircuitBreaker(key);
  cb.failures++;
  cb.lastFailure = Date.now();
  if (cb.failures >= 3) {
    cb.open = true;
    console.warn(`⚡ Circuit breaker OPEN for: ${key}`);
    setTimeout(() => {
      cb.open = false;
      cb.failures = 0;
      console.log(`✅ Circuit breaker RESET for: ${key}`);
    }, 5 * 60 * 1000); // 5 min pause
  }
}

function isCircuitOpen(key) {
  return getCircuitBreaker(key).open;
}

// ─────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────
// Helper: fetch with cache
// ─────────────────────────────────────────
async function fetchWithCache(cacheKey, ttl, fetchFn) {
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (e) {
    console.warn('Cache read failed:', e.message);
  }

  const data = await fetchFn();

  try {
    await redis.setex(cacheKey, ttl, JSON.stringify(data));
  } catch (e) {
    console.warn('Cache write failed:', e.message);
  }

  return data;
}

// ─────────────────────────────────────────
// Helper: safe fetch
// ─────────────────────────────────────────
async function safeFetch(url, options = {}) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

// ─────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Version
app.get('/api/version', (req, res) => {
  res.json({ version: '1.0.0', mode: 'self-hosted', redis: redis.status });
});

// Bootstrap - returns basic config
app.get('/api/bootstrap', (req, res) => {
  res.json({
    variant: process.env.VITE_VARIANT || 'full',
    selfHosted: true,
    features: {
      ai: !!process.env.GROQ_API_KEY,
      flights: !!(process.env.OPENSKY_USERNAME && process.env.OPENSKY_PASSWORD),
      ships: !!process.env.VESSELFINDER_API_KEY,
      fires: !!process.env.NASA_FIRMS_API_KEY,
      energy: !!process.env.EIA_API_KEY,
    }
  });
});

// ─────────────────────────────────────────
// RSS Proxy
// ─────────────────────────────────────────
app.get('/api/rss-proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url parameter required' });

  const key = 'rss-proxy';
  if (isCircuitOpen(key)) return res.status(503).json({ error: 'Service temporarily unavailable' });

  try {
    const { default: fetch } = await import('node-fetch');
    const response = await fetch(url, {
      headers: { 'User-Agent': 'WorldMonitor/1.0' },
      timeout: 10000
    });
    const text = await response.text();
    res.set('Content-Type', 'application/xml');
    res.send(text);
  } catch (err) {
    recordFailure(key);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// OpenSky - Flight Tracking
// ─────────────────────────────────────────
app.get('/api/opensky', async (req, res) => {
  if (!process.env.OPENSKY_USERNAME) {
    return res.status(503).json({ error: 'OpenSky credentials not configured' });
  }

  const key = 'opensky';
  if (isCircuitOpen(key)) return res.status(503).json({ error: 'Service temporarily unavailable' });

  try {
    const data = await fetchWithCache('opensky:states', 30, async () => {
      const auth = Buffer.from(`${process.env.OPENSKY_USERNAME}:${process.env.OPENSKY_PASSWORD}`).toString('base64');
      return safeFetch('https://opensky-network.org/api/states/all', {
        headers: { Authorization: `Basic ${auth}` }
      });
    });
    res.json(data);
  } catch (err) {
    recordFailure(key);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// EIA Energy Data
// ─────────────────────────────────────────
app.get('/api/eia/:series', async (req, res) => {
  if (!process.env.EIA_API_KEY) {
    return res.status(503).json({ error: 'EIA API key not configured' });
  }

  const key = 'eia';
  if (isCircuitOpen(key)) return res.status(503).json({ error: 'Service temporarily unavailable' });

  try {
    const { series } = req.params;
    const data = await fetchWithCache(`eia:${series}`, 3600, () =>
      safeFetch(`https://api.eia.gov/v2/${series}?api_key=${process.env.EIA_API_KEY}`)
    );
    res.json(data);
  } catch (err) {
    recordFailure(key);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// NASA FIRMS - Satellite Fire Detection
// ─────────────────────────────────────────
app.get('/api/firms', async (req, res) => {
  if (!process.env.NASA_FIRMS_API_KEY) {
    return res.status(503).json({ error: 'NASA FIRMS API key not configured' });
  }

  const key = 'firms';
  if (isCircuitOpen(key)) return res.status(503).json({ error: 'Service temporarily unavailable' });

  try {
    const data = await fetchWithCache('firms:viirs', 600, () =>
      safeFetch(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${process.env.NASA_FIRMS_API_KEY}/VIIRS_SNPP_NRT/world/1`)
    );
    res.json(data);
  } catch (err) {
    recordFailure(key);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// Groq AI - World Brief
// ─────────────────────────────────────────
app.post('/api/ai/brief', async (req, res) => {
  if (!process.env.GROQ_API_KEY) {
    return res.status(503).json({ error: 'Groq API key not configured' });
  }

  const key = 'groq';
  if (isCircuitOpen(key)) return res.status(503).json({ error: 'AI service temporarily unavailable' });

  try {
    const { headlines } = req.body;
    const cacheKey = `brief:${Buffer.from(headlines?.join('') || '').toString('base64').slice(0, 32)}`;

    const data = await fetchWithCache(cacheKey, 3600, () =>
      safeFetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [{
            role: 'user',
            content: `Summarize these global news headlines into a concise 3-paragraph intelligence brief:\n${headlines?.join('\n')}`
          }],
          temperature: 0,
          max_tokens: 500
        })
      })
    );
    res.json(data);
  } catch (err) {
    recordFailure(key);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// Geo lookup
// ─────────────────────────────────────────
app.get('/api/geo', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q parameter required' });

  try {
    const data = await fetchWithCache(`geo:${q}`, 86400, () =>
      safeFetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`, {
        headers: { 'User-Agent': 'WorldMonitor/1.0' }
      })
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// GPSJam - GPS Interference
// ─────────────────────────────────────────
app.get('/api/gpsjam', async (req, res) => {
  const key = 'gpsjam';
  if (isCircuitOpen(key)) return res.status(503).json({ error: 'Service temporarily unavailable' });

  try {
    const data = await fetchWithCache('gpsjam:latest', 300, () =>
      safeFetch('https://gpsjam.org/api/interference')
    );
    res.json(data);
  } catch (err) {
    recordFailure(key);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// Domain RPC Routes (21 routes)
// ─────────────────────────────────────────
const domains = [
  'market', 'military', 'maritime', 'aviation',
  'news', 'protests', 'earthquakes', 'weather',
  'outages', 'fires', 'sanctions', 'cyber',
  'nuclear', 'pipelines', 'cables', 'datacenters',
  'bases', 'conflicts', 'instability', 'signals', 'focal'
];

domains.forEach(domain => {
  app.get(`/api/${domain}`, async (req, res) => {
    const key = `domain:${domain}`;
    if (isCircuitOpen(key)) return res.status(503).json({ error: 'Service temporarily unavailable' });

    try {
      const cached = await redis.get(key);
      if (cached) return res.json(JSON.parse(cached));
      res.json({ domain, data: [], message: 'No data available - configure API keys in .env' });
    } catch (err) {
      recordFailure(key);
      res.status(500).json({ error: err.message });
    }
  });
});

// ─────────────────────────────────────────
// 404 Handler
// ─────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.path} not found` });
});

// ─────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🌍 World Monitor API running on port ${PORT}`);
  console.log(`📡 Redis: ${process.env.REDIS_URL || 'redis://redis:6379'}`);
  console.log(`🤖 AI: ${process.env.GROQ_API_KEY ? 'enabled' : 'disabled'}`);
  console.log(`✈️  Flights: ${process.env.OPENSKY_USERNAME ? 'enabled' : 'disabled'}`);
  console.log(`🚢 Ships: ${process.env.VESSELFINDER_API_KEY ? 'enabled' : 'disabled'}`);
});
