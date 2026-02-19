import { getCachedJson, setCachedJson, mget, hashString } from './_upstash-cache.js';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { getAi4uApiKey, getAi4uModel, postAi4u } from './_ai4u.js';

export const config = {
  runtime: 'edge',
};

const MODEL = getAi4uModel('AI4U_CLASSIFY_MODEL', 'gemini-3-flash');
const CACHE_TTL_SECONDS = 86400;
const CACHE_VERSION = 'v1';
const MAX_BATCH_SIZE = 20;

const VALID_LEVELS = ['critical', 'high', 'medium', 'low', 'info'];
const VALID_CATEGORIES = [
  'conflict', 'protest', 'disaster', 'diplomatic', 'economic',
  'terrorism', 'cyber', 'health', 'environmental', 'military',
  'crime', 'infrastructure', 'tech', 'general',
];

export default async function handler(request) {
  const corsHeaders = getCorsHeaders(request, 'POST, OPTIONS');

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (isDisallowedOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = getAi4uApiKey();
  if (!apiKey) {
    return new Response(JSON.stringify({ results: [], fallback: true, skipped: true, reason: 'AI4U_API_KEY not configured' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
  if (contentLength > 51200) {
    return new Response(JSON.stringify({ error: 'Payload too large' }), {
      status: 413,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { titles, variant = 'full' } = body;
  if (!Array.isArray(titles) || titles.length === 0) {
    return new Response(JSON.stringify({ error: 'titles array required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const batch = titles.slice(0, MAX_BATCH_SIZE);
  const results = new Array(batch.length).fill(null);
  const uncachedIndices = [];

  const cacheKeys = batch.map(
    (t) => `classify:${CACHE_VERSION}:${hashString(t.toLowerCase() + ':' + variant)}`
  );
  const cached = await mget(...cacheKeys);
  for (let i = 0; i < cached.length; i++) {
    const val = cached[i];
    if (val && typeof val === 'object' && val.level) {
      results[i] = { level: val.level, category: val.category, cached: true };
    } else {
      uncachedIndices.push(i);
    }
  }

  if (uncachedIndices.length === 0) {
    return new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=600' },
    });
  }

  const uncachedTitles = uncachedIndices.map((i) => batch[i]);
  const isTech = variant === 'tech';
  const numberedList = uncachedTitles.map((t, i) => `${i + 1}. ${t}`).join('\n');

  const systemPrompt = `You classify news headlines into threat level and category. Return ONLY a valid JSON array, no other text.

Levels: critical, high, medium, low, info
Categories: conflict, protest, disaster, diplomatic, economic, terrorism, cyber, health, environmental, military, crime, infrastructure, tech, general

${isTech ? 'Focus: technology, startups, AI, cybersecurity. Most tech news is "low" or "info" unless it involves outages, breaches, or major disruptions.' : 'Focus: geopolitical events, conflicts, disasters, diplomacy. Classify by real-world severity and impact.'}

Return a JSON array with one object per headline in order: [{"level":"...","category":"..."},...]`;

  try {
    const response = await postAi4u('/chat/completions', apiKey, {
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: numberedList },
        ],
        temperature: 0,
        max_tokens: uncachedTitles.length * 60,
    });

    if (!response.ok) {
      console.error('[ClassifyBatch] AI4U error:', response.status);
      return new Response(JSON.stringify({ results, fallback: true }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) {
      return new Response(JSON.stringify({ results, fallback: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { /* fall through */ }
      }
    }

    if (!Array.isArray(parsed)) {
      return new Response(JSON.stringify({ results, fallback: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const cacheWrites = [];
    for (let i = 0; i < uncachedIndices.length; i++) {
      const classification = parsed[i];
      if (!classification) continue;

      const level = VALID_LEVELS.includes(classification.level) ? classification.level : null;
      const category = VALID_CATEGORIES.includes(classification.category) ? classification.category : null;
      if (!level || !category) continue;

      const idx = uncachedIndices[i];
      results[idx] = { level, category, cached: false };

      const cacheKey = `classify:${CACHE_VERSION}:${hashString(batch[idx].toLowerCase() + ':' + variant)}`;
      cacheWrites.push(
        setCachedJson(cacheKey, { level, category, timestamp: Date.now() }, CACHE_TTL_SECONDS)
      );
    }

    if (cacheWrites.length > 0) {
      await Promise.allSettled(cacheWrites);
    }

    return new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=600' },
    });
  } catch (error) {
    console.error('[ClassifyBatch] Error:', error.message);
    return new Response(JSON.stringify({ results, fallback: true }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
