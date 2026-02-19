/**
 * Astrai Intelligent Router Summarization Endpoint with Redis Caching
 * Routes to the optimal model/provider (OpenAI, Anthropic, Groq, etc.)
 * based on cost, latency, and task complexity.
 * Set ASTRAI_API_KEY to enable. Supports "auto" model selection.
 * Server-side Redis cache for cross-user deduplication
 */

import { getCachedJson, setCachedJson, hashString } from './_upstash-cache.js';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

export const config = {
  runtime: 'edge',
};

const ASTRAI_API_URL = 'https://astrai-compute.fly.dev/v1/chat/completions';
const MODEL = 'auto'; // Let Astrai pick the optimal model per request
const CACHE_TTL_SECONDS = 86400; // 24 hours

const CACHE_VERSION = 'v3';

function getCacheKey(headlines, mode, geoContext = '', variant = 'full', lang = 'en') {
  const sorted = headlines.slice(0, 8).sort().join('|');
  const geoHash = geoContext ? ':g' + hashString(geoContext).slice(0, 6) : '';
  const hash = hashString(`${mode}:${sorted}`);
  const normalizedVariant = typeof variant === 'string' && variant ? variant.toLowerCase() : 'full';
  const normalizedLang = typeof lang === 'string' && lang ? lang.toLowerCase() : 'en';

  if (mode === 'translate') {
    const targetLang = normalizedVariant || normalizedLang;
    return `summary:${CACHE_VERSION}:${mode}:${targetLang}:${hash}${geoHash}`;
  }

  return `summary:${CACHE_VERSION}:${mode}:${normalizedVariant}:${normalizedLang}:${hash}${geoHash}`;
}

// Deduplicate similar headlines (same story from different sources)
function deduplicateHeadlines(headlines) {
  const seen = new Set();
  const unique = [];

  for (const headline of headlines) {
    const normalized = headline.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const words = new Set(normalized.split(' ').filter(w => w.length >= 4));

    let isDuplicate = false;
    for (const seenWords of seen) {
      const intersection = [...words].filter(w => seenWords.has(w));
      const similarity = intersection.length / Math.min(words.size, seenWords.size);
      if (similarity > 0.6) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      seen.add(words);
      unique.push(headline);
    }
  }

  return unique;
}

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

  const apiKey = process.env.ASTRAI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ summary: null, fallback: true, skipped: true, reason: 'ASTRAI_API_KEY not configured' }), {
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

  try {
    const { headlines, mode = 'brief', geoContext = '', variant = 'full', lang = 'en' } = await request.json();

    if (!headlines || !Array.isArray(headlines) || headlines.length === 0) {
      return new Response(JSON.stringify({ error: 'Headlines array required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Check cache first (shared key format with Groq/OpenRouter endpoints)
    const cacheKey = getCacheKey(headlines, mode, geoContext, variant, lang);
    const cached = await getCachedJson(cacheKey);
    if (cached && typeof cached === 'object' && cached.summary) {
      console.log('[Astrai] Cache hit:', cacheKey);
      return new Response(JSON.stringify({
        summary: cached.summary,
        model: cached.model || MODEL,
        provider: 'cache',
        cached: true,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Deduplicate similar headlines (same story from multiple sources)
    const uniqueHeadlines = deduplicateHeadlines(headlines.slice(0, 8));
    const headlineText = uniqueHeadlines.map((h, i) => `${i + 1}. ${h}`).join('\n');

    let systemPrompt, userPrompt;

    const intelSection = geoContext ? `\n\n${geoContext}` : '';
    const isTechVariant = variant === 'tech';
    const dateContext = `Current date: ${new Date().toISOString().split('T')[0]}.${isTechVariant ? '' : ' Donald Trump is the current US President (second term, inaugurated Jan 2025).'}`;
    const langInstruction = lang && lang !== 'en' ? `\nIMPORTANT: Output the summary in ${lang.toUpperCase()} language.` : '';

    if (mode === 'brief') {
      if (isTechVariant) {
        systemPrompt = `${dateContext}\n\nSummarize the key tech/startup development in 2-3 sentences.\nRules:\n- Focus ONLY on technology, startups, AI, funding, product launches, or developer news\n- IGNORE political news, trade policy, tariffs, government actions unless directly about tech regulation\n- Lead with the company/product/technology name\n- Start directly: "OpenAI announced...", "A new $50M Series B...", "GitHub released..."\n- No bullet points, no meta-commentary${langInstruction}`;
      } else {
        systemPrompt = `${dateContext}\n\nSummarize the key development in 2-3 sentences.\nRules:\n- Lead with WHAT happened and WHERE - be specific\n- NEVER start with "Breaking news", "Good evening", "Tonight", or TV-style openings\n- Start directly with the subject: "Iran's regime...", "The US Treasury...", "Protests in..."\n- CRITICAL FOCAL POINTS are the main actors - mention them by name\n- If focal points show news + signals convergence, that's the lead\n- No bullet points, no meta-commentary${langInstruction}`;
      }
      userPrompt = `Summarize the top story:\n${headlineText}${intelSection}`;
    } else if (mode === 'analysis') {
      if (isTechVariant) {
        systemPrompt = `${dateContext}\n\nAnalyze the tech/startup trend in 2-3 sentences.\nRules:\n- Focus ONLY on technology implications: funding trends, AI developments, market shifts, product strategy\n- IGNORE political implications, trade wars, government unless directly about tech policy\n- Lead with the insight for tech industry\n- Connect to startup ecosystem, VC trends, or technical implications`;
      } else {
        systemPrompt = `${dateContext}\n\nProvide analysis in 2-3 sentences. Be direct and specific.\nRules:\n- Lead with the insight - what's significant and why\n- NEVER start with "Breaking news", "Tonight", "The key/dominant narrative is"\n- Start with substance: "Iran faces...", "The escalation in...", "Multiple signals suggest..."\n- CRITICAL FOCAL POINTS are your main actors - explain WHY they matter\n- If focal points show news-signal correlation, flag as escalation\n- Connect dots, be specific about implications`;
      }
      userPrompt = isTechVariant
        ? `What's the key tech trend or development?\n${headlineText}${intelSection}`
        : `What's the key pattern or risk?\n${headlineText}${intelSection}`;
    } else if (mode === 'translate') {
      const targetLang = variant;
      systemPrompt = `You are a professional news translator. Translate the following news headlines/summaries into ${targetLang}.\nRules:\n- Maintain the original tone and journalistic style.\n- Do NOT add any conversational filler.\n- Output ONLY the translated text.`;
      userPrompt = `Translate to ${targetLang}:\n${headlines[0]}`;
    } else {
      systemPrompt = isTechVariant
        ? `${dateContext}\n\nSynthesize tech news in 2 sentences. Focus on startups, AI, funding, products. Ignore politics unless directly about tech regulation.${langInstruction}`
        : `${dateContext}\n\nSynthesize in 2 sentences max. Lead with substance. NEVER start with "Breaking news" or "Tonight" - just state the insight directly. CRITICAL focal points with news-signal convergence are significant.${langInstruction}`;
      userPrompt = `Key takeaway:\n${headlineText}${intelSection}`;
    }

    const response = await fetch(ASTRAI_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        'X-Astrai-App': 'worldmonitor',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 150,
        strategy: 'cheapest', // Summarization is a lightweight task — optimize for cost
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Astrai] API error:', response.status, errorText);

      if (response.status === 429) {
        return new Response(JSON.stringify({ error: 'Rate limited', fallback: true }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ error: 'Astrai API error', fallback: true }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const data = await response.json();
    const summary = data.choices?.[0]?.message?.content?.trim();

    if (!summary) {
      return new Response(JSON.stringify({ error: 'Empty response', fallback: true }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const actualModel = data._astrai_meta?.model || data.model || MODEL;

    // Store in cache (shared with Groq/OpenRouter endpoints)
    await setCachedJson(cacheKey, {
      summary,
      model: actualModel,
      timestamp: Date.now(),
    }, CACHE_TTL_SECONDS);

    return new Response(JSON.stringify({
      summary,
      model: actualModel,
      provider: 'astrai',
      cached: false,
      tokens: data.usage?.total_tokens || 0,
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=1800, s-maxage=1800, stale-while-revalidate=300',
      },
    });

  } catch (error) {
    console.error('[Astrai] Error:', error.name, error.message, error.stack?.split('\n')[1]);
    return new Response(JSON.stringify({
      error: error.message,
      errorType: error.name,
      fallback: true
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
