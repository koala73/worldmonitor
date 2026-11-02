import type {
  ServerContext,
  SummarizeArticleRequest,
  SummarizeArticleResponse,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';

import { cachedFetchJsonWithMeta } from '../../../_shared/redis';
import {
  CACHE_TTL_SECONDS,
  MAX_BODY_LEN,
  SUMMARY_OUTPUT_LANGUAGES,
  TRANSLATE_TEXT_CLOSE,
  TRANSLATE_TEXT_OPEN,
  buildArticlePrompts,
  getProviderCredentials,
  getCacheKey,
  neutralizeTranslateText,
  selectUniqueHeadlinePairs,
} from './_shared';
import { checkIpScopedEdgeProof, checkScopedRateLimit, getClientRateLimitKey, reportRateLimitDegraded } from '../../../_shared/rate-limit';
import { CHROME_UA } from '../../../_shared/constants';
import { isModelUsable, isProviderAvailable, recordModelFailure, recordModelSuccess } from '../../../_shared/llm-health';
import { sanitizeHeadlinesLight, sanitizeForPrompt, sanitizeForPromptLine } from '../../../_shared/llm-sanitize.js';
import {
  getPremiumRpcBillingErrorType,
  resolvePremiumCallerIdentity,
} from '../../../_shared/premium-check';
import {
  markRetryableResponse,
  markUnservedLlmResponse,
  setResponseHeader,
} from '../../../_shared/response-headers';
import { callLlm, isDefaultChainProvider, resolveProviderChain, stripThinkingTags } from '../../../_shared/llm';
import { aiRoutingCacheSuffix, resolveAiRouting, toLlmRoutingPolicy } from '../../../_shared/ai-routing-policy';
import { buildLlmCallEvent, deliverUsageEvents } from '../../../_shared/usage';

// Best-effort llm_call telemetry (#4895). This handler bypasses callLlm (the
// client picks the provider), so it emits its own events.
async function emitSummarizeLlmEvent(p: {
  provider: string; model: string; mode: string; ok: boolean; durationMs: number;
  promptChars: number; usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
  reason?: string;
}): Promise<void> {
  try {
    await deliverUsageEvents([buildLlmCallEvent({
      provider: p.provider,
      model: p.model,
      stage: 'summarize-article',
      mode: p.mode,
      ok: p.ok,
      durationMs: p.durationMs,
      tokensTotal: p.usage?.total_tokens ?? 0,
      tokensPrompt: p.usage?.prompt_tokens ?? 0,
      tokensCompletion: p.usage?.completion_tokens ?? 0,
      promptChars: p.promptChars,
      maxTokens: 100,
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

// Translate mode is free and skips the gateway's direct-LLM quota, and its
// `variant` is the target language interpolated into the prompt. Accept only
// the dashboard's UI languages (the digest set plus Traditional Chinese, which
// the digest folds into `zh`) so an anonymous caller cannot turn translate into
// an unmetered general-purpose prompt with a cache-busting key.
export const TRANSLATE_TARGET_LANGUAGES: ReadonlySet<string> = SUMMARY_OUTPUT_LANGUAGES;

// Translate reads one headline; longer text is refused rather than silently
// cut, so a caller never gets a translation of a prefix it did not choose.
export const MAX_TRANSLATE_INPUT_LEN = 500;

// A translation is about as long as its source. An answer far longer than any
// translation of the input is the model doing something else; it is neither
// served nor cached. max_tokens (100) bounds the absolute size regardless.
export function maxTranslateOutputChars(inputChars: number): number {
  return inputChars * 4 + 120;
}

// Anonymous translate spends provider tokens with no account behind it and
// skips the gateway's direct-LLM quota, so each provider call it causes (a
// cache miss) is charged against a daily per-IP budget and a global daily
// ceiling. Cache hits are free. Sized from Axiom wm_api_usage, 2026-09-27 to
// 2026-10-27: anonymous summarize-article 200s peaked at 122 per IP per day
// (p99 86) and 524 in total per day; the defaults leave about 2.5x and 10x
// headroom. Both are env-overridable.
export const ANON_TRANSLATE_IP_SCOPE = 'summarize-article:translate-anon-ip';
export const ANON_TRANSLATE_GLOBAL_SCOPE = 'summarize-article:translate-anon-global';
const ANON_TRANSLATE_WINDOW = '1 d' as const;
const DEFAULT_ANON_TRANSLATE_IP_DAILY_MISSES = 300;
const DEFAULT_ANON_TRANSLATE_GLOBAL_DAILY_MISSES = 5000;

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

type ScopedLimiter = typeof checkScopedRateLimit;
let translateBudgetLimiter: ScopedLimiter = checkScopedRateLimit;

/** Test seam: replaces the scoped limiter the translate budget charges. */
export function __setTranslateBudgetLimiterForTests(limiter: ScopedLimiter | null): void {
  translateBudgetLimiter = limiter ?? checkScopedRateLimit;
}

type TranslateBudgetDecision = 'allowed' | 'exhausted' | 'unavailable';

/**
 * Thrown from the cache-miss fetcher when the caller's budget refuses. It is a
 * caller-local error (isCallerLocalError below): a request coalesced on the
 * same key does not inherit it, but retries as the next leader and is charged
 * against its own budget.
 */
class TranslateBudgetRefusal extends Error {
  constructor(readonly decision: Exclude<TranslateBudgetDecision, 'allowed'>) {
    super(`translate budget ${decision}`);
    this.name = 'TranslateBudgetRefusal';
  }
}

/**
 * Charges one anonymous translate cache miss. Fails closed: an unproven
 * Cloudflare client IP, a degraded or throwing limiter all refuse, because the
 * budget is the only spend bound on this path.
 */
async function chargeAnonymousTranslateMiss(request: Request): Promise<TranslateBudgetDecision> {
  if (checkIpScopedEdgeProof(request, {})) return 'unavailable';
  try {
    const perIp = await translateBudgetLimiter(
      ANON_TRANSLATE_IP_SCOPE,
      positiveIntEnv('TRANSLATE_ANON_IP_DAILY_MISS_LIMIT', DEFAULT_ANON_TRANSLATE_IP_DAILY_MISSES),
      ANON_TRANSLATE_WINDOW,
      getClientRateLimitKey(request),
    );
    if (perIp.degraded) return 'unavailable';
    if (!perIp.allowed) return 'exhausted';
    const global = await translateBudgetLimiter(
      ANON_TRANSLATE_GLOBAL_SCOPE,
      positiveIntEnv('TRANSLATE_ANON_GLOBAL_DAILY_MISS_LIMIT', DEFAULT_ANON_TRANSLATE_GLOBAL_DAILY_MISSES),
      ANON_TRANSLATE_WINDOW,
      'global',
    );
    if (global.degraded) return 'unavailable';
    return global.allowed ? 'allowed' : 'exhausted';
  } catch (err) {
    // checkScopedRateLimit reports its own Redis failures; this covers a throw
    // past it, through the same per-stage deduped Sentry path.
    reportRateLimitDegraded('summarize-article:translate-budget', err);
    return 'unavailable';
  }
}

function stripTranslateMarkers(text: string): string {
  return text.split(TRANSLATE_TEXT_OPEN).join('').split(TRANSLATE_TEXT_CLOSE).join('').trim();
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
  const { provider: requestedProvider, mode = 'brief', geoContext = '', variant = 'full', lang = 'en' } = req;
  // A restricted caller is served by their whole policy chain, in order,
  // whatever provider the client fallback chain named; the default chain is
  // never reached (ai-routing-policy.ts). An unrestricted caller may name only
  // a default-chain provider: opt-in providers (anthropic) are reachable
  // through a policy, never on a request's say-so.
  // Translate mode is free, so the gateway may not have resolved a Clerk
  // session; the identity this handler resolved covers that case.
  const aiRouting = await resolveAiRouting(ctx.request, premiumIdentity.userId);
  const routingPolicy = toLlmRoutingPolicy(aiRouting);
  const policyChain = routingPolicy ? resolveProviderChain({ routingPolicy }) : null;
  const provider = policyChain
    ? (policyChain.find((name) => getProviderCredentials(name) !== null) ?? policyChain[0] ?? '')
    : requestedProvider;
  // Only a policy chain or a default-chain name may resolve credentials; any
  // other client-named provider is reported as unknown (#8885).
  const providerIsSelectable = policyChain !== null || isDefaultChainProvider(provider);
  // Bounded like geoContext and the intel-brief framework: the append is
  // free text that the sanitizer scans and the system prompt carries.
  const MAX_SYSTEM_APPEND_LEN = 2000;
  const systemAppend = isPremium && typeof req.systemAppend === 'string' ? req.systemAppend.slice(0, MAX_SYSTEM_APPEND_LEN) : '';
  const requiresPremium = mode !== 'translate';
  // Every empty-summary envelope below (denied, skipped, rejected, failed)
  // serves no LLM output; the gateway reserved a daily-quota slot for this
  // call and releases it on this marker. The served and cached paths do not
  // go through here and stay charged.
  const unserved = (payload: SummarizeArticleResponse): SummarizeArticleResponse => {
    markUnservedLlmResponse(ctx.request);
    return payload;
  };

  if (requiresPremium && !isPremium) {
    const billingDenial = premiumIdentity.billingDenial;
    if (billingDenial) {
      if (billingDenial.retryable) {
        markRetryableResponse(ctx.request);
        setResponseHeader(ctx.request, 'Retry-After', String(billingDenial.retryAfterSeconds));
        setResponseHeader(ctx.request, 'X-Billing-Verification', billingDenial.code);
      }
      return unserved({
        summary: '',
        model: '',
        provider,
        tokens: 0,
        fallback: true,
        error: billingDenial.message,
        errorType: getPremiumRpcBillingErrorType(billingDenial),
        status: 'SUMMARIZE_STATUS_ERROR',
        statusDetail: billingDenial.code,
      });
    }
    return unserved({
      summary: '',
      model: '',
      provider: provider,
      tokens: 0,
      fallback: true,
      error: 'Pro subscription required',
      errorType: 'AuthError',
      status: 'SUMMARIZE_STATUS_ERROR',
      statusDetail: 'Pro subscription required',
    });
  }

  if (mode === 'translate' && !TRANSLATE_TARGET_LANGUAGES.has(variant)) {
    return unserved({
      summary: '',
      model: '',
      provider,
      tokens: 0,
      fallback: false,
      error: 'Unsupported translation language',
      errorType: 'ValidationError',
      status: 'SUMMARIZE_STATUS_ERROR',
      statusDetail: 'Unsupported translation language',
    });
  }

  // Brief and analysis interpolate `lang` into the system prompt. '' means no
  // output-language instruction; anything else must be a UI language.
  if (mode !== 'translate' && lang !== '' && !SUMMARY_OUTPUT_LANGUAGES.has(lang)) {
    return unserved({
      summary: '',
      model: '',
      provider,
      tokens: 0,
      fallback: false,
      error: 'Unsupported output language',
      errorType: 'ValidationError',
      status: 'SUMMARIZE_STATUS_ERROR',
      statusDetail: 'Unsupported output language',
    });
  }

  // Every entry, not only the first: translate reads the first headline that
  // survives sanitization, which need not be headlines[0].
  const translateInputTooLong = mode === 'translate'
    && Array.isArray(req.headlines)
    && req.headlines.some((h) => typeof h === 'string' && h.length > MAX_TRANSLATE_INPUT_LEN);
  if (translateInputTooLong) {
    return unserved({
      summary: '',
      model: '',
      provider,
      tokens: 0,
      fallback: false,
      error: `Text too long to translate (max ${MAX_TRANSLATE_INPUT_LEN} characters)`,
      errorType: 'ValidationError',
      status: 'SUMMARIZE_STATUS_ERROR',
      statusDetail: 'Text too long to translate',
    });
  }

  // Premium and operator callers are metered by the gateway. A routing policy
  // exists only for an identified customer account (a verified Clerk subject
  // or the gateway's trusted user header), never for an anonymous caller. The
  // desktop sidecar and a self-hosted Ollama spend no shared provider budget.
  const chargesTranslateBudget = mode === 'translate'
    && !isPremium
    && routingPolicy === null
    && process.env.LOCAL_API_MODE !== 'tauri-sidecar'
    && provider !== 'ollama';

  const MAX_HEADLINES = 10;
  const MAX_HEADLINE_LEN = 500;
  const MAX_GEO_CONTEXT_LEN = 2000;

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

  // Provider credential check
  const skipReasons: Record<string, string> = {
    ollama: 'OLLAMA_API_URL not configured',
    openrouter: 'OPENROUTER_API_KEY not configured',
    anthropic: 'ANTHROPIC_API_KEY not configured',
    '': 'No AI provider is available for this request',
  };

  const credentials = providerIsSelectable ? getProviderCredentials(provider) : null;
  if (!credentials) {
    return unserved({
      summary: '',
      model: '',
      provider: provider,
      tokens: 0,
      fallback: true,
      error: '',
      errorType: '',
      status: 'SUMMARIZE_STATUS_SKIPPED',
      statusDetail: (providerIsSelectable && skipReasons[provider]) || `Unknown provider: ${provider}`,
    });
  }

  const { apiUrl, model, headers: providerHeaders, extraBody } = credentials;

  // Request validation
  if (!headlines || !Array.isArray(headlines) || headlines.length === 0) {
    return unserved({
      summary: '',
      model: '',
      provider: provider,
      tokens: 0,
      fallback: false,
      error: 'Headlines array required',
      errorType: 'ValidationError',
      status: 'SUMMARIZE_STATUS_ERROR',
      statusDetail: 'Headlines array required',
    });
  }

  try {
    const cacheKey = `${await getCacheKey(headlines, mode, sanitizedGeoContext, variant, lang, systemAppend || undefined, bodies)}${aiRoutingCacheSuffix(aiRouting)}`;

    // Single atomic call — source tracking happens inside cachedFetchJsonWithMeta,
    // eliminating the TOCTOU race between a separate getCachedJson and cachedFetchJson.
    const { data: result, source } = await cachedFetchJsonWithMeta<{ summary: string; model: string; tokens: number; provider?: string }>(
      cacheKey,
      CACHE_TTL_SECONDS,
      async () => {
        // callLlm runs its own reachability and model-health gates per provider.
        if (!routingPolicy && !(await isProviderAvailable(apiUrl))) return null;
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
        const selectedPairs = mode === 'translate' ? paired.slice(0, 1) : selectUniqueHeadlinePairs(paired);
        // sanitizeForPromptLine, not sanitizeForPrompt: the latter deliberately
        // preserves a lone newline, and buildArticlePrompts joins headlines
        // with '\n' as the item delimiter, so one embedded newline in a feed
        // headline forges an extra numbered story the model reads as real.
        // Translate also drops forged data-block markers here, so text that
        // is nothing but markers is rejected below instead of prompting with
        // an empty block.
        const sanitizedPairs = selectedPairs.map((pair) => ({
          h: mode === 'translate'
            ? neutralizeTranslateText(sanitizeForPromptLine(pair.h))
            : sanitizeForPromptLine(pair.h),
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

        const translateOutputCap = maxTranslateOutputChars(uniqueHeadlines[0]?.length ?? 0);
        const rejectsSummary = (text: string): boolean => (['brief', 'analysis'].includes(mode)
          && (text.length < 20 || hasReasoningPreamble(text)))
          || (mode === 'translate' && (text.length === 0 || text.length > translateOutputCap));
        // Echoed data-block markers are dropped on every provider path before
        // the answer is validated, served or cached.
        const cleanAnswer = (text: string): string => (mode === 'translate' ? stripTranslateMarkers(text) : text);

        // Charged here, on the miss path right before the provider call, so
        // cache hits and requests rejected above never spend the budget.
        if (chargesTranslateBudget) {
          const decision = await chargeAnonymousTranslateMiss(ctx.request);
          if (decision !== 'allowed') throw new TranslateBudgetRefusal(decision);
        }

        if (routingPolicy) {
          // callLlm walks the policy chain with fallback, speaks the Anthropic
          // Messages API, and owns telemetry and model health; the
          // OpenAI-format fetch below serves unrestricted callers only.
          const result = await callLlm({
            messages: [
              { role: 'system', content: effectiveSystemPrompt },
              { role: 'user', content: userPrompt },
            ],
            maxTokens: 100,
            timeoutMs: 25_000,
            routingPolicy,
            stage: 'summarize-article',
            validate: (text) => !rejectsSummary(cleanAnswer(text)),
          });
          return result
            ? { summary: cleanAnswer(result.content), model: result.model, tokens: result.tokens, provider: result.provider }
            : null;
        }

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
          await emitSummarizeLlmEvent({ provider, model, mode, ok: false, durationMs: Date.now() - llmStartMs, promptChars: llmPromptChars, reason: `http_${response.status}` });
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
        const rawContent = cleanAnswer(stripThinkingTags(rawText));

        if (['brief', 'analysis'].includes(mode) && rawContent.length < 20) {
          console.warn(`[SummarizeArticle:${provider}] Output too short after stripping (${rawContent.length} chars), rejecting`);
          await emitSummarizeLlmEvent({ provider, model, mode, ok: false, durationMs: Date.now() - llmStartMs, promptChars: llmPromptChars, usage, reason: 'stripped_empty' });
          return null;
        }

        if (['brief', 'analysis'].includes(mode) && hasReasoningPreamble(rawContent)) {
          console.warn(`[SummarizeArticle:${provider}] Reasoning preamble detected, rejecting`);
          await emitSummarizeLlmEvent({ provider, model, mode, ok: false, durationMs: Date.now() - llmStartMs, promptChars: llmPromptChars, usage, reason: 'validate_reject' });
          return null;
        }

        if (mode === 'translate' && rawContent.length > translateOutputCap) {
          console.warn(`[SummarizeArticle:${provider}] Translation far longer than its input (${rawContent.length} > ${translateOutputCap} chars), rejecting`);
          await emitSummarizeLlmEvent({ provider, model, mode, ok: false, durationMs: Date.now() - llmStartMs, promptChars: llmPromptChars, usage, reason: 'validate_reject' });
          return null;
        }

        await emitSummarizeLlmEvent({ provider, model, mode, ok: Boolean(rawContent), durationMs: Date.now() - llmStartMs, promptChars: llmPromptChars, usage, reason: rawContent ? '' : 'empty' });
        return rawContent ? { summary: rawContent, model, tokens } : null;
      },
      undefined,
      {
        // This cache key is intentionally provider-independent so a successful
        // summary can be reused across the client fallback chain. Provider-
        // local failures and in-flight work must not suppress another provider.
        shouldFetch: () => routingPolicy !== null || isModelUsable(apiUrl, model),
        cacheFailures: false,
        inflightKey: `${cacheKey}:${provider}:${model}`,
        isCallerLocalError: (err) => err instanceof TranslateBudgetRefusal,
      },
    );

    if (result?.summary) {
      const isCached = source === 'cache';
      return {
        summary: result.summary,
        model: result.model || model,
        provider: isCached ? 'cache' : (result.provider || provider),
        tokens: isCached ? 0 : (result.tokens || 0),
        fallback: false,
        error: '',
        errorType: '',
        status: isCached ? 'SUMMARIZE_STATUS_CACHED' : 'SUMMARIZE_STATUS_SUCCESS',
        statusDetail: '',
      };
    }

    return unserved({
      summary: '',
      model: '',
      provider: provider,
      tokens: 0,
      fallback: true,
      error: 'Empty response',
      errorType: '',
      status: 'SUMMARIZE_STATUS_ERROR',
      statusDetail: 'Empty response',
    });

  } catch (err: unknown) {
    if (err instanceof TranslateBudgetRefusal) {
      const exhausted = err.decision === 'exhausted';
      if (!exhausted) {
        markRetryableResponse(ctx.request);
        setResponseHeader(ctx.request, 'Retry-After', '5');
      }
      return unserved({
        summary: '',
        model: '',
        provider,
        tokens: 0,
        // Not a provider failure: every budgeted provider shares this budget,
        // so there is nothing for a fallback to recover.
        fallback: false,
        error: exhausted ? 'Daily translation limit reached' : 'Translation temporarily unavailable',
        errorType: exhausted ? 'RateLimitError' : 'ServiceUnavailable',
        status: 'SUMMARIZE_STATUS_ERROR',
        statusDetail: exhausted ? 'translate_daily_budget' : 'translate_budget_unavailable',
      });
    }
    // sentry-coverage-ok Provider failures return SUMMARIZE_STATUS_ERROR for the client fallback chain.
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[SummarizeArticle:${provider}] Error:`, error.name, error.message);
    return unserved({
      summary: '',
      model: '',
      provider: provider,
      tokens: 0,
      fallback: true,
      // Provider error text can carry upstream URLs and request details; it
      // stays in the log above. Callers get the error class only.
      error: 'Summarization failed',
      errorType: error.name,
      status: 'SUMMARIZE_STATUS_ERROR',
      statusDetail: error.name,
    });
  }
}
