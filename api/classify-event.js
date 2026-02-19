import { getCachedJson, setCachedJson, hashString } from './_upstash-cache.js';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { getAi4uApiKey, getAi4uModel, postAi4u } from './_ai4u.js';

export const config = {
  runtime: 'edge',
};

const MODEL = getAi4uModel('AI4U_CLASSIFY_MODEL', 'gemini-3-flash');
const CACHE_TTL_SECONDS = 86400;
const CACHE_VERSION = 'v1';

const VALID_LEVELS = ['critical', 'high', 'medium', 'low', 'info'];
const VALID_CATEGORIES = [
  'conflict', 'protest', 'disaster', 'diplomatic', 'economic',
  'terrorism', 'cyber', 'health', 'environmental', 'military',
  'crime', 'infrastructure', 'tech', 'general',
];

export default async function handler(request) {
  const corsHeaders = getCorsHeaders(request, 'GET, OPTIONS');

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'GET') {
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
    return new Response(JSON.stringify({ fallback: true, skipped: true, reason: 'AI4U_API_KEY not configured' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const title = url.searchParams.get('title');
  const variant = url.searchParams.get('variant') || 'full';

  if (!title) {
    return new Response(JSON.stringify({ error: 'title param required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const cacheKey = `classify:${CACHE_VERSION}:${hashString(title.toLowerCase() + ':' + variant)}`;

  try {
    const cached = await getCachedJson(cacheKey);
    if (cached && typeof cached === 'object' && cached.level) {
      return new Response(JSON.stringify({
        level: cached.level,
        category: cached.category,
        confidence: 0.9,
        source: 'llm',
        cached: true,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const isTech = variant === 'tech';
    const systemPrompt = `You classify news headlines into threat level and category. Return ONLY valid JSON, no other text.

Levels: critical, high, medium, low, info
Categories: conflict, protest, disaster, diplomatic, economic, terrorism, cyber, health, environmental, military, crime, infrastructure, tech, general

${isTech ? 'Focus: technology, startups, AI, cybersecurity. Most tech news is "low" or "info" unless it involves outages, breaches, or major disruptions.' : 'Focus: geopolitical events, conflicts, disasters, diplomacy. Classify by real-world severity and impact.'}

Return: {"level":"...","category":"..."}`;

    const response = await postAi4u('/chat/completions', apiKey, {
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: title },
        ],
        temperature: 0,
        max_tokens: 50,
    });

    if (!response.ok) {
      console.error('[Classify] AI4U error:', response.status);
      return new Response(JSON.stringify({ fallback: true }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) {
      return new Response(JSON.stringify({ fallback: true }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('[Classify] Invalid JSON from LLM:', raw);
      return new Response(JSON.stringify({ fallback: true }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const level = VALID_LEVELS.includes(parsed.level) ? parsed.level : null;
    const category = VALID_CATEGORIES.includes(parsed.category) ? parsed.category : null;
    if (!level || !category) {
      return new Response(JSON.stringify({ fallback: true }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    await setCachedJson(cacheKey, { level, category, timestamp: Date.now() }, CACHE_TTL_SECONDS);

    return new Response(JSON.stringify({
      level,
      category,
      confidence: 0.9,
      source: 'llm',
      cached: false,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=600',
      },
    });

  } catch (error) {
    console.error('[Classify] Error:', error.message);
    return new Response(JSON.stringify({ fallback: true }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
