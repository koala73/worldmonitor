/**
 * Shared Summarization Handler Factory
 *
 * All LLM summarization endpoints (Groq, OpenRouter, Ollama) share identical
 * logic for CORS, validation, caching, prompt building, and response shaping.
 * This module extracts that shared pipeline behind a provider-config interface.
 *
 * Each endpoint file becomes a thin wrapper:
 *   export default createSummarizeHandler({ name, getCredentials });
 */

import { getCachedJson, setCachedJson, hashString } from './_upstash-cache.js';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

const CACHE_TTL_SECONDS = 86400; // 24 hours
const CACHE_VERSION = 'v3';

// ── Shared helpers ──

export function getCacheKey(headlines, mode, geoContext = '', variant = 'full', lang = 'en') {
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

export function deduplicateHeadlines(headlines) {
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

// ── Prompt builder (shared across all providers) ──

function buildPrompts(headlines, uniqueHeadlines, { mode, geoContext, variant, lang }) {
  const headlineText = uniqueHeadlines.map((h, i) => `${i + 1}. ${h}`).join('\n');
  const intelSection = geoContext ? `\n\n${geoContext}` : '';
  const isTechVariant = variant === 'tech';
  const dateContext = `Current date: ${new Date().toISOString().split('T')[0]}.${isTechVariant ? '' : ' Donald Trump is the current US President (second term, inaugurated Jan 2025).'}`;
  const langInstruction = lang && lang !== 'en' ? `\nIMPORTANT: Output the summary in ${lang.toUpperCase()} language.` : '';

  let systemPrompt, userPrompt;

  if (mode === 'brief') {
    if (isTechVariant) {
      systemPrompt = `${dateContext}

Summarize the key tech/startup development in 2-3 sentences.
Rules:
- Focus ONLY on technology, startups, AI, funding, product launches, or developer news
- IGNORE political news, trade policy, tariffs, government actions unless directly about tech regulation
- Lead with the company/product/technology name
- Start directly: "OpenAI announced...", "A new $50M Series B...", "GitHub released..."
- No bullet points, no meta-commentary${langInstruction}`;
    } else {
      systemPrompt = `${dateContext}

Summarize the key development in 2-3 sentences.
Rules:
- Lead with WHAT happened and WHERE - be specific
- NEVER start with "Breaking news", "Good evening", "Tonight", or TV-style openings
- Start directly with the subject: "Iran's regime...", "The US Treasury...", "Protests in..."
- CRITICAL FOCAL POINTS are the main actors - mention them by name
- If focal points show news + signals convergence, that's the lead
- No bullet points, no meta-commentary${langInstruction}`;
    }
    userPrompt = `Summarize the top story:\n${headlineText}${intelSection}`;
  } else if (mode === 'analysis') {
    if (isTechVariant) {
      systemPrompt = `${dateContext}

Analyze the tech/startup trend in 2-3 sentences.
Rules:
- Focus ONLY on technology implications: funding trends, AI developments, market shifts, product strategy
- IGNORE political implications, trade wars, government unless directly about tech policy
- Lead with the insight for tech industry
- Connect to startup ecosystem, VC trends, or technical implications`;
    } else {
      systemPrompt = `${dateContext}

Provide analysis in 2-3 sentences. Be direct and specific.
Rules:
- Lead with the insight - what's significant and why
- NEVER start with "Breaking news", "Tonight", "The key/dominant narrative is"
- Start with substance: "Iran faces...", "The escalation in...", "Multiple signals suggest..."
- CRITICAL FOCAL POINTS are your main actors - explain WHY they matter
- If focal points show news-signal correlation, flag as escalation
- Connect dots, be specific about implications`;
    }
    userPrompt = isTechVariant
      ? `What's the key tech trend or development?\n${headlineText}${intelSection}`
      : `What's the key pattern or risk?\n${headlineText}${intelSection}`;
  } else if (mode === 'translate') {
    const targetLang = variant;
    systemPrompt = `You are a professional news translator. Translate the following news headlines/summaries into ${targetLang}.
Rules:
- Maintain the original tone and journalistic style.
- Do NOT add any conversational filler (e.g., "Here is the translation").
- Output ONLY the translated text.
- If the text is already in ${targetLang}, return it as is.`;
    userPrompt = `Translate to ${targetLang}:\n${headlines[0]}`;
  } else {
    systemPrompt = isTechVariant
      ? `${dateContext}\n\nSynthesize tech news in 2 sentences. Focus on startups, AI, funding, products. Ignore politics unless directly about tech regulation.${langInstruction}`
      : `${dateContext}\n\nSynthesize in 2 sentences max. Lead with substance. NEVER start with "Breaking news" or "Tonight" - just state the insight directly. CRITICAL focal points with news-signal convergence are significant.${langInstruction}`;
    userPrompt = `Key takeaway:\n${headlineText}${intelSection}`;
  }

  return { systemPrompt, userPrompt };
}

// ── Handler factory ──

/**
 * @typedef {Object} ProviderCredentials
 * @property {string} apiUrl      - Full chat-completions endpoint URL
 * @property {string} model       - Model identifier
 * @property {Record<string, string>} headers - Request headers (incl. auth)
 * @property {Record<string, unknown>} [extraBody] - Extra request body fields (e.g. think: false)
 *
 * @typedef {Object} ProviderConfig
 * @property {string} name        - Provider label in responses (e.g. 'groq')
 * @property {string} logTag      - Console log prefix (e.g. '[Groq]')
 * @property {() => ProviderCredentials | null} getCredentials
 *                                - Returns credentials or null to skip
 * @property {string} skipReason  - Reason string when getCredentials returns null
 */

/**
 * Creates a Vercel edge handler for an LLM summarization provider.
 * @param {ProviderConfig} providerConfig
 * @returns {(request: Request) => Promise<Response>}
 */
export function createSummarizeHandler(providerConfig) {
  const { name, logTag, getCredentials, skipReason } = providerConfig;

  return async function handler(request) {
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

    const credentials = getCredentials();
    if (!credentials) {
      return new Response(JSON.stringify({ summary: null, fallback: true, skipped: true, reason: skipReason }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { apiUrl, model, headers: providerHeaders, extraBody } = credentials;

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

      // Check cache first (shared across all providers)
      const cacheKey = getCacheKey(headlines, mode, geoContext, variant, lang);
      const cached = await getCachedJson(cacheKey);
      if (cached && typeof cached === 'object' && cached.summary) {
        console.log(`${logTag} Cache hit:`, cacheKey);
        return new Response(JSON.stringify({
          summary: cached.summary,
          model: cached.model || model,
          provider: 'cache',
          cached: true,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Deduplicate similar headlines
      const uniqueHeadlines = deduplicateHeadlines(headlines.slice(0, 8));
      const { systemPrompt, userPrompt } = buildPrompts(headlines, uniqueHeadlines, { mode, geoContext, variant, lang });

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: providerHeaders,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.3,
          max_tokens: 150,
          top_p: 0.9,
          ...extraBody,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`${logTag} API error:`, response.status, errorText);

        if (response.status === 429) {
          return new Response(JSON.stringify({ error: 'Rate limited', fallback: true }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const displayName = logTag.replace(/[[\]]/g, '');
        return new Response(JSON.stringify({ error: `${displayName} API error`, fallback: true }), {
          status: response.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const data = await response.json();
      const message = data.choices?.[0]?.message;
      let rawContent = (typeof message?.content === 'string' ? message.content.trim() : '')
        || (typeof message?.reasoning === 'string' ? message.reasoning.trim() : '');

      // Strip <think>...</think> reasoning tokens (common in DeepSeek-R1, QwQ, etc.)
      rawContent = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

      // Some models output unterminated <think> blocks — strip from <think> to end if no closing tag
      if (rawContent.includes('<think>') && !rawContent.includes('</think>')) {
        rawContent = rawContent.replace(/<think>[\s\S]*/gi, '').trim();
      }

      const summary = rawContent;

      if (!summary) {
        return new Response(JSON.stringify({ error: 'Empty response', fallback: true }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Store in cache (shared across all providers)
      await setCachedJson(cacheKey, {
        summary,
        model,
        timestamp: Date.now(),
      }, CACHE_TTL_SECONDS);

      return new Response(JSON.stringify({
        summary,
        model,
        provider: name,
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
      console.error(`${logTag} Error:`, error.name, error.message, error.stack?.split('\n')[1]);
      return new Response(JSON.stringify({
        error: error.message,
        errorType: error.name,
        fallback: true
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  };
}
