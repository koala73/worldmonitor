import type {
  ServerContext,
  SummarizeArticleRequest,
  SummarizeArticleResponse,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';

import { getCachedJson, setCachedJson } from '../../../_shared/redis';
import {
  CACHE_TTL_SECONDS,
  deduplicateHeadlines,
  buildArticlePrompts,
  getProviderCredentials,
  getCacheKey,
} from './_shared';
import { CHROME_UA } from '../../../_shared/constants';

// ======================================================================
// Reasoning preamble detection
// ======================================================================

export const TASK_NARRATION = /^(we need to|i need to|let me|i'll |i should|i will |the task is|the instructions|according to the rules|so we need to|okay[,.]\s*(i'll|let me|so|we need|the task|i should|i will)|sure[,.]\s*(i'll|let me|so|we need|the task|i should|i will|here))/i;
export const PROMPT_ECHO = /^(summarize the top story|summarize the key|rules:|here are the rules|the top story is likely)/i;

export function hasReasoningPreamble(text: string): boolean {
  const trimmed = text.trim();
  return TASK_NARRATION.test(trimmed) || PROMPT_ECHO.test(trimmed);
}

// ======================================================================
// SummarizeArticle: Multi-provider LLM summarization with Redis caching
// Ported from api/_summarize-handler.js
// ======================================================================

export async function summarizeArticle(
  _ctx: ServerContext,
  req: SummarizeArticleRequest,
): Promise<SummarizeArticleResponse> {
  const { provider, mode = 'brief', geoContext = '', variant = 'full', lang = 'en' } = req;

  // Input sanitization (M-14 fix): limit headline count and length
  const MAX_HEADLINES = 10;
  const MAX_HEADLINE_LEN = 500;
  const MAX_GEO_CONTEXT_LEN = 2000;
  const headlines = (req.headlines || [])
    .slice(0, MAX_HEADLINES)
    .map(h => typeof h === 'string' ? h.slice(0, MAX_HEADLINE_LEN) : '');
  const sanitizedGeoContext = typeof geoContext === 'string' ? geoContext.slice(0, MAX_GEO_CONTEXT_LEN) : '';

  // Provider credential check
  const skipReasons: Record<string, string> = {
    ollama: 'OLLAMA_API_URL not configured',
    groq: 'GROQ_API_KEY not configured',
    openrouter: 'OPENROUTER_API_KEY not configured',
  };

  const credentials = getProviderCredentials(provider);
  if (!credentials) {
    return {
      summary: '',
      model: '',
      provider: provider,
      cached: false,
      tokens: 0,
      fallback: true,
      skipped: true,
      reason: skipReasons[provider] || `Unknown provider: ${provider}`,
      error: '',
      errorType: '',
    };
  }

  const { apiUrl, model, headers: providerHeaders, extraBody } = credentials;

  // Request validation
  if (!headlines || !Array.isArray(headlines) || headlines.length === 0) {
    return {
      summary: '',
      model: '',
      provider: provider,
      cached: false,
      tokens: 0,
      fallback: false,
      skipped: false,
      reason: '',
      error: 'Headlines array required',
      errorType: 'ValidationError',
    };
  }

  try {
    // Check cache first (shared across all providers)
    const cacheKey = getCacheKey(headlines, mode, sanitizedGeoContext, variant, lang);
    const cached = await getCachedJson(cacheKey);
    if (cached && typeof cached === 'object' && (cached as any).summary) {
      const c = cached as { summary: string; model?: string };
      console.log(`[SummarizeArticle:${provider}] Cache hit:`, cacheKey);
      return {
        summary: c.summary,
        model: c.model || model,
        provider: 'cache',
        cached: true,
        tokens: 0,
        fallback: false,
        skipped: false,
        reason: '',
        error: '',
        errorType: '',
      };
    }

    // Deduplicate similar headlines
    const uniqueHeadlines = deduplicateHeadlines(headlines.slice(0, 8));
    const { systemPrompt, userPrompt } = buildArticlePrompts(headlines, uniqueHeadlines, {
      mode,
      geoContext: sanitizedGeoContext,
      variant,
      lang,
    });

    // LLM call
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { ...providerHeaders, 'User-Agent': CHROME_UA },
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
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[SummarizeArticle:${provider}] API error:`, response.status, errorText);

      if (response.status === 429) {
        return {
          summary: '',
          model: '',
          provider: provider,
          cached: false,
          tokens: 0,
          fallback: true,
          skipped: false,
          reason: '',
          error: 'Rate limited',
          errorType: '',
        };
      }

      return {
        summary: '',
        model: '',
        provider: provider,
        cached: false,
        tokens: 0,
        fallback: true,
        skipped: false,
        reason: '',
        error: `${provider} API error`,
        errorType: '',
      };
    }

    const data = await response.json() as any;
    const message = data.choices?.[0]?.message;
    let rawContent = typeof message?.content === 'string' ? message.content.trim() : '';

    // Strip thinking/reasoning tags from various model formats
    rawContent = rawContent
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, '')
      .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
      .replace(/<reflection>[\s\S]*?<\/reflection>/gi, '')
      .trim();

    // Strip unterminated thinking blocks (no closing tag)
    rawContent = rawContent
      .replace(/<think>[\s\S]*/gi, '')
      .replace(/<\|thinking\|>[\s\S]*/gi, '')
      .replace(/<reasoning>[\s\S]*/gi, '')
      .replace(/<reflection>[\s\S]*/gi, '')
      .trim();

    // Reject plain-text reasoning for summarization modes only
    if (['brief', 'analysis'].includes(mode) && hasReasoningPreamble(rawContent)) {
      console.warn(`[SummarizeArticle:${provider}] Reasoning preamble detected, rejecting`);
      rawContent = '';
    }

    const summary = rawContent;

    if (!summary) {
      return {
        summary: '',
        model: '',
        provider: provider,
        cached: false,
        tokens: 0,
        fallback: true,
        skipped: false,
        reason: '',
        error: 'Empty response',
        errorType: '',
      };
    }

    // Store in cache (shared across all providers)
    await setCachedJson(cacheKey, {
      summary,
      model,
      timestamp: Date.now(),
    }, CACHE_TTL_SECONDS);

    return {
      summary,
      model,
      provider: provider,
      cached: false,
      tokens: data.usage?.total_tokens || 0,
      fallback: false,
      skipped: false,
      reason: '',
      error: '',
      errorType: '',
    };

  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[SummarizeArticle:${provider}] Error:`, error.name, error.message);
    return {
      summary: '',
      model: '',
      provider: provider,
      cached: false,
      tokens: 0,
      fallback: true,
      skipped: false,
      reason: '',
      error: error.message,
      errorType: error.name,
    };
  }
}
