import type {
  ServerContext,
  SummarizeArticleRequest,
  SummarizeArticleResponse,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';

import { cachedFetchJsonWithMeta, getCachedJsonBatch, setCachedJson } from '../../../_shared/redis';
import {
  CACHE_TTL_SECONDS,
  buildArticlePrompts,
  getProviderCredentials,
  getCacheKey,
  selectUniqueHeadlinePairs,
} from './_shared';
import { buildNumberedList, parseNumberedList } from '../../../../src/utils/numbered-list';
import { CHROME_UA } from '../../../_shared/constants';
import { isModelUsable, isProviderAvailable, recordModelFailure, recordModelSuccess } from '../../../_shared/llm-health';
import { sanitizeHeadlinesLight, sanitizeForPrompt, sanitizeForPromptLine } from '../../../_shared/llm-sanitize.js';
import {
  getPremiumRpcBillingErrorType,
  resolvePremiumCallerIdentity,
} from '../../../_shared/premium-check';
import {
  markRetryableResponse,
  setResponseHeader,
} from '../../../_shared/response-headers';
import { stripThinkingTags } from '../../../_shared/llm';
import { buildLlmCallEvent, deliverUsageEvents } from '../../../_shared/usage';

// Best-effort llm_call telemetry (#4895). This handler bypasses callLlm (the
// client picks the provider), so it emits its own events.
async function emitSummarizeLlmEvent(p: {
  provider: string; model: string; ok: boolean; durationMs: number;
  promptChars: number; usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
  reason?: string; maxTokens?: number;
}): Promise<void> {
  try {
    await deliverUsageEvents([buildLlmCallEvent({
      provider: p.provider,
      model: p.model,
      stage: 'summarize-article',
      ok: p.ok,
      durationMs: p.durationMs,
      tokensTotal: p.usage?.total_tokens ?? 0,
      tokensPrompt: p.usage?.prompt_tokens ?? 0,
      tokensCompletion: p.usage?.completion_tokens ?? 0,
      promptChars: p.promptChars,
      maxTokens: p.maxTokens ?? 100,
      fallbackIndex: 0,
      reason: p.reason,
    })]);
  } catch { /* telemetry must never affect the summary */ }
}

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
  const premiumIdentity = await resolvePremiumCallerIdentity(ctx.request);
  const isPremium = premiumIdentity.isPremium;
  const { provider, mode = 'brief', geoContext = '', variant = 'full', lang = 'en' } = req;
  const systemAppend = isPremium && typeof req.systemAppend === 'string' ? req.systemAppend : '';
  const requiresPremium = mode !== 'translate';

  const MAX_HEADLINES = 10;
  const MAX_HEADLINE_LEN = 500;
  const MAX_GEO_CONTEXT_LEN = 2000;
  const MAX_BODY_LEN = 400;

  // Bounded raw headlines — used for cache key so browser/server keys agree.
  // Only structural patterns stripped (delimiters, control chars); semantic
  // phrases kept intact to avoid mangling legitimate security news headlines.
  //
  // Zip with bodies BEFORE dropping anything: sanitizeHeadlinesLight filters
  // out entries that reduce to empty, so pairing bodies by index afterwards
  // shifted every later body one slot left and grounded each headline on the
  // PREVIOUS story's article text. Drop each headline together with its own
  // body instead, so the 1:1 association survives the filter.
  const rawBodiesIn = Array.isArray(req.bodies) ? req.bodies : [];
  const intakePairs = (req.headlines || [])
    .slice(0, MAX_HEADLINES)
    .map((h, i) => ({
      h: typeof h === 'string' ? h.slice(0, MAX_HEADLINE_LEN) : '',
      b: rawBodiesIn[i],
    }))
    .map(p => ({ h: sanitizeHeadlinesLight([p.h])[0] ?? '', b: p.b }))
    .filter(p => p.h.length > 0);

  const headlines = intakePairs.map(p => p.h);

  // geoContext gets full injection sanitization — it is free-form user text.
  const sanitizedGeoContext = sanitizeForPrompt(
    typeof geoContext === 'string' ? geoContext.slice(0, MAX_GEO_CONTEXT_LEN) : '',
  );

  // Bodies (RSS descriptions) paired 1:1 with headlines. Full injection
  // sanitisation applied — bodies are untrusted upstream text identical in
  // trust-level to geoContext. Taken from the zipped intake pairs above, so a
  // headline dropped by light sanitisation takes its own body with it rather
  // than shifting its successors'. Callers may omit bodies entirely (old
  // path) or pass a shorter/longer array (handler tolerates).
  const bodies = intakePairs.map(p =>
    typeof p.b === 'string' ? sanitizeForPrompt(p.b.slice(0, MAX_BODY_LEN)) : '',
  );

  if (requiresPremium && !isPremium) {
    const billingDenial = premiumIdentity.billingDenial;
    if (billingDenial) {
      if (billingDenial.retryable) {
        markRetryableResponse(ctx.request);
        setResponseHeader(ctx.request, 'Retry-After', String(billingDenial.retryAfterSeconds));
        setResponseHeader(ctx.request, 'X-Billing-Verification', billingDenial.code);
      }
      return {
        summary: '',
        model: '',
        provider,
        tokens: 0,
        fallback: true,
        error: billingDenial.message,
        errorType: getPremiumRpcBillingErrorType(billingDenial),
        status: 'SUMMARIZE_STATUS_ERROR',
        statusDetail: billingDenial.code,
      };
    }
    return {
      summary: '',
      model: '',
      provider: provider,
      tokens: 0,
      fallback: true,
      error: 'Pro subscription required',
      errorType: 'AuthError',
      status: 'SUMMARIZE_STATUS_ERROR',
      statusDetail: 'Pro subscription required',
    };
  }

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

  if (mode === 'translate') {
    // Positional (per-element) light sanitize: the shared `headlines` array
    // above is sanitized array-level, which DROPS empty/stripped entries and
    // would shift the numbered-response alignment against the request. Here
    // an entry that sanitizes away must stay in place as '' (its response
    // line stays blank and the client keeps the original text).
    const positionalHeadlines = (req.headlines || [])
      .slice(0, MAX_HEADLINES)
      .map(h => typeof h === 'string' ? h.slice(0, MAX_HEADLINE_LEN) : '')
      .map(h => sanitizeHeadlinesLight([h])[0] ?? '');
    return translateHeadlines({
      provider, model, apiUrl, providerHeaders, extraBody,
      headlines: positionalHeadlines, variant, lang,
    });
  }

  try {
    const cacheKey = getCacheKey(headlines, mode, sanitizedGeoContext, variant, lang, systemAppend || undefined, bodies);

    // Single atomic call — source tracking happens inside cachedFetchJsonWithMeta,
    // eliminating the TOCTOU race between a separate getCachedJson and cachedFetchJson.
    const { data: result, source } = await cachedFetchJsonWithMeta<{ summary: string; model: string; tokens: number }>(
      cacheKey,
      CACHE_TTL_SECONDS,
      async () => {
        if (!(await isProviderAvailable(apiUrl))) return null;
        // Full injection sanitization applied at prompt-build time only.
        // Headlines are re-sanitized here (not at cache-key time) so that
        // the cache key stays aligned with the browser while the actual
        // prompt is protected against semantic injection phrases.
        //
        // Select the prompt window from the same headline/body pairs used by
        // the cache key. Full prompt sanitization happens only after that
        // bounded selection, so a sixth story cannot become prompt-relevant
        // while remaining absent from cache identity if an earlier headline
        // sanitizes to empty or aliases another selected headline.
        const paired = headlines.map((h, i) => ({
          h,
          b: bodies[i] ?? '',
        }));
        const selectedPairs = selectUniqueHeadlinePairs(paired);
        // sanitizeForPromptLine, not sanitizeForPrompt: the latter deliberately
        // preserves a lone newline, and buildArticlePrompts joins headlines
        // with '\n' as the item delimiter, so one embedded newline in a feed
        // headline forges an extra numbered story the model reads as real.
        const sanitizedPairs = selectedPairs.map((pair) => ({
          h: sanitizeForPromptLine(pair.h),
          b: pair.b,
          // The pre-sanitization headline, i.e. the text the cache key is
          // built from. Used to break alias ties the same way the key sorts.
          keyH: pair.h,
        }));
        const nonEmpty = sanitizedPairs.filter((pair) => pair.h.length > 0);
        // Sanitization can make two distinct selected headlines identical.
        // Collapse that prompt-only alias without backfilling from outside the
        // cache-key window — and choose the survivor by the same (headline,
        // body) comparison buildSummaryCacheKey sorts on, NOT by arrival
        // order. The key is order-insensitive within the window, so an
        // arrival-order tie-break let the same key serve prompts grounded on
        // different bodies depending on which order the headlines arrived in.
        // Survivors keep request order for rendering; only the choice of
        // survivor is normalized.
        const aliasWinners = new Map<string, typeof nonEmpty[number]>();
        for (const pair of nonEmpty) {
          const current = aliasWinners.get(pair.h);
          if (
            !current
            || pair.keyH < current.keyH
            || (pair.keyH === current.keyH && pair.b < current.b)
          ) {
            aliasWinners.set(pair.h, pair);
          }
        }
        const uniquePairs = nonEmpty.filter((pair) => aliasWinners.get(pair.h) === pair);
        // Every selected headline sanitised away. Backfilling from outside the
        // cache-key window would reopen the prompt/key divergence this
        // selection exists to close, so reject instead: prompting the model
        // with zero stories would cache an invented summary under a key that
        // represents five real headlines. cacheFailures:false below keeps this
        // out of Redis, matching the other rejections in this factory.
        if (uniquePairs.length === 0) return null;
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

        const llmStartMs = Date.now();
        const llmPromptChars = effectiveSystemPrompt.length + userPrompt.length;
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
          recordModelFailure(apiUrl, model, response.status, errorText);
          await emitSummarizeLlmEvent({ provider, model, ok: false, durationMs: Date.now() - llmStartMs, promptChars: llmPromptChars, reason: `http_${response.status}` });
          throw new Error(response.status === 429 ? 'Rate limited' : `${provider} API error`);
        }

        // HTTP success proves provider/model compatibility. Summary validation
        // below is an application-level concern and must not preserve a stale
        // model-rejection streak.
        recordModelSuccess(apiUrl, model);

        const data = await response.json() as any;
        const tokens = (data.usage?.total_tokens as number) || 0;
        const usage = data.usage as { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } | undefined;
        const message = data.choices?.[0]?.message;
        const rawText = typeof message?.content === 'string' ? message.content.trim() : '';
        const rawContent = stripThinkingTags(rawText);

        if (['brief', 'analysis'].includes(mode) && rawContent.length < 20) {
          console.warn(`[SummarizeArticle:${provider}] Output too short after stripping (${rawContent.length} chars), rejecting`);
          await emitSummarizeLlmEvent({ provider, model, ok: false, durationMs: Date.now() - llmStartMs, promptChars: llmPromptChars, usage, reason: 'stripped_empty' });
          return null;
        }

        if (['brief', 'analysis'].includes(mode) && hasReasoningPreamble(rawContent)) {
          console.warn(`[SummarizeArticle:${provider}] Reasoning preamble detected, rejecting`);
          await emitSummarizeLlmEvent({ provider, model, ok: false, durationMs: Date.now() - llmStartMs, promptChars: llmPromptChars, usage, reason: 'validate_reject' });
          return null;
        }

        await emitSummarizeLlmEvent({ provider, model, ok: Boolean(rawContent), durationMs: Date.now() - llmStartMs, promptChars: llmPromptChars, usage, reason: rawContent ? '' : 'empty' });
        return rawContent ? { summary: rawContent, model, tokens } : null;
      },
      undefined,
      {
        // This cache key is intentionally provider-independent so a successful
        // summary can be reused across the client fallback chain. Provider-
        // local failures and in-flight work must not suppress another provider.
        shouldFetch: () => isModelUsable(apiUrl, model),
        cacheFailures: false,
        inflightKey: `${cacheKey}:${provider}:${model}`,
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

// ======================================================================
// Translate mode: per-headline cache + one batched LLM call for misses
// ======================================================================
//
// Unlike brief/analysis (one summary per headline SET), a translation is a
// per-headline artifact — so caching whole batches under the sorted-top-5
// batch key would both collide distinct batches and replay order-sensitive
// numbered output against differently-ordered requests. Instead each unique
// headline gets its own cache entry, keyed exactly like the legacy
// single-headline translate request (getCacheKey([h], 'translate', '',
// targetLang, lang)) so entries minted by the manual per-item translate
// button and by batch requests are interchangeable. Only cache misses reach
// the LLM, as one numbered-list prompt.
//
// Response contract: a single-headline request returns the bare translation
// (legacy shape); a multi-headline request returns a numbered list aligned
// 1:1 with the REQUEST order (duplicates repeated, untranslated slots left
// empty so the client keeps the original text).

interface TranslateDeps {
  provider: string;
  model: string;
  apiUrl: string;
  providerHeaders: Record<string, string>;
  extraBody?: Record<string, unknown>;
  /** Light-sanitized, length-bounded headlines (cache-key identity). */
  headlines: string[];
  /** Legacy wire shape: `variant` carries the target language. */
  variant: string;
  lang: string;
}

async function translateHeadlines(deps: TranslateDeps): Promise<SummarizeArticleResponse> {
  const { provider, model, apiUrl, providerHeaders, extraBody, headlines, variant, lang } = deps;

  const errorResponse = (message: string): SummarizeArticleResponse => ({
    summary: '',
    model: '',
    provider,
    tokens: 0,
    fallback: true,
    error: message,
    errorType: '',
    status: 'SUMMARIZE_STATUS_ERROR',
    statusDetail: message,
  });

  // Dedup on the light-sanitized headline — the same identity the per-item
  // cache key hashes, so duplicate inputs share one lookup/translation.
  const uniques: string[] = [];
  const uniqueIndexByHeadline = new Map<string, number>();
  const inputToUnique: number[] = headlines.map((h) => {
    const trimmed = h.trim();
    if (!trimmed) return -1;
    let idx = uniqueIndexByHeadline.get(trimmed);
    if (idx === undefined) {
      idx = uniques.length;
      uniques.push(trimmed);
      uniqueIndexByHeadline.set(trimmed, idx);
    }
    return idx;
  });

  if (uniques.length === 0) return errorResponse('Empty response');

  const keys = uniques.map((h) => getCacheKey([h], 'translate', '', variant, lang));
  const translations: Array<string | null> = new Array(uniques.length).fill(null);
  try {
    const cached = await getCachedJsonBatch(keys);
    keys.forEach((key, i) => {
      const entry = cached.get(key) as { summary?: unknown } | null | undefined;
      const summary = entry && typeof entry.summary === 'string' ? entry.summary.trim() : '';
      if (summary) translations[i] = summary;
    });
  } catch {
    // Cache degradation → treat everything as a miss.
  }

  const missIndexes = translations
    .map((t, i) => (t === null ? i : -1))
    .filter((i) => i >= 0);
  let llmModel = '';
  let llmTokens = 0;

  if (missIndexes.length > 0 && (await isProviderAvailable(apiUrl))) {
    // Full injection sanitization at prompt-build time only, mirroring the
    // summary path: cache keys stay light-sanitized, prompts get the strict
    // pass. Entries the strict pass empties out are skipped (stay null).
    const llmItems: Array<{ uniqueIndex: number; text: string }> = [];
    for (const uniqueIndex of missIndexes) {
      const text = (sanitizeHeadlines([uniques[uniqueIndex] ?? ''])[0] ?? '').trim();
      if (text.length > 0) llmItems.push({ uniqueIndex, text });
    }

    if (llmItems.length > 0) {
      const texts = llmItems.map((item) => item.text);
      const { systemPrompt, userPrompt } = buildArticlePrompts(texts, texts, {
        mode: 'translate',
        geoContext: '',
        variant,
        lang,
        bodies: [],
      });
      // 150 output tokens per headline: CJK/Cyrillic translations of a
      // 500-char headline routinely exceed the summary path's flat 100.
      const maxTokens = Math.min(1500, 150 * texts.length);
      const llmStartMs = Date.now();
      const llmPromptChars = systemPrompt.length + userPrompt.length;

      try {
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
            max_tokens: maxTokens,
            top_p: 0.9,
            ...extraBody,
          }),
          signal: AbortSignal.timeout(25_000),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[SummarizeArticle:${provider}] translate API error:`, response.status, errorText);
          await emitSummarizeLlmEvent({ provider, model, ok: false, durationMs: Date.now() - llmStartMs, promptChars: llmPromptChars, maxTokens, reason: `http_${response.status}` });
          throw new Error(response.status === 429 ? 'Rate limited' : `${provider} API error`);
        }

        const data = await response.json() as any;
        const usage = data.usage as { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } | undefined;
        const message = data.choices?.[0]?.message;
        const rawText = typeof message?.content === 'string' ? message.content.trim() : '';
        const rawContent = stripThinkingTags(rawText);
        const parsed = parseNumberedList(rawContent, texts.length);

        for (const [slot, item] of llmItems.entries()) {
          const translated = parsed[slot]?.trim();
          if (!translated) continue;
          translations[item.uniqueIndex] = translated;
          const key = keys[item.uniqueIndex];
          if (key) {
            // Fire-and-forget: a failed cache write only costs a re-translate.
            void setCachedJson(key, { summary: translated, model, tokens: 0 }, CACHE_TTL_SECONDS).catch(() => {});
          }
        }

        llmModel = model;
        llmTokens = usage?.total_tokens ?? 0;
        const anyTranslated = parsed.some((p) => p && p.trim().length > 0);
        await emitSummarizeLlmEvent({ provider, model, ok: anyTranslated, durationMs: Date.now() - llmStartMs, promptChars: llmPromptChars, usage, maxTokens, reason: anyTranslated ? '' : 'empty' });
      } catch (err: unknown) {
        // Partial results (cache hits) still ship below; a fully-failed
        // request falls through to the error response so the client's
        // provider chain can try the next provider.
        const error = err instanceof Error ? err : new Error(String(err));
        console.error(`[SummarizeArticle:${provider}] translate error:`, error.name, error.message);
        if (!translations.some((t) => t !== null)) {
          return {
            ...errorResponse(error.message),
            errorType: error.name,
            statusDetail: `${error.name}: ${error.message}`,
          };
        }
      }
    }
  }

  if (!translations.some((t) => t !== null)) return errorResponse('Empty response');

  // Compose in REQUEST order: duplicates repeat their unique translation,
  // untranslated/empty slots stay blank lines (client keeps the original).
  const lines = inputToUnique.map((uniqueIndex) =>
    uniqueIndex >= 0 ? (translations[uniqueIndex] ?? '') : '');
  const summary = headlines.length === 1 ? (lines[0] ?? '') : buildNumberedList(lines);
  const allFromCache = missIndexes.length === 0;

  return {
    summary,
    model: llmModel || model,
    provider: allFromCache ? 'cache' : provider,
    tokens: llmTokens,
    fallback: false,
    error: '',
    errorType: '',
    status: allFromCache ? 'SUMMARIZE_STATUS_CACHED' : 'SUMMARIZE_STATUS_SUCCESS',
    statusDetail: '',
  };
}
