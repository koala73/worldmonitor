import type {
  ServerContext,
  SummarizeArticleRequest,
  SummarizeArticleResponse,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';

import { cachedFetchJsonWithMeta } from '../../../_shared/redis';
import {
  CACHE_TTL_SECONDS,
  buildArticlePrompts,
  getProviderCredentials,
  getCacheKey,
} from './_shared';
import { CHROME_UA } from '../../../_shared/constants';
import { isProviderAvailable } from '../../../_shared/llm-health';
import { sanitizeHeadlinesLight, sanitizeHeadlines, sanitizeForPrompt } from '../../../_shared/llm-sanitize.js';
import { isCallerPremium } from '../../../_shared/premium-check';
import { stripThinkingTags } from '../../../_shared/llm';

// ======================================================================
// Reasoning preamble detection
// ======================================================================

export const TASK_NARRATION = /^(we need to|i need to|let me|i'll |i should|i will |the task is|the instructions|according to the rules|so we need to|okay[,.]\s*(i'll|let me|so|we need|the task|i should|i will)|sure[,.]\s*(i'll|let me|so|we need|the task|i should|i will|here)|first[, ]+(i|we|let)|to summarize (the headlines|the task|this)|my task (is|was|:)|step \d)/i;
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
  ctx: ServerContext,
  req: SummarizeArticleRequest,
): Promise<SummarizeArticleResponse> {
  const isPremium = await isCallerPremium(ctx.request);
  const { provider, mode = 'brief', geoContext = '', variant = 'full', lang = 'en' } = req;
  const systemAppend = isPremium && typeof req.systemAppend === 'string' ? req.systemAppend : '';

  const MAX_HEADLINES = 10;
  const MAX_HEADLINE_LEN = 500;
  const MAX_GEO_CONTEXT_LEN = 2000;
  const MAX_BODY_LEN = 400;

  // Bounded raw headlines — used for cache key so browser/server keys agree.
  // Only structural patterns stripped (delimiters, control chars); semantic
  // phrases kept intact to avoid mangling legitimate security news headlines.
  const headlines = sanitizeHeadlinesLight(
    (req.headlines || [])
      .slice(0, MAX_HEADLINES)
      .map(h => typeof h === 'string' ? h.slice(0, MAX_HEADLINE_LEN) : ''),
  );

  // geoContext gets full injection sanitization — it is free-form user text.
  const sanitizedGeoContext = sanitizeForPrompt(
    typeof geoContext === 'string' ? geoContext.slice(0, MAX_GEO_CONTEXT_LEN) : '',
  );

  // Bodies (RSS descriptions) paired 1:1 with headlines. Full injection
  // sanitisation applied — bodies are untrusted upstream text identical in
  // trust-level to geoContext. Padded to match headlines length so pair-wise
  // cache-key identity stays stable. Callers may omit (old path) or pass a
  // shorter/longer array (handler tolerates).
  const rawBodies = Array.isArray(req.bodies) ? req.bodies : [];
  const bodies = headlines.map((_, i) => {
    const b = rawBodies[i];
    return typeof b === 'string' ? sanitizeForPrompt(b.slice(0, MAX_BODY_LEN)) : '';
  });

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
      tokens: 0,
      fallback: true,
      error: '',
      errorType: '',
      status: 'SUMMARIZE_STATUS_SKIPPED',
      statusDetail: skipReasons[provider] || `Unknown provider: ${provider}`,
    };
  }

  const { apiUrl, model, headers: providerHeaders, extraBody } = credentials;

  // Request validation
  if (!headlines || !Array.isArray(headlines) || headlines.length === 0) {
    return {
      summary: '',
      model: '',
      provider: provider,
      tokens: 0,
      fallback: false,
      error: 'Headlines array required',
      errorType: 'ValidationError',
      status: 'SUMMARIZE_STATUS_ERROR',
      statusDetail: 'Headlines array required',
    };
  }

  try {
    const cacheKey = getCacheKey(headlines, mode, sanitizedGeoContext, variant, lang, systemAppend || undefined, bodies);

    // Single atomic call — source tracking happens inside cachedFetchJsonWithMeta,
    // eliminating the TOCTOU race between a separate getCachedJson and cachedFetchJson.
    const { data: result, source } = await cachedFetchJsonWithMeta<{ summary: string; model: string; tokens: number }>(
      cacheKey,
      CACHE_TTL_SECONDS,
      async () => {
        // Health gate inside fetcher — only runs on cache miss
        if (!(await isProviderAvailable(apiUrl))) return null;
        // Full injection sanitization applied at prompt-build time only.
        // Headlines are re-sanitized here (not at cache-key time) so that
        // the cache key stays aligned with the browser while the actual
        // prompt is protected against semantic injection phrases.
        //
        // Pair headlines with bodies BEFORE deduping so sanitizeHeadlines
        // drops / merges don't break the 1:1 mapping. sanitizeHeadlines
        // operates elementwise so paired indices survive per-element
        // replacement; we then dedup pairs together (seen-set on the
        // sanitized headline) to preserve the pairing post-dedup.
        const paired = headlines.map((h, i) => ({
          h: sanitizeHeadlines([h])[0] ?? '',
          b: bodies[i] ?? '',
        }));
        const nonEmpty = paired.filter((p) => p.h.length > 0);
        const uniquePairs: Array<{ h: string; b: string }> = [];
        const seen = new Set<string>();
        for (const p of nonEmpty.slice(0, 5)) {
          if (!seen.has(p.h)) {
            seen.add(p.h);
            uniquePairs.push(p);
          }
        }
        // Preserves the existing variable name for downstream prompt
        // builder callers that expect the full sanitised-headline list.
        const promptHeadlines = nonEmpty.map((p) => p.h);
        const uniqueHeadlines = uniquePairs.map((p) => p.h);
        const uniqueBodies = uniquePairs.map((p) => p.b);
        const { systemPrompt, userPrompt } = buildArticlePrompts(promptHeadlines, uniqueHeadlines, {
          mode,
          geoContext: sanitizedGeoContext,
          variant,
          lang,
          bodies: uniqueBodies,
        });

        const sanitizedAppend = systemAppend ? sanitizeForPrompt(systemAppend) : '';
        const effectiveSystemPrompt = sanitizedAppend
          ? `${systemPrompt}\n\n---\n\n${sanitizedAppend}`
          : systemPrompt;

        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: { ...providerHeaders, 'User-Agent': CHROME_UA },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: effectiveSystemPrompt },
              { role: 'user', content: userPrompt },
            ],
            temperature: 0.3,
            max_tokens: 100,
            top_p: 0.9,
            ...extraBody,
          }),
          signal: AbortSignal.timeout(25_000),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[SummarizeArticle:${provider}] API error:`, response.status, errorText);
          throw new Error(response.status === 429 ? 'Rate limited' : `${provider} API error`);
        }

        const data = await response.json() as any;
        const tokens = (data.usage?.total_tokens as number) || 0;
        const message = data.choices?.[0]?.message;
        const rawText = typeof message?.content === 'string' ? message.content.trim() : '';
        let rawContent = stripThinkingTags(rawText);

        if (['brief', 'analysis'].includes(mode) && rawContent.length < 20) {
          console.warn(`[SummarizeArticle:${provider}] Output too short after stripping (${rawContent.length} chars), rejecting`);
          return null;
        }

        if (['brief', 'analysis'].includes(mode) && hasReasoningPreamble(rawContent)) {
          console.warn(`[SummarizeArticle:${provider}] Reasoning preamble detected, rejecting`);
          return null;
        }

        return rawContent ? { summary: rawContent, model, tokens } : null;
      },
    );

    if (result?.summary) {
      const isCached = source === 'cache';
      return {
        summary: result.summary,
        model: result.model || model,
        provider: isCached ? 'cache' : provider,
        tokens: isCached ? 0 : (result.tokens || 0),
        fallback: false,
        error: '',
        errorType: '',
        status: isCached ? 'SUMMARIZE_STATUS_CACHED' : 'SUMMARIZE_STATUS_SUCCESS',
        statusDetail: '',
      };
    }

    return {
      summary: '',
      model: '',
      provider: provider,
      tokens: 0,
      fallback: true,
      error: 'Empty response',
      errorType: '',
      status: 'SUMMARIZE_STATUS_ERROR',
      statusDetail: 'Empty response',
    };

  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[SummarizeArticle:${provider}] Error:`, error.name, error.message);
    return {
      summary: '',
      model: '',
      provider: provider,
      tokens: 0,
      fallback: true,
      error: error.message,
      errorType: error.name,
      status: 'SUMMARIZE_STATUS_ERROR',
      statusDetail: `${error.name}: ${error.message}`,
    };
  }
}
